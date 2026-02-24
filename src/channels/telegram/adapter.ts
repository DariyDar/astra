import type { Bot, Context } from 'grammy'
import { logger } from '../../logging/logger.js'
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
   */
  async send(message: OutboundMessage): Promise<void> {
    await this.bot.api.sendMessage(message.channelId, message.text, {
      ...(message.parseMode ? { parse_mode: message.parseMode } : {}),
    })
  }

  /**
   * Start the Telegram bot polling.
   */
  async start(): Promise<void> {
    this.registerMiddleware()
    this.bot.start()
    logger.info('Telegram adapter started')
  }

  /**
   * Stop the Telegram bot.
   */
  async stop(): Promise<void> {
    this.bot.stop()
    logger.info('Telegram adapter stopped')
  }
}
