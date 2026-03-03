#!/usr/bin/env node
/**
 * One-time Gmail cleanup script.
 * Classifies emails as system vs human, keeps last 200 per account deep-indexed,
 * converts the rest to metadata-only stubs.
 *
 * Usage: npx tsx src/kb/gmail-cleanup.ts [--dry-run]
 */
import 'dotenv/config'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { QdrantClient } from '@qdrant/js-client-rest'
import { sql, eq, and, inArray } from 'drizzle-orm'
import * as schema from '../db/schema.js'
import { kbChunks } from '../db/schema.js'
import { KBVectorStore } from './vector-store.js'
import { formatEmail, contentHash } from './chunker.js'
import { classifyEmail } from './gmail-classifier.js'
import { logger } from '../logging/logger.js'

const DEEP_INDEX_LIMIT = 200
const BATCH_SIZE = 100

interface EmailRow {
  sourceId: string
  account: string
  fromAddr: string
  subject: string
  sourceDate: Date | null
}

interface EmailInfo {
  sourceId: string
  emailType: 'system' | 'human'
  sourceDate: Date | null
}

const isDryRun = process.argv.includes('--dry-run')

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const db = drizzle(pool, { schema })
  const qdrantClient = new QdrantClient({ url: process.env.QDRANT_URL ?? 'http://localhost:6333' })
  const vectorStore = new KBVectorStore(qdrantClient)

  try {
    // Step 1 — Discover unique emails (one row per email via chunk_index=0)
    logger.info('Step 1: Discovering unique Gmail emails...')
    const emailResult = await pool.query<EmailRow>(`
      SELECT DISTINCT source_id AS "sourceId",
        metadata->>'account' AS account,
        metadata->>'from' AS "fromAddr",
        metadata->>'subject' AS subject,
        source_date AS "sourceDate"
      FROM kb_chunks
      WHERE source = 'gmail' AND chunk_index = 0
      ORDER BY source_date DESC
    `)

    const rows = emailResult.rows
    logger.info({ totalEmails: rows.length }, 'Discovered unique emails')

    // Step 2 — Classify each email and group by account
    logger.info('Step 2: Classifying emails...')
    const byAccount = new Map<string, EmailInfo[]>()
    const allEmailClassifications = new Map<string, 'system' | 'human'>()

    for (const row of rows) {
      const emailType = classifyEmail(row.fromAddr ?? '', row.subject ?? '')
      allEmailClassifications.set(row.sourceId, emailType)

      const account = row.account ?? 'unknown'
      const list = byAccount.get(account) ?? []
      list.push({ sourceId: row.sourceId, emailType, sourceDate: row.sourceDate })
      byAccount.set(account, list)
    }

    // Step 3 — Determine which emails to downgrade
    logger.info('Step 3: Determining emails to downgrade...')
    const sourceIdsToDowngrade: string[] = []
    const deepIndexedSourceIds: string[] = []

    for (const [account, emails] of Array.from(byAccount.entries())) {
      // Sort by sourceDate DESC (most recent first)
      emails.sort((a, b) => {
        const dateA = a.sourceDate?.getTime() ?? 0
        const dateB = b.sourceDate?.getTime() ?? 0
        return dateB - dateA
      })

      const systemCount = emails.filter((e) => e.emailType === 'system').length
      const humanCount = emails.filter((e) => e.emailType === 'human').length

      logger.info(
        { account, total: emails.length, system: systemCount, human: humanCount },
        'Account classification',
      )

      // Top N stay deep-indexed, rest downgrade
      const keepCount = Math.min(DEEP_INDEX_LIMIT, emails.length)
      for (let i = 0; i < emails.length; i++) {
        if (i < keepCount) {
          deepIndexedSourceIds.push(emails[i].sourceId)
        } else {
          sourceIdsToDowngrade.push(emails[i].sourceId)
        }
      }
    }

    // Step 4 — Print dry-run summary (always)
    logger.info('=== Gmail Cleanup Summary ===')
    logger.info({ totalEmails: rows.length }, 'Total emails')

    for (const [account, emails] of Array.from(byAccount.entries())) {
      const systemCount = emails.filter((e) => e.emailType === 'system').length
      const humanCount = emails.filter((e) => e.emailType === 'human').length
      const keepCount = Math.min(DEEP_INDEX_LIMIT, emails.length)
      const downgradeCount = emails.length - keepCount

      logger.info({
        account,
        total: emails.length,
        system: systemCount,
        human: humanCount,
        keepDeepIndexed: keepCount,
        downgradeToStub: downgradeCount,
      }, 'Account summary')
    }

    logger.info({
      emailsToDowngrade: sourceIdsToDowngrade.length,
      emailsKeepDeep: deepIndexedSourceIds.length,
    }, 'Cleanup plan')

    if (isDryRun) {
      logger.info('Dry-run mode — no changes made')
      return
    }

    // Step 5 — Delete Qdrant vectors FIRST (safety order)
    logger.info('Step 5: Deleting Qdrant vectors for downgraded emails...')
    let qdrantDeleted = 0
    for (let i = 0; i < sourceIdsToDowngrade.length; i += BATCH_SIZE) {
      const batch = sourceIdsToDowngrade.slice(i, i + BATCH_SIZE)
      for (const sourceId of batch) {
        try {
          await vectorStore.deleteBySourceId(sourceId)
          qdrantDeleted++
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error)
          logger.warn({ sourceId, error: errMsg }, 'Qdrant deletion failed (continuing)')
        }
      }
      logger.info(
        { progress: `${Math.min(i + BATCH_SIZE, sourceIdsToDowngrade.length)}/${sourceIdsToDowngrade.length}` },
        'Qdrant vector deletion progress',
      )
    }

    // Step 6 — Delete PG chunks with chunk_index > 0 for downgraded emails
    logger.info('Step 6: Deleting extra PG chunks for downgraded emails...')
    let pgChunksDeleted = 0
    for (let i = 0; i < sourceIdsToDowngrade.length; i += BATCH_SIZE) {
      const batch = sourceIdsToDowngrade.slice(i, i + BATCH_SIZE)
      try {
        const result = await db.delete(kbChunks).where(
          and(
            eq(kbChunks.source, 'gmail'),
            inArray(kbChunks.sourceId, batch),
            sql`${kbChunks.chunkIndex} > 0`,
          ),
        )
        pgChunksDeleted += (result as unknown as { rowCount: number }).rowCount ?? 0
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        logger.error({ batch: batch.slice(0, 3), error: errMsg }, 'PG chunk deletion failed')
        throw new Error(`PG chunk deletion failed: ${errMsg}`)
      }
    }
    logger.info({ pgChunksDeleted }, 'Extra PG chunks deleted')

    // Step 7 — Update chunk_index=0 stubs for downgraded emails (batch SELECT)
    logger.info('Step 7: Updating stubs for downgraded emails...')
    let stubsUpdated = 0
    for (let i = 0; i < sourceIdsToDowngrade.length; i += BATCH_SIZE) {
      const batch = sourceIdsToDowngrade.slice(i, i + BATCH_SIZE)
      try {
        const rows = await db.select({
          id: kbChunks.id,
          sourceId: kbChunks.sourceId,
          metadata: kbChunks.metadata,
        })
          .from(kbChunks)
          .where(and(
            eq(kbChunks.source, 'gmail'),
            inArray(kbChunks.sourceId, batch),
            eq(kbChunks.chunkIndex, 0),
          ))

        for (const row of rows) {
          const meta = (row.metadata ?? {}) as Record<string, unknown>
          const stubText = formatEmail({
            from: (meta.from as string) ?? '',
            to: (meta.to as string) ?? '',
            subject: (meta.subject as string) ?? '',
            body: '[metadata-only stub]',
            date: meta.date as string,
          })
          const hash = contentHash(stubText)
          const emailType = allEmailClassifications.get(row.sourceId) ?? 'human'

          await db.update(kbChunks)
            .set({
              text: stubText,
              contentHash: hash,
              qdrantId: null,
              metadata: { ...meta, emailType },
            })
            .where(eq(kbChunks.id, row.id))

          stubsUpdated++
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        logger.error({ batch: batch.slice(0, 3), error: errMsg }, 'Stub update failed')
        throw new Error(`Stub update failed: ${errMsg}`)
      }
      logger.info(
        { progress: `${Math.min(i + BATCH_SIZE, sourceIdsToDowngrade.length)}/${sourceIdsToDowngrade.length}` },
        'Stub update progress',
      )
    }
    logger.info({ stubsUpdated }, 'Stubs updated')

    // Step 8 — Tag deep-indexed emails (top 200) with emailType (batched by type)
    logger.info('Step 8: Tagging deep-indexed emails with emailType...')
    let deepTagged = 0
    const humanIds = deepIndexedSourceIds.filter((id) => allEmailClassifications.get(id) !== 'system')
    const systemIds = deepIndexedSourceIds.filter((id) => allEmailClassifications.get(id) === 'system')

    for (const [emailType, ids] of [['human', humanIds], ['system', systemIds]] as const) {
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE)
        try {
          const patch = JSON.stringify({ emailType })
          await db.update(kbChunks)
            .set({ metadata: sql`metadata || ${patch}::jsonb` })
            .where(and(
              eq(kbChunks.source, 'gmail'),
              inArray(kbChunks.sourceId, batch),
            ))
          deepTagged += batch.length
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error)
          logger.warn({ emailType, batchSize: batch.length, error: errMsg }, 'Deep-index tagging failed (continuing)')
        }
      }
    }
    logger.info({ deepTagged }, 'Deep-indexed emails tagged')

    // Step 9 — Final summary
    logger.info('=== Cleanup Complete ===')
    logger.info({
      qdrantVectorsRemoved: qdrantDeleted,
      pgChunksDeleted,
      stubsUpdated,
      deepIndexedTagged: deepTagged,
    }, 'Final results')
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    logger.error({ error: errMsg }, 'Gmail cleanup failed')
    process.exit(1)
  } finally {
    await pool.end()
  }
}

main()
