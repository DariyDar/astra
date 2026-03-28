import type { Server as HttpServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { startMcpServer } from '../mcp/server.js'
import { generateMcpConfig } from '../mcp/config-generator.js'
import { SkillRegistry } from '../skills/registry.js'
import { ClickUpDeadlineMonitor } from '../integrations/monitors/clickup-deadlines.js'
import { KBVectorStore } from '../kb/vector-store.js'

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

// Slack adapters — one per workspace (AC primary, HG secondary)
if (env.SLACK_AC_BOT_TOKEN && env.SLACK_AC_APP_TOKEN && env.SLACK_AC_ADMIN_USER_ID) {
  const slackAcAdapter = new SlackAdapter({
    botToken: env.SLACK_AC_BOT_TOKEN,
    appToken: env.SLACK_AC_APP_TOKEN,
    adminUserId: env.SLACK_AC_ADMIN_USER_ID,
  })
  adapters.push(slackAcAdapter)
  adapterMap.set('slack', slackAcAdapter) // 'slack' key for notification compat
  logger.info('Slack AC adapter configured')
}
if (env.SLACK_HG_BOT_TOKEN && env.SLACK_HG_APP_TOKEN && env.SLACK_HG_ADMIN_USER_ID) {
  const slackHgAdapter = new SlackAdapter({
    botToken: env.SLACK_HG_BOT_TOKEN,
    appToken: env.SLACK_HG_APP_TOKEN,
    adminUserId: env.SLACK_HG_ADMIN_USER_ID,
  })
  adapters.push(slackHgAdapter)
  adapterMap.set('slack-hg', slackHgAdapter)
  logger.info('Slack HG adapter configured')
}
if (!adapterMap.has('slack')) {
  logger.info('No Slack workspace configured, running Telegram-only mode')
}

// --- Notification dispatcher and digest scheduler ---
const notificationDispatcher = new NotificationDispatcher({
  adapters: adapterMap,
  preferences: notificationPreferences,
  defaultChannelId: {
    telegram: env.TELEGRAM_ADMIN_CHAT_ID,
    slack: env.SLACK_AC_ADMIN_USER_ID,
  },
})

const digestScheduler = new DigestScheduler({
  dispatcher: notificationDispatcher,
  adapters: adapterMap,
  defaultUserId: env.TELEGRAM_ADMIN_CHAT_ID,
  defaultChannelId: {
    telegram: env.TELEGRAM_ADMIN_CHAT_ID,
    slack: env.SLACK_AC_ADMIN_USER_ID,
  },
})

// --- ClickUp deadline monitor (conditional, no LLM calls) ---
let clickUpMonitor: ClickUpDeadlineMonitor | undefined
if (env.CLICKUP_API_KEY && env.CLICKUP_TEAM_ID) {
  clickUpMonitor = new ClickUpDeadlineMonitor({
    apiKey: env.CLICKUP_API_KEY,
    teamId: env.CLICKUP_TEAM_ID,
    dispatcher: notificationDispatcher,
    adminUserId: env.TELEGRAM_ADMIN_CHAT_ID,
  })
} else {
  logger.info('ClickUp credentials not configured, deadline monitor disabled')
}

// --- Generate MCP config dynamically based on available env vars ---
const mcpConfigPath = resolve(
  fileURLToPath(import.meta.url),
  '../../mcp/mcp-config.json',
)
generateMcpConfig(mcpConfigPath)

// --- Skill registry (auto-discovers skill modules from src/skills/) ---
const skillRegistry = new SkillRegistry()

// --- Message router (with notification preferences, MCP memory tools, and skills) ---
const messageRouter = new MessageRouter({
  shortTerm: shortTermMemory,
  mediumTerm: mediumTermMemory,
  longTerm: longTermMemory,
  adapters,
  preferences: notificationPreferences,
  mcpEnabled: true,
  skillRegistry,
})

// --- MCP server handle (for graceful shutdown) ---
let mcpServer: HttpServer | null = null

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
    await ctx.reply('Не удалось определить пользователя.')
    return
  }

  await notificationPreferences.ensureDefaults(userId)
  const prefs = await notificationPreferences.getAll(userId)

  if (prefs.length === 0) {
    await ctx.reply('Настройки уведомлений пока не заданы. Будут созданы автоматически.')
    return
  }

  const urgencyIcons: Record<string, string> = {
    urgent: '\u{1F534}',
    important: '\u{1F7E1}',
    normal: '\u{26AA}',
  }

  const urgencyLabels: Record<string, string> = {
    urgent: 'срочно',
    important: 'важно',
    normal: 'обычно',
  }

  const categoryLabels: Record<string, string> = {
    task_deadline: 'Дедлайны задач',
    email_urgent: 'Срочные письма',
    calendar_meeting: 'Встречи',
    task_update: 'Обновления задач',
    email_digest: 'Дайджест писем',
  }

  const channelIcons: Record<string, string> = {
    telegram: '\u{2709}\u{FE0F}',
    slack: '\u{1F4AC}',
  }

  const lines = prefs.map((p) => {
    const urgIcon = urgencyIcons[p.urgencyLevel] ?? ''
    const chIcon = channelIcons[p.deliveryChannel] ?? ''
    const catLabel = categoryLabels[p.category] ?? p.category
    const urgLabel = urgencyLabels[p.urgencyLevel] ?? p.urgencyLevel
    const status = p.enabled === false ? ' [выкл]' : ''
    return `${urgIcon} <b>${catLabel}</b>: ${urgLabel} \u{2192} ${chIcon} ${p.deliveryChannel}${status}`
  })

  const header = '<b>\u{1F514} Настройки уведомлений</b>\n\n'
  const footer = '\n\n<i>Чтобы изменить, просто скажи, например: \u{00AB}дедлайны задач \u{2014} срочные в Telegram\u{00BB} или \u{00AB}выключи уведомления о встречах\u{00BB}</i>'

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
    const errMsg = error instanceof Error ? error.message : String(error)
    logger.warn({ error: errMsg }, 'Embedder initialization failed, long-term memory degraded')
  }

  // 3. Ensure Qdrant collections exist (memory + knowledge base)
  try {
    await longTermMemory.ensureCollection()
    const kbVectorStore = new KBVectorStore(qdrantClient)
    await kbVectorStore.ensureCollection()
    logger.info('Qdrant collections ready (astra_messages + astra_knowledge)')
  } catch (error) {
    logger.warn({ error }, 'Qdrant collection setup failed, long-term memory degraded')
  }

  // 4. Start MCP memory server (sidecar for Claude memory tools)
  try {
    mcpServer = await startMcpServer()
  } catch (error) {
    const mcpErr = error instanceof Error ? error.message : String(error)
    logger.warn({ error: mcpErr }, 'MCP server failed to start, memory tools unavailable')
  }

  // 4b. Load skill modules (auto-discovers from src/skills/)
  await skillRegistry.loadSkills()

  // 4c. Initialize knowledge map from Obsidian vault (for system prompt injection)
  try {
    const { refreshKnowledgeMap } = await import('../kb/vault-reader.js')
    refreshKnowledgeMap()
    logger.info('Knowledge map initialized from vault')
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Knowledge map init failed (non-blocking)')
  }

  // 5. Start health checker
  healthChecker.startPeriodicChecks(5 * 60_000)

  // 6. Start message router (which starts all adapters including Telegram)
  await messageRouter.start()

  // 7. Morning digest and ClickUp monitor — disabled until proactive features are configured
  //    See Phase 6 in roadmap. Only user-initiated requests for now.
  // const digestCron = digestScheduler.getScheduledTime()
  // digestCronJob = cron.schedule(digestCron, ...)
  // clickUpMonitor?.start()

  logger.info('Astra bot started successfully')
}

// --- Graceful shutdown ---
let isShuttingDown = false

function shutdown(signal: string): void {
  if (isShuttingDown) return // Prevent double shutdown
  isShuttingDown = true

  logger.info({ signal }, 'Shutting down bot')

  // Stop digest cron job
  if (digestCronJob) {
    digestCronJob.stop()
    logger.info('Digest cron job stopped')
  }

  // Stop ClickUp deadline monitor
  clickUpMonitor?.stop()

  // Stop MCP server
  if (mcpServer) {
    mcpServer.close()
    logger.info('MCP server stopped')
  }

  // messageRouter.stop() waits for in-flight Claude requests (up to 30s)
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

  // Hard kill after 35s (PM2 kill_timeout should be >= 35s)
  setTimeout(() => {
    logger.warn('Shutdown timeout exceeded, forcing exit')
    process.exit(1)
  }, 35_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// Launch
startup().catch((error) => {
  logger.error({ error }, 'Fatal startup error')
  process.exit(1)
})
