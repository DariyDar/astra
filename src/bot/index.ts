import { Bot } from 'grammy'
import { Redis } from 'ioredis'
import { QdrantClient } from '@qdrant/js-client-rest'
import cron from 'node-cron'
import { env } from '../config/env.js'
import { logger } from '../logging/logger.js'
import { createRequestLogger } from '../logging/correlation.js'
import { writeAuditEntry } from '../logging/audit.js'
import { HealthChecker } from '../health/checker.js'
import { db, closeDb } from '../db/index.js'
import { TelegramAdapter } from '../channels/telegram/adapter.js'
import { SlackAdapter } from '../channels/slack/adapter.js'
import type { ChannelAdapter } from '../channels/types.js'
import { ShortTermMemory } from '../memory/short-term.js'
import { MediumTermMemory } from '../memory/medium-term.js'
import { LongTermMemory } from '../memory/long-term.js'
import { initEmbedder } from '../memory/embedder.js'
import { MessageRouter } from '../brain/router.js'
import { NotificationPreferences } from '../notifications/preferences.js'
import { NotificationDispatcher } from '../notifications/dispatcher.js'
import { DigestScheduler } from '../notifications/digest.js'

// --- Create core instances ---
const bot = new Bot(env.TELEGRAM_BOT_TOKEN)
const healthChecker = new HealthChecker()

// --- Memory tier instances ---
const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
})
const shortTermMemory = new ShortTermMemory(redis)
const mediumTermMemory = new MediumTermMemory(db)
const qdrantClient = new QdrantClient({ url: env.QDRANT_URL })
const longTermMemory = new LongTermMemory(qdrantClient)

// --- Notification system ---
const notificationPreferences = new NotificationPreferences(db)

// --- Telegram adapter ---
const telegramAdapter = new TelegramAdapter(bot, env.TELEGRAM_ADMIN_CHAT_ID)

// --- Channel adapters (Telegram always, Slack optional) ---
const adapters: ChannelAdapter[] = [telegramAdapter]
const adapterMap = new Map<string, ChannelAdapter>()
adapterMap.set('telegram', telegramAdapter)

if (env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN && env.SLACK_ADMIN_USER_ID) {
  const slackAdapter = new SlackAdapter({
    botToken: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    adminUserId: env.SLACK_ADMIN_USER_ID,
  })
  adapters.push(slackAdapter)
  adapterMap.set('slack', slackAdapter)
  logger.info('Slack adapter configured')
} else {
  logger.info('Slack not configured, running Telegram-only mode')
}

// --- Notification dispatcher and digest scheduler ---
const notificationDispatcher = new NotificationDispatcher({
  adapters: adapterMap,
  preferences: notificationPreferences,
  defaultChannelId: {
    telegram: env.TELEGRAM_ADMIN_CHAT_ID,
    slack: env.SLACK_ADMIN_USER_ID,
  },
})

const digestScheduler = new DigestScheduler({
  dispatcher: notificationDispatcher,
  adapters: adapterMap,
  defaultUserId: env.TELEGRAM_ADMIN_CHAT_ID,
  defaultChannelId: {
    telegram: env.TELEGRAM_ADMIN_CHAT_ID,
    slack: env.SLACK_ADMIN_USER_ID,
  },
})

// --- Message router (with notification preferences wired) ---
const messageRouter = new MessageRouter({
  shortTerm: shortTermMemory,
  mediumTerm: mediumTermMemory,
  longTerm: longTermMemory,
  adapters,
  preferences: notificationPreferences,
})

// --- Digest cron job (8 AM daily) ---
let digestCronJob: cron.ScheduledTask | null = null

