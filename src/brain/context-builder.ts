import type { InboundMessage } from '../channels/types.js'
import { logger } from '../logging/logger.js'
import type { LongTermMemory } from '../memory/long-term.js'
import type { MediumTermMemory } from '../memory/medium-term.js'
import type { ShortTermMemory } from '../memory/short-term.js'
import type { StoredMessage } from '../memory/types.js'

/** Rough token budget: ~3000 tokens at ~4 chars per token */
const MAX_CONTEXT_CHARS = 12_000

/**
 * Cross-channel context config.
 * Used so Astra remembers conversations across Telegram and Slack.
 * Queries by channelType so Slack DM IDs don't need to be known in advance.
 */
export interface CrossChannelConfig {
  /** The other platform's channel type ('telegram' | 'slack') */
  otherChannelType: 'telegram' | 'slack'
  /** Human-readable label for the other channel */
  otherChannelLabel: string
}

/**
 * Build conversation context from the three-tier memory system.
 * Assembles short-term (Redis), medium-term (PostgreSQL), and long-term (Qdrant)
 * context into a structured string for Claude.
 *
 * Optionally includes cross-channel context so conversations from other platforms
 * (Telegram ↔ Slack) are visible to the LLM.
 *
 * Graceful degradation: if any tier is unavailable, it is skipped with a warning.
 * Context assembly never throws.
 */
export async function buildContext(
  message: InboundMessage,
  shortTerm: ShortTermMemory,
  mediumTerm: MediumTermMemory,
  longTerm: LongTermMemory,
  crossChannel?: CrossChannelConfig,
): Promise<string> {
  const sections: string[] = []
  let totalChars = 0

  // 0. User profile: self-introductions across ALL channels (always first, always present)
  try {
    const profileMessages = await mediumTerm.getUserProfileMessages(10)
    if (profileMessages.length > 0) {
      const lines = profileMessages
        .reverse() // oldest first
        .map((m) => `[${m.channelType}] ${m.text}`)
        .join('\n')
      const section = `## User profile (from all channels)\n${lines}`
      sections.push(section)
      totalChars += section.length
    }
  } catch (error) {
    logger.warn({ error }, 'User profile lookup failed, skipping')
  }

  // 1. Short-term: last 20 messages from Redis (today, current channel)
  try {
    const recentMessages = await shortTerm.getRecent(message.channelId, 20)
    if (recentMessages.length > 0) {
      const formatted = formatRecentMessages(recentMessages)
      sections.push(`## Recent conversation (today)\n${formatted}`)
      totalChars += formatted.length
    }
  } catch (error) {
    logger.warn(
      { error, channelId: message.channelId },
      'Short-term memory unavailable, skipping recent context',
    )
  }

  // 2. Medium-term: last 7 days from PostgreSQL (current channel)
  try {
    if (totalChars < MAX_CONTEXT_CHARS) {
      const weekMessages = await mediumTerm.getRecent(
        message.channelId,
        7,
        50,
      )
      if (weekMessages.length > 0) {
        const budget = MAX_CONTEXT_CHARS - totalChars - 500 // reserve for long-term
        const formatted = formatWeekMessages(weekMessages, budget)
        if (formatted) {
          sections.push(`## Earlier context (this week)\n${formatted}`)
          totalChars += formatted.length
        }
      }
    }
  } catch (error) {
    logger.warn(
      { error, channelId: message.channelId },
      'Medium-term memory unavailable, skipping weekly context',
    )
  }

  // 3. Cross-channel context: recent messages from the other platform
  if (crossChannel && totalChars < MAX_CONTEXT_CHARS) {
    try {
      const crossMessages = await mediumTerm.getRecentByChannelType(
        crossChannel.otherChannelType,
        7,
        20,
      )
      if (crossMessages.length > 0) {
        const budget = Math.min(4000, MAX_CONTEXT_CHARS - totalChars - 500)
        const formatted = formatWeekMessages(crossMessages, budget)
        if (formatted) {
          sections.push(
            `## Context from ${crossChannel.otherChannelLabel}\n${formatted}`,
          )
          totalChars += formatted.length
        }
      }
    } catch (error) {
      logger.warn(
        { error, otherChannelType: crossChannel.otherChannelType },
        'Cross-channel memory unavailable, skipping cross-platform context',
      )
    }
  }

  // 4. Long-term: semantic search from Qdrant (all channels — cross-platform)
  try {
    if (totalChars < MAX_CONTEXT_CHARS) {
      const searchResults = await longTerm.search(
        message.text,
        5,
      )
      if (searchResults.length > 0) {
        const budget = MAX_CONTEXT_CHARS - totalChars
        const formatted = formatSearchResults(searchResults, budget)
        if (formatted) {
          sections.push(`## Related past conversations\n${formatted}`)
        }
      }
    }
  } catch (error) {
    logger.warn(
      { error, channelId: message.channelId },
      'Long-term memory unavailable, skipping semantic context',
    )
  }

  return sections.join('\n\n')
}

/**
 * Format recent messages (short-term) in chronological order.
 * Messages come newest-first from Redis, so we reverse them.
 */
function formatRecentMessages(messages: StoredMessage[]): string {
  return [...messages]
    .reverse()
    .map((m) => `[${m.role}]: ${m.text}`)
    .join('\n')
}

/**
 * Format weekly messages (medium-term) with dates.
 * Messages come newest-first from PostgreSQL, so we reverse them.
 * Truncates to fit within the character budget.
 */
function formatWeekMessages(
  messages: StoredMessage[],
  budget: number,
): string {
  const reversed = [...messages].reverse()
  const lines: string[] = []
  let chars = 0

  for (const m of reversed) {
    const dateStr = m.timestamp.toISOString().split('T')[0]
    const line = `[${dateStr}] [${m.role}]: ${m.text}`
    if (chars + line.length > budget) break
    lines.push(line)
    chars += line.length + 1 // +1 for newline
  }

  return lines.join('\n')
}

/**
 * Format semantic search results with relevance scores.
 * Truncates to fit within the character budget.
 */
function formatSearchResults(
  results: Array<{ message: StoredMessage; score: number }>,
  budget: number,
): string {
  const lines: string[] = []
  let chars = 0

  for (const r of results) {
    const dateStr = r.message.timestamp.toISOString().split('T')[0]
    const score = r.score.toFixed(2)
    const line = `[${dateStr}] [${r.message.role}]: ${r.message.text} (relevance: ${score})`
    if (chars + line.length > budget) break
    lines.push(line)
    chars += line.length + 1
  }

  return lines.join('\n')
}
