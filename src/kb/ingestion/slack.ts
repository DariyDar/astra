import { SLACK_WORKSPACES, fetchSlackChannels } from '../../mcp/briefing/slack.js'
import { formatSlackMessage, splitText } from '../chunker.js'
import { buildSlackUserCache, resolveSlackMentions } from '../slack-user-cache.js'
import type { KBChunkInput } from '../types.js'
import type { SourceAdapter, RawItem } from './types.js'
import { logger } from '../../logging/logger.js'

const RATE_LIMIT_MS = 1100  // Slack Tier 3: ~1 req/sec
const MESSAGES_PER_PAGE = 200
const ACTIVE_LOOKBACK_DAYS = 90
const INACTIVE_LOOKBACK_DAYS = 30  // For inactive channels: 30 days before last message
const REPLIES_PER_PAGE = 200
const MAX_THREAD_PAGES = 10  // Cap thread pagination (2000 replies max)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

type SlackMessage = {
  user?: string
  text?: string
  ts?: string
  subtype?: string
  reply_count?: number
  thread_ts?: string
}

type HistoryResponse = {
  ok: boolean
  messages?: SlackMessage[]
  response_metadata?: { next_cursor?: string }
}

type RepliesResponse = {
  ok: boolean
  messages?: SlackMessage[]
  has_more?: boolean
  response_metadata?: { next_cursor?: string }
  error?: string
}

/** Fetch channel history from `oldest` forward, with pagination and rate limiting. */
async function fetchChannelHistory(
  headers: Record<string, string>,
  channelId: string,
  channelName: string,
  oldest: string,
  maxPages: number,
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = []
  let cursor: string | undefined
  let pageCount = 0

  do {
    const params = new URLSearchParams({
      channel: channelId,
      limit: String(MESSAGES_PER_PAGE),
      oldest,
    })
    if (cursor) params.set('cursor', cursor)

    const resp = await fetch(
      `https://slack.com/api/conversations.history?${params}`,
      { headers, signal: AbortSignal.timeout(15_000) },
    )

    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get('retry-after') ?? '5')
      logger.warn({ channel: channelName, retryAfter }, 'Slack rate limited, backing off')
      await sleep(retryAfter * 1000)
      continue
    }

    if (!resp.ok) {
      logger.warn({ channel: channelName, status: resp.status }, 'Slack history fetch failed')
      break
    }

    const data = await resp.json() as HistoryResponse
    if (!data.ok) break

    messages.push(...(data.messages ?? []))
    cursor = data.response_metadata?.next_cursor || undefined
    pageCount++
    if (cursor) await sleep(RATE_LIMIT_MS)
  } while (cursor && pageCount < maxPages)

  return messages
}

/**
 * Fetch all replies in a thread (excluding the parent message).
 * Uses explicit ts === threadTs check to skip parent regardless of position.
 */
async function fetchThreadReplies(
  headers: Record<string, string>,
  channelId: string,
  threadTs: string,
): Promise<SlackMessage[]> {
  const replies: SlackMessage[] = []
  let cursor: string | undefined
  let pageCount = 0

  do {
    const params = new URLSearchParams({
      channel: channelId,
      ts: threadTs,
      limit: String(REPLIES_PER_PAGE),
    })
    if (cursor) params.set('cursor', cursor)

    const resp = await fetch(
      `https://slack.com/api/conversations.replies?${params}`,
      { headers, signal: AbortSignal.timeout(15_000) },
    )

    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get('retry-after') ?? '5')
      logger.warn({ threadTs, retryAfter }, 'Slack thread rate limited, backing off')
      await sleep(retryAfter * 1000)
      continue
    }

    if (!resp.ok) {
      logger.warn({ threadTs, status: resp.status }, 'Slack thread fetch failed')
      break
    }

    const data = await resp.json() as RepliesResponse
    if (!data.ok) {
      logger.warn({ threadTs, error: data.error }, 'Slack thread API error')
      break
    }

    for (const msg of data.messages ?? []) {
      // Skip the parent message (always has ts === threadTs)
      if (msg.ts === threadTs) continue
      replies.push(msg)
    }

    cursor = data.response_metadata?.next_cursor || undefined
    pageCount++
    if (pageCount >= MAX_THREAD_PAGES) {
      logger.warn({ threadTs, pages: pageCount, replies: replies.length }, 'Thread reply pagination limit reached')
      break
    }
    if (cursor) await sleep(RATE_LIMIT_MS)
  } while (cursor)

  return replies
}

