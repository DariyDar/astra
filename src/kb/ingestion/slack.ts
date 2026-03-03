import { SLACK_WORKSPACES, fetchSlackChannels } from '../../mcp/briefing/slack.js'
import { formatSlackMessage, splitText } from '../chunker.js'
import type { KBChunkInput } from '../types.js'
import type { SourceAdapter, RawItem } from './types.js'
import { logger } from '../../logging/logger.js'

const RATE_LIMIT_MS = 1100  // Slack Tier 3: ~1 req/sec
const MESSAGES_PER_PAGE = 200
const ACTIVE_LOOKBACK_DAYS = 90
const INACTIVE_LOOKBACK_DAYS = 30  // For inactive channels: 30 days before last message

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

type SlackMessage = { user?: string; text?: string; ts?: string; subtype?: string }
type HistoryResponse = {
  ok: boolean
  messages?: SlackMessage[]
  response_metadata?: { next_cursor?: string }
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

/** Convert a Slack message into a RawItem. */
function toRawItem(
  wsLabel: string,
  ch: { id: string; name: string },
  msg: SlackMessage,
): RawItem {
  return {
    id: `${wsLabel}:${ch.id}:${msg.ts}`,
    text: msg.text ?? '',
    metadata: {
      channel: `${wsLabel}/${ch.name}`,
      channelId: ch.id,
      workspace: wsLabel,
      user: msg.user ?? 'unknown',
    },
    date: msg.ts ? new Date(parseFloat(msg.ts) * 1000) : undefined,
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

      // For incremental runs, just use the watermark
      const activeOldest = watermark || String((Date.now() - ACTIVE_LOOKBACK_DAYS * 86400_000) / 1000)

      const channels = await fetchSlackChannels(headers, ws.teamId)
      const items: RawItem[] = []
      let maxTs = activeOldest
      let activeCount = 0
      let inactiveCount = 0

      for (const ch of channels) {
        await sleep(RATE_LIMIT_MS)

        try {
          // Fetch messages from the active window (90 days or from watermark)
          const msgs = await fetchChannelHistory(headers, ch.id, ch.name, activeOldest, 50)

          if (msgs.length > 0) {
            // Channel is active — use all fetched messages
            activeCount++
            for (const msg of msgs) {
              if (!msg.text || msg.text.trim().length === 0) continue
              items.push(toRawItem(ws.label, ch, msg))
              if (msg.ts && msg.ts > maxTs) maxTs = msg.ts
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
                items.push(toRawItem(ws.label, ch, msg))
                if (msg.ts && msg.ts > maxTs) maxTs = msg.ts
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
      }, 'Slack ingestion complete')
      return { items, nextWatermark: maxTs }
    },

    toChunks(item: RawItem): KBChunkInput[] {
      const text = formatSlackMessage({
        user: item.metadata.user as string,
        text: item.text,
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
