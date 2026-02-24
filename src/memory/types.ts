/**
 * Shared types for the three-tier memory system.
 * Used by short-term (Redis), medium-term (PostgreSQL), and long-term (Qdrant) memory.
 */

export interface StoredMessage {
  id: string
  channelType: 'telegram' | 'slack'
  channelId: string
  userId: string
  role: 'user' | 'assistant'
  text: string
  language?: 'ru' | 'en'
  timestamp: Date
  metadata?: Record<string, unknown>
}

export interface SearchResult {
  message: StoredMessage
  score: number // relevance score (0-1 for semantic, exact for keyword)
}
