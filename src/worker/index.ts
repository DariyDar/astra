import cron from 'node-cron'
import '../config/env.js'
import { logger } from '../logging/logger.js'
import { cleanupOldEntries } from '../logging/audit.js'
import { db, closeDb } from '../db/index.js'
import { QdrantClient } from '@qdrant/js-client-rest'
import { env } from '../config/env.js'
import { KBVectorStore } from '../kb/vector-store.js'
import { runIngestion } from '../kb/ingestion/runner.js'
import { createSlackAdapters } from '../kb/ingestion/slack.js'
import { createGmailAdapters } from '../kb/ingestion/gmail.js'
import { createClickUpAdapter } from '../kb/ingestion/clickup.js'
import { createCalendarAdapters } from '../kb/ingestion/calendar.js'
import { createDriveAdapters, syncDriveChanges } from '../kb/ingestion/drive.js'
import { resolveGoogleTokens } from '../mcp/briefing/google-auth.js'
import { createNotionAdapter } from '../kb/ingestion/notion.js'
import { extractKnowledgeBatch, markLowValueChunks } from '../kb/knowledge-extractor.js'
import type { SourceAdapter } from '../kb/ingestion/types.js'
import { deliverDailyDigest } from '../digest/scheduler.js'

const AUDIT_RETENTION_DAYS = 30

/**
 * Schedule audit trail cleanup: daily at 3 AM.
 * Deletes entries older than 30 days.
 */
const auditCleanupJob = cron.schedule('0 3 * * *', async () => {
  logger.info('Starting audit trail cleanup')
  try {
    const deleted = await cleanupOldEntries(AUDIT_RETENTION_DAYS)
    logger.info(
      { deletedCount: deleted, retentionDays: AUDIT_RETENTION_DAYS },
      'Audit trail cleanup complete',
    )
  } catch (error) {
    logger.error({ error }, 'Audit trail cleanup failed')
  }
})

/**
 * Daily digest: 01:00 UTC = 09:00 WITA (Bali time).
 * "Краткое содержание предыдущих серий" — recap of yesterday only.
 * Each source has 5 retries with exponential backoff,
 * plus 3 full-compilation retries with 5-min intervals.
 * Worst-case delivery by ~09:30 Bali time.
 */
const digestJob = cron.schedule('0 1 * * *', async () => {
  logger.info('Starting daily digest')
  try {
    await deliverDailyDigest()
    logger.info('Daily digest delivered')
  } catch (error) {
    logger.error({ error }, 'Daily digest failed')
  }
})

/**
 * KB ingestion + entity extraction: daily at 22:00 UTC = 06:00 WITA (Bali time).
 * Runs 3 hours before digest (01:00 UTC) to ensure fresh data.
 * 1. Fetch new data from all sources incl. Slack threads (REST, no LLM)
 * 2. Mark low-value chunks as processed (no LLM)
 * 3. Extract entities from remaining chunks (multi-batch LLM loop, budget-controlled)
 */
const qdrantClient = new QdrantClient({ url: env.QDRANT_URL })
const kbVectorStore = new KBVectorStore(qdrantClient)

const kbIngestionJob = cron.schedule('0 22 * * *', async () => {
  logger.info('Starting KB nightly ingestion')
  try {
    await kbVectorStore.ensureCollection()

    // Build adapters from all configured sources
    const adapters: SourceAdapter[] = []
    adapters.push(...createSlackAdapters())
    adapters.push(...await createGmailAdapters())
    adapters.push(...await createCalendarAdapters())
    adapters.push(...await createDriveAdapters())
    const clickup = createClickUpAdapter()
    if (clickup) adapters.push(clickup)
    const notion = createNotionAdapter()
    if (notion) adapters.push(notion)

    if (adapters.length === 0) {
      logger.warn('KB ingestion: no adapters configured, skipping')
      return
    }

    const ingestionStats = await runIngestion(db, kbVectorStore, adapters)
    const totalCreated = ingestionStats.reduce((sum, s) => sum + s.chunksCreated, 0)
    logger.info({ totalCreated }, 'KB ingestion complete')

    // Drive incremental sync — poll Changes API for modified files
    try {
      const tokens = await resolveGoogleTokens()
      for (const account of tokens.keys()) {
        const result = await syncDriveChanges(db, account, qdrantClient)
        logger.info({ account, ...result }, 'Drive incremental sync complete')
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      logger.error({ error: errMsg }, 'Drive incremental sync failed (non-blocking)')
    }

    // Mark any new low-value chunks as processed
    const marked = await markLowValueChunks(db)
    if (marked > 0) {
      logger.info({ marked }, 'KB: marked low-value chunks as processed')
    }

    // Run multi-batch knowledge extraction via Gemini (free, fast)
    logger.info('KB: starting nightly knowledge extraction')
    const extractionStats = await extractKnowledgeBatch(db, {
      maxBatches: 100,
      maxTimeMinutes: 60,
      chunkBatchSize: 100,
    }, qdrantClient)
    logger.info(extractionStats, 'KB nightly knowledge extraction complete')
  } catch (error) {
    logger.error({ error }, 'KB nightly ingestion failed')
  }
})

logger.info('Worker started')

/**
 * Graceful shutdown: stop cron jobs, close DB connection.
 */
function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down worker')
  auditCleanupJob.stop()
  digestJob.stop()
  kbIngestionJob.stop()
  closeDb()
    .then(() => {
      logger.info('Database connection closed')
      process.exit(0)
    })
    .catch((error) => {
      logger.error({ error }, 'Error closing database connection')
      process.exit(1)
    })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// Keep the worker process alive
setInterval(() => {
  // Heartbeat - worker is alive
}, 60_000)
