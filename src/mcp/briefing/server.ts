import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import type { Source, QueryType, FieldName, BriefingRequest, BriefingItem, BriefingResult } from './types.js'
import { log, filterFields } from './utils.js'
import { parsePeriod } from './period.js'
import { resolveGoogleTokens } from './google-auth.js'
import { fetchSlack, fetchSlackThread, getSlackThreadTool } from './slack.js'
import { fetchGmail, fetchEmailContent, getEmailContentTool } from './gmail.js'
import { fetchCalendar } from './calendar.js'
import { fetchClickUp } from './clickup.js'
import { executeClockifyReport, clockifyReportTool, type ClockifyReportType } from './clockify.js'
import { executeAuditTasks, auditTasksTool } from './audit.js'
import { kbSearchTool, kbEntitiesTool, kbRegistryTool, vaultUpdateTool, handleKBSearch, handleKBEntities, handleKBRegistry, handleVaultUpdate } from '../../kb/mcp-tools.js'

// ── Main briefing logic ──

async function executeBriefing(req: BriefingRequest): Promise<BriefingResult> {
  const startTime = Date.now()
  const period = parsePeriod(req.period)

  // Pre-resolve Google tokens once if any Google source is requested
  const needsGoogle = req.sources.some(s => s === 'gmail' || s === 'calendar')
  const googleTokens = needsGoogle ? await resolveGoogleTokens() : new Map<string, string>()

  const sourceFetchers: Record<Source, () => Promise<BriefingItem[]>> = {
    slack: () => fetchSlack(req, period),
    gmail: () => fetchGmail(req, period, googleTokens),
    calendar: () => fetchCalendar(req, period, googleTokens),
    clickup: () => fetchClickUp(req, period),
  }

  // Fan out to all requested sources in parallel
  const entries = await Promise.allSettled(
    req.sources.map(async (src) => {
      const fetcher = sourceFetchers[src]
      if (!fetcher) throw new Error(`Unknown source: ${src}`)
      const items = await fetcher()
      // Apply field filtering
      const filtered = items.map(item => filterFields(item, req.fields) as BriefingItem)
      return { source: src, items: filtered }
    }),
  )

  const results: Record<string, BriefingItem[] | { error: string }> = {}
  const sourcesOk: Source[] = []
  const sourcesFailed: Source[] = []
  let totalItems = 0

  for (let i = 0; i < req.sources.length; i++) {
    const src = req.sources[i]
    const entry = entries[i]
    if (entry.status === 'fulfilled') {
      results[src] = entry.value.items
      sourcesOk.push(src)
      totalItems += entry.value.items.length
    } else {
      const errMsg = entry.reason instanceof Error ? entry.reason.message : String(entry.reason)
      results[src] = { error: errMsg }
      sourcesFailed.push(src)
      log(`source=${src} FAILED: ${errMsg}`)
    }
  }

  return {
    query: req,
    results: results as Record<Source, BriefingItem[] | { error: string }>,
    meta: {
      sources_queried: req.sources,
      sources_ok: sourcesOk,
      sources_failed: sourcesFailed,
      total_items: totalItems,
      query_time_ms: Date.now() - startTime,
    },
  }
}

// ── Tool definitions ──

