/**
 * Graphiti ingestion runner — replaces the legacy chunk→embed→qdrant pipeline.
 *
 * Same SourceAdapter interface, but instead of chunking + embedding + vector store,
 * items are batched by channel+day and sent as Graphiti episodes.
 * Graphiti handles: entity extraction, deduplication, embedding, and graph construction.
 *
 * Batching: messages from the same channel on the same day → 1 episode.
 * This reduces ~19K Slack messages to ~1-2K episodes (15-20x cost savings).
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../../db/schema.js'
import { logger } from '../../logging/logger.js'
import { getIngestionState, setIngestionState } from '../repository.js'
import { addEpisode, healthcheck, type GraphitiMessage } from '../graphiti-client.js'
import { classifyEmail } from '../gmail-classifier.js'
import type { SourceAdapter, RawItem } from './types.js'

type DB = NodePgDatabase<typeof schema>

const INTER_EPISODE_DELAY_MS = 500 // Paid tier: 2000 RPM, bottleneck is Graphiti processing
const MAX_EPISODE_CHARS = 15_000 // Cap episode size to avoid overwhelming LLM context

interface GraphitiIngestionStats {
  adapter: string
  itemsFetched: number
  episodesCreated: number
  episodesSkipped: number
  errors: number
  durationMs: number
}

/** Build a group_id safe for FalkorDB RediSearch (no hyphens). */
function safeGroupId(_source: string, adapterName: string): string {
  return adapterName.replace(/[^a-zA-Z0-9_]/g, '_')
}

/** Strip lone surrogates that break Python's UTF-8 codec (e.g. broken emoji from Slack). */
function stripSurrogates(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\uD800-\uDFFF]/g, '')
}

/** Get YYYY-MM-DD date key from a Date object. */
function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Build a human-readable source description from adapter name and batch key. */
function buildSourceDescription(adapterName: string, batchKey: string): string {
  return `${adapterName}/${batchKey}`
}

interface BatchedEpisode {
  key: string // grouping key (channel+date or source+date)
  name: string // episode name
  content: string // concatenated messages
  timestamp: Date // latest message date in batch
  sourceDescription: string
  itemCount: number
}

/**
 * Group items into batched episodes by channel+day (Slack) or by day (other sources).
 * Filters out Gmail system emails and short content.
 */
function batchItems(
  adapter: SourceAdapter,
  items: RawItem[],
): BatchedEpisode[] {
  const batches = new Map<string, { items: RawItem[]; latestDate: Date }>()
  let skipped = 0

  for (const item of items) {
    // Skip Gmail system emails
    if (adapter.source === 'gmail' && item.metadata.from) {
      const emailType = classifyEmail(
        item.metadata.from as string,
        item.metadata.subject as string | undefined,
      )
      if (emailType === 'system') {
        skipped++
        continue
      }
    }

    // Skip very short content
    if (!item.text || item.text.trim().length < 20) {
      skipped++
      continue
    }

    // Build batch key: channel+date for Slack, source+date for others
    const day = item.date ? dateKey(item.date) : 'unknown'
    const channel = (item.metadata.channel as string) ?? adapter.name
    const key = `${channel}:${day}`

    const existing = batches.get(key)
    if (existing) {
      existing.items.push(item)
      if (item.date && item.date > existing.latestDate) {
        existing.latestDate = item.date
      }
    } else {
      batches.set(key, {
        items: [item],
        latestDate: item.date ?? new Date(),
      })
    }
  }

  if (skipped > 0) {
    logger.info({ adapter: adapter.name, skipped }, 'Items skipped (system emails / short)')
  }

  const episodes: BatchedEpisode[] = []

  for (const [key, batch] of batches) {
    // Format messages chronologically
    const sorted = batch.items.sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0))

    const lines: string[] = []
    let totalChars = 0

    for (const item of sorted) {
      const time = item.date ? item.date.toISOString().slice(11, 16) : '??:??'
      const user = (item.metadata.user as string) ?? (item.metadata.from as string) ?? 'unknown'
      const isReply = item.metadata.isReply as boolean | undefined
      const prefix = isReply ? '  ↳ ' : ''
      const line = `${prefix}[${time}] ${user}: ${item.text.trim()}`

      // Cap episode size
      if (totalChars + line.length > MAX_EPISODE_CHARS) {
        // Flush current batch and start overflow
        if (lines.length > 0) {
          episodes.push({
            key,
            name: stripSurrogates(`${adapter.source}:${key}`),
            content: stripSurrogates(lines.join('\n')),
            timestamp: batch.latestDate,
            sourceDescription: buildSourceDescription(adapter.name, key),
            itemCount: lines.length,
          })
        }
        lines.length = 0
        totalChars = 0
      }

      lines.push(line)
      totalChars += line.length
    }

    if (lines.length > 0) {
      episodes.push({
        key,
        name: stripSurrogates(`${adapter.source}:${key}`),
        content: stripSurrogates(lines.join('\n')),
        timestamp: batch.latestDate,
        sourceDescription: buildSourceDescription(adapter.name, key),
        itemCount: sorted.length,
      })
    }
  }

  return episodes
}

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Run Graphiti ingestion for a single adapter.
 * Fetches items, batches by channel+day, sends batched episodes to Graphiti.
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

    // Batch items into episodes (channel+day grouping)
    const episodes = batchItems(adapter, items)
    const groupId = safeGroupId(adapter.source, adapter.name)

    logger.info(
      { adapter: adapter.name, items: items.length, episodes: episodes.length },
      'Batched items into episodes',
    )

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i]

      try {
        const message: GraphitiMessage = {
          content: ep.content,
          name: ep.name,
          role_type: 'user',
          timestamp: ep.timestamp.toISOString(),
          source_description: ep.sourceDescription,
        }

        await addEpisode(groupId, message)
        stats.episodesCreated++

        if ((i + 1) % 50 === 0 || i === episodes.length - 1) {
          logger.info(
            { adapter: adapter.name, progress: `${i + 1}/${episodes.length}`, created: stats.episodesCreated, errors: stats.errors },
            'Graphiti ingestion progress',
          )
        }
      } catch (error) {
        stats.errors++
        const errMsg = error instanceof Error ? error.message : String(error)
        logger.warn(
          { adapter: adapter.name, episode: ep.key, error: errMsg },
          'Episode ingestion failed',
        )
      }

      // Brief delay between episodes (paid tier has 2000 RPM, bottleneck is Graphiti processing)
      if (i < episodes.length - 1) {
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
