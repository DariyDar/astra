import type { ChannelAdapter } from '../channels/types.js'
import { logger } from '../logging/logger.js'
import type { NotificationPreferences } from './preferences.js'
import type { NotificationItem } from './urgency.js'
import { classifyUrgency } from './urgency.js'

interface DispatcherConfig {
  adapters: Map<string, ChannelAdapter>
  preferences: NotificationPreferences
  defaultChannelId: {
    telegram: string
    slack?: string
  }
}

/**
 * Routes notifications to the correct channel based on user preferences and urgency.
 *
 * Urgency determines delivery timing:
 * - urgent: sent immediately via adapter.send()
 * - important: queued for morning digest
 * - normal: stored for on-demand retrieval
 */
export class NotificationDispatcher {
  private readonly adapters: Map<string, ChannelAdapter>
  private readonly preferences: NotificationPreferences
  private readonly defaultChannelId: { telegram: string; slack?: string }

  /** In-memory queue for digest items (important urgency), keyed by userId */
  private readonly digestQueue: Map<string, NotificationItem[]> = new Map()

  /** In-memory queue for on-demand items (normal urgency), keyed by userId */
  private readonly onDemandQueue: Map<string, NotificationItem[]> = new Map()

  constructor(config: DispatcherConfig) {
    this.adapters = config.adapters
    this.preferences = config.preferences
    this.defaultChannelId = config.defaultChannelId
  }

  /**
   * Dispatch a notification based on user preferences and urgency.
   *
   * 1. Look up preference for the item's category
   * 2. Classify urgency
   * 3. Route based on urgency level
   */
  async dispatch(userId: string, item: NotificationItem): Promise<void> {
    const allPrefs = await this.preferences.getAll(userId)
    const urgency = classifyUrgency(item, allPrefs)

    const pref = allPrefs.find((p) => p.category === item.category)
    const channel = pref?.deliveryChannel ?? 'telegram'

    logger.info(
      {
        userId,
        category: item.category,
        urgency,
        channel,
        source: item.source,
      },
      'Dispatching notification',
    )

    switch (urgency) {
      case 'urgent':
        await this.sendImmediate(userId, item, channel)
        break
      case 'important':
        this.addToDigestQueue(userId, item)
        break
      case 'normal':
        this.addToOnDemandQueue(userId, item)
        break
    }
  }

  /**
   * Return accumulated important items for digest, then clear the queue.
   */
  async getPendingDigestItems(userId: string): Promise<NotificationItem[]> {
    const items = this.digestQueue.get(userId) ?? []
    this.digestQueue.delete(userId)
    return items
  }

  /**
   * Return accumulated normal items for on-demand retrieval.
   */
  async getPendingOnDemandItems(userId: string): Promise<NotificationItem[]> {
    const items = this.onDemandQueue.get(userId) ?? []
    this.onDemandQueue.delete(userId)
    return items
  }

  /**
   * Send a notification immediately via the appropriate channel adapter.
   */
  private async sendImmediate(
    userId: string,
    item: NotificationItem,
    channel: 'telegram' | 'slack',
  ): Promise<void> {
    const adapter = this.adapters.get(channel)
    if (!adapter) {
      logger.warn(
        { channel, userId, category: item.category },
        'No adapter available for channel, falling back to telegram',
      )
      const fallback = this.adapters.get('telegram')
      if (!fallback) {
        logger.error({ userId, category: item.category }, 'No adapters available for immediate notification')
        return
      }
      await this.sendViaAdapter(fallback, 'telegram', item)
      return
    }

    await this.sendViaAdapter(adapter, channel, item)
  }

  /**
   * Format and send a notification item through an adapter.
   */
  private async sendViaAdapter(
    adapter: ChannelAdapter,
    channel: 'telegram' | 'slack',
    item: NotificationItem,
  ): Promise<void> {
    const channelId =
      channel === 'slack' && this.defaultChannelId.slack
        ? this.defaultChannelId.slack
        : this.defaultChannelId.telegram

    const text = this.formatNotification(item)

    await adapter.send({
      channelType: channel,
      channelId,
      text,
    })

    logger.debug(
      { channel, category: item.category },
      'Urgent notification sent',
    )
  }

  /**
   * Add an item to the digest queue (important urgency).
   */
  private addToDigestQueue(userId: string, item: NotificationItem): void {
    const queue = this.digestQueue.get(userId) ?? []
    queue.push(item)
    this.digestQueue.set(userId, queue)

    logger.debug(
      { userId, category: item.category, queueSize: queue.length },
      'Item added to digest queue',
    )
  }

  /**
   * Add an item to the on-demand queue (normal urgency).
   */
  private addToOnDemandQueue(userId: string, item: NotificationItem): void {
    const queue = this.onDemandQueue.get(userId) ?? []
    queue.push(item)
    this.onDemandQueue.set(userId, queue)

    logger.debug(
      { userId, category: item.category, queueSize: queue.length },
      'Item added to on-demand queue',
    )
  }

  /**
   * Format a notification item into a human-readable message.
   */
  private formatNotification(item: NotificationItem): string {
    const icon = this.getCategoryIcon(item.category)
    return `${icon} <b>${item.title}</b>\n${item.body}\n\n<i>Source: ${item.source}</i>`
  }

  /**
   * Get an emoji icon for a notification category.
   */
  private getCategoryIcon(category: string): string {
    const icons: Record<string, string> = {
      task_deadline: '\u{23F0}',
      email_urgent: '\u{1F4E8}',
      calendar_meeting: '\u{1F4C5}',
      task_update: '\u{1F4CB}',
      email_digest: '\u{1F4EC}',
    }
    return icons[category] ?? '\u{1F514}'
  }
}
