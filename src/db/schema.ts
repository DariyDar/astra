import {
  pgTable,
  serial,
  text,
  timestamp,
  jsonb,
  bigserial,
  boolean,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/**
 * Encrypted credentials table.
 * Stores API tokens and OAuth refresh tokens encrypted with AES-256-GCM.
 * Each row contains the ciphertext, IV, and auth tag needed for decryption.
 */
export const credentials = pgTable('credentials', {
  id: serial('id').primaryKey(),
  name: text('name').unique().notNull(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

/**
 * Audit trail table.
 * Logs every bot action with correlation ID for traceability.
 * 30-day retention with automatic cleanup via scheduled job.
 */
export const auditTrail = pgTable(
  'audit_trail',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    correlationId: text('correlation_id').notNull(),
    userId: text('user_id'),
    action: text('action').notNull(),
    source: text('source'),
    model: text('model'),
    metadata: jsonb('metadata'),
    status: text('status').notNull(),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('audit_trail_created_at_idx').on(table.createdAt),
    index('audit_trail_correlation_id_idx').on(table.correlationId),
  ],
)

/**
 * Messages table.
 * Stores all inbound and outbound messages across channels (Telegram, Slack).
 * Supports the three-tier memory model and conversation history retrieval.
 */
export const messages = pgTable(
  'messages',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    externalId: text('external_id').notNull(),
    channelType: text('channel_type').notNull(),
    channelId: text('channel_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role').notNull(),
    text: text('text').notNull(),
    language: text('language'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('messages_channel_type_idx').on(table.channelType),
    index('messages_channel_id_idx').on(table.channelId),
    index('messages_created_at_idx').on(table.createdAt),
    index('messages_channel_created_idx').on(table.channelId, table.createdAt),
  ],
)

/**
 * Notification preferences table.
 * Stores per-user notification routing preferences by category and urgency.
 * Used by the notification system to determine delivery channel and filtering.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').notNull(),
    category: text('category').notNull(),
    urgencyLevel: text('urgency_level').notNull(),
    deliveryChannel: text('delivery_channel').notNull(),
    enabled: boolean('enabled').default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex('notification_preferences_user_category_idx').on(
      table.userId,
      table.category,
    ),
  ],
)

/**
 * User feedback table.
 * Foundation for Phase 7 self-learning system.
 * Stores natural language feedback with auto-classification and importance scoring.
 */
export const userFeedback = pgTable(
  'user_feedback',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    userId: text('user_id').notNull(),
    context: text('context').notNull(),
    feedbackText: text('feedback_text').notNull(),
    category: text('category'),
    importanceScore: real('importance_score'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('user_feedback_created_at_idx').on(table.createdAt),
    index('user_feedback_user_id_idx').on(table.userId),
  ],
)
