/**
 * Graphiti ingestion runner — replaces the legacy chunk→embed→qdrant pipeline.
 *
 * Same SourceAdapter interface, but instead of chunking + embedding + vector store,
 * each item becomes a Graphiti episode via addEpisode(). Graphiti handles:
 * entity extraction, deduplication, embedding, and graph construction.
 *
 * Rate limited to ~13 RPM (4.5s delay) to stay under Gemini 15 RPM limit.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../../db/schema.js'
import { logger } from '../../logging/logger.js'
import { getIngestionState, setIngestionState } from '../repository.js'
import { addEpisode, healthcheck, type GraphitiMessage } from '../graphiti-client.js'
import { classifyEmail } from '../gmail-classifier.js'
import type { SourceAdapter, RawItem } from './types.js'
import type { KBChunkInput } from '../types.js'

type DB = NodePgDatabase<typeof schema>

const INTER_EPISODE_DELAY_MS = 4_500 // ~13 RPM, under Gemini 15 RPM limit

interface GraphitiIngestionStats {
  adapter: string
  itemsFetched: number
  episodesCreated: number
  episodesSkipped: number
  errors: number
  durationMs: number
}

/** Build a group_id safe for FalkorDB RediSearch (no hyphens). */
function safeGroupId(source: string, adapterName: string): string {
  return adapterName.replace(/[^a-zA-Z0-9_]/g, '_')
}

/** Convert a RawItem's chunks into a single Graphiti episode message. */
function itemToEpisode(adapter: SourceAdapter, item: RawItem, chunks: KBChunkInput[]): GraphitiMessage {
  // Combine all chunk texts into one episode body
  const content = chunks.map((c) => c.text).join('\n\n')

  return {
    content,
    name: `${adapter.source}:${item.id}`,
    role_type: 'user',
    timestamp: item.date?.toISOString(),
    source_description: `${adapter.source}:${adapter.name}`,
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Run Graphiti ingestion for a single adapter.
 * Fetches new items, converts to episodes, sends to Graphiti.
 */
async function runGraphitiAdapter(
  db: DB,
  adapter: SourceAdapter,
): Promise<GraphitiIngestionStats> {
  const startTime = Date.now()
  const stats: GraphitiIngestionStats = {
    adapter: adapter.name,
    itemsFetched: 0,
    episodesCreated: 0,
    episodesSkipped: 0,
    errors: 0,
    durationMs: 0,
  }

  try {
    const state = await getIngestionState(db, adapter.name)
    const watermark = state?.watermark ?? ''

    await setIngestionState(db, adapter.name, { watermark: watermark || '0', status: 'running' })

    // Fetch new items from source
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

    const groupId = safeGroupId(adapter.source, adapter.name)

    for (let i = 0; i < items.length; i++) {
      const item = items[i]

      try {
        // Convert item to chunks (reuse existing adapter logic)
        const chunks = adapter.toChunks(item)
        if (chunks.length === 0) {
          stats.episodesSkipped++
          continue
        }

        // Skip Gmail system emails (noreply, notifications, etc.)
        if (adapter.source === 'gmail' && item.metadata.from) {
          const emailType = classifyEmail(
            item.metadata.from as string,
            item.metadata.subject as string | undefined,
          )
          if (emailType === 'system') {
            stats.episodesSkipped++
            continue
          }
        }

        // Skip very short content (< 20 chars — likely empty/noise)
        const totalText = chunks.map((c) => c.text).join('')
        if (totalText.trim().length < 20) {
          stats.episodesSkipped++
          continue
        }

        // Build and send episode
        const message = itemToEpisode(adapter, item, chunks)
        await addEpisode(groupId, message)
        stats.episodesCreated++

        logger.debug(
          { adapter: adapter.name, itemId: item.id, index: i + 1, total: items.length },
          'Episode ingested',
        )
      } catch (error) {
        stats.errors++
        const errMsg = error instanceof Error ? error.message : String(error)
        logger.warn(
          { adapter: adapter.name, itemId: item.id, error: errMsg },
          'Episode ingestion failed',
        )
      }

      // Rate limit between episodes (skip after last item)
      if (i < items.length - 1) {
        await delay(INTER_EPISODE_DELAY_MS)
      }
    }

    // Update watermark
    await setIngestionState(db, adapter.name, {
      watermark: nextWatermark,
      status: 'idle',
      itemsTotal: (state?.itemsTotal ?? 0) + stats.episodesCreated,
    })
  } catch (error) {
    stats.errors++
    const errMsg = error instanceof Error ? error.message : String(error)
    logger.error({ adapter: adapter.name, error: errMsg }, 'Graphiti adapter ingestion failed')

    await setIngestionState(db, adapter.name, {
      watermark: (await getIngestionState(db, adapter.name))?.watermark ?? '0',
      status: 'failed',
      error: errMsg,
    }).catch(() => { /* ignore state update failure */ })
  }

  stats.durationMs = Date.now() - startTime
  return stats
}

const ADAPTER_MAX_RETRIES = 3
const ADAPTER_RETRY_DELAY_MS = 30_000

async function runGraphitiAdapterWithRetry(
  db: DB,
  adapter: SourceAdapter,
): Promise<GraphitiIngestionStats> {
  for (let attempt = 1; attempt <= ADAPTER_MAX_RETRIES; attempt++) {
    const stats = await runGraphitiAdapter(db, adapter)

    const state = await getIngestionState(db, adapter.name)
    if (state?.status !== 'failed') {
      return stats
    }

    if (attempt < ADAPTER_MAX_RETRIES) {
      logger.warn(
        { adapter: adapter.name, attempt, maxAttempts: ADAPTER_MAX_RETRIES },
        'Graphiti adapter failed, retrying',
      )
      await delay(ADAPTER_RETRY_DELAY_MS)
    } else {
      logger.error(
        { adapter: adapter.name, attempts: ADAPTER_MAX_RETRIES },
        'Graphiti adapter failed after all retries',
      )
      return stats
    }
  }

  throw new Error(`Unreachable: adapter retry loop for ${adapter.name}`)
}

/**
 * Run Graphiti ingestion for all adapters.
 * Checks Graphiti server health before starting.
 */
export async function runGraphitiIngestion(
  db: DB,
  adapters: SourceAdapter[],
): Promise<GraphitiIngestionStats[]> {
  logger.info({ adapterCount: adapters.length }, 'Starting Graphiti KB ingestion')

  // Health check — fail fast if Graphiti server is down
  const healthy = await healthcheck()
  if (!healthy) {
    logger.error('Graphiti server is not healthy, skipping ingestion')
    return []
  }

  const results: GraphitiIngestionStats[] = []

  for (const adapter of adapters) {
    const stats = await runGraphitiAdapterWithRetry(db, adapter)
    results.push(stats)

    logger.info(
      {
        adapter: stats.adapter,
        fetched: stats.itemsFetched,
        created: stats.episodesCreated,
        skipped: stats.episodesSkipped,
        errors: stats.errors,
        durationMs: stats.durationMs,
      },
      'Graphiti adapter ingestion completed',
    )
  }

  const totalCreated = results.reduce((sum, r) => sum + r.episodesCreated, 0)
  const totalErrors = results.reduce((sum, r) => sum + r.errors, 0)
  logger.info({ totalCreated, totalErrors, adapters: results.length }, 'Graphiti KB ingestion complete')

  return results
}
