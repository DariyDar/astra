/**
 * Dedicated Slack fetcher for daily digest.
 * Unlike the briefing fetcher (top 5 channels, 10 msgs), this fetches
 * ALL channels with ALL yesterday's messages, resolves user IDs to names,
 * and filters out standups/system messages.
 */

import { SLACK_WORKSPACES, fetchSlackChannels } from '../../mcp/briefing/slack.js'
import { buildSlackUserCache, resolveUserId, resolveSlackMentionsAsync } from '../../kb/slack-user-cache.js'
import { logger } from '../../logging/logger.js'

const RATE_LIMIT_MS = 600  // Slightly faster than ingestion (1100ms) — runs once/day
const MESSAGES_PER_PAGE = 200
const MAX_PAGES_PER_CHANNEL = 10  // 2000 msgs/channel max — plenty for 1 day

/** Workspace subdomains for Slack permalink generation */
const WORKSPACE_DOMAINS: Record<string, string> = {
  ac: 'astro-cat-workspace',
  hg: 'highground-games',
}

/** Channels that are general/team-wide (not project-specific). Shown as "Общие новости" in digest. */
const GENERAL_CHANNELS: Record<string, Set<string>> = {
  ac: new Set(['announcements', 'leads', 'cofounders-speakeasy', 'ac-team', 'ac-production-updates', 'absence', 'random']),
  hg: new Set(['general', 'random']),
}

export interface DigestSlackChannel {
  workspace: string
  channelName: string
  isGeneral: boolean
  messages: DigestSlackMessage[]
}

export interface DigestSlackMessage {
  author: string
  text: string
  ts: string
  date: string
  threadInfo?: string
  link?: string
}

/** Subtypes to skip entirely — system noise. */
const SKIP_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_topic',
  'channel_purpose', 'channel_name', 'channel_archive',
  'channel_unarchive', 'group_join', 'group_leave',
  'pinned_item', 'unpinned_item',
])

/**
 * Patterns that indicate a standup BOT TEMPLATE — skip these.
 * Human standup responses (actual content from standups) are KEPT.
 * Only skip automated standup prompts/templates.
 */
const STANDUP_BOT_PATTERNS = [
  /standup\s*(completed|submitted|posted)/i,
  /стендап\s*(проведён|завершён|создан|отправлен)/i,
  /standup_report/i,
  /^What did you do.*\nWhat will you do.*\nAny blockers/is,  // Only the template prompt itself
]

function isStandupBotMessage(text: string): boolean {
  return STANDUP_BOT_PATTERNS.some((p) => p.test(text))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

type SlackMessage = {
  user?: string
  text?: string
  ts?: string
  subtype?: string
  reply_count?: number
  bot_id?: string
}

type HistoryResponse = {
  ok: boolean
  messages?: SlackMessage[]
  response_metadata?: { next_cursor?: string }
}

/** Fetch channel history for a time window with pagination. */
async function fetchChannelHistory(
  headers: Record<string, string>,
  channelId: string,
  channelName: string,
  oldest: string,
  latest: string,
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = []
  let cursor: string | undefined
  let pageCount = 0

  do {
    const params = new URLSearchParams({
      channel: channelId,
      limit: String(MESSAGES_PER_PAGE),
      oldest,
      latest,
    })
    if (cursor) params.set('cursor', cursor)

    const resp = await fetch(
      `https://slack.com/api/conversations.history?${params}`,
      { headers, signal: AbortSignal.timeout(15_000) },
    )

    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get('retry-after') ?? '5')
      logger.warn({ channel: channelName, retryAfter }, 'Digest Slack: rate limited')
      await sleep(retryAfter * 1000)
      continue
    }

    if (!resp.ok) {
      logger.warn({ channel: channelName, status: resp.status }, 'Digest Slack: history fetch failed')
      break
    }

    const data = await resp.json() as HistoryResponse
    if (!data.ok) break

    messages.push(...(data.messages ?? []))
    cursor = data.response_metadata?.next_cursor || undefined
    pageCount++
    if (cursor) await sleep(RATE_LIMIT_MS)
  } while (cursor && pageCount < MAX_PAGES_PER_CHANNEL)

  return messages
}

/**
 * Fetch ALL yesterday's Slack messages for a specific workspace.
 * Returns channels with messages, filtered and with resolved user names.
 */
export async function fetchDigestSlack(
  workspace: 'ac' | 'hg',
  period: { after: Date; before: Date },
): Promise<DigestSlackChannel[]> {
  const ws = SLACK_WORKSPACES.find((w) => w.label === workspace)
  if (!ws) {
    logger.warn({ workspace }, 'Digest Slack: workspace not configured')
    return []
  }

  const headers = { Authorization: `Bearer ${ws.token}`, 'Content-Type': 'application/json' }

  // Build user cache for name resolution
  const userCache = await buildSlackUserCache()

  // Get ALL channels
  const channels = await fetchSlackChannels(headers, ws.teamId)

  const oldest = String(period.after.getTime() / 1000)
  const latest = String(period.before.getTime() / 1000)

  const result: DigestSlackChannel[] = []
  let totalMessages = 0
  let skippedSystem = 0
  let skippedStandup = 0

  for (const ch of channels) {
    await sleep(RATE_LIMIT_MS)

    try {
      const rawMsgs = await fetchChannelHistory(headers, ch.id, ch.name, oldest, latest)
      if (rawMsgs.length === 0) continue

      const messages: DigestSlackMessage[] = []

      for (const msg of rawMsgs) {
        // Skip system messages
        if (msg.subtype && SKIP_SUBTYPES.has(msg.subtype)) {
          skippedSystem++
          continue
        }

        // Skip empty messages
        if (!msg.text || msg.text.trim().length === 0) continue

        // Skip standup bot templates (keep actual human standup responses)
        if (isStandupBotMessage(msg.text)) {
          skippedStandup++
          continue
        }

        // Skip bot messages (automated notifications, standup bots, etc.)
        if (msg.bot_id && msg.subtype === 'bot_message') {
          skippedSystem++
          continue
        }

        // Resolve user name (with fallback to users.info for Slack Connect guests)
        const authorName = msg.user
          ? await resolveUserId(msg.user, userCache)
          : 'unknown'
        const resolvedText = await resolveSlackMentionsAsync(msg.text, userCache)

        // Slack permalink with workspace subdomain
        const domain = WORKSPACE_DOMAINS[workspace] ?? 'slack'
        const slackLink = msg.ts
          ? `https://${domain}.slack.com/archives/${ch.id}/p${msg.ts.replace('.', '')}`
          : undefined

        messages.push({
          author: authorName,
          text: resolvedText,
          ts: msg.ts ?? '',
          date: msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString() : '',
          threadInfo: msg.reply_count ? `${msg.reply_count} replies` : undefined,
          link: slackLink,
        })
      }

      if (messages.length > 0) {
        const generalSet = GENERAL_CHANNELS[workspace] ?? new Set()
        result.push({
          workspace,
          channelName: ch.name,
          isGeneral: generalSet.has(ch.name),
          messages,
        })
        totalMessages += messages.length
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.warn({ channel: ch.name, error: errMsg }, 'Digest Slack: channel fetch failed, skipping')
    }
  }

  logger.info({
    workspace,
    channels: result.length,
    totalMessages,
    skippedSystem,
    skippedStandup,
  }, 'Digest Slack: fetch complete')

  return result
}