// --- Middleware: correlation ID logging for all updates ---
bot.use(async (ctx, next) => {
  const requestLogger = createRequestLogger({
    userId: ctx.from?.id?.toString(),
    action: 'incoming_message',
    source: 'telegram',
  })

  ;(ctx as unknown as { requestLogger: typeof requestLogger }).requestLogger =
    requestLogger

  requestLogger.info(
    {
      updateId: ctx.update.update_id,
      chatId: ctx.chat?.id,
    },
    'Incoming Telegram update',
  )

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

// --- Commands (registered BEFORE adapter middleware) ---
bot.command('start', (ctx) => ctx.reply('Astra is running'))

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

bot.command('settings', async (ctx) => {
  const userId = ctx.from?.id?.toString()
  if (!userId) {
    await ctx.reply('Cannot identify user.')
    return
  }

  await notificationPreferences.ensureDefaults(userId)
  const prefs = await notificationPreferences.getAll(userId)

  if (prefs.length === 0) {
    await ctx.reply('No notification preferences found. Defaults will be created on first use.')
    return
  }

  const urgencyIcons: Record<string, string> = {
    urgent: '\u{1F534}',
    important: '\u{1F7E1}',
    normal: '\u{26AA}',
  }

  const channelIcons: Record<string, string> = {
    telegram: '\u{2709}\u{FE0F}',
    slack: '\u{1F4AC}',
  }

  const lines = prefs.map((p) => {
    const urgIcon = urgencyIcons[p.urgencyLevel] ?? ''
    const chIcon = channelIcons[p.deliveryChannel] ?? ''
    const status = p.enabled === false ? ' [disabled]' : ''
    return `${urgIcon} <b>${p.category}</b>: ${p.urgencyLevel} via ${chIcon} ${p.deliveryChannel}${status}`
  })

  const header = '<b>Notification Preferences:</b>\n'
  const footer = '\n\nYou can change preferences by telling me in natural language, e.g., "set task deadlines to urgent on Slack" or "disable calendar notifications".'

  await ctx.reply(header + lines.join('\n') + footer, { parse_mode: 'HTML' })
})

// --- Error handler ---
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

// --- Startup sequence ---
async function startup(): Promise<void> {
  logger.info('Starting Astra bot...')

  // 1. Connect Redis
  try {
    await redis.connect()
    logger.info('Redis connected')
  } catch (error) {
    logger.warn({ error }, 'Redis connection failed, short-term memory degraded')
  }

  // 2. Initialize embedder (downloads model on first run)
  try {
    await initEmbedder()
    logger.info('Embedder initialized')
  } catch (error) {
    logger.warn({ error }, 'Embedder initialization failed, long-term memory degraded')
  }

  // 3. Ensure Qdrant collection exists
  try {
    await longTermMemory.ensureCollection()
    logger.info('Qdrant collection ready')
  } catch (error) {
    logger.warn({ error }, 'Qdrant collection setup failed, long-term memory degraded')
  }

  // 4. Start health checker
  healthChecker.startPeriodicChecks(60_000)

  // 5. Start message router (which starts all adapters including Telegram)
  await messageRouter.start()

  // 6. Schedule morning digest cron job (8 AM daily)
  const digestCron = digestScheduler.getScheduledTime()
  digestCronJob = cron.schedule(digestCron, async () => {
    logger.info('Running scheduled morning digest')
    try {
      await digestScheduler.deliverDigest()
    } catch (error) {
      logger.error({ error }, 'Morning digest delivery failed')
    }
  })
  logger.info({ cron: digestCron }, 'Morning digest scheduled')

  logger.info('Astra bot started successfully')
}

// --- Graceful shutdown ---
function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down bot')

  // Stop digest cron job
  if (digestCronJob) {
    digestCronJob.stop()
    logger.info('Digest cron job stopped')
  }

  messageRouter.stop()
    .then(() => {
      healthChecker.stopPeriodicChecks()
      redis.disconnect()
      return closeDb()
    })
    .then(() => {
      logger.info('All connections closed')
      process.exit(0)
    })
    .catch((error) => {
      logger.error({ error }, 'Error during shutdown')
      process.exit(1)
    })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// Launch
startup().catch((error) => {
  logger.error({ error }, 'Fatal startup error')
  process.exit(1)
})
