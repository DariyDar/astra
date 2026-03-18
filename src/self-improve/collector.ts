/**
 * Interaction collector for self-improvement agent.
 * Queries audit_trail + messages tables to collect today's interactions
 * and identify problematic cases.
 */

import { and, eq, gte, lt, asc } from 'drizzle-orm'
import { db } from '../db/index.js'
import { auditTrail, messages } from '../db/schema.js'
import { logger } from '../logging/logger.js'
import type { InteractionRecord, ProblematicCase, ProblemType } from './types.js'

/** Response time threshold for "slow" detection (2 minutes). */
const SLOW_RESPONSE_MS = 120_000

/** Minimum response length — shorter is suspicious. */
const SHORT_RESPONSE_THRESHOLD = 50

/** Russian negative feedback keywords. */
const NEGATIVE_KEYWORDS = [
  'нет', 'неправильно', 'не то', 'ошибка', 'не так', 'бред', 'чушь',
  'не знаешь', 'wrong', 'incorrect', 'не нашёл', 'не нашел',
  'не понял', 'не туда', 'опять', 'снова', 'плохо', 'фигня',
]

/** Max turns exceeded marker from client.ts. */
const MAX_TURNS_MARKER = 'Не удалось обработать запрос за отведённое количество шагов'

/**
 * Collect today's interactions from audit_trail + messages.
 * Returns enriched InteractionRecords with full text content.
 */
export async function collectTodayInteractions(): Promise<InteractionRecord[]> {
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const now = new Date()

  // Get all message_exchange audit entries for today
  const exchanges = await db
    .select()
    .from(auditTrail)
    .where(
      and(
        eq(auditTrail.action, 'message_exchange'),
        gte(auditTrail.createdAt, todayStart),
        lt(auditTrail.createdAt, now),
      ),
    )
    .orderBy(asc(auditTrail.createdAt))

  if (exchanges.length === 0) return []

  // Get all LLM request entries for today (to get timing + cost data)
  const llmRequests = await db
    .select()
    .from(auditTrail)
    .where(
      and(
        eq(auditTrail.action, 'llm_request'),
        gte(auditTrail.createdAt, todayStart),
        lt(auditTrail.createdAt, now),
      ),
    )
    .orderBy(asc(auditTrail.createdAt))

  // Index LLM requests by correlationId
  const llmByCorrelation = new Map<string, typeof llmRequests[0]>()
  for (const req of llmRequests) {
    llmByCorrelation.set(req.correlationId, req)
  }

  // Get all messages for today
  const todayMessages = await db
    .select()
    .from(messages)
    .where(
      and(
        gte(messages.createdAt, todayStart),
        lt(messages.createdAt, now),
      ),
    )
    .orderBy(asc(messages.createdAt))

  // Build interaction records by matching audit entries with message text
  const records: InteractionRecord[] = []

  for (const exchange of exchanges) {
    const meta = exchange.metadata as Record<string, unknown> | null
    const channelId = (meta?.channelId as string) ?? ''
    const userId = exchange.userId ?? ''

    // Find the closest user message within 60s window (not just first match)
    const exchangeTime = exchange.createdAt.getTime()
    const userMsg = todayMessages
      .filter((m) =>
        m.userId === userId &&
        m.channelId === channelId &&
        m.role === 'user' &&
        Math.abs(m.createdAt.getTime() - exchangeTime) < 60_000,
      )
      .sort((a, b) =>
        Math.abs(a.createdAt.getTime() - exchangeTime) -
        Math.abs(b.createdAt.getTime() - exchangeTime),
      )[0]

    // Find the assistant response (wider window to account for slow LLM responses)
    const assistantMsg = todayMessages.find((m) =>
      m.channelId === channelId &&
      m.role === 'assistant' &&
      m.createdAt.getTime() >= exchangeTime - 5_000 &&
      m.createdAt.getTime() <= exchangeTime + SLOW_RESPONSE_MS,
    )

    // Get LLM metrics from the paired llm_request entry
    const llmReq = llmByCorrelation.get(exchange.correlationId)
    const llmMeta = llmReq?.metadata as Record<string, unknown> | null

    // Calculate response time: time between user message and assistant message
    let responseTimeMs = 0
    if (userMsg && assistantMsg) {
      responseTimeMs = assistantMsg.createdAt.getTime() - userMsg.createdAt.getTime()
    }

    records.push({
      correlationId: exchange.correlationId,
      userId,
      channelId,
      userText: userMsg?.text ?? '[text not found]',
      assistantText: assistantMsg?.text ?? '[text not found]',
      status: exchange.status as 'success' | 'error' | 'timeout',
      errorMessage: exchange.errorMessage ?? undefined,
      skill: (meta?.skill as string) ?? undefined,
      responseTimeMs,
      inputTokens: (llmMeta?.inputTokens as number) ?? undefined,
      outputTokens: (llmMeta?.outputTokens as number) ?? undefined,
      costUsd: (llmMeta?.costUsd as number) ?? undefined,
      createdAt: exchange.createdAt,
    })
  }

  // Also collect failed LLM requests that have NO matching exchange (= crash before response)
  // Exclude system/scheduled jobs (digest, pre-meeting, self-improve) — they have no Telegram context
  // and their failures are not actionable by self-improvement analysis.
  const SYSTEM_CORRELATION_PREFIXES = ['digest-', 'pre-meeting-', 'self-improve-']
  const isSystemCorrelation = (id: string) =>
    id === 'unknown' || SYSTEM_CORRELATION_PREFIXES.some((p) => id.startsWith(p))

  const exchangeCorrelations = new Set(exchanges.map((e) => e.correlationId))
  const failedLlmRequests = llmRequests.filter(
    (r) =>
      r.status === 'error' &&
      !exchangeCorrelations.has(r.correlationId) &&
      !isSystemCorrelation(r.correlationId),
  )

  for (const failed of failedLlmRequests) {
    // Try to find the user message for this failed request
    const failedTime = failed.createdAt.getTime()
    const userMsg = todayMessages.find((m) =>
      m.role === 'user' &&
      Math.abs(m.createdAt.getTime() - failedTime) < 30_000,
    )

    records.push({
      correlationId: failed.correlationId,
      userId: failed.userId ?? '',
      channelId: '',
      userText: userMsg?.text ?? '[text not found]',
      assistantText: '',
      status: 'error',
      errorMessage: failed.errorMessage ?? undefined,
      responseTimeMs: 0,
      createdAt: failed.createdAt,
    })
  }

  logger.info({ count: records.length }, 'Self-improve: collected interactions')
  return records
}

