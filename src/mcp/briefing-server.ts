#!/usr/bin/env node
/**
 * Astra Briefing MCP Server — aggregated multi-source queries in a single tool call.
 *
 * Instead of Claude making 4-6 separate MCP tool calls (1 turn each), this server
 * takes a structured query, fans out to all requested sources in parallel, filters
 * results to only the requested fields, and returns a compact JSON response.
 *
 * ## Tools
 *
 * ### `briefing`
 * Flexible constructor: pick sources, query type, period, and which fields to return.
 * One tool call replaces 4-14 turns of raw tool calls.
 *
 * ### `search_everywhere`
 * Search a keyword/phrase across all available sources in parallel.
 * Returns matching items grouped by source with preview text.
 *
 * ## Architecture
 * - stdio transport (spawned by Claude CLI as child process)
 * - Direct REST API calls (no MCP-over-MCP — avoids extra latency)
 * - Google OAuth tokens read from ~/.google_workspace_mcp/credentials/
 * - Slack/ClickUp tokens from environment variables
 * - All sources queried in parallel (Promise.allSettled)
 * - Graceful degradation: failed sources return error message, not crash
 *
 * ## Adding new presets
 * See docs/briefing-system.md for the gap analysis workflow.
 */

import { readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

// ── Logging ──

const LOG_PATH = '/tmp/astra-briefing.log'

function log(msg: string): void {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`)
  } catch { /* ignore */ }
}

// ── Types ──

type Source = 'slack' | 'gmail' | 'calendar' | 'clickup'
type QueryType = 'recent' | 'digest' | 'search' | 'unread'
type FieldName = 'author' | 'date' | 'text' | 'text_preview' | 'subject' | 'links' | 'thread_info' | 'status' | 'assignee' | 'due_date' | 'channel'

interface BriefingRequest {
  sources: Source[]
  query_type: QueryType
  period?: string        // "today", "last_week", "last_3_days", or ISO date range "2026-01-01/2026-01-20"
  search_term?: string   // for query_type "search"
  slack_channels?: string[]  // specific channels (default: all active)
  limit_per_source?: number  // max items per source (default: 10)
  fields?: FieldName[]       // which fields to include (default: all)
}

interface BriefingItem {
  source: Source
  [key: string]: unknown
}

interface BriefingResult {
  query: BriefingRequest
  results: Record<Source, BriefingItem[] | { error: string }>
  meta: {
    sources_queried: Source[]
    sources_ok: Source[]
    sources_failed: Source[]
    total_items: number
    query_time_ms: number
  }
}

// ── Period parsing ──

function parsePeriod(period?: string): { after: Date; before: Date } {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayEnd = new Date(todayStart.getTime() + 86400_000)

  if (!period || period === 'today') {
    return { after: todayStart, before: todayEnd }
  }
  if (period === 'yesterday') {
    const yStart = new Date(todayStart.getTime() - 86400_000)
    return { after: yStart, before: todayStart }
  }
  if (period === 'last_3_days') {
    return { after: new Date(todayStart.getTime() - 3 * 86400_000), before: todayEnd }
  }
  if (period === 'last_week' || period === 'this_week') {
    return { after: new Date(todayStart.getTime() - 7 * 86400_000), before: todayEnd }
  }
  if (period === 'last_month' || period === 'this_month') {
    return { after: new Date(todayStart.getTime() - 30 * 86400_000), before: todayEnd }
  }
  // ISO date range: "2026-01-01/2026-01-20"
  if (period.includes('/')) {
    const [from, to] = period.split('/')
    const after = new Date(from)
    const before = new Date(to)
    if (isNaN(after.getTime()) || isNaN(before.getTime())) {
      throw new Error(`Invalid date range: "${period}". Expected ISO format like "2026-01-01/2026-01-20"`)
    }
    return { after, before }
  }
  // Single date
  const d = new Date(period)
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: "${period}". Use "today", "last_week", or ISO date like "2026-01-01"`)
  }
  return { after: d, before: new Date(d.getTime() + 86400_000) }
}

function toSlackTs(date: Date): string {
  return (date.getTime() / 1000).toFixed(6)
}

function toGmailDate(date: Date): string {
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
}

// ── Field filtering ──

function filterFields(item: Record<string, unknown>, fields?: FieldName[]): Record<string, unknown> {
  if (!fields || fields.length === 0) return item
  const result: Record<string, unknown> = {}
  for (const f of fields) {
    if (f in item) result[f] = item[f]
  }
  // Always include source
  if ('source' in item) result.source = item.source
  return result
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '…'
}

// ── Google Auth ──

interface GoogleTokens {
  token: string
  refresh_token: string
  token_uri: string
  client_id: string
  client_secret: string
  expiry: string
}

