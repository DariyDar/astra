/**
 * Investigation Orchestrator — runs parallel subagents for deep research queries.
 *
 * Instead of one Claude process doing everything sequentially, this launches
 * 3 focused subagents in parallel (Slack, KB, Web), then a synthesizer
 * merges the results into a unified response.
 */

import type pino from 'pino'
import type { Language } from './language.js'
import { callClaude } from '../llm/client.js'
import type { ClaudeResponse, UsageMetrics } from '../llm/client.js'
import { writeAuditEntry } from '../logging/audit.js'
import { logger } from '../logging/logger.js'

const SUBAGENT_TIMEOUT_MS = 120_000
const SYNTHESIZER_TIMEOUT_MS = 60_000

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

interface SubagentResults {
  slack: string | null
  kb: string | null
  web: string | null
}

/**
 * Run a parallel investigation with 3 subagents + synthesizer.
 * Falls back gracefully if subagents fail.
 */
export async function runInvestigation(
  query: string,
  opts: InvestigationOpts,
  requestLogger?: pino.Logger,
): Promise<ClaudeResponse> {
  const log = requestLogger ?? logger
  const startTime = Date.now()

  log.info({ queryLength: query.length }, 'Starting investigation with subagents')

  // Phase 1: Run 3 subagents in parallel
  const subagentResults = await runSubagents(query, opts, log)

  const successCount = Object.values(subagentResults).filter(Boolean).length
  log.info({ successCount }, 'Subagents completed')

  // Phase 2: Synthesize results
  if (successCount === 0) {
    return {
      text: opts.language === 'ru'
        ? 'Не удалось найти информацию ни в одном из источников. Попробуй переформулировать запрос или уточнить, где именно искать.'
        : 'Could not find information in any source. Try rephrasing or specifying where to look.',
      model: 'sonnet',
    }
  }

  const response = await synthesize(query, subagentResults, opts.language, log)

  const durationMs = Date.now() - startTime
  log.info({ durationMs, successCount }, 'Investigation completed')

  const correlationId = (log.bindings() as { correlationId?: string }).correlationId ?? 'unknown'
  await writeAuditEntry({
    correlationId,
    action: 'investigation',
    model: 'sonnet',
    metadata: {
      durationMs,
      subagentResults: {
        slack: subagentResults.slack !== null,
        kb: subagentResults.kb !== null,
        web: subagentResults.web !== null,
      },
      responseLength: response.text.length,
      ...(response.usage ?? {}),
    },
    status: 'success',
  })

  return response
}

async function runSubagents(
  query: string,
  opts: InvestigationOpts,
  log: pino.Logger,
): Promise<SubagentResults> {
  const { mcpConfigPath, knowledgeMap } = opts

  const slackPrompt = buildSlackAgentPrompt(query, knowledgeMap)
  const kbPrompt = buildKBAgentPrompt(query, knowledgeMap)
  const webPrompt = buildWebAgentPrompt(query)

  const [slackResult, kbResult, webResult] = await Promise.allSettled([
    callClaude(slackPrompt.prompt, {
      system: slackPrompt.system,
      mcpConfigPath,
      timeoutMs: SUBAGENT_TIMEOUT_MS,
    }, log),
    callClaude(kbPrompt.prompt, {
      system: kbPrompt.system,
      mcpConfigPath,
      timeoutMs: SUBAGENT_TIMEOUT_MS,
    }, log),
    callClaude(webPrompt.prompt, {
      system: webPrompt.system,
      mcpConfigPath,
      timeoutMs: SUBAGENT_TIMEOUT_MS,
    }, log),
  ])

  const extract = (r: PromiseSettledResult<ClaudeResponse>, name: string): string | null => {
    if (r.status === 'fulfilled' && r.value.text.length > 10) {
      log.debug({ agent: name, length: r.value.text.length }, 'Subagent succeeded')
      return r.value.text
    }
    if (r.status === 'rejected') {
      log.warn({ agent: name, error: (r.reason as Error).message }, 'Subagent failed')
    }
    return null
  }

  return {
    slack: extract(slackResult, 'slack'),
    kb: extract(kbResult, 'kb'),
    web: extract(webResult, 'web'),
  }
}

