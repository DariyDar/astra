/**
 * Urgency classification for the notification system.
 * Three levels determine delivery timing:
 * - urgent: delivered immediately
 * - important: included in morning digest
 * - normal: available on-demand only
 */

export type UrgencyLevel = 'urgent' | 'important' | 'normal'

export interface NotificationItem {
  /** Matches a preference category (e.g. 'task_deadline', 'email_urgent') */
  category: string
  title: string
  body: string
  /** Origin integration (e.g. 'clickup', 'gmail', 'calendar', 'slack') */
  source: string
  metadata?: Record<string, unknown>
  createdAt: Date
}

export interface Preference {
  id: number
  userId: string
  category: string
  urgencyLevel: UrgencyLevel
  deliveryChannel: 'telegram' | 'slack'
  enabled: boolean | null
  createdAt: Date | null
  updatedAt: Date | null
}

/**
 * Classify urgency of a notification item based on user preferences.
 * Looks up the item's category in the user's preference list.
 * Returns the configured urgency level if found and enabled, otherwise 'normal'.
 */
export function classifyUrgency(
  item: NotificationItem,
  preferences: Preference[],
): UrgencyLevel {
  const pref = preferences.find(
    (p) => p.category === item.category && p.enabled !== false,
  )

  if (pref) {
    return pref.urgencyLevel as UrgencyLevel
  }

  return 'normal'
}