function loadGoogleTokens(account: string): GoogleTokens | null {
  try {
    const path = resolve(homedir(), '.google_workspace_mcp', 'credentials', `${account}.json`)
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    if (!data.token) return null
    return data as GoogleTokens
  } catch {
    return null
  }
}

const GOOGLE_ACCOUNT = process.env.GOOGLE_ACCOUNT ?? 'dariy@astrocat.co'
if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(GOOGLE_ACCOUNT)) {
  throw new Error(`Invalid GOOGLE_ACCOUNT format: "${GOOGLE_ACCOUNT}"`)
}

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60_000 // refresh 5 min before actual expiry

async function refreshGoogleToken(tokens: GoogleTokens): Promise<string> {
  // Check if token is still valid (with buffer to avoid mid-request expiry)
  if (new Date(tokens.expiry).getTime() - TOKEN_EXPIRY_BUFFER_MS > Date.now()) {
    return tokens.token
  }

  // Refresh
  const resp = await fetch(tokens.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: tokens.client_id,
      client_secret: tokens.client_secret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10_000),
  })
  const data = await jsonOrThrow<{ access_token?: string; error?: string }>(resp, 'Google token refresh')
  if (!data.access_token) {
    throw new Error(`Google token refresh failed: ${data.error ?? 'no access_token'}`)
  }
  // Update in-memory + persist to disk so subsequent spawns reuse the fresh token
  tokens.token = data.access_token
  tokens.expiry = new Date(Date.now() + 3500_000).toISOString()
  try {
    const credPath = resolve(homedir(), '.google_workspace_mcp', 'credentials', `${GOOGLE_ACCOUNT}.json`)
    const fullData = JSON.parse(readFileSync(credPath, 'utf-8'))
    fullData.token = tokens.token
    fullData.expiry = tokens.expiry
    // Atomic write: temp file + rename to avoid corruption on crash
    const tmpPath = credPath + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(fullData, null, 2), 'utf-8')
    renameSync(tmpPath, credPath)
    log('Google token refreshed and persisted to disk')
  } catch (e) {
    log(`WARN: could not persist refreshed Google token: ${e}`)
  }
  return data.access_token
}

/** Pre-resolve Google access token once (avoids duplicate refresh when both Gmail + Calendar requested). */
async function resolveGoogleToken(): Promise<string | null> {
  const tokens = loadGoogleTokens(GOOGLE_ACCOUNT)
  if (!tokens) return null
  return refreshGoogleToken(tokens)
}

/** Parse JSON from a fetch response, throwing a clear error on non-OK status. */
async function jsonOrThrow<T>(resp: Response, label: string): Promise<T> {
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`${label} HTTP ${resp.status}: ${body.slice(0, 200)}`)
  }
  return resp.json() as Promise<T>
}

// ── Source fetchers ──

