import {
  pgTable,
  serial,
  text,
  timestamp,
  jsonb,
  bigserial,
  boolean,
  real,
  integer,
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

// ── Knowledge Base tables (Phase 4) ──

/**
 * KB entities — people, projects, channels, clients, companies, processes.
 * Each entity has a canonical name and type. Aliases stored separately.
 */
export const kbEntities = pgTable(
  'kb_entities',
  {
    id: serial('id').primaryKey(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    company: text('company'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('kb_entities_type_name_idx').on(table.type, table.name),
    index('kb_entities_type_idx').on(table.type),
  ],
)

/**
 * KB entity aliases — cross-language alternative names for entities.
 * Семён = Semyon = Syoma, Никита Кокарев = Nikita = NK.
 */
export const kbEntityAliases = pgTable(
  'kb_entity_aliases',
  {
    id: serial('id').primaryKey(),
    entityId: integer('entity_id').notNull().references(() => kbEntities.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
    language: text('language'),
  },
  (table) => [
    uniqueIndex('kb_entity_aliases_alias_idx').on(table.alias),
    index('kb_entity_aliases_entity_id_idx').on(table.entityId),
  ],
)

/**
 * KB entity relations — connections between entities with role, status, and period.
 * E.g., person "Семён" works_on project "Level One" as "developer" since "2024-01".
 */
export const kbEntityRelations = pgTable(
  'kb_entity_relations',
  {
    id: serial('id').primaryKey(),
    fromId: integer('from_id').notNull().references(() => kbEntities.id, { onDelete: 'cascade' }),
    toId: integer('to_id').notNull().references(() => kbEntities.id, { onDelete: 'cascade' }),
    relation: text('relation').notNull(),
    role: text('role'),
    status: text('status').default('active'),
    period: text('period'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('kb_entity_relations_from_idx').on(table.fromId),
    index('kb_entity_relations_to_idx').on(table.toId),
    index('kb_entity_relations_relation_idx').on(table.relation),
  ],
)

/**
 * KB chunks — text fragments from all sources, linked to Qdrant vectors.
 * Each chunk has a content hash for deduplication and optional entity references.
 */
export const kbChunks = pgTable(
  'kb_chunks',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    chunkIndex: integer('chunk_index').default(0).notNull(),
    contentHash: text('content_hash').notNull(),
    text: text('text').notNull(),
    qdrantId: text('qdrant_id'),
    entityIds: integer('entity_ids').array(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    sourceDate: timestamp('source_date', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('kb_chunks_source_id_idx').on(table.source, table.sourceId, table.chunkIndex),
    index('kb_chunks_source_idx').on(table.source),
    index('kb_chunks_content_hash_idx').on(table.contentHash),
    index('kb_chunks_source_date_idx').on(table.sourceDate),
  ],
)

/**
 * KB ingestion state — tracks watermarks for incremental sync per source.
 * Each source (e.g., 'slack:ac', 'gmail:dariy') has its own cursor.
 */
export const kbIngestionState = pgTable(
  'kb_ingestion_state',
  {
    id: serial('id').primaryKey(),
    source: text('source').unique().notNull(),
    watermark: text('watermark').notNull(),
    lastRun: timestamp('last_run', { withTimezone: true }),
    itemsTotal: integer('items_total').default(0),
    status: text('status').default('idle'),
    error: text('error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
)
