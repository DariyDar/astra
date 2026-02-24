import type { Redis } from 'ioredis'
import type { StoredMessage } from './types.js'

const MESSAGES_TTL = 86400 // 24 hours in seconds
const MAX_MESSAGES = 100

/**
 * Short-term memory backed by Redis.
 * Stores today's messages per channel with 24h TTL.
 * Optimized for fast retrieval of recent conversation context.
 */
export class ShortTermMemory {
  constructor(private readonly redis: Redis) {}

  /**
   * Store a message in the channel's recent messages list.
   * Messages are kept in LIFO order (newest first).
   * List is trimmed to MAX_MESSAGES and expires after 24h.
   */
  async store(channelId: string, message: StoredMessage): Promise<void> {
    const key = this.buildKey(channelId)
    const serialized = JSON.stringify({
      ...message,
      timestamp: message.timestamp.toISOString(),
    })

    await this.redis.lpush(key, serialized)
    await this.redis.ltrim(key, 0, MAX_MESSAGES - 1)
    await this.redis.expire(key, MESSAGES_TTL)
  }

  /**
   * Get the most recent messages for a channel.
   * Returns messages in reverse chronological order (newest first).
   */
  async getRecent(channelId: string, count: number): Promise<StoredMessage[]> {
    const key = this.buildKey(channelId)
    const raw = await this.redis.lrange(key, 0, count - 1)

    return raw.map((entry) => {
      const parsed = JSON.parse(entry) as StoredMessage & { timestamp: string }
      return {
        ...parsed,
        timestamp: new Date(parsed.timestamp),
      }
    })
  }

  /**
   * Clear all messages for a channel.
   */
  async clear(channelId: string): Promise<void> {
    const key = this.buildKey(channelId)
    await this.redis.del(key)
  }

  private buildKey(channelId: string): string {
    return `chat:${channelId}:messages`
  }
}
