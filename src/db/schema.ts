import {
  pgTable,
  serial,
  text,
  timestamp,
  jsonb,
  bigserial,
  index,
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
