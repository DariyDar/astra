/**
 * CLI script to delete raw-ID person entities, reset Slack watermarks,
 * purge Slack chunks, and trigger re-ingestion with resolved names.
 *
 * Usage:
 *   npx tsx src/kb/reset-slack-entities.ts [--dry-run]
 */
import 'dotenv/config'
import { db, closeDb } from '../db/index.js'
import { kbEntities, kbEntityAliases, kbEntityRelations, kbChunks, kbIngestionState } from '../db/schema.js'
import { eq, and, sql, like } from 'drizzle-orm'
import { QdrantClient } from '@qdrant/js-client-rest'
import { logger } from '../logging/logger.js'

const RAW_ID_PATTERN = /^U[A-Z0-9]{8,}$/

async function main() {
  const isDryRun = process.argv.includes('--dry-run')
  if (isDryRun) logger.info('=== DRY RUN — no changes will be made ===')

  // 1. Delete raw-ID person entities
  const personEntities = await db.select({
    id: kbEntities.id,
    name: kbEntities.name,
  }).from(kbEntities).where(eq(kbEntities.type, 'person'))

  const rawIdEntities = personEntities.filter((e) => RAW_ID_PATTERN.test(e.name))
  logger.info({ total: rawIdEntities.length }, 'Found raw-ID person entities to delete')

  if (!isDryRun) {
    for (const entity of rawIdEntities) {
      // Delete aliases (CASCADE should handle, but be explicit)
      await db.delete(kbEntityAliases).where(eq(kbEntityAliases.entityId, entity.id))

      // Delete relations (both directions)
      await db.delete(kbEntityRelations).where(eq(kbEntityRelations.fromId, entity.id))
      await db.delete(kbEntityRelations).where(eq(kbEntityRelations.toId, entity.id))

      // Remove entity ID from chunk entity_ids arrays
      await db.execute(sql`
        UPDATE kb_chunks
        SET entity_ids = array_remove(entity_ids, ${entity.id})
        WHERE ${entity.id} = ANY(entity_ids)
      `)

      // Delete the entity
      await db.delete(kbEntities).where(eq(kbEntities.id, entity.id))

      logger.info({ id: entity.id, name: entity.name }, 'Deleted raw-ID entity')
    }
  }

  // 2. Reset Slack watermarks
  const slackStates = await db.select({
    id: kbIngestionState.id,
    source: kbIngestionState.source,
  }).from(kbIngestionState).where(like(kbIngestionState.source, 'slack:%'))

  logger.info({ count: slackStates.length }, 'Slack watermarks to reset')

  if (!isDryRun) {
    for (const state of slackStates) {
      await db.delete(kbIngestionState).where(eq(kbIngestionState.id, state.id))
      logger.info({ source: state.source }, 'Reset Slack watermark')
    }
  }

  // 3. Delete existing Slack chunks
  const [chunkCount] = await db.select({
    count: sql<number>`count(*)::int`,
  }).from(kbChunks).where(eq(kbChunks.source, 'slack'))

  logger.info({ chunks: chunkCount?.count ?? 0 }, 'Slack chunks to delete')

  if (!isDryRun) {
    // Delete from Qdrant first
    try {
      const qdrant = new QdrantClient({ url: process.env.QDRANT_URL })
      await qdrant.delete('astra_knowledge', {
        wait: true,
        filter: { must: [{ key: 'source', match: { value: 'slack' } }] },
      })
      logger.info('Deleted Slack vectors from Qdrant')
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.warn({ error: errMsg }, 'Qdrant Slack vector deletion failed')
    }

    // Delete from PostgreSQL
    await db.delete(kbChunks).where(eq(kbChunks.source, 'slack'))
    logger.info('Deleted Slack chunks from PostgreSQL')
  }

  // 4. Trigger re-ingestion (skip in dry-run)
  if (!isDryRun) {
    logger.info('Slack re-ingestion will happen on next nightly cron run (watermarks are reset)')
    logger.info('To trigger immediately, run: npx tsx src/kb/ingest-manual.ts slack')
  }

  // Summary
  logger.info({
    dryRun: isDryRun,
    entitiesDeleted: rawIdEntities.length,
    watermarksReset: slackStates.length,
    chunksDeleted: chunkCount?.count ?? 0,
  }, 'Reset Slack entities complete')

  await closeDb()
}

main().catch((err) => {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Reset failed')
  process.exit(1)
})
