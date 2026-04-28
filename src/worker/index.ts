import cron from 'node-cron'
import '../config/env.js'
import { logger } from '../logging/logger.js'
import { cleanupOldEntries } from '../logging/audit.js'
import { closeDb } from '../db/index.js'
import { deliverDailyDigest } from '../digest/scheduler.js'
import { runHealthCheck } from '../health/source-monitor.js'

const AUDIT_RETENTION_DAYS = 30

/**
 * Schedule audit trail cleanup: daily at 3 AM.
 * Deletes entries older than 30 days.
 */
// All cron times in Bali (WITA, UTC+8) — server TZ = Asia/Makassar
const auditCleanupJob = cron.schedule('0 3 * * *', async () => { // 03:00 Bali
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
const digestJob = cron.schedule('0 9 * * 1-5', async () => { // 09:00 Bali, Mon-Fri only
  logger.info('Starting daily digest')
  try {
    await deliverDailyDigest()
    logger.info('Daily digest delivered')
  } catch (error) {
    logger.error({ error }, 'Daily digest failed')
  }
})

/**
 * External service health check: every 30 minutes, all days.
 * Checks Slack, ClickUp, Google, Notion connectivity. Alerts via Telegram on failures.
 */
const healthCheckJob = cron.schedule('*/30 * * * *', async () => {
  try {
    await runHealthCheck()
  } catch (error) {
    logger.error({ error }, 'Health check failed')
  }
})

/**
 * Google Drive tree collector: Mon/Wed/Fri at 06:00 Bali.
 * Saves folder/file tree to vault/_drive-tree.md for Astra context.
 */
const driveTreeJob = cron.schedule('0 6 * * 1,3,5', async () => { // Mon/Wed/Fri 06:00 Bali
  logger.info('Starting Drive tree collection')
  try {
    const { collectDriveTree } = await import('../integrations/drive-tree-collector.js')
    const stats = await collectDriveTree()
    logger.info(stats, 'Drive tree collected')
  } catch (error) {
    logger.error({ error }, 'Drive tree collection failed')
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
  healthCheckJob.stop()
  driveTreeJob.stop()
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
