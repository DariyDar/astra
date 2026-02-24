import { eq, and } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { notificationPreferences } from '../db/schema.js'
import type { Preference, UrgencyLevel } from './urgency.js'

type DrizzleDb = NodePgDatabase<Record<string, unknown>>

/**
 * Default notification preferences for new users.
 * Each category has a sensible urgency level and delivery channel.
 */
const DEFAULT_PREFERENCES: Array<{
  category: string
  urgencyLevel: UrgencyLevel
  deliveryChannel: 'telegram' | 'slack'
}> = [
  { category: 'task_deadline', urgencyLevel: 'urgent', deliveryChannel: 'telegram' },
  { category: 'email_urgent', urgencyLevel: 'urgent', deliveryChannel: 'telegram' },
  { category: 'calendar_meeting', urgencyLevel: 'important', deliveryChannel: 'telegram' },
  { category: 'task_update', urgencyLevel: 'normal', deliveryChannel: 'telegram' },
  { category: 'email_digest', urgencyLevel: 'important', deliveryChannel: 'telegram' },
]

/**
 * CRUD operations for notification preferences.
 * Backed by the notification_preferences table with unique (userId, category) constraint.
 */
export class NotificationPreferences {
  private readonly db: DrizzleDb

  constructor(db: DrizzleDb) {
    this.db = db
  }

  /**
   * Find a single preference by userId and category.
   */
  async get(userId: string, category: string): Promise<Preference | null> {
    const rows = await this.db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, userId),
          eq(notificationPreferences.category, category),
        ),
      )
      .limit(1)

    if (rows.length === 0) return null

    return this.toPreference(rows[0])
  }

  /**
   * List all preferences for a user.
   */
  async getAll(userId: string): Promise<Preference[]> {
    const rows = await this.db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId))

    return rows.map((row) => this.toPreference(row))
  }

  /**
   * Upsert a preference: insert or update on conflict (userId, category).
   */
  async set(
    userId: string,
    category: string,
    urgencyLevel: UrgencyLevel,
    deliveryChannel: 'telegram' | 'slack',
  ): Promise<void> {
    await this.db
      .insert(notificationPreferences)
      .values({
        userId,
        category,
        urgencyLevel,
        deliveryChannel,
        enabled: true,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [notificationPreferences.userId, notificationPreferences.category],
        set: {
          urgencyLevel,
          deliveryChannel,
          enabled: true,
          updatedAt: new Date(),
        },
      })
  }

  /**
   * Enable or disable a specific preference.
   */
  async setEnabled(
    userId: string,
    category: string,
    enabled: boolean,
  ): Promise<void> {
    await this.db
      .update(notificationPreferences)
      .set({ enabled, updatedAt: new Date() })
      .where(
        and(
          eq(notificationPreferences.userId, userId),
          eq(notificationPreferences.category, category),
        ),
      )
  }

  /**
   * Remove a preference entirely.
   */
  async delete(userId: string, category: string): Promise<void> {
    await this.db
      .delete(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, userId),
          eq(notificationPreferences.category, category),
        ),
      )
  }

  /**
   * Return the default preference set (not persisted, used as template).
   */
  getDefaults(): Preference[] {
    return DEFAULT_PREFERENCES.map((d, i) => ({
      id: -(i + 1),
      userId: '',
      category: d.category,
      urgencyLevel: d.urgencyLevel,
      deliveryChannel: d.deliveryChannel,
      enabled: true,
      createdAt: null,
      updatedAt: null,
    }))
  }

  /**
   * Insert default preferences if the user has none.
   * Safe to call multiple times — only inserts when user has zero rows.
   */
  async ensureDefaults(userId: string): Promise<void> {
    const existing = await this.getAll(userId)
    if (existing.length > 0) return

    for (const d of DEFAULT_PREFERENCES) {
      await this.set(userId, d.category, d.urgencyLevel, d.deliveryChannel)
    }
  }

  /**
   * Map a DB row to the Preference interface.
   */
  private toPreference(row: typeof notificationPreferences.$inferSelect): Preference {
    return {
      id: row.id,
      userId: row.userId,
      category: row.category,
      urgencyLevel: row.urgencyLevel as UrgencyLevel,
      deliveryChannel: row.deliveryChannel as 'telegram' | 'slack',
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}
