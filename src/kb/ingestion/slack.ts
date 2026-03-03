import { SLACK_WORKSPACES, fetchSlackChannels } from '../../mcp/briefing/slack.js'
import { formatSlackMessage, splitText } from '../chunker.js'
import type { KBChunkInput } from '../types.js'
import type { SourceAdapter, RawItem } from './types.js'
import { logger } from '../../logging/logger.js'

const RATE_LIMIT_MS = 1100  // Slack Tier 3: ~1 req/sec
const MESSAGES_PER_PAGE = 200
const INITIAL_LOOKBACK_DAYS = 90

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Creates one SlackIngestionAdapter per workspace. */
export function createSlackAdapters(): SourceAdapter[] {
  return SLACK_WORKSPACES.map((ws) => ({
    name: `slack:${ws.label}`,
    source: 'slack' as const,

    async fetchSince(watermark: string): Promise<{ items: RawItem[]; nextWatermark: string }> {
      const headers = { Authorization: `Bearer ${ws.token}`, 'Content-Type': 'application/json' }

      // If no watermark, start from N days ago
      const oldest = watermark || String((Date.now() - INITIAL_LOOKBACK_DAYS * 86400_000) / 1000)

      const channels = await fetchSlackChannels(headers, ws.teamId)
      const items: RawItem[] = []
      let maxTs = oldest

      for (const ch of channels) {
        await sleep(RATE_LIMIT_MS)

        try {
          let cursor: string | undefined
          let pageCount = 0
          const maxPages = 50  // Safety limit: 50 pages × 200 = 10K messages per channel

          do {
            const params = new URLSearchParams({
              channel: ch.id,
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
              logger.warn({ channel: ch.name, retryAfter }, 'Slack rate limited, backing off')
              await sleep(retryAfter * 1000)
              continue
            }

            if (!resp.ok) {
              logger.warn({ channel: ch.name, status: resp.status }, 'Slack history fetch failed')
              break
            }

            const data = await resp.json() as {
              ok: boolean
              messages?: Array<{ user?: string; text?: string; ts?: string }>
              response_metadata?: { next_cursor?: string }
            }

            if (!data.ok) break

            for (const msg of data.messages ?? []) {
              if (!msg.text || msg.text.trim().length === 0) continue

              items.push({
                id: `${ws.label}:${ch.id}:${msg.ts}`,
                text: msg.text,
                metadata: {
                  channel: `${ws.label}/${ch.name}`,
                  channelId: ch.id,
                  workspace: ws.label,
                  user: msg.user ?? 'unknown',
                },
                date: msg.ts ? new Date(parseFloat(msg.ts) * 1000) : undefined,
              })

              if (msg.ts && msg.ts > maxTs) maxTs = msg.ts
            }

            cursor = data.response_metadata?.next_cursor || undefined
            pageCount++
            if (cursor) await sleep(RATE_LIMIT_MS)
          } while (cursor && pageCount < maxPages)
        } catch (error) {
          logger.warn({ channel: ch.name, error }, 'Slack channel ingestion failed, continuing')
        }
      }

      logger.info({ workspace: ws.label, channels: channels.length, messages: items.length }, 'Slack ingestion complete')
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
