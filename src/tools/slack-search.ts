/**
 * Slack search tool — fetches messages from channels without LLM.
 * Used by investigation and briefing to pre-fetch data before passing to Claude.
 */

import { SLACK_WORKSPACES, fetchSlackChannels } from '../mcp/briefing/slack.js'
import { buildSlackUserCache, resolveSlackMentions } from '../kb/slack-user-cache.js'
import { logger } from '../logging/logger.js'
import { getCached, setCache, TTL } from './cache.js'

export interface SlackSearchOpts {
  channels: string[]
  keywords?: string[]
  period: 'day' | 'week' | 'month' | '3months' | '6months' | 'year'
  includeThreads?: boolean
  maxMessages?: number
}

export interface SlackMessage {
  channel: string
  workspace: string
  author: string
  text: string
  ts: string
  threadReplies?: Array<{ author: string; text: string; ts: string }>
}

export interface SlackSearchResult {
  messages: SlackMessage[]
  channelsSearched: string[]
  period: string
  totalFound: number
}

const PERIOD_HOURS: Record<SlackSearchOpts['period'], number> = {
  day: 24,
  week: 168,
  month: 720,
  '3months': 2160,
  '6months': 4320,
  year: 8760,
}

export async function searchSlack(opts: SlackSearchOpts): Promise<SlackSearchResult> {
  const cached = getCached<SlackSearchResult>('slack-search', opts)
  if (cached) return cached

  const lookbackHours = PERIOD_HOURS[opts.period]
  const oldest = String(Math.floor((Date.now() - lookbackHours * 3600_000) / 1000))
  const maxMessages = opts.maxMessages ?? 100
  const userCache = await buildSlackUserCache()

  const messages: SlackMessage[] = []
  const channelsSearched: string[] = []

  for (const ws of SLACK_WORKSPACES) {
    const headers = { Authorization: `Bearer ${ws.token}` }

    let allChannels: Array<{ id: string; name: string }>
    try {
      allChannels = await fetchSlackChannels(headers, ws.teamId)
    } catch {
      continue
    }

    const requestedNames = new Set(opts.channels.map(n => n.replace(/^#/, '').toLowerCase()))
    const matched = allChannels.filter(ch => requestedNames.has(ch.name.toLowerCase()))

    for (const ch of matched) {
      try {
        channelsSearched.push(`#${ch.name} (${ws.label})`)

        const resp = await fetch(`https://slack.com/api/conversations.history?${new URLSearchParams({
          channel: ch.id,
          oldest,
          limit: String(maxMessages),
        })}`, { headers, signal: AbortSignal.timeout(15_000) })

        const data = await resp.json() as {
          ok: boolean
          messages?: Array<{
            user?: string; text?: string; ts?: string
            subtype?: string; bot_id?: string
            reply_count?: number
          }>
        }
        if (!data.ok || !data.messages) continue

        const humanMsgs = data.messages.filter(m => !m.bot_id && !m.subtype && m.text && m.user)

        for (const m of humanMsgs) {
          const text = resolveSlackMentions(m.text!, userCache)

          // Keyword filter (if specified)
          if (opts.keywords?.length) {
            const lower = text.toLowerCase()
            if (!opts.keywords.some(kw => lower.includes(kw.toLowerCase()))) continue
          }

          const msg: SlackMessage = {
            channel: `#${ch.name}`,
            workspace: ws.label,
            author: userCache.get(m.user!) ?? m.user!,
            text,
            ts: m.ts!,
          }

          // Fetch thread replies if requested
          if (opts.includeThreads && m.reply_count && m.reply_count > 0) {
            try {
              await new Promise(r => setTimeout(r, 1100)) // rate limit
              const threadResp = await fetch(`https://slack.com/api/conversations.replies?${new URLSearchParams({
                channel: ch.id,
                ts: m.ts!,
                limit: '30',
              })}`, { headers, signal: AbortSignal.timeout(15_000) })
              const threadData = await threadResp.json() as {
                ok: boolean
                messages?: Array<{ user?: string; text?: string; ts?: string; subtype?: string; bot_id?: string }>
              }
              if (threadData.ok && threadData.messages) {
                msg.threadReplies = threadData.messages
                  .slice(1) // skip parent
                  .filter(r => !r.bot_id && !r.subtype && r.text && r.user)
                  .map(r => ({
                    author: userCache.get(r.user!) ?? r.user!,
                    text: resolveSlackMentions(r.text!, userCache),
                    ts: r.ts!,
                  }))
              }
            } catch {
              // non-fatal
            }
          }

          messages.push(msg)
        }

        await new Promise(r => setTimeout(r, 1100)) // rate limit between channels
      } catch (error) {
        logger.warn({ channel: ch.name, error }, 'slack-search: failed')
      }
    }
  }

  const result: SlackSearchResult = {
    messages,
    channelsSearched,
    period: opts.period,
    totalFound: messages.length,
  }

  setCache('slack-search', opts, result, TTL.slack)
  return result
}

/** Format search results as text for LLM consumption */
export function formatSlackResults(result: SlackSearchResult): string {
  if (result.messages.length === 0) {
    return `Поиск в Slack: 0 сообщений найдено.\nКаналы: ${result.channelsSearched.join(', ')}\nПериод: ${result.period}`
  }

  const lines: string[] = [
    `--- Slack: ${result.totalFound} сообщений (${result.period}, каналы: ${result.channelsSearched.join(', ')}) ---`,
    '',
  ]

  for (const msg of result.messages) {
    const date = new Date(Number(msg.ts) * 1000).toISOString().slice(0, 16).replace('T', ' ')
    lines.push(`[${date}] ${msg.channel} | ${msg.author}: ${msg.text}`)

    if (msg.threadReplies?.length) {
      for (const r of msg.threadReplies) {
        const rDate = new Date(Number(r.ts) * 1000).toISOString().slice(0, 16).replace('T', ' ')
        lines.push(`  ↳ [${rDate}] ${r.author}: ${r.text}`)
      }
    }
  }

  return lines.join('\n')
}
