import { Bot } from 'grammy'
import { env } from '../config/env.js'
import { logger } from '../logging/logger.js'
import { createRequestLogger } from '../logging/correlation.js'
import { writeAuditEntry } from '../logging/audit.js'
import { HealthChecker } from '../health/checker.js'
import { closeDb } from '../db/index.js'

const bot = new Bot(env.TELEGRAM_BOT_TOKEN)
const healthChecker = new HealthChecker()

/**
 * Middleware: Create a request logger with correlation ID for every incoming message.
 * Attaches the logger to ctx.state for downstream middleware and handlers.
 */
bot.use(async (ctx, next) => {
  const requestLogger = createRequestLogger({
    userId: ctx.from?.id?.toString(),
    action: 'incoming_message',
    source: 'telegram',
  })

  // Store logger in context state for access in handlers
  ;(ctx as unknown as { requestLogger: typeof requestLogger }).requestLogger =
    requestLogger

  requestLogger.info(
    {
      updateId: ctx.update.update_id,
      chatId: ctx.chat?.id,
    },
    'Incoming Telegram update',
  )

  // Write audit entry for every handled message
  await writeAuditEntry({
    correlationId:
      (requestLogger.bindings() as { correlationId: string }).correlationId,
    userId: ctx.from?.id?.toString(),
    action: 'message_received',
    source: 'telegram',
    metadata: {
      updateId: ctx.update.update_id,
      chatId: ctx.chat?.id,
    },
    status: 'success',
  })

  await next()
})

bot.command('start', (ctx) => ctx.reply('Astra is running'))

/**
 * /health command: Run health checks and reply with formatted status.
 */
bot.command('health', async (ctx) => {
  const results = await healthChecker.checkAll()

  const lines = results.map((r) => {
    const icon = r.healthy ? 'OK' : 'FAIL'
    const latency = `${r.latencyMs}ms`
    const error = r.error ? ` (${r.error})` : ''
    return `[${icon}] ${r.service}: ${latency}${error}`
  })

  const allHealthy = results.every((r) => r.healthy)
  const header = allHealthy ? 'All systems operational' : 'Issues detected'

  await ctx.reply(`Health Check: ${header}\n\n${lines.join('\n')}`)
})

/**
 * Error handler: Log errors with correlation ID and write audit entry.
 */
bot.catch(async (err) => {
  const ctx = err.ctx
  const requestLogger =
    (ctx as unknown as { requestLogger?: ReturnType<typeof createRequestLogger> })
      .requestLogger ?? logger

  requestLogger.error(
    {
      error: err.error,
      updateId: ctx.update.update_id,
    },
    'Error while handling update',
  )

  await writeAuditEntry({
    correlationId:
      (requestLogger.bindings() as { correlationId?: string }).correlationId ??
      'unknown',
    userId: ctx.from?.id?.toString(),
    action: 'bot_error',
    source: 'telegram',
    status: 'error',
    errorMessage:
      err.error instanceof Error ? err.error.message : String(err.error),
  })
})

/**
 * Graceful shutdown: stop health checker, close DB connection, stop bot.
 */
function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down bot')
  healthChecker.stopPeriodicChecks()
  bot.stop()
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

// Start health checker periodic checks (every 60 seconds)
healthChecker.startPeriodicChecks(60_000)

logger.info('Bot started')
bot.start()
