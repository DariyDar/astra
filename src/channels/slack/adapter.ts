import { App } from '@slack/bolt'
import type { GenericMessageEvent } from '@slack/types'
import { logger } from '../../logging/logger.js'
import { markdownToMrkdwn } from '../formatter.js'
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
 *
 * UX patterns:
 * - 👀 reaction on receipt (requires reactions:write scope)
 * - Typing indicator via placeholder "..." message that gets updated to final response
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
   * If metadata contains placeholderTs, updates that message instead of posting new one.
   * This enables the typing indicator UX (placeholder "..." → final response).
   */
  async send(message: OutboundMessage): Promise<void> {
    const placeholderTs = message.metadata?.placeholderTs as string | undefined
    const formatted = markdownToMrkdwn(message.text)

    if (placeholderTs) {
      await this.app.client.chat.update({
        channel: message.channelId,
        ts: placeholderTs,
        text: formatted,
      })
    } else {
      await this.app.client.chat.postMessage({
        channel: message.channelId,
        text: formatted,
        mrkdwn: true,
        ...(message.replyToMessageId
          ? { thread_ts: message.replyToMessageId }
          : {}),
      })
    }
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
   *
   * On valid message:
   * 1. Add 👀 reaction (requires reactions:write scope)
   * 2. Post placeholder "..." message as typing indicator
   * 3. Pass placeholderTs in metadata so send() updates it instead of posting new
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

      // React with 👀 to acknowledge receipt (requires reactions:write scope)
      try {
        await this.app.client.reactions.add({
          channel: msg.channel,
          timestamp: msg.ts,
          name: 'eyes',
        })
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.warn({ error: errMsg }, 'Failed to add reaction (missing reactions:write scope?)')
      }

      // Post placeholder typing indicator message
      let placeholderTs: string | undefined
      try {
        const placeholder = await this.app.client.chat.postMessage({
          channel: msg.channel,
          text: '...',
          ...(msg.thread_ts ? { thread_ts: msg.thread_ts } : {}),
        })
        placeholderTs = placeholder.ts as string | undefined
      } catch (err) {
        logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Failed to post placeholder message')
      }

      const inbound: InboundMessage = {
        id: msg.ts,
        channelType: 'slack',
        channelId: msg.channel,
        userId: msg.user,
        text: msg.text ?? '',
        timestamp: new Date(parseFloat(msg.ts) * 1000),
        replyToMessageId: msg.thread_ts,
        metadata: placeholderTs ? { placeholderTs } : undefined,
      }

      try {
        for (const handler of this.handlers) {
          await handler(inbound)
        }
      } catch (error) {
        // On error: update placeholder with error message or delete it
        if (placeholderTs) {
          try {
            await this.app.client.chat.delete({
              channel: msg.channel,
              ts: placeholderTs,
            })
          } catch {
            // Ignore delete errors
          }
        }
        logger.error(
          { error, messageTs: msg.ts },
          'Error in Slack message handler',
        )
      }
    })
  }
}
