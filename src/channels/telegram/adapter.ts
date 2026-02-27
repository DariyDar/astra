import type { Bot, Context } from 'grammy'
import { logger } from '../../logging/logger.js'
import { formatUsageFooter, markdownToHtml } from '../formatter.js'
import type {
  ChannelAdapter,
  InboundMessage,
  MessageHandler,
  OutboundMessage,
} from '../types.js'

/**
 * Telegram channel adapter wrapping a grammY Bot instance.
 * Implements ChannelAdapter for unified message handling.
 * Filters non-text messages and enforces admin-only access.
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly channelType = 'telegram' as const

  private readonly bot: Bot
  private readonly adminChatId: string
  private readonly handlers: MessageHandler[] = []

  constructor(bot: Bot, adminChatId: string) {
    this.bot = bot
    this.adminChatId = adminChatId
  }

  /**
   * Register a message handler.
   * Handlers are stored and registered as grammY middleware
   * when registerMiddleware() is called.
   * IMPORTANT: Call this BEFORE start() so grammY processes handlers in order.
   */
  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler)
  }

  /**
   * Register stored handlers as grammY middleware on the bot.
   * Must be called after all onMessage() calls and command registrations,
   * but before bot.start().
   */
  registerMiddleware(): void {
    this.bot.on('message:text', async (ctx: Context) => {
      // Skip non-text messages
      if (!ctx.message?.text) {
        return
      }

      // Admin guard: silently ignore non-admin users
      const senderId = ctx.from?.id?.toString()
      if (senderId !== this.adminChatId) {
        logger.debug(
          { senderId, adminChatId: this.adminChatId },
          'Ignoring message from non-admin user',
        )
        return
      }

      // React with eyes to acknowledge receipt
      try {
        await ctx.react('👀')
      } catch {
        // Reaction API may not be available in all chats
      }

      // Show "typing" indicator while processing
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {})
      }, 4000)
      ctx.replyWithChatAction('typing').catch(() => {})

      const inbound: InboundMessage = {
        id: ctx.update.update_id.toString(),
        channelType: 'telegram',
        channelId: ctx.chat!.id.toString(),
        userId: ctx.from!.id.toString(),
        text: ctx.message!.text,
        timestamp: new Date(ctx.message!.date * 1000),
        replyToMessageId:
          ctx.message!.reply_to_message?.message_id?.toString(),
      }

      try {
        for (const handler of this.handlers) {
          await handler(inbound)
        }
      } catch (error) {
        logger.error(
          { error, updateId: ctx.update.update_id },
          'Error in message handler',
        )
      } finally {
        clearInterval(typingInterval)
      }
    })
  }

  /**
   * Send an outbound message via Telegram.
   * Uses HTML parse mode for structured responses.
   * Falls back to plain text if HTML parsing fails (malformed tags from LLM output).
   */
  async send(message: OutboundMessage): Promise<void> {
    const textWithFooter = message.usage
      ? `${message.text}\n\n---\n_${formatUsageFooter(message.usage)}_`
      : message.text
    const html = markdownToHtml(textWithFooter)
    try {
      await this.bot.api.sendMessage(message.channelId, html, {
        parse_mode: 'HTML',
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (errorMsg.includes("can't parse entities") || errorMsg.includes('Bad Request')) {
        logger.warn({ error: errorMsg }, 'Telegram HTML parse failed, falling back to plain text')
        await this.bot.api.sendMessage(message.channelId, textWithFooter)
      } else {
        throw error
      }
    }
  }

  private pollingAttempt = 0
  private readonly maxPollingRetries = 5

  /**
   * Start the Telegram bot polling.
   * Handles 409 conflict errors with exponential backoff retry.
   */
  async start(): Promise<void> {
    this.registerMiddleware()
    this.startPolling()
  }

  private startPolling(): void {
    this.bot.start({
      drop_pending_updates: true,
      onStart: () => {
        this.pollingAttempt = 0
        logger.info('Telegram adapter started (polling active)')
      },
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      const isConflict = message.includes('409') || message.includes('Conflict')

      if (isConflict && this.pollingAttempt < this.maxPollingRetries) {
        this.pollingAttempt++
        const delay = Math.min(5000 * 2 ** this.pollingAttempt, 60000)
        logger.warn(
          { attempt: this.pollingAttempt, retryInMs: delay },
          'Telegram 409 conflict — previous instance still polling, retrying...',
        )
        setTimeout(() => this.startPolling(), delay)
        return
      }

      if (isConflict) {
        logger.fatal(
          { error, attempts: this.pollingAttempt },
          'Telegram 409 conflict persists after retries. Exiting.',
        )
      } else {
        logger.fatal({ error }, 'Telegram polling fatal error')
      }

      process.exit(1)
    })
  }

  /**
   * Stop the Telegram bot.
   */
  async stop(): Promise<void> {
    await this.bot.stop()
    logger.info('Telegram adapter stopped')
  }
}
