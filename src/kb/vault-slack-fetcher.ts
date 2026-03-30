/**
 * Lightweight Slack fetcher for vault synthesizer.
 * Fetches recent messages from specific channels by name.
 * Reuses workspace config and user cache from existing Slack infrastructure.
 */

import { SLACK_WORKSPACES, fetchSlackChannels } from '../mcp/briefing/slack.js'
import { buildSlackUserCache, resolveSlackMentions } from './slack-user-cache.js'
import { logger } from '../logging/logger.js'

export interface ChannelMessages {
  channel: string
  workspace: string
  messages: Array<{ user: string; text: string; ts: string }>
}

const RATE_LIMIT_MS = 1100
const MAX_MESSAGES_PER_CHANNEL = 50

/** Module-level cache for Slack channel lists, keyed by workspace teamId. TTL = 60 min. */
const channelListCache = new Map<string, { channels: Array<{ id: string; name: string }>; cachedAt: number }>()
const CHANNEL_CACHE_TTL = 60 * 60 * 1000

/** Sleep helper */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Fetch recent messages from named Slack channels across all workspaces.
 * Returns messages from the last `lookbackHours` hours.
 */
export async function fetchRecentMessages(
  channelNames: string[],
  lookbackHours: number,
): Promise<ChannelMessages[]> {
  if (channelNames.length === 0 || SLACK_WORKSPACES.length === 0) return []

  const oldest = String(Math.floor((Date.now() - lookbackHours * 3600_000) / 1000))
  const userCache = await buildSlackUserCache()
  const results: ChannelMessages[] = []

  for (const ws of SLACK_WORKSPACES) {
    const headers = { Authorization: `Bearer ${ws.token}` }

    // Fetch channel list for this workspace (cached with 60-min TTL)
    let allChannels: Array<{ id: string; name: string }>
    const cached = channelListCache.get(ws.teamId)
    if (cached && Date.now() - cached.cachedAt < CHANNEL_CACHE_TTL) {
      allChannels = cached.channels
    } else {
      try {
        allChannels = await fetchSlackChannels(headers, ws.teamId)
        channelListCache.set(ws.teamId, { channels: allChannels, cachedAt: Date.now() })
      } catch (error) {
        logger.warn({ workspace: ws.label, error }, 'Vault synth: failed to fetch channel list')
        continue
      }
    }

    // Match requested channel names to IDs
    const normalizedNames = new Set(channelNames.map(n => n.replace(/^#/, '').toLowerCase()))
    const matched = allChannels.filter(ch => normalizedNames.has(ch.name.toLowerCase()))

    for (const ch of matched) {
      try {
        await sleep(RATE_LIMIT_MS)
        const resp = await fetch(`https://slack.com/api/conversations.history?${new URLSearchParams({
          channel: ch.id,
          oldest,
          limit: String(MAX_MESSAGES_PER_CHANNEL),
        })}`, { headers, signal: AbortSignal.timeout(15_000) })

        if (!resp.ok) continue
        const data = await resp.json() as {
          ok: boolean
          messages?: Array<{ user?: string; text?: string; ts?: string; subtype?: string; bot_id?: string }>
        }
        if (!data.ok || !data.messages) continue

        // Filter out bot messages and system messages
        const humanMessages = data.messages.filter(m =>
          !m.bot_id && !m.subtype && m.text && m.user,
        )

        const messages = humanMessages.map(m => ({
          user: userCache.get(m.user!) ?? m.user!,
          text: resolveSlackMentions(m.text!, userCache),
          ts: m.ts!,
        }))

        if (messages.length > 0) {
          results.push({ channel: `#${ch.name}`, workspace: ws.label, messages })
        }
      } catch (error) {
        logger.warn({ channel: ch.name, workspace: ws.label, error }, 'Vault synth: failed to fetch channel history')
      }
    }
  }

  return results
}
