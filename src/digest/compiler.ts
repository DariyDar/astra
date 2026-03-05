/**
 * Core digest compiler — "Краткое содержание предыдущих серий".
 * Fetches YESTERDAY's data from all sources + KB context,
 * sends to Gemini LLM to produce a formatted Telegram HTML digest.
 *
 * Reliability: each source is fetched with retry + exponential backoff.
 * Critical sources (Slack, Gmail, Calendar, ClickUp) must all succeed —
 * if any critical source fails after all retries, the digest is NOT compiled.
 */

import { db } from '../db/index.js'
import { callGemini } from '../llm/gemini.js'
import { logger } from '../logging/logger.js'
import { resolveGoogleTokens } from '../mcp/briefing/google-auth.js'
import { fetchSlack } from '../mcp/briefing/slack.js'
import { fetchGmail } from '../mcp/briefing/gmail.js'
import { fetchCalendar } from '../mcp/briefing/calendar.js'
import { fetchClickUp } from '../mcp/briefing/clickup.js'
import { parsePeriod } from '../mcp/briefing/period.js'
import { findEntitiesByType, getFactsForEntity } from '../kb/repository.js'
import { fetchMyTasks } from './my-tasks.js'
import { DIGEST_SYSTEM_PROMPT, buildDigestUserPrompt } from './prompt.js'
import type { BriefingRequest, BriefingItem } from '../mcp/briefing/types.js'

type Company = 'astrocat' | 'highground'

const COMPANY_LABELS: Record<Company, string> = {
  astrocat: 'AstroCat',
  highground: 'Highground',
}

const SLACK_WORKSPACE_MAP: Record<Company, string> = {
  astrocat: 'ac',
  highground: 'hg',
}

/** Retry config for source fetching. */
const RETRY_MAX_ATTEMPTS = 5
const RETRY_INITIAL_DELAY_MS = 5_000
const RETRY_MAX_DELAY_MS = 60_000

/** Max projects to include KB context for (limits LLM prompt size). */
const MAX_KB_PROJECTS = 15

