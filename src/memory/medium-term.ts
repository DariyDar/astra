import { and, desc, eq, gte, ilike, lte, or } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { messages } from '../db/schema.js'
import type * as schema from '../db/schema.js'
import type { StoredMessage } from './types.js'

/**
 * Medium-term memory backed by PostgreSQL.
 * Stores all messages persistently with date-range queries and keyword search.
 * Designed for retrieving ~7 days of conversation context.
 */
export class MediumTermMemory {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  /**
   * Store a message in PostgreSQL.
   */
  async store(message: StoredMessage): Promise<void> {
    await this.db.insert(messages).values({
      externalId: message.id,
      channelType: message.channelType,
      channelId: message.channelId,
      userId: message.userId,
      role: message.role,
      text: message.text,
      language: message.language ?? null,
      metadata: message.metadata ?? null,
      createdAt: message.timestamp,
    })
  }

  /**
   * Get recent messages for a channel within the last N days.
   * Returns messages in reverse chronological order (newest first).
   */
  async getRecent(
    channelId: string,
    days: number,
    limit: number,
  ): Promise<StoredMessage[]> {
    const since = new Date()
    since.setDate(since.getDate() - days)

    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.channelId, channelId), gte(messages.createdAt, since)))
      .orderBy(desc(messages.createdAt))
      .limit(limit)

    return rows.map(rowToStoredMessage)
  }

  /**
   * Get messages for a channel within a specific date range.
   * Returns messages in reverse chronological order (newest first).
   */
  async getByDateRange(
    channelId: string,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<StoredMessage[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          gte(messages.createdAt, from),
          lte(messages.createdAt, to),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit)

    return rows.map(rowToStoredMessage)
  }

  /**
   * Get recent messages by channel type (e.g. all 'telegram' or all 'slack' messages).
   * Used for cross-platform memory: when in Slack, load recent Telegram context, and vice versa.
   * Returns messages in reverse chronological order (newest first).
   */
  async getRecentByChannelType(
    channelType: 'telegram' | 'slack',
    days: number,
    limit: number,
  ): Promise<StoredMessage[]> {
    const since = new Date()
    since.setDate(since.getDate() - days)

    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.channelType, channelType), gte(messages.createdAt, since)))
      .orderBy(desc(messages.createdAt))
      .limit(limit)

    return rows.map(rowToStoredMessage)
  }

  /**
   * Search for user profile facts across ALL channels (name, company, role, etc.).
   * Used to build a persistent user profile section injected into every LLM context.
   * Looks for user messages containing self-introduction keywords.
   * Returns oldest first so the earliest known facts appear first.
   */
  async getUserProfileMessages(limit: number): Promise<StoredMessage[]> {
    const keywords = [
      '%меня зовут%',
      '%my name is%',
      '%i am %',
      '%я %',
      '%компания%',
      '%company%',
      '%работаю%',
      '%i work%',
      '%запомни%',
      '%remember%',
    ]

    const conditions = keywords.map((kw) => ilike(messages.text, kw))

    const rows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.role, 'user'),
          or(...conditions),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit)

    return rows.map(rowToStoredMessage)
  }

  /**
   * Search messages by keyword using case-insensitive LIKE.
   * Returns messages in reverse chronological order (newest first).
   */
  async search(
    channelId: string,
    keyword: string,
    limit: number,
  ): Promise<StoredMessage[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          ilike(messages.text, `%${keyword}%`),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit)

    return rows.map(rowToStoredMessage)
  }
}

/**
 * Map a database row to a StoredMessage.
 */
function rowToStoredMessage(row: typeof messages.$inferSelect): StoredMessage {
  return {
    id: row.externalId,
    channelType: row.channelType as StoredMessage['channelType'],
    channelId: row.channelId,
    userId: row.userId,
    role: row.role as StoredMessage['role'],
    text: row.text,
    language: (row.language as StoredMessage['language']) ?? undefined,
    timestamp: row.createdAt,
    metadata: (row.metadata as Record<string, unknown>) ?? undefined,
  }
}