async function fetchSlack(
  req: BriefingRequest,
  period: { after: Date; before: Date },
): Promise<BriefingItem[]> {
  const token = process.env.SLACK_USER_TOKEN ?? process.env.SLACK_BOT_TOKEN
  const teamId = process.env.SLACK_TEAM_ID
  if (!token || !teamId) throw new Error('Slack not configured')

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  // Determine which channels to query
  let channelIds: { id: string; name: string }[] = []

  if (req.slack_channels && req.slack_channels.length > 0) {
    // Resolve names to IDs
    const allChannels = await fetchSlackChannels(headers, teamId)
    for (const ch of req.slack_channels) {
      const found = allChannels.find(c =>
        c.name.toLowerCase() === ch.toLowerCase().replace(/^#/, '') || c.id === ch,
      )
      if (found) channelIds.push(found)
    }
  } else {
    // For "recent" / "unread" without specific channels, get top active channels
    const allChannels = await fetchSlackChannels(headers, teamId)
    // Sort by member count (proxy for activity), take top 5
    channelIds = allChannels
      .sort((a, b) => (b.num_members ?? 0) - (a.num_members ?? 0))
      .slice(0, 5)
  }

  if (channelIds.length === 0) return []

  const limit = req.limit_per_source ?? 10
  const perChannel = Math.max(3, Math.ceil(limit / channelIds.length))

  // Fetch messages from all channels in parallel
  const results = await Promise.allSettled(
    channelIds.map(async (ch) => {
      const params = new URLSearchParams({
        channel: ch.id,
        limit: String(perChannel),
        oldest: toSlackTs(period.after),
        latest: toSlackTs(period.before),
      })
      const resp = await fetch(`https://slack.com/api/conversations.history?${params}`, { headers, signal: AbortSignal.timeout(15_000) })
      if (!resp.ok) throw new Error(`Slack history HTTP ${resp.status}`)
      const data = await resp.json() as { ok: boolean; messages?: Array<{ user?: string; text?: string; ts?: string; thread_ts?: string; reply_count?: number }> }
      if (!data.ok) return []

      return (data.messages ?? []).map(msg => ({
        source: 'slack' as Source,
        channel: ch.name,
        author: msg.user ?? 'unknown',
        text: msg.text ?? '',
        text_preview: truncate(msg.text ?? '', 200),
        date: msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : '',
        thread_info: msg.reply_count ? `${msg.reply_count} replies` : undefined,
        links: extractUrls(msg.text ?? ''),
      }))
    }),
  )

  const items: BriefingItem[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') items.push(...r.value)
  }
  return items.slice(0, limit)
}

async function fetchSlackChannels(
  headers: Record<string, string>,
  teamId: string,
): Promise<Array<{ id: string; name: string; num_members?: number }>> {
  const params = new URLSearchParams({
    types: 'public_channel,private_channel',
    exclude_archived: 'true',
    limit: '200',
    team_id: teamId,
  })
  const resp = await fetch(`https://slack.com/api/conversations.list?${params}`, { headers, signal: AbortSignal.timeout(15_000) })
  if (!resp.ok) throw new Error(`Slack channels HTTP ${resp.status}`)
  const data = await resp.json() as { ok: boolean; channels?: Array<{ id: string; name: string; num_members?: number }> }
  if (!data.ok) return []
  return data.channels ?? []
}

async function fetchGmail(
  req: BriefingRequest,
  period: { after: Date; before: Date },
  googleToken?: string | null,
): Promise<BriefingItem[]> {
  const accessToken = googleToken ?? await resolveGoogleToken()
  if (!accessToken) throw new Error('Gmail: dariy@astrocat.co not authorized')

  const headers = { Authorization: `Bearer ${accessToken}` }

  // Build Gmail search query
  const queryParts: string[] = []
  if (req.query_type === 'unread') queryParts.push('is:unread')
  if (req.search_term) queryParts.push(req.search_term)
  queryParts.push(`after:${toGmailDate(period.after)}`)
  queryParts.push(`before:${toGmailDate(period.before)}`)

  const limit = req.limit_per_source ?? 10
  const params = new URLSearchParams({
    q: queryParts.join(' '),
    maxResults: String(limit),
  })

  const listResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  )
  const listData = await jsonOrThrow<{ messages?: Array<{ id: string }> }>(listResp, 'Gmail list')
  if (!listData.messages || listData.messages.length === 0) return []

  // Fetch message metadata (not full body — saves tokens)
  const msgResults = await Promise.allSettled(
    listData.messages.slice(0, limit).map(async (msg) => {
      const msgResp = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers, signal: AbortSignal.timeout(10_000) },
      )
      const msgData = await jsonOrThrow<{
        id: string
        snippet?: string
        payload?: { headers?: Array<{ name: string; value: string }> }
        labelIds?: string[]
      }>(msgResp, `Gmail message ${msg.id}`)

      const getHeader = (name: string) =>
        msgData.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''

      return {
        source: 'gmail' as Source,
        author: getHeader('From'),
        subject: getHeader('Subject'),
        date: getHeader('Date'),
        text_preview: truncate(msgData.snippet ?? '', 200),
        is_unread: msgData.labelIds?.includes('UNREAD') ?? false,
      }
    }),
  )

  const items: BriefingItem[] = []
  for (const r of msgResults) {
    if (r.status === 'fulfilled') items.push(r.value)
  }
  return items
}

async function fetchCalendar(
  req: BriefingRequest,
  period: { after: Date; before: Date },
  googleToken?: string | null,
): Promise<BriefingItem[]> {
  const accessToken = googleToken ?? await resolveGoogleToken()
  if (!accessToken) throw new Error('Calendar: dariy@astrocat.co not authorized')

  const headers = { Authorization: `Bearer ${accessToken}` }

  const limit = req.limit_per_source ?? 10
  const params = new URLSearchParams({
    timeMin: period.after.toISOString(),
    timeMax: period.before.toISOString(),
    maxResults: String(limit),
    singleEvents: 'true',
    orderBy: 'startTime',
  })

  if (req.search_term) params.set('q', req.search_term)

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  )
  const data = await jsonOrThrow<{
    items?: Array<{
      summary?: string
      start?: { dateTime?: string; date?: string }
      end?: { dateTime?: string; date?: string }
      attendees?: Array<{ email: string; responseStatus?: string }>
      htmlLink?: string
      status?: string
    }>
  }>(resp, 'Calendar')

  return (data.items ?? []).map(event => ({
    source: 'calendar' as Source,
    subject: event.summary ?? '(no title)',
    date: event.start?.dateTime ?? event.start?.date ?? '',
    end_date: event.end?.dateTime ?? event.end?.date ?? '',
    attendees: event.attendees?.map(a => a.email).join(', ') ?? '',
    status: event.status ?? '',
    links: event.htmlLink ? [event.htmlLink] : [],
  }))
}