const briefingTool = {
  name: 'briefing',
  description: `Aggregated multi-source query. Fetches data from multiple services (Slack, Gmail, Calendar, ClickUp) in a single call. Use this instead of making separate tool calls to each service.

Returns results grouped by source with only the requested fields. Failed sources return an error message (not a crash).

query_type options:
- "recent" — latest items from each source (default)
- "unread" — unread emails + recent Slack messages
- "search" — search by keyword across all sources (requires search_term)
- "digest" — summary of activity in a period

period options: "today", "yesterday", "last_3_days", "last_week", "last_month", or ISO range "2026-01-01/2026-01-20"`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      sources: {
        type: 'array' as const,
        items: { type: 'string' as const, enum: ['slack', 'gmail', 'calendar', 'clickup'] },
        description: 'Which sources to query. Example: ["slack", "gmail", "calendar"]',
      },
      query_type: {
        type: 'string' as const,
        enum: ['recent', 'digest', 'search', 'unread'],
        description: 'Type of query',
        default: 'recent',
      },
      period: {
        type: 'string' as const,
        description: 'Time period: "today", "last_week", "last_3_days", "last_month", or ISO range "2026-01-01/2026-01-20"',
        default: 'today',
      },
      search_term: {
        type: 'string' as const,
        description: 'Search keyword (required when query_type is "search")',
      },
      slack_channels: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Specific Slack channels to query (by name). If omitted, queries top 5 active channels.',
      },
      clickup_list_names: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Specific ClickUp lists/projects to query (fuzzy-matched by name against list, folder, or space names). Example: ["Ohbibi Creatives"]',
      },
      include_closed: {
        type: 'boolean' as const,
        description: 'Include closed/completed tasks in ClickUp results (default: false). Set to true when checking task completion status.',
        default: false,
      },
      limit_per_source: {
        type: 'number' as const,
        description: 'Max items per source (default 10)',
        default: 10,
      },
      fields: {
        type: 'array' as const,
        items: {
          type: 'string' as const,
          enum: ['author', 'date', 'text', 'text_preview', 'subject', 'links', 'thread_info', 'status', 'assignee', 'due_date', 'channel', 'account', 'list'],
        },
        description: 'Which fields to include in results. Omit for all fields.',
      },
    },
    required: ['sources'],
  },
}

