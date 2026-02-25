import { App } from '@slack/bolt'
import type { GenericMessageEvent } from '@slack/types'
import { logger } from '../../logging/logger.js'
import type {
  ChannelAdapter,
  InboundMessage,
  MessageHandler,
  OutboundMessage,
} from '../types.js'

interface SlackAdapterConfig {
  botToken: string
  appToken: string
  adminUserId: string
}

/**
 * Slack channel adapter using Bolt Socket Mode.
 * Implements ChannelAdapter for unified message handling.
 * Filters non-admin users and messages with subtypes (edits, joins, bot messages).
 * Socket Mode requires no public URL — connects via WebSocket.
 */
export class SlackAdapter implements ChannelAdapter {
  readonly channelType = 'slack' as const

  private readonly app: App
  private readonly adminUserId: string
  private readonly handlers: MessageHandler[] = []

  constructor(config: SlackAdapterConfig) {
    this.adminUserId = config.adminUserId
    this.app = new App({
      token: config.botToken,
      socketMode: true,
      appToken: config.appToken,
    })
  }

  /**
   * Register a message handler.
   * Handlers are invoked when a valid admin DM is received.
   */
  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler)
  }

  /**
   * Send an outbound message via Slack.
   * Optionally threads the reply if replyToMessageId is provided.
   */
  async send(message: OutboundMessage): Promise<void> {
    await this.app.client.chat.postMessage({
      channel: message.channelId,
      text: message.text,
      ...(message.replyToMessageId
        ? { thread_ts: message.replyToMessageId }
        : {}),
    })
  }

  /**
   * Start the Slack adapter with Socket Mode.
   * Registers the message listener and connects via WebSocket.
   */
  async start(): Promise<void> {
    this.registerListener()
    await this.app.start()
    logger.info('Slack adapter started (Socket Mode)')
  }

  /**
   * Stop the Slack adapter.
   */
  async stop(): Promise<void> {
    await this.app.stop()
    logger.info('Slack adapter stopped')
  }

  /**
   * Register the Bolt message listener.
   * Filters out messages with subtypes and non-admin users.
   * Adds 👀 reaction on receipt (processing) and removes it when done.
   * Note: Slack bots don't support native typing indicators via Bot API.
   */
  private registerListener(): void {
    this.app.message(async ({ message }) => {
      // Skip messages with subtype (edits, joins, bot messages, etc.)
      if ('subtype' in message && message.subtype !== undefined) {
        return
      }

      const msg = message as GenericMessageEvent

      // Admin guard: silently ignore non-admin users
      if (msg.user !== this.adminUserId) {
        logger.debug(
          { userId: msg.user, adminUserId: this.adminUserId },
          'Ignoring Slack message from non-admin user',
        )
        return
      }

      // React with 👀 to acknowledge receipt and signal processing
      try {
        await this.app.client.reactions.add({
          channel: msg.channel,
          timestamp: msg.ts,
          name: 'eyes',
        })
      } catch {
        // Reaction API may fail silently (duplicate reaction, etc.)
      }

      const inbound: InboundMessage = {
        id: msg.ts,
        channelType: 'slack',
        channelId: msg.channel,
        userId: msg.user,
        text: msg.text ?? '',
        timestamp: new Date(parseFloat(msg.ts) * 1000),
        replyToMessageId: msg.thread_ts,
      }

      try {
        for (const handler of this.handlers) {
          await handler(inbound)
        }
      } catch (error) {
        logger.error(
          { error, messageTs: msg.ts },
          'Error in Slack message handler',
        )
      }
    })
  }
}
