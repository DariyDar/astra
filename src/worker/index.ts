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
import { createDriveAdapters } from '../kb/ingestion/drive.js'
import { createNotionAdapter } from '../kb/ingestion/notion.js'
import { extractEntities } from '../kb/entity-extractor.js'
import type { SourceAdapter } from '../kb/ingestion/types.js'

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

// Digest scheduling runs in bot process (has access to adapters). See src/bot/index.ts.

/**
 * KB ingestion + entity extraction: daily at 20:00 UTC (04:00 Bali).
 * 1. Fetch new data from all sources (REST, no LLM)
 * 2. Extract entities from new chunks (single LLM call)
 */
const qdrantClient = new QdrantClient({ url: env.QDRANT_URL })
const kbVectorStore = new KBVectorStore(qdrantClient)

const kbIngestionJob = cron.schedule('0 20 * * *', async () => {
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

    // Run entity extraction on new chunks (single LLM call)
    if (totalCreated > 0) {
      logger.info({ totalCreated }, 'KB ingestion done, starting entity extraction')
      const extractionStats = await extractEntities(db)
      logger.info(extractionStats, 'KB entity extraction complete')
    } else {
      logger.info('KB ingestion: no new chunks, skipping entity extraction')
    }
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