const searchEverywhereTool = {
  name: 'search_everywhere',
  description: `Search a keyword across all available sources (Slack, Gmail, Calendar, ClickUp) in parallel. Shortcut for briefing with query_type="search". Returns matching items grouped by source with text preview.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      search_term: {
        type: 'string' as const,
        description: 'Keyword or phrase to search for',
      },
      period: {
        type: 'string' as const,
        description: 'Time period to search within (default: "last_month")',
        default: 'last_month',
      },
      limit_per_source: {
        type: 'number' as const,
        description: 'Max results per source (default 5)',
        default: 5,
      },
    },
    required: ['search_term'],
  },
}

// ── Server ──

export async function main(): Promise<void> {
  log('\n--- astra-briefing starting ---')

  // KB tools now use the facade (kb-facade.ts) which manages its own connections
  log('KB: using facade (KB_BACKEND=' + (process.env.KB_BACKEND ?? 'legacy') + ')')

  const server = new Server(
    { name: 'Astra Briefing Server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [briefingTool, searchEverywhereTool, clockifyReportTool, getSlackThreadTool, getEmailContentTool, kbSearchTool, kbEntitiesTool, kbRegistryTool, vaultUpdateTool, auditTasksTool],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    log(`tool=${toolName} args=${JSON.stringify(args)}`)

    try {
      let result: BriefingResult
      const VALID_SOURCES: ReadonlySet<string> = new Set(['slack', 'gmail', 'calendar', 'clickup'])

      if (toolName === 'briefing') {
        const rawSources = (args.sources as string[]) ?? ['slack', 'gmail', 'calendar']
        const invalid = rawSources.filter(s => !VALID_SOURCES.has(s))
        if (invalid.length > 0) throw new Error(`Invalid sources: ${invalid.join(', ')}. Valid: slack, gmail, calendar, clickup`)

        const rawLimit = (args.limit_per_source as number) ?? 10
        result = await executeBriefing({
          sources: rawSources as Source[],
          query_type: (args.query_type as QueryType) ?? 'recent',
          period: (args.period as string) ?? 'today',
          search_term: args.search_term as string | undefined,
          slack_channels: args.slack_channels as string[] | undefined,
          clickup_list_names: args.clickup_list_names as string[] | undefined,
          include_closed: (args.include_closed as boolean) ?? false,
          limit_per_source: Math.max(1, Math.min(rawLimit, 200)),
          fields: args.fields as FieldName[] | undefined,
        })
      } else if (toolName === 'search_everywhere') {
        if (!args.search_term) throw new Error('search_term is required')
        const searchLimit = Math.max(1, Math.min((args.limit_per_source as number) ?? 5, 200))
        result = await executeBriefing({
          sources: ['slack', 'gmail', 'calendar', 'clickup'],
          query_type: 'search',
          period: (args.period as string) ?? 'last_month',
          search_term: args.search_term as string,
          limit_per_source: searchLimit,
          fields: ['author', 'date', 'subject', 'text_preview', 'channel', 'status', 'links', 'account', 'list'],
        })
      } else if (toolName === 'clockify_report') {
        const VALID_REPORT_TYPES: ReadonlySet<string> = new Set(['summary', 'who_tracked', 'who_missing'])
        const reportType = args.report_type as string
        if (!reportType || !VALID_REPORT_TYPES.has(reportType)) {
          throw new Error(`Invalid report_type: "${reportType ?? ''}". Valid: summary, who_tracked, who_missing`)
        }
        const clockifyResult = await executeClockifyReport({
          report_type: reportType as ClockifyReportType,
          period: (args.period as string) ?? 'this_month',
          group_by: (args.group_by as 'user' | 'project') ?? 'user',
          project_name: args.project_name as string | undefined,
          user_name: args.user_name as string | undefined,
        })
        const text = JSON.stringify(clockifyResult, null, 0)
        log(`tool=${toolName} type=${reportType} items=${clockifyResult.data.length} time=${clockifyResult.meta.query_time_ms}ms`)
        return { content: [{ type: 'text', text }] }
      } else if (toolName === 'get_slack_thread') {
        if (!args.channel_name) throw new Error('channel_name is required')
        if (!args.thread_ts) throw new Error('thread_ts is required')
        const threadResult = await fetchSlackThread(
          args.channel_name as string,
          args.thread_ts as string,
          Math.max(1, Math.min((args.limit as number) ?? 20, 100)),
        )
        const text = JSON.stringify(threadResult, null, 0)
        log(`tool=${toolName} channel=${threadResult.channel} messages=${threadResult.messages.length}`)
        return { content: [{ type: 'text', text }] }
      } else if (toolName === 'get_email_content') {
        if (!args.message_id) throw new Error('message_id is required')
        const emailResult = await fetchEmailContent(
          args.message_id as string,
          args.account as string | undefined,
        )
        const text = JSON.stringify(emailResult, null, 0)
        log(`tool=${toolName} id=${emailResult.id} account=${emailResult.account}`)
        return { content: [{ type: 'text', text }] }
      } else if (toolName === 'kb_search') {
        const text = await handleKBSearch(args)
        log(`tool=${toolName} done`)
        return { content: [{ type: 'text', text }] }
      } else if (toolName === 'kb_entities') {
        const text = await handleKBEntities(args)
        log(`tool=${toolName} done`)
        return { content: [{ type: 'text', text }] }
      } else if (toolName === 'kb_registry') {
        const text = handleKBRegistry(args)
        log(`tool=${toolName} done len=${text.length}`)
        return { content: [{ type: 'text', text }] }
      } else if (toolName === 'vault_update') {
        const text = handleVaultUpdate(args)
        log(`tool=${toolName} action=${args.action} done`)
        return { content: [{ type: 'text', text }] }
      } else if (toolName === 'audit_tasks') {
        if (!args.list_name) throw new Error('list_name is required')
        const auditResult = await executeAuditTasks(
          args.list_name as string,
          (args.include_closed as boolean) ?? true,
        )
        const text = JSON.stringify(auditResult, null, 0)
        log(`tool=${toolName} list=${auditResult.list} total=${auditResult.total_tasks} issues=${auditResult.tasks_with_issues}`)
        return { content: [{ type: 'text', text }] }
      } else {
        throw new Error(`Unknown tool: ${toolName}`)
      }

      const text = JSON.stringify(result, null, 0)
      log(`tool=${toolName} ok sources_ok=${result.meta.sources_ok} failed=${result.meta.sources_failed} items=${result.meta.total_items} size=${text.length} time=${result.meta.query_time_ms}ms`)
      return { content: [{ type: 'text', text }] }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      log(`tool=${toolName} EXCEPTION: ${errMsg}`)
      return { content: [{ type: 'text', text: JSON.stringify({ error: errMsg }) }] }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  log('server connected via stdio')
}
