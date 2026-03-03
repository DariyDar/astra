import { QdrantClient } from '@qdrant/js-client-rest'
import { embed } from '../memory/embedder.js'
import { logger } from '../logging/logger.js'
import type { KBSearchFilters } from './types.js'

const COLLECTION_NAME = 'astra_knowledge'
const VECTOR_SIZE = 384

export interface VectorChunk {
  id: string       // UUID for Qdrant point
  vector: number[]
  payload: {
    source: string
    source_id: string
    chunk_type: string
    entity_ids: number[]
    source_date: number  // epoch ms
  }
}

/**
 * Qdrant vector store for the Knowledge Base.
 * Separate from astra_messages (conversation memory).
 */
export class KBVectorStore {
  constructor(private readonly client: QdrantClient) {}

  async ensureCollection(): Promise<void> {
    const { collections } = await this.client.getCollections()
    const exists = collections.some((c) => c.name === COLLECTION_NAME)

    if (!exists) {
      await this.client.createCollection(COLLECTION_NAME, {
        vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
      })

      await this.client.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'source',
        field_schema: 'keyword',
      })
      await this.client.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'source_id',
        field_schema: 'keyword',
      })
      await this.client.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'entity_ids',
        field_schema: 'integer',
      })
      await this.client.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'source_date',
        field_schema: 'integer',
      })
      await this.client.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'chunk_type',
        field_schema: 'keyword',
      })

      logger.info('Created Qdrant collection: astra_knowledge')
    }
  }

  /** Batch upsert vectors into the collection. */
  async upsert(chunks: VectorChunk[]): Promise<void> {
    if (chunks.length === 0) return

    await this.client.upsert(COLLECTION_NAME, {
      wait: true,
      points: chunks.map((c) => ({
        id: c.id,
        vector: c.vector,
        payload: c.payload,
      })),
    })
  }

  /** Semantic search with optional payload filters. */
  async search(
    query: string,
    filters: KBSearchFilters | undefined,
    limit: number,
  ): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> {
    const vector = await embed(query)

    const must: Array<Record<string, unknown>> = []

    if (filters?.source) {
      must.push({ key: 'source', match: { value: filters.source } })
    }
    if (filters?.chunkType) {
      must.push({ key: 'chunk_type', match: { value: filters.chunkType } })
    }
    if (filters?.entityIds && filters.entityIds.length > 0) {
      for (const entityId of filters.entityIds) {
        must.push({ key: 'entity_ids', match: { value: entityId } })
      }
    }
    if (filters?.after) {
      must.push({ key: 'source_date', range: { gte: filters.after.getTime() } })
    }
    if (filters?.before) {
      must.push({ key: 'source_date', range: { lte: filters.before.getTime() } })
    }

    const filter = must.length > 0 ? { must } : undefined

    const results = await this.client.search(COLLECTION_NAME, {
      vector,
      limit,
      with_payload: true,
      filter,
    })

    return results.map((r) => ({
      id: r.id as string,
      score: r.score,
      payload: (r.payload ?? {}) as Record<string, unknown>,
    }))
  }

  /** Delete all vectors for a given source_id. */
  async deleteBySourceId(sourceId: string): Promise<void> {
    await this.client.delete(COLLECTION_NAME, {
      wait: true,
      filter: {
        must: [{ key: 'source_id', match: { value: sourceId } }],
      },
    })
  }
}