async function fetchClickUp(
  req: BriefingRequest,
  period: { after: Date; before: Date },
): Promise<BriefingItem[]> {
  const apiKey = process.env.CLICKUP_API_KEY
  const teamId = process.env.CLICKUP_TEAM_ID
  if (!apiKey || !teamId) throw new Error('ClickUp not configured')

  const headers = { Authorization: apiKey }
  const limit = req.limit_per_source ?? 10

  if (req.search_term) {
    // ClickUp task list endpoint has no full-text search — fetch page 0 and filter client-side
    const resp = await fetch(
      `https://api.clickup.com/api/v2/team/${teamId}/task?${new URLSearchParams({
        include_closed: 'false',
        subtasks: 'true',
        page: '0',
      })}`,
      { headers, signal: AbortSignal.timeout(15_000) },
    )
    const data = await jsonOrThrow<{ tasks?: Array<Record<string, unknown>> }>(resp, 'ClickUp search')

    // Filter by search term client-side (ClickUp task list endpoint has no full-text search param)
    const term = req.search_term.toLowerCase()
    const filtered = (data.tasks ?? []).filter(t =>
      ((t.name as string) ?? '').toLowerCase().includes(term) ||
      ((t.description as string) ?? '').toLowerCase().includes(term),
    )

    return filtered.slice(0, limit).map(mapClickUpTask)
  }

  // For "recent" / "digest" — fetch tasks with due dates in period
  const resp = await fetch(
    `https://api.clickup.com/api/v2/team/${teamId}/task?${new URLSearchParams({
      include_closed: 'false',
      subtasks: 'true',
      due_date_gt: String(period.after.getTime()),
      due_date_lt: String(period.before.getTime()),
      page: '0',
    })}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  )
  const data = await jsonOrThrow<{ tasks?: Array<Record<string, unknown>> }>(resp, 'ClickUp tasks')

  return (data.tasks ?? []).slice(0, limit).map(mapClickUpTask)
}

// ── Helpers ──

function mapClickUpTask(t: Record<string, unknown>): BriefingItem {
  return {
    source: 'clickup' as Source,
    subject: (t.name as string) ?? '',
    status: (t.status as { status?: string })?.status ?? '',
    assignee: ((t.assignees as Array<{ username?: string }>) ?? []).map(a => a.username).join(', '),
    due_date: t.due_date ? new Date(parseInt(t.due_date as string)).toISOString() : '',
    text_preview: truncate((t.description as string) ?? '', 200),
    links: t.url ? [t.url as string] : [],
  }
}

function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s>|)]+/g
  return [...text.matchAll(urlRegex)].map(m => m[0])
}

// ── Main briefing logic ──

async function executeBriefing(req: BriefingRequest): Promise<BriefingResult> {
  const startTime = Date.now()
  const period = parsePeriod(req.period)

  // Pre-resolve Google token once if any Google source is requested
  const needsGoogle = req.sources.some(s => s === 'gmail' || s === 'calendar')
  const googleToken = needsGoogle ? await resolveGoogleToken() : null

  const sourceFetchers: Record<Source, () => Promise<BriefingItem[]>> = {
    slack: () => fetchSlack(req, period),
    gmail: () => fetchGmail(req, period, googleToken),
    calendar: () => fetchCalendar(req, period, googleToken),
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
      limit_per_source: {
        type: 'number' as const,
        description: 'Max items per source (default 10)',
        default: 10,
      },
      fields: {
        type: 'array' as const,
        items: {
          type: 'string' as const,
          enum: ['author', 'date', 'text', 'text_preview', 'subject', 'links', 'thread_info', 'status', 'assignee', 'due_date', 'channel'],
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

async function main(): Promise<void> {
  log('\n--- astra-briefing starting ---')

  const server = new Server(
    { name: 'Astra Briefing Server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [briefingTool, searchEverywhereTool],
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
          limit_per_source: Math.max(1, Math.min(rawLimit, 50)),
          fields: args.fields as FieldName[] | undefined,
        })
      } else if (toolName === 'search_everywhere') {
        if (!args.search_term) throw new Error('search_term is required')
        const searchLimit = Math.max(1, Math.min((args.limit_per_source as number) ?? 5, 50))
        result = await executeBriefing({
          sources: ['slack', 'gmail', 'calendar', 'clickup'],
          query_type: 'search',
          period: (args.period as string) ?? 'last_month',
          search_term: args.search_term as string,
          limit_per_source: searchLimit,
          fields: ['author', 'date', 'subject', 'text_preview', 'channel', 'status', 'links'],
        })
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

main().catch((error) => {
  log(`FATAL: ${error}`)
  console.error('Fatal error:', error)
  process.exit(1)
})
