/**
 * Investigation Orchestrator — two-phase architecture for deep research queries.
 *
 * Phase 1 (planning): Claude determines what data to collect (1 LLM turn).
 * Data collection: tools fetch Slack/KB/ClickUp/Drive data without LLM.
 * Phase 2 (analysis): Claude analyzes collected data (1 LLM turn).
 * Optional: Web search still uses MCP (external APIs can't be pre-fetched).
 *
 * Total: 2-4 LLM turns instead of 60-90+ with full MCP.
 */

import type pino from 'pino'
import type { Language } from './language.js'
import { callClaude } from '../llm/client.js'
import type { ClaudeResponse } from '../llm/client.js'
import { writeAuditEntry } from '../logging/audit.js'
import { logger } from '../logging/logger.js'
import { loadPromptCached } from '../kb/vault-loader.js'
import { executeToolPlan, TOOL_CATALOG, type ToolPlan } from '../tools/executor.js'

const PLANNING_TIMEOUT_MS = 30_000
const ANALYSIS_TIMEOUT_MS = 60_000
const WEB_SEARCH_TIMEOUT_MS = 60_000

const LANGUAGE_LABELS: Record<Language, string> = {
  ru: 'Russian',
  en: 'English',
}

interface InvestigationOpts {
  mcpConfigPath: string
  knowledgeMap: string
  language: Language
  channelId: string
  recentContext?: string
}

/**
 * Run a two-phase investigation:
 * 1. Claude plans what tools to run (1 turn)
 * 2. Tools collect data without LLM
 * 3. Optionally: web search via MCP (limited turns)
 * 4. Claude analyzes all collected data (1 turn)
 */
export async function runInvestigation(
  query: string,
  opts: InvestigationOpts,
  requestLogger?: pino.Logger,
): Promise<ClaudeResponse> {
  const log = requestLogger ?? logger
  const startTime = Date.now()

  log.info({ queryLength: query.length }, 'Starting two-phase investigation')

  // ── Phase 1: Planning ──
  const planningSystem = `Ты помощник, который определяет какие данные нужно собрать для ответа на вопрос.

${opts.knowledgeMap}

${TOOL_CATALOG}

Ответь ТОЛЬКО JSON с планом вызовов. Не отвечай на вопрос пользователя — только план сбора данных.`

  let plan: ToolPlan
  try {
    const planResponse = await callClaude(
      `Вопрос пользователя: ${query}\n\nКакие данные нужно собрать? Ответь JSON.`,
      { system: planningSystem, timeoutMs: PLANNING_TIMEOUT_MS },
      log,
    )

    // Parse JSON from response (may be wrapped in markdown code block)
    const jsonMatch = planResponse.text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      log.warn({ response: planResponse.text.slice(0, 200) }, 'Investigation: failed to parse plan JSON')
      plan = { plan: [] }
    } else {
      plan = JSON.parse(jsonMatch[0]) as ToolPlan
    }
  } catch (error) {
    log.warn({ error: (error as Error).message }, 'Investigation: planning failed')
    plan = { plan: [] }
  }

  log.info({ toolCount: plan.plan.length, tools: plan.plan.map(t => t.tool) }, 'Investigation plan ready')

  // ── Data collection (no LLM) ──
  let collectedData = ''
  if (plan.plan.length > 0) {
    const execution = await executeToolPlan(plan)
    collectedData = execution.results
    log.info({ toolsRun: execution.toolsRun, errors: execution.errors }, 'Tools executed')
  }

  // ── Optional: Web search via MCP (limited turns) ──
  let webData = ''
  const needsWeb = /интернет|web|search|внешн|отзыв|review|reddit|форум|community|баг.*(извест|public)/i.test(query)
  if (needsWeb) {
    try {
      const webSystem = loadPromptCached('instructions-for-llm/agent-investigation-web.md')
      const webResponse = await callClaude(
        `Search the web for: ${query}`,
        {
          system: webSystem,
          mcpConfigPath: opts.mcpConfigPath,
          timeoutMs: WEB_SEARCH_TIMEOUT_MS,
          maxTurns: 6, // limited — 3 searches × 2 turns
        },
        log,
      )
      webData = webResponse.text
    } catch (error) {
      log.warn({ error: (error as Error).message }, 'Web search failed')
    }
  }

  // ── Phase 2: Analysis ──
  const langLabel = LANGUAGE_LABELS[opts.language]
  const synthSystem = loadPromptCached('instructions-for-llm/agent-investigation-synthesizer.md')
    .replace(/\{\{languageLabel\}\}/g, langLabel)

  const sections: string[] = []
  if (collectedData) sections.push(`## Собранные данные (Slack, KB, ClickUp, Drive)\n${collectedData}`)
  if (webData) sections.push(`## Внешние источники (Web)\n${webData}`)

  if (sections.length === 0) {
    return {
      text: opts.language === 'ru'
        ? 'Не удалось найти информацию. Попробуй переформулировать запрос или уточнить, где именно искать.'
        : 'Could not find information. Try rephrasing or specifying where to look.',
      model: 'sonnet',
    }
  }

  let response: ClaudeResponse
  try {
    response = await callClaude(
      `Вопрос: ${query}\n\nРезультаты исследования:\n\n${sections.join('\n\n---\n\n')}\n\nДай подробный ответ на основе собранных данных.`,
      { system: synthSystem, timeoutMs: ANALYSIS_TIMEOUT_MS },
      log,
    )
  } catch (error) {
    log.warn({ error: (error as Error).message }, 'Analysis failed, returning raw results')
    response = { text: sections.join('\n\n---\n\n'), model: 'sonnet' }
  }

  const durationMs = Date.now() - startTime
  log.info({ durationMs, toolsPlanned: plan.plan.length, hadWeb: needsWeb }, 'Investigation completed')

  const correlationId = (log.bindings() as { correlationId?: string }).correlationId ?? 'unknown'
  await writeAuditEntry({
    correlationId,
    action: 'investigation',
    model: 'sonnet',
    metadata: {
      durationMs,
      toolsPlanned: plan.plan.length,
      toolNames: plan.plan.map(t => t.tool),
      hadWebSearch: needsWeb,
      responseLength: response.text.length,
      ...(response.usage ?? {}),
    },
    status: 'success',
  })

  return response
}
