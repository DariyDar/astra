import cron from 'node-cron'
import '../config/env.js'
import { logger } from '../logging/logger.js'
import { cleanupOldEntries } from '../logging/audit.js'
import { closeDb } from '../db/index.js'
import { env } from '../config/env.js'
import { deliverDailyDigest } from '../digest/scheduler.js'
import { runSelfImprovement } from '../self-improve/runner.js'
import { deliverPreMeetingReport } from '../digest/pre-meeting-report.js'
import { compileMeetingReport } from '../digest/meeting-report.js'
import { runVaultSynthesizer } from '../kb/vault-synthesizer.js'
import { runHealthCheck } from '../health/source-monitor.js'
import { runChannelDiscovery } from '../kb/channel-discovery.js'

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
const digestJob = cron.schedule('0 9 * * *', async () => { // 09:00 Bali
  logger.info('Starting daily digest')
  try {
    await deliverDailyDigest()
    logger.info('Daily digest delivered')
  } catch (error) {
    logger.error({ error }, 'Daily digest failed')
  }
})

/**
 * Lisbon Talks prep: Tuesday 17:00 Bali (2h before 19:00 meeting).
 * Compiles a weekly AC project status report via meeting-report compiler,
 * then falls back to the legacy pre-meeting report if the new one fails.
 */
const lisbonPrepJob = cron.schedule('0 17 * * 2', async () => { // 17:00 Bali Tue
  logger.info('Starting Lisbon Talks report compilation')
  try {
    await compileMeetingReport('lisbon')
  } catch (error) {
    logger.error({ error }, 'Lisbon Talks report failed, falling back to legacy pre-meeting')
    try {
      await deliverPreMeetingReport()
    } catch (fallbackError) {
      logger.error({ error: fallbackError }, 'Legacy pre-meeting report also failed')
    }
  }
})

/**
 * Board Meeting prep: every other Friday 20:30 Bali (2h before 22:30 meeting).
 * Biweekly = check if ISO week number is even.
 */
const boardPrepJob = cron.schedule('30 20 * * 5', async () => { // 20:30 Bali Fri
  const weekNum = Math.ceil((Date.now() - new Date(2026, 0, 1).getTime()) / (7 * 86400_000))
  if (weekNum % 2 !== 0) return // skip odd weeks
  logger.info('Starting Board Meeting report compilation')
  try {
    await compileMeetingReport('board')
  } catch (error) {
    logger.error({ error }, 'Board Meeting report failed')
  }
})

/**
 * Self-improvement agent: daily at 23:30 UTC.
 * Analyzes today's interactions, identifies problems, applies safe YAML fixes,
 * and sends a report to Telegram.
 * Runs 1.5 hours after KB ingestion (22:00 UTC) to ensure fresh registry data.
 */
const selfImproveJob = cron.schedule('30 23 * * *', async () => {
  logger.info('Starting self-improvement analysis')
  try {
    await runSelfImprovement()
    logger.info('Self-improvement analysis complete')
  } catch (error) {
    logger.error({ error }, 'Self-improvement analysis failed')
  }
})

/**
 * Vault synthesizer: hourly during work hours (09:00-21:00 Bali = 01:00-13:00 UTC).
 * Fetches recent Slack messages, synthesizes status updates via Claude, writes to vault.
 */
// Vault synth: hourly 15:00-23:59 Bali (work hours), Mon-Fri. Server TZ = Asia/Makassar.
const vaultSynthHourlyJob = cron.schedule('0 15-23 * * 1-5', async () => {
  if (env.VAULT_SYNTH_ENABLED === 'false') return
  logger.info('Starting vault synthesizer (hourly)')
  try {
    const stats = await runVaultSynthesizer(env.VAULT_SYNTH_LOOKBACK_HOURS)
    logger.info(stats, 'Vault synthesizer complete')
  } catch (error) {
    logger.error({ error }, 'Vault synthesizer failed')
  }
})

// Vault synth: every 8h during off-hours (00:00, 08:00 Bali), Mon-Fri.
const vaultSynthOffhoursJob = cron.schedule('0 0,8 * * 1-5', async () => {
  if (env.VAULT_SYNTH_ENABLED === 'false') return
  logger.info('Starting vault synthesizer (off-hours)')
  try {
    const stats = await runVaultSynthesizer(8) // 8h lookback for off-hours
    logger.info(stats, 'Vault synthesizer complete')
  } catch (error) {
    logger.error({ error }, 'Vault synthesizer failed')
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
 * Channel discovery: weekly on Monday 10:00 Bali.
 * Finds Slack channels not mapped to any vault project and notifies via Telegram.
 */
const channelDiscoveryJob = cron.schedule('0 10 * * 1', async () => { // Mon 10:00 Bali
  logger.info('Starting channel discovery')
  try {
    await runChannelDiscovery()
  } catch (error) {
    logger.error({ error }, 'Channel discovery failed')
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
  lisbonPrepJob.stop()
  boardPrepJob.stop()
  selfImproveJob.stop()
  vaultSynthHourlyJob.stop()
  vaultSynthOffhoursJob.stop()
  healthCheckJob.stop()
  channelDiscoveryJob.stop()
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
