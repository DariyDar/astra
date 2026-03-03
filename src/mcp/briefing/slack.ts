import type { Source, BriefingRequest, BriefingItem } from './types.js'
import { log, truncate, extractUrls } from './utils.js'
import { toSlackTs } from './period.js'

// ── Slack multi-workspace ──

export interface SlackWorkspace {
  label: string
  token: string
  teamId: string
}

function buildSlackWorkspaces(): SlackWorkspace[] {
  const workspaces: SlackWorkspace[] = []
  for (const label of ['AC', 'HG']) {
    const token = process.env[`SLACK_${label}_USER_TOKEN`] ?? process.env[`SLACK_${label}_BOT_TOKEN`]
    const teamId = process.env[`SLACK_${label}_TEAM_ID`]
    if (token && teamId) {
      workspaces.push({ label: label.toLowerCase(), token, teamId })
    }
  }
  return workspaces
}

export const SLACK_WORKSPACES = buildSlackWorkspaces()

// ── Channel listing ──

export async function fetchSlackChannels(
  headers: Record<string, string>,
  teamId: string,
): Promise<Array<{ id: string; name: string; num_members?: number }>> {
  const params = new URLSearchParams({
    types: 'public_channel,private_channel',
    exclude_archived: 'false',
    limit: '200',
    team_id: teamId,
  })
  const resp = await fetch(`https://slack.com/api/conversations.list?${params}`, { headers, signal: AbortSignal.timeout(15_000) })
  if (!resp.ok) throw new Error(`Slack channels HTTP ${resp.status}`)
  const data = await resp.json() as { ok: boolean; channels?: Array<{ id: string; name: string; num_members?: number }> }
  if (!data.ok) return []
  return data.channels ?? []
}

// ── Briefing fetcher ──

export async function fetchSlack(
  req: BriefingRequest,
  period: { after: Date; before: Date },
): Promise<BriefingItem[]> {
  if (SLACK_WORKSPACES.length === 0) throw new Error('Slack not configured')

  const results = await Promise.allSettled(
    SLACK_WORKSPACES.map(ws => fetchSlackWorkspace(req, period, ws)),
  )

  let items: BriefingItem[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') items.push(...r.value)
  }

  const limit = req.limit_per_source ?? 10
  return items.slice(0, limit)
}

async function fetchSlackWorkspace(
  req: BriefingRequest,
  period: { after: Date; before: Date },
  ws: SlackWorkspace,
): Promise<BriefingItem[]> {
  const headers = { Authorization: `Bearer ${ws.token}`, 'Content-Type': 'application/json' }

  let channelIds: { id: string; name: string }[] = []

  if (req.slack_channels && req.slack_channels.length > 0) {
    const allChannels = await fetchSlackChannels(headers, ws.teamId)
    for (const ch of req.slack_channels) {
      const found = allChannels.find(c =>
        c.name.toLowerCase() === ch.toLowerCase().replace(/^#/, '') || c.id === ch,
      )
      if (found) channelIds.push(found)
    }
  } else if (req.search_term) {
    const allChannels = await fetchSlackChannels(headers, ws.teamId)
    const term = req.search_term.toLowerCase()
    const nameMatches = allChannels.filter(c => c.name.toLowerCase().includes(term))
    const topActive = allChannels
      .filter(c => !nameMatches.some(m => m.id === c.id))
      .sort((a, b) => (b.num_members ?? 0) - (a.num_members ?? 0))
      .slice(0, Math.max(1, 5 - nameMatches.length))
    channelIds = [...nameMatches, ...topActive]
  } else {
    const allChannels = await fetchSlackChannels(headers, ws.teamId)
    channelIds = allChannels
      .sort((a, b) => (b.num_members ?? 0) - (a.num_members ?? 0))
      .slice(0, 5)
  }

  if (channelIds.length === 0) return []

  const limit = req.limit_per_source ?? 10
  const perChannel = Math.max(3, Math.ceil(limit / channelIds.length))

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
        channel: `${ws.label}/${ch.name}`,
        author: msg.user ?? 'unknown',
        text: msg.text ?? '',
        text_preview: truncate(msg.text ?? '', 200),
        date: msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : '',
        ts: msg.ts ?? '',
        thread_ts: msg.thread_ts ?? msg.ts ?? '',
        thread_info: msg.reply_count ? `${msg.reply_count} replies` : undefined,
        links: extractUrls(msg.text ?? ''),
      }))
    }),
  )

  let items: BriefingItem[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') items.push(...r.value)
  }

  if (req.search_term) {
    const term = req.search_term.toLowerCase()
    items = items.filter(item =>
      ((item.text as string) ?? '').toLowerCase().includes(term) ||
      ((item.channel as string) ?? '').toLowerCase().includes(term),
    )
  }

  return items
}

// ── Thread reader ──

export async function fetchSlackThread(
  channelName: string,
  threadTs: string,
  limit: number = 20,
): Promise<{ channel: string; workspace: string; messages: Array<{ author: string; text: string; date: string }> }> {
  if (SLACK_WORKSPACES.length === 0) throw new Error('Slack not configured')
  if (!/^\d+\.\d+$/.test(threadTs)) throw new Error(`Invalid thread_ts format: "${threadTs}". Expected: "1709456789.123456"`)

  for (const ws of SLACK_WORKSPACES) {
    const headers = { Authorization: `Bearer ${ws.token}`, 'Content-Type': 'application/json' }
    const allChannels = await fetchSlackChannels(headers, ws.teamId)
    const found = allChannels.find(c =>
      c.name.toLowerCase() === channelName.toLowerCase().replace(/^#/, '') || c.id === channelName,
    )
    if (!found) continue

    const params = new URLSearchParams({
      channel: found.id,
      ts: threadTs,
      limit: String(limit),
      inclusive: 'true',
    })
    const resp = await fetch(`https://slack.com/api/conversations.replies?${params}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    })
    if (!resp.ok) throw new Error(`Slack replies HTTP ${resp.status}`)
    const data = await resp.json() as {
      ok: boolean
      error?: string
      messages?: Array<{ user?: string; text?: string; ts?: string }>
    }
    if (!data.ok) throw new Error(`Slack replies error: ${data.error ?? 'unknown'}`)

    return {
      channel: `${ws.label}/${found.name}`,
      workspace: ws.label,
      messages: (data.messages ?? []).map(msg => ({
        author: msg.user ?? 'unknown',
        text: msg.text ?? '',
        date: msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : '',
      })),
    }
  }

  throw new Error(`Channel "${channelName}" not found in any workspace`)
}

// ── Tool definition ──

export const getSlackThreadTool = {
  name: 'get_slack_thread',
  description: `Read a Slack thread (all replies) by channel name and thread timestamp.

Use this to get full conversation context when briefing results show a thread with replies.
The thread_ts comes from the "thread_ts" field in briefing Slack results (e.g. "1709456789.123456").`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      channel_name: {
        type: 'string' as const,
        description: 'Channel name (e.g. "general", "dev-chat") or channel ID. Searched across all workspaces.',
      },
      thread_ts: {
        type: 'string' as const,
        description: 'Thread timestamp (parent message ts). Example: "1709456789.123456"',
      },
      limit: {
        type: 'number' as const,
        description: 'Max replies to return (default: 20)',
        default: 20,
      },
    },
    required: ['channel_name', 'thread_ts'],
  },
}
