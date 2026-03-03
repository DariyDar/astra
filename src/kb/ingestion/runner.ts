import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../../db/schema.js'
import { embed } from '../../memory/embedder.js'
import { logger } from '../../logging/logger.js'
import { KBVectorStore } from '../vector-store.js'
import { contentHash } from '../chunker.js'
import { upsertChunk, getIngestionState, setIngestionState } from '../repository.js'
import type { SourceAdapter } from './types.js'
import type { KBChunkInput } from '../types.js'

type DB = NodePgDatabase<typeof schema>

const EMBED_BATCH_SIZE = 20  // Embed N chunks at a time to avoid OOM

interface IngestionStats {
  adapter: string
  itemsFetched: number
  chunksCreated: number
  chunksSkipped: number
  errors: number
  durationMs: number
}

/**
 * Run ingestion for a single adapter.
 * Fetches new items since watermark, chunks, embeds, stores.
 */
async function runAdapter(
  db: DB,
  vectorStore: KBVectorStore,
  adapter: SourceAdapter,
): Promise<IngestionStats> {
  const startTime = Date.now()
  const stats: IngestionStats = {
    adapter: adapter.name,
    itemsFetched: 0,
    chunksCreated: 0,
    chunksSkipped: 0,
    errors: 0,
    durationMs: 0,
  }

  try {
    // Mark as running
    const state = await getIngestionState(db, adapter.name)
    const watermark = state?.watermark ?? ''

    await setIngestionState(db, adapter.name, { watermark: watermark || '0', status: 'running' })

    // Fetch new items
    const { items, nextWatermark } = await adapter.fetchSince(watermark)
    stats.itemsFetched = items.length

    if (items.length === 0) {
      await setIngestionState(db, adapter.name, {
        watermark: nextWatermark || watermark || '0',
        status: 'idle',
        itemsTotal: state?.itemsTotal ?? 0,
      })
      stats.durationMs = Date.now() - startTime
      return stats
    }

    // Convert items to chunks
    const allChunks: KBChunkInput[] = []
    for (const item of items) {
      try {
        const chunks = adapter.toChunks(item)
        allChunks.push(...chunks)
      } catch (error) {
        stats.errors++
        logger.warn({ adapter: adapter.name, itemId: item.id, error }, 'Chunk conversion failed')
      }
    }

    // Process chunks in batches: hash → dedup → embed → store
    for (let i = 0; i < allChunks.length; i += EMBED_BATCH_SIZE) {
      const batch = allChunks.slice(i, i + EMBED_BATCH_SIZE)

      for (const chunk of batch) {
        try {
          const hash = contentHash(chunk.text)

          // Upsert to PostgreSQL (handles dedup by source + sourceId + chunkIndex)
          const { isNew } = await upsertChunk(db, {
            source: chunk.source,
            sourceId: chunk.sourceId,
            chunkIndex: chunk.chunkIndex,
            contentHash: hash,
            text: chunk.text,
            metadata: { ...chunk.metadata, chunkType: chunk.chunkType },
            sourceDate: chunk.sourceDate,
          })

          if (!isNew) {
            stats.chunksSkipped++
            continue
          }

          // Embed and store in Qdrant
          const vector = await embed(chunk.text)
          const qdrantId = crypto.randomUUID()

          await vectorStore.upsert([{
            id: qdrantId,
            vector,
            payload: {
              source: chunk.source,
              source_id: chunk.sourceId,
              chunk_type: chunk.chunkType,
              entity_ids: [],
              source_date: chunk.sourceDate?.getTime() ?? Date.now(),
            },
          }])

          // Update chunk with qdrant_id
          await upsertChunk(db, {
            source: chunk.source,
            sourceId: chunk.sourceId,
            chunkIndex: chunk.chunkIndex,
            contentHash: hash,
            text: chunk.text,
            qdrantId,
            metadata: { ...chunk.metadata, chunkType: chunk.chunkType },
            sourceDate: chunk.sourceDate,
          })

          stats.chunksCreated++
        } catch (error) {
          stats.errors++
          logger.warn({ adapter: adapter.name, sourceId: chunk.sourceId, error }, 'Chunk processing failed')
        }
      }
    }

    // Update watermark
    await setIngestionState(db, adapter.name, {
      watermark: nextWatermark,
      status: 'idle',
      itemsTotal: (state?.itemsTotal ?? 0) + stats.chunksCreated,
    })
  } catch (error) {
    stats.errors++
    const errMsg = error instanceof Error ? error.message : String(error)
    logger.error({ adapter: adapter.name, error: errMsg }, 'Adapter ingestion failed')

    await setIngestionState(db, adapter.name, {
      watermark: (await getIngestionState(db, adapter.name))?.watermark ?? '0',
      status: 'failed',
      error: errMsg,
    }).catch(() => { /* ignore state update failure */ })
  }

  stats.durationMs = Date.now() - startTime
  return stats
}

/**
 * Run ingestion for all adapters.
 * Each adapter runs independently — one failure doesn't stop others.
 */
export async function runIngestion(
  db: DB,
  vectorStore: KBVectorStore,
  adapters: SourceAdapter[],
): Promise<IngestionStats[]> {
  logger.info({ adapterCount: adapters.length }, 'Starting KB ingestion')

  const results: IngestionStats[] = []

  // Run adapters sequentially to avoid overwhelming APIs
  for (const adapter of adapters) {
    const stats = await runAdapter(db, vectorStore, adapter)
    results.push(stats)

    logger.info(
      {
        adapter: stats.adapter,
        fetched: stats.itemsFetched,
        created: stats.chunksCreated,
        skipped: stats.chunksSkipped,
        errors: stats.errors,
        durationMs: stats.durationMs,
      },
      'Adapter ingestion completed',
    )
  }

  const totalCreated = results.reduce((sum, r) => sum + r.chunksCreated, 0)
  const totalErrors = results.reduce((sum, r) => sum + r.errors, 0)
  logger.info({ totalCreated, totalErrors, adapters: results.length }, 'KB ingestion complete')

  return results
}