/**
 * Identify problematic cases from collected interactions.
 * Applies multiple heuristic detectors.
 */
export function identifyProblems(interactions: InteractionRecord[]): ProblematicCase[] {
  const cases: ProblematicCase[] = []

  for (let i = 0; i < interactions.length; i++) {
    const interaction = interactions[i]
    const problems: ProblemType[] = []
    let feedbackText: string | undefined

    // 1. Error or timeout
    if (interaction.status === 'error') {
      problems.push('error')
    }
    if (interaction.status === 'timeout' || interaction.errorMessage?.includes('timed out')) {
      problems.push('timeout')
    }

    // 2. Max turns exceeded
    if (interaction.assistantText.includes(MAX_TURNS_MARKER)) {
      problems.push('max_turns_exceeded')
    }

    // 3. Short response (might indicate inability to answer)
    if (
      interaction.assistantText.length > 0 &&
      interaction.assistantText.length < SHORT_RESPONSE_THRESHOLD &&
      interaction.status === 'success'
    ) {
      problems.push('short_response')
    }

    // 4. Slow response (>2 min)
    if (interaction.responseTimeMs > SLOW_RESPONSE_MS && interaction.status === 'success') {
      problems.push('slow_response')
    }

    // 5. Negative feedback — check if next message from same user looks like correction
    //    Require short follow-up (<100 chars) + keyword to reduce false positives
    if (i + 1 < interactions.length) {
      const next = interactions[i + 1]
      if (
        next.userId === interaction.userId &&
        next.createdAt.getTime() - interaction.createdAt.getTime() < 3 * 60_000 &&
        next.userText.length < 100
      ) {
        const nextLower = next.userText.toLowerCase()
        const hasNegative = NEGATIVE_KEYWORDS.some((kw) => {
          if (kw.length <= 3) {
            return new RegExp(`\\b${kw}\\b`, 'i').test(nextLower)
          }
          return nextLower.includes(kw)
        })
        if (hasNegative) {
          problems.push('negative_feedback')
          feedbackText = next.userText
        }
      }
    }

    if (problems.length > 0) {
      cases.push({ interaction, problems, feedbackText })
    }
  }

  logger.info(
    { total: interactions.length, problematic: cases.length },
    'Self-improve: problem detection complete',
  )

  return cases
}