/** Format date in Russian for the digest header. */
function formatDateRu(date: Date): string {
  const months = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ]
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`
}

/** Sources that MUST succeed for a complete digest. */
const CRITICAL_SOURCES = ['slack', 'gmail', 'calendar', 'clickup'] as const

interface SourceResult<T> {
  name: string
  data: T | null
  error: string | null
}

/**
 * Compile a daily digest for a specific company.
 * Fetches YESTERDAY's data with retry, validates completeness, sends to LLM.
 * Throws if any critical source fails after all retries.
 */
export async function compileDigest(company: Company): Promise<string> {
  const now = new Date()
  const dateStr = formatDateRu(now)
  const companyLabel = COMPANY_LABELS[company]
  const wsLabel = SLACK_WORKSPACE_MAP[company]

  const yesterdayPeriod = parsePeriod('yesterday')

  // Pre-resolve Google tokens (retry-wrapped — needed by gmail + calendar)
  const googleTokens = await fetchWithRetry('google-auth', () => resolveGoogleTokens())

  // Fetch all sources in parallel — each with its own retry logic
  const [slackResult, gmailResult, calResult, clickupResult, myTasksResult, kbResult] =
    await Promise.allSettled([
      fetchWithRetry('slack', () => fetchSlackForCompany(yesterdayPeriod, wsLabel)),
      fetchWithRetry('gmail', () => fetchGmail(buildBriefingReq('yesterday', 50), yesterdayPeriod, googleTokens)),
      fetchWithRetry('calendar', () => fetchCalendar(buildBriefingReq('yesterday', 50), yesterdayPeriod, googleTokens)),
      fetchWithRetry('clickup', () => fetchClickUp(buildBriefingReq('yesterday', 50), yesterdayPeriod)),
      fetchWithRetry('my-tasks', () => fetchMyTasks()),
      fetchWithRetry('kb', () => fetchKBContext(wsLabel)),
    ])

  // Collect results and check for critical failures
  const results: SourceResult<unknown>[] = [
    { name: 'slack', ...settledToResult(slackResult) },
    { name: 'gmail', ...settledToResult(gmailResult) },
    { name: 'calendar', ...settledToResult(calResult) },
    { name: 'clickup', ...settledToResult(clickupResult) },
    { name: 'my-tasks', ...settledToResult(myTasksResult) },
    { name: 'kb', ...settledToResult(kbResult) },
  ]

  // Validate completeness — all critical sources must succeed
  const failedCritical = results.filter(
    (r) => r.error !== null && (CRITICAL_SOURCES as readonly string[]).includes(r.name),
  )
  if (failedCritical.length > 0) {
    const names = failedCritical.map((r) => `${r.name}: ${r.error}`).join('; ')
    throw new Error(`Critical sources failed for ${company} digest: ${names}`)
  }

  const slackData = (slackResult.status === 'fulfilled' ? slackResult.value : []) as BriefingItem[]
  const gmailData = (gmailResult.status === 'fulfilled' ? gmailResult.value : []) as BriefingItem[]
  const calendarYesterday = (calResult.status === 'fulfilled' ? calResult.value : []) as BriefingItem[]
  const clickupData = (clickupResult.status === 'fulfilled' ? clickupResult.value : []) as BriefingItem[]
  const myTasks = (myTasksResult.status === 'fulfilled' ? myTasksResult.value : []) as Array<{ subject: string; status: string; due_date: string; list: string; url: string; is_overdue: boolean }>
  const kbContext = (kbResult.status === 'fulfilled' ? kbResult.value : []) as Array<{ project: string; facts: string[] }>

  // Log non-critical failures as warnings
  const failedNonCritical = results.filter(
    (r) => r.error !== null && !(CRITICAL_SOURCES as readonly string[]).includes(r.name),
  )
  for (const f of failedNonCritical) {
    logger.warn({ source: f.name, error: f.error }, 'Digest: non-critical source failed, using empty fallback')
  }

  logger.info({
    company,
    slack: slackData.length,
    gmail: gmailData.length,
    calendar: calendarYesterday.length,
    clickup: clickupData.length,
    myTasks: myTasks.length,
    kbProjects: kbContext.length,
  }, 'Digest: all data fetched successfully')

  // Build LLM prompt
  const userPrompt = buildDigestUserPrompt({
    company: companyLabel,
    date: dateStr,
    slackData,
    gmailData,
    calendarYesterday,
    clickupData,
    myTasks,
    kbContext,
  })

  // Call Gemini to compile the digest
  // Note: callGemini already has its own internal retry logic (5 attempts with backoff).
  // The outer compileWithRetry in scheduler.ts provides additional full-compilation retries.
  const response = await callGemini(userPrompt, {
    systemInstruction: DIGEST_SYSTEM_PROMPT,
    maxOutputTokens: 4096,
    timeoutMs: 60_000,
  })

  if (!response.text || response.text.trim().length === 0) {
    throw new Error(`Gemini returned empty response for ${company} digest`)
  }

  logger.info({
    company,
    outputLen: response.text.length,
    usage: response.usage,
  }, 'Digest: LLM compilation done')

  return response.text
}

/** Fetch Slack data filtered to a specific workspace. */
async function fetchSlackForCompany(
  period: { after: Date; before: Date },
  wsLabel: string,
): Promise<BriefingItem[]> {
  const req = buildBriefingReq('yesterday', 100)
  const items = await fetchSlack(req, period)
  return items.filter((item) => {
    const channel = item.channel as string | undefined
    return channel?.startsWith(`${wsLabel}/`)
  })
}

/** Fetch KB facts for projects belonging to a company. */
async function fetchKBContext(companyCode: string): Promise<Array<{ project: string; facts: string[] }>> {
  const projects = await findEntitiesByType(db, 'project')
  const companyProjects = projects.filter((p) => {
    if (!p.company) return false
    return p.company.toLowerCase() === companyCode.toLowerCase()
  })

  // Fetch facts in parallel to avoid N+1
  // No date filter — get the most recent facts regardless of age (extraction is still catching up)
  const results = await Promise.all(
    companyProjects.slice(0, MAX_KB_PROJECTS).map(async (project) => {
      const facts = await getFactsForEntity(db, project.id, {
        limit: 5,
      })
      return facts.length > 0
        ? { project: project.name, facts: facts.map((f) => f.text) }
        : null
    }),
  )

  return results.filter((r): r is NonNullable<typeof r> => r !== null)
}

/** Build a minimal BriefingRequest for the fetchers. */
function buildBriefingReq(period: string, limit: number): BriefingRequest {
  return {
    sources: ['slack', 'gmail', 'calendar', 'clickup'],
    query_type: 'digest',
    period,
    limit_per_source: limit,
  }
}

/**
 * Fetch with retry and exponential backoff.
 * Retries up to RETRY_MAX_ATTEMPTS times with increasing delays.
 */
async function fetchWithRetry<T>(name: string, fn: () => Promise<T>): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < RETRY_MAX_ATTEMPTS) {
        const delay = Math.min(
          RETRY_INITIAL_DELAY_MS * Math.pow(2, attempt - 1),
          RETRY_MAX_DELAY_MS,
        )
        logger.warn(
          { source: name, attempt, maxAttempts: RETRY_MAX_ATTEMPTS, delay, error: lastError.message },
          'Digest: source fetch failed, retrying',
        )
        await sleep(delay)
      }
    }
  }

  logger.error(
    { source: name, attempts: RETRY_MAX_ATTEMPTS, error: lastError?.message },
    'Digest: source fetch failed after all retries',
  )
  throw lastError!
}

/** Convert PromiseSettledResult to data/error pair. */
function settledToResult<T>(result: PromiseSettledResult<T>): { data: T | null; error: string | null } {
  if (result.status === 'fulfilled') {
    return { data: result.value, error: null }
  }
  const msg = result.reason instanceof Error ? result.reason.message : String(result.reason)
  return { data: null, error: msg }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
