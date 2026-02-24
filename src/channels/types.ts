/**
 * Unified channel types that abstract platform differences.
 * Telegram and Slack adapters implement ChannelAdapter to provide
 * a common interface for message handling across channels.
 */

export interface InboundMessage {
  id: string
  channelType: 'telegram' | 'slack'
  channelId: string
  userId: string
  text: string
  timestamp: Date
  replyToMessageId?: string
  metadata?: Record<string, unknown>
}

export interface OutboundMessage {
  channelType: 'telegram' | 'slack'
  channelId: string
  text: string
  replyToMessageId?: string
  metadata?: Record<string, unknown>
}

export type MessageHandler = (message: InboundMessage) => Promise<void>

export interface ChannelAdapter {
  readonly channelType: 'telegram' | 'slack'
  start(): Promise<void>
  stop(): Promise<void>
  send(message: OutboundMessage): Promise<void>
  onMessage(handler: MessageHandler): void
}
