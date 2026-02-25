import type { InboundMessage } from '../channels/types.js'
import { logger } from '../logging/logger.js'
import type { ShortTermMemory } from '../memory/short-term.js'

/**
 * Build a compact recent-conversation context from short-term memory (Redis).
 * Returns the last N messages from the current channel as a simple formatted string.
 *
 * The full memory system is now accessible to Claude via MCP tools:
 * - memory_search (semantic, Qdrant)
 * - get_user_profile (keyword, PostgreSQL)
 * - get_recent_messages (date-range, PostgreSQL)
 *
 * This function only provides the immediate in-session context so Claude
 * can see the current conversation without a tool call.
 *
 * Graceful degradation: if Redis is unavailable, returns empty string.
 */
export async function buildRecentContext(
  message: InboundMessage,
  shortTerm: ShortTermMemory,
  limit = 10,
): Promise<string> {
  try {
    const recentMessages = await shortTerm.getRecent(message.channelId, limit)
    if (recentMessages.length === 0) return ''

    const lines = [...recentMessages]
      .reverse() // newest-first from Redis → oldest first for Claude
      .map((m) => `[${m.role}]: ${m.text}`)
      .join('\n')

    return `## Recent conversation\n${lines}`
  } catch (error) {
    logger.warn(
      { error, channelId: message.channelId },
      'Short-term memory unavailable, skipping recent context',
    )
    return ''
  }
}
