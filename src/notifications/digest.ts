import type { ChannelAdapter } from '../channels/types.js'
import { logger } from '../logging/logger.js'
import type { NotificationDispatcher } from './dispatcher.js'
import type { NotificationItem } from './urgency.js'

interface DigestSchedulerConfig {
  dispatcher: NotificationDispatcher
  adapters: Map<string, ChannelAdapter>
  defaultUserId: string
  defaultChannelId: {
    telegram: string
    slack?: string
  }
}

/** Icon mapping for notification categories in digest */
const CATEGORY_ICONS: Record<string, string> = {
  task_deadline: '\u{23F0}',
  email_urgent: '\u{1F4E8}',
  calendar_meeting: '\u{1F4C5}',
  task_update: '\u{1F4CB}',
  email_digest: '\u{1F4EC}',
}

/**
 * Compiles and delivers morning digest messages.
 * Aggregates important (digest-queued) and normal (on-demand) notification items
 * into a structured summary delivered via the user's preferred channel.
 */
export class DigestScheduler {
  private readonly dispatcher: NotificationDispatcher
  private readonly adapters: Map<string, ChannelAdapter>
  private readonly defaultUserId: string
  private readonly defaultChannelId: { telegram: string; slack?: string }

  constructor(config: DigestSchedulerConfig) {
    this.dispatcher = config.dispatcher
    this.adapters = config.adapters
    this.defaultUserId = config.defaultUserId
    this.defaultChannelId = config.defaultChannelId
  }

  /**
   * Compile pending digest and on-demand items into a formatted morning digest.
   * Returns the formatted message string.
   */
  async compileMorningDigest(userId: string): Promise<string> {
    const digestItems = await this.dispatcher.getPendingDigestItems(userId)
    const onDemandItems = await this.dispatcher.getPendingOnDemandItems(userId)

    if (digestItems.length === 0 && onDemandItems.length === 0) {
      return '\u{2615} No pending notifications. Have a great day!'
    }

    const lines: string[] = ['\u{1F31E} Good morning! Here\'s your digest:\n']

    if (digestItems.length > 0) {
      lines.push('<b>\u{2757} Important items:</b>')
      for (const item of digestItems) {
        lines.push(this.formatDigestItem(item))
      }
      lines.push('')
    }

    if (onDemandItems.length > 0) {
      lines.push('<b>\u{1F4CB} Normal items you might want to check:</b>')
      for (const item of onDemandItems) {
        lines.push(this.formatDigestItem(item))
      }
      lines.push('')
    }

    const total = digestItems.length + onDemandItems.length
    lines.push(`\u{2705} Total: ${total} item${total !== 1 ? 's' : ''}`)

    return lines.join('\n')
  }

  /**
   * Compile and deliver the morning digest to the user's preferred channel.
   */
  async deliverDigest(userId?: string): Promise<void> {
    const targetUser = userId ?? this.defaultUserId
    const digestText = await this.compileMorningDigest(targetUser)

    logger.info({ userId: targetUser }, 'Delivering morning digest')

    // Use Telegram as default delivery channel for digest
    const adapter = this.adapters.get('telegram')
    if (!adapter) {
      logger.error('No Telegram adapter available for digest delivery')
      return
    }

    await adapter.send({
      channelType: 'telegram',
      channelId: this.defaultChannelId.telegram,
      text: digestText,
    })

    logger.info({ userId: targetUser }, 'Morning digest delivered')
  }

  /**
   * Return the cron expression for the morning digest schedule.
   * Default: 8:00 AM daily.
   */
  getScheduledTime(): string {
    return '0 8 * * *'
  }

  /**
   * Format a single notification item for the digest.
   */
  private formatDigestItem(item: NotificationItem): string {
    const icon = CATEGORY_ICONS[item.category] ?? '\u{1F514}'
    return `  ${icon} <b>${item.title}</b>: ${item.body}`
  }
}
