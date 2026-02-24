import cron from 'node-cron'
import '../config/env.js'
import { logger } from '../logging/logger.js'
import { cleanupOldEntries } from '../logging/audit.js'
import { closeDb } from '../db/index.js'

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

logger.info('Worker started')

/**
 * Graceful shutdown: stop cron jobs, close DB connection.
 */
function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down worker')
  auditCleanupJob.stop()
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