/** Get the latest message timestamp in a channel (for inactive channel lookback). */
async function getLatestMessageTs(
  headers: Record<string, string>,
  channelId: string,
): Promise<string | null> {
  const params = new URLSearchParams({ channel: channelId, limit: '1' })
  const resp = await fetch(
    `https://slack.com/api/conversations.history?${params}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  )
  if (!resp.ok) return null
  const data = await resp.json() as HistoryResponse
  if (!data.ok || !data.messages?.length) return null
  return data.messages[0].ts ?? null
}

/** Convert a Slack message into a RawItem, resolving user IDs via cache. */
function toRawItem(
  wsLabel: string,
  ch: { id: string; name: string },
  msg: SlackMessage,
  userCache: Map<string, string>,
  threadContext?: { parentTs: string },
): RawItem {
  const resolvedText = resolveSlackMentions(msg.text ?? '', userCache)
  const resolvedUser = (msg.user ? userCache.get(msg.user) : undefined) ?? msg.user ?? 'unknown'

  // Thread replies get a composite sourceId to distinguish from parent
  const sourceId = threadContext
    ? `${wsLabel}:${ch.id}:${threadContext.parentTs}:${msg.ts}`
    : `${wsLabel}:${ch.id}:${msg.ts}`

  return {
    id: sourceId,
    text: resolvedText,
    metadata: {
      channel: `${wsLabel}/${ch.name}`,
      channelId: ch.id,
      workspace: wsLabel,
      user: resolvedUser,
      ...(threadContext ? { threadTs: threadContext.parentTs, isReply: true } : {}),
    },
    date: msg.ts ? new Date(parseFloat(msg.ts) * 1000) : undefined,
  }
}

/**
 * Fetch thread replies for a parent message and append to items array.
 * Does NOT update maxTs — watermark tracks parent messages only.
 */
async function collectThreadReplies(
  headers: Record<string, string>,
  ch: { id: string; name: string },
  parentTs: string,
  wsLabel: string,
  userCache: Map<string, string>,
  items: RawItem[],
  counters: { threadCount: number; replyCount: number },
): Promise<void> {
  try {
    await sleep(RATE_LIMIT_MS)
    const replies = await fetchThreadReplies(headers, ch.id, parentTs)
    counters.threadCount++
    for (const reply of replies) {
      if (!reply.text || reply.text.trim().length === 0) continue
      items.push(toRawItem(wsLabel, ch, reply, userCache, { parentTs }))
      counters.replyCount++
      // NOTE: Do NOT update maxTs from reply timestamps.
      // Watermark tracks parent messages (conversations.history), not replies.
      // Reply timestamps can be much newer and would cause watermark to skip parents.
    }
  } catch (threadErr) {
    const errMsg = threadErr instanceof Error ? threadErr.message : String(threadErr)
    logger.warn({ channel: ch.name, threadTs: parentTs, error: errMsg }, 'Thread fetch failed, continuing')
  }
}

/** Creates one SlackIngestionAdapter per workspace. */
export function createSlackAdapters(): SourceAdapter[] {
  return SLACK_WORKSPACES.map((ws) => ({
    name: `slack:${ws.label}`,
    source: 'slack' as const,

    async fetchSince(watermark: string): Promise<{ items: RawItem[]; nextWatermark: string }> {
      const headers = { Authorization: `Bearer ${ws.token}`, 'Content-Type': 'application/json' }
      const isInitialRun = !watermark

      // Build user cache once per ingestion run (covers both workspaces)
      const userCache = await buildSlackUserCache()

      // For incremental runs, just use the watermark
      const activeOldest = watermark || String((Date.now() - ACTIVE_LOOKBACK_DAYS * 86400_000) / 1000)

      const channels = await fetchSlackChannels(headers, ws.teamId)
      const items: RawItem[] = []
      let maxTs = activeOldest
      let activeCount = 0
      let inactiveCount = 0
      const counters = { threadCount: 0, replyCount: 0 }

      for (const ch of channels) {
        await sleep(RATE_LIMIT_MS)

        try {
          // Fetch messages from the active window (90 days or from watermark)
          const msgs = await fetchChannelHistory(headers, ch.id, ch.name, activeOldest, 50)

          if (msgs.length > 0) {
            activeCount++

            // Log thread fetch progress for channels with many threads
            const threadedMsgs = msgs.filter((m) => m.reply_count && m.reply_count > 0)
            if (threadedMsgs.length > 0) {
              logger.info({ channel: ch.name, threadedMessages: threadedMsgs.length }, 'Fetching thread replies')
            }

            for (const msg of msgs) {
              if (!msg.text || msg.text.trim().length === 0) continue
              items.push(toRawItem(ws.label, ch, msg, userCache))
              if (msg.ts && msg.ts > maxTs) maxTs = msg.ts

              // Fetch thread replies for messages that have them
              if (msg.reply_count && msg.reply_count > 0 && msg.ts) {
                await collectThreadReplies(headers, ch, msg.ts, ws.label, userCache, items, counters)
              }
            }
          } else if (isInitialRun) {
            // Channel has no recent activity — on initial run, grab last 30 days of activity
            await sleep(RATE_LIMIT_MS)
            const latestTs = await getLatestMessageTs(headers, ch.id)
            if (latestTs) {
              const latestEpoch = parseFloat(latestTs)
              const lookbackStart = String(latestEpoch - INACTIVE_LOOKBACK_DAYS * 86400)
              await sleep(RATE_LIMIT_MS)
              const archiveMsgs = await fetchChannelHistory(headers, ch.id, ch.name, lookbackStart, 10)
              inactiveCount++
              for (const msg of archiveMsgs) {
                if (!msg.text || msg.text.trim().length === 0) continue
                items.push(toRawItem(ws.label, ch, msg, userCache))
                if (msg.ts && msg.ts > maxTs) maxTs = msg.ts

                if (msg.reply_count && msg.reply_count > 0 && msg.ts) {
                  await collectThreadReplies(headers, ch, msg.ts, ws.label, userCache, items, counters)
                }
              }
              logger.info({ channel: ch.name, msgs: archiveMsgs.length }, 'Fetched archive from inactive channel')
            }
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error)
          logger.warn({ channel: ch.name, error: errMsg }, 'Slack channel ingestion failed, continuing')
        }
      }

      logger.info({
        workspace: ws.label,
        channels: channels.length,
        active: activeCount,
        inactive: inactiveCount,
        messages: items.length,
        threads: counters.threadCount,
        replies: counters.replyCount,
      }, 'Slack ingestion complete')
      return { items, nextWatermark: maxTs }
    },

    toChunks(item: RawItem): KBChunkInput[] {
      const isReply = item.metadata.isReply as boolean | undefined

      const text = formatSlackMessage({
        user: item.metadata.user as string,
        text: isReply ? `[thread reply] ${item.text}` : item.text,
        channel: item.metadata.channel as string,
      })

      // Short messages = 1 chunk. Long messages (rare) = split.
      const chunks = splitText(text)
      return chunks.map((chunkText, i) => ({
        source: 'slack' as const,
        sourceId: item.id,
        chunkIndex: i,
        text: chunkText,
        chunkType: 'message' as const,
        metadata: item.metadata,
        sourceDate: item.date,
      }))
    },
  }))
}