async function synthesize(
  query: string,
  results: SubagentResults,
  language: Language,
  log: pino.Logger,
): Promise<ClaudeResponse> {
  const langLabel = LANGUAGE_LABELS[language]
  const sections: string[] = []

  if (results.slack) {
    sections.push(`## Live Slack data (real-time)\n${results.slack}`)
  }
  if (results.kb) {
    sections.push(`## Knowledge Base (historical indexed data)\n${results.kb}`)
  }
  if (results.web) {
    sections.push(`## External sources (web search)\n${results.web}`)
  }

  const synthSystem = `You are a synthesis specialist. Your job is to combine research findings from multiple sources into a clear, structured answer.

Rules:
- Respond in ${langLabel}
- Merge duplicate information — don't repeat the same fact from different sources
- Prioritize internal data (Slack, KB) over external web results
- If sources contradict each other, note the discrepancy
- Use structured format: sections, bullet points, bold for key facts
- Include timestamps and source references where available
- End with actionable recommendations if appropriate
- Keep formatting compatible with Telegram (Markdown bold, italic, lists)
- Do NOT use # headers — use **bold text** for section labels`

  const synthPrompt = `Original question: ${query}

Research findings from 3 parallel agents:

${sections.join('\n\n---\n\n')}

Synthesize these into a single comprehensive answer.`

  try {
    return await callClaude(synthPrompt, {
      system: synthSystem,
      timeoutMs: SYNTHESIZER_TIMEOUT_MS,
    }, log)
  } catch (error) {
    log.warn({ error: (error as Error).message }, 'Synthesizer failed, returning raw results')
    // Fallback: concatenate raw results
    return {
      text: sections.join('\n\n---\n\n'),
      model: 'sonnet',
    }
  }
}

// ─── Subagent Prompt Builders ───

function buildSlackAgentPrompt(query: string, knowledgeMap: string): { system: string; prompt: string } {
  return {
    system: `You are a Slack research specialist. Your ONLY job is to search live Slack channels for relevant information.

${knowledgeMap}

Tools available:
- **briefing(sources=["slack"], query_type="search", query="...", slack_channels=[...])** — search live Slack messages
- **get_slack_thread(channel_name, thread_ts)** — drill into a specific thread for details

Strategy:
1. Identify relevant channels from the Project Quick Reference above
2. Search with briefing() using the most relevant channels
3. Try both Russian AND English keywords if first search is sparse
4. If you find a thread reference, use get_slack_thread() to get full context
5. Max 4 tool calls

Output format:
- List each finding with: channel name, who said it, when, what they said
- Include thread timestamps for drill-down
- Do NOT synthesize or give recommendations — just report raw findings`,
    prompt: `Search Slack for: ${query}`,
  }
}

function buildKBAgentPrompt(query: string, knowledgeMap: string): { system: string; prompt: string } {
  return {
    system: `You are a knowledge base research specialist. Your ONLY job is to search historical indexed data.

${knowledgeMap}

Tools available:
- **kb_search(query, source?, person?, project?, period?, limit?)** — semantic + keyword search across indexed Slack, Gmail, Drive, Notion data
- **kb_entities(name?, type?)** — entity graph lookup (people, projects, relations)
- **kb_registry(project?, section?)** — org registry with team, channels, docs, status

Strategy:
1. Search kb_search() with relevant keywords
2. Try variations: different keywords, English AND Russian terms
3. If a specific person or project is mentioned, filter by them
4. Use kb_entities() if you need to identify people or projects
5. Max 4 tool calls

Output format:
- List each finding with: source (Slack/Gmail/Drive/Notion), date, content summary
- Include document URLs where available
- Do NOT synthesize or give recommendations — just report raw findings`,
    prompt: `Search knowledge base for: ${query}`,
  }
}

function buildWebAgentPrompt(query: string): { system: string; prompt: string } {
  return {
    system: `You are an external research specialist. Your ONLY job is to find relevant public information about the topic.

Strategy:
1. Search for the specific topic: bug reports, user reviews, community discussions, documentation
2. Try both the product/game name and specific issue keywords
3. Check: forums, Reddit, Fandom wikis, app store reviews, community sites
4. Max 3 searches

Output format:
- List each finding with: source URL, date (if available), key information
- Distinguish between confirmed bugs, user complaints, and general discussions
- Do NOT synthesize or give recommendations — just report raw findings`,
    prompt: `Search the web for: ${query}`,
  }
}
