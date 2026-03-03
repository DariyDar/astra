import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../db/schema.js'
import { KBVectorStore } from './vector-store.js'
import { searchChunksByKeyword } from './repository.js'
import { resolveEntity } from './entity-resolver.js'
import type { KBSearchResult, KBSearchFilters, ChunkSource } from './types.js'

type DB = NodePgDatabase<typeof schema>

/**
 * Hybrid search: combines Qdrant semantic search with PostgreSQL keyword search.
 * Uses Reciprocal Rank Fusion (RRF) to merge results from both sources.
 */
export async function hybridSearch(
  db: DB,
  vectorStore: KBVectorStore,
  query: string,
  options: {
    source?: ChunkSource
    person?: string
    project?: string
    after?: Date
    before?: Date
    limit?: number
  } = {},
): Promise<KBSearchResult[]> {
  const limit = options.limit ?? 10

  // Resolve person/project names to entity IDs for filtering
  const entityIds: number[] = []
  if (options.person) {
    const id = await resolveEntity(db, options.person)
    if (id !== null) entityIds.push(id)
  }
  if (options.project) {
    const id = await resolveEntity(db, options.project)
    if (id !== null) entityIds.push(id)
  }

  const filters: KBSearchFilters = {
    source: options.source,
    entityIds: entityIds.length > 0 ? entityIds : undefined,
    after: options.after,
    before: options.before,
  }

  // Run both searches in parallel
  const [semanticResults, keywordResults] = await Promise.allSettled([
    vectorStore.search(query, filters, limit * 2),
    searchChunksByKeyword(db, query, {
      source: options.source,
      after: options.after,
      before: options.before,
    }, limit * 2),
  ])

  // Build scored maps for RRF
  const rrfK = 60  // RRF constant
  const scoreMap = new Map<string, {
    text: string
    source: ChunkSource
    sourceId: string
    sourceDate?: Date | null
    entityIds?: number[] | null
    metadata?: Record<string, unknown> | null
    rrfScore: number
  }>()

  // Process semantic results
  if (semanticResults.status === 'fulfilled') {
    for (let rank = 0; rank < semanticResults.value.length; rank++) {
      const r = semanticResults.value[rank]
      const sourceId = r.payload.source_id as string
      const existing = scoreMap.get(sourceId)
      const rrfContribution = 1 / (rrfK + rank + 1)

      if (existing) {
        existing.rrfScore += rrfContribution
      } else {
        scoreMap.set(sourceId, {
          text: '', // Will be filled from keyword results or left empty
          source: r.payload.source as ChunkSource,
          sourceId,
          sourceDate: r.payload.source_date ? new Date(r.payload.source_date as number) : null,
          entityIds: r.payload.entity_ids as number[] | null,
          metadata: r.payload as Record<string, unknown>,
          rrfScore: rrfContribution,
        })
      }
    }
  }

  // Process keyword results
  if (keywordResults.status === 'fulfilled') {
    for (let rank = 0; rank < keywordResults.value.length; rank++) {
      const r = keywordResults.value[rank]
      const rrfContribution = 1 / (rrfK + rank + 1)

      const existing = scoreMap.get(r.sourceId)
      if (existing) {
        existing.rrfScore += rrfContribution
        if (!existing.text) existing.text = r.text
      } else {
        scoreMap.set(r.sourceId, {
          text: r.text,
          source: r.source as ChunkSource,
          sourceId: r.sourceId,
          sourceDate: r.sourceDate,
          entityIds: null,
          metadata: r.metadata as Record<string, unknown> | null,
          rrfScore: rrfContribution,
        })
      }
    }
  }

  // Sort by RRF score descending, take top N
  const sorted = [...scoreMap.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit)

  // For results missing text (came only from Qdrant), fetch from PG
  for (const item of sorted) {
    if (!item.text && item.sourceId) {
      const pgResults = await searchChunksByKeyword(db, '', { source: item.source }, 1)
      if (pgResults.length > 0) item.text = pgResults[0].text
    }
  }

  return sorted.map((item) => ({
    chunkId: item.sourceId,
    text: item.text,
    source: item.source,
    sourceId: item.sourceId,
    sourceDate: item.sourceDate,
    score: item.rrfScore,
    entityIds: item.entityIds,
    metadata: item.metadata,
  }))
}
