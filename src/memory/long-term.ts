import { QdrantClient } from '@qdrant/js-client-rest'
import { embed } from './embedder.js'
import type { SearchResult, StoredMessage } from './types.js'

const COLLECTION_NAME = 'astra_messages'
const VECTOR_SIZE = 384

/**
 * Long-term memory backed by Qdrant vector database.
 * Stores all messages as embeddings for semantic search across all time.
 * Enables "you mentioned X weeks ago" type queries.
 */
export class LongTermMemory {
  constructor(private readonly client: QdrantClient) {}

  /**
   * Ensure the Qdrant collection exists with correct schema.
   * Creates collection and payload indexes if they don't exist.
   * Idempotent -- safe to call multiple times.
   */
  async ensureCollection(): Promise<void> {
    const { collections } = await this.client.getCollections()
    const exists = collections.some((c) => c.name === COLLECTION_NAME)

    if (!exists) {
      await this.client.createCollection(COLLECTION_NAME, {
        vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
      })

      await this.client.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'channel_type',
        field_schema: 'keyword',
      })

      await this.client.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'channel_id',
        field_schema: 'keyword',
      })

      await this.client.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'timestamp',
        field_schema: 'integer',
      })
    }
  }

  /**
   * Store a message with its pre-computed embedding vector.
   * Uses crypto.randomUUID() for point IDs (separate from message.id).
   */
  async store(message: StoredMessage, vector: number[]): Promise<void> {
    const pointId = crypto.randomUUID()

    await this.client.upsert(COLLECTION_NAME, {
      wait: true,
      points: [
        {
          id: pointId,
          vector,
          payload: {
            channel_type: message.channelType,
            channel_id: message.channelId,
            user_id: message.userId,
            role: message.role,
            text: message.text,
            language: message.language ?? null,
            timestamp: message.timestamp.getTime(),
            message_id: message.id,
          },
        },
      ],
    })
  }

  /**
   * Search for semantically similar messages by query text.
   * Embeds the query and searches Qdrant for nearest neighbors.
   * Optionally filters by channel ID.
   */
  async search(
    query: string,
    limit: number,
    channelId?: string,
  ): Promise<SearchResult[]> {
    const vector = await embed(query)
    return this.searchByVector(vector, limit, channelId)
  }

  /**
   * Search for semantically similar messages by pre-computed vector.
   * Use when embedding is already available to avoid redundant computation.
   */
  async searchByVector(
    vector: number[],
    limit: number,
    channelId?: string,
  ): Promise<SearchResult[]> {
    const filter = channelId
      ? {
          must: [
            {
              key: 'channel_id',
              match: { value: channelId },
            },
          ],
        }
      : undefined

    const results = await this.client.search(COLLECTION_NAME, {
      vector,
      limit,
      filter,
      with_payload: true,
    })

    return results.map((result) => {
      const payload = result.payload as Record<string, unknown>

      return {
        message: {
          id: payload.message_id as string,
          channelType: payload.channel_type as StoredMessage['channelType'],
          channelId: payload.channel_id as string,
          userId: payload.user_id as string,
          role: payload.role as StoredMessage['role'],
          text: payload.text as string,
          language:
            (payload.language as StoredMessage['language']) ?? undefined,
          timestamp: new Date(payload.timestamp as number),
          metadata: undefined,
        },
        score: result.score,
      }
    })
  }
}
