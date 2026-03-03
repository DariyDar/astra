#!/usr/bin/env node
/**
 * Manual entity extraction -- run bulk extraction on existing KB chunks.
 * Usage: npx tsx src/kb/extract-entities-manual.ts [options]
 *
 * Options:
 *   --max-batches N   Max number of batches (default: 200)
 *   --max-cost N      Max cost in USD (default: 15)
 *   --max-time N      Max time in minutes (default: 180)
 *   --batch-size N    Chunks per batch (default: 50)
 *   --skip-mark       Skip marking low-value chunks (if already done)
 *   --dry-run         Only count chunks and estimate cost, don't extract
 */
import 'dotenv/config'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { QdrantClient } from '@qdrant/js-client-rest'
import * as schema from '../db/schema.js'
import { extractEntitiesBatch, markLowValueChunks } from './entity-extractor.js'
import { countUnprocessedChunks } from './repository.js'
import { logger } from '../logging/logger.js'

function parseArg(flag: string, defaultVal: number): number {
  const idx = process.argv.indexOf(flag)
  if (idx === -1 || idx + 1 >= process.argv.length) return defaultVal
  const val = Number(process.argv[idx + 1])
  return Number.isFinite(val) ? val : defaultVal
}

const maxBatches = parseArg('--max-batches', 200)
const maxCost = parseArg('--max-cost', 15)
const maxTime = parseArg('--max-time', 180)
const batchSize = parseArg('--batch-size', 50)
const skipMark = process.argv.includes('--skip-mark')
const dryRun = process.argv.includes('--dry-run')

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const db = drizzle(pool, { schema })
  const qdrantClient = new QdrantClient({ url: process.env.QDRANT_URL ?? 'http://localhost:6333' })

  try {
    // Step 1: Mark low-value chunks
    if (!skipMark) {
      logger.info('Step 1: Marking low-value chunks as processed...')
      const marked = await markLowValueChunks(db)
      logger.info({ marked }, 'Low-value chunks marked')
    } else {
      logger.info('Step 1: Skipped (--skip-mark)')
    }

    // Step 2: Count remaining
    const remaining = await countUnprocessedChunks(db)
    const estBatches = Math.ceil(remaining / batchSize)
    const estCost = (estBatches * 0.044).toFixed(2)
    const estTimeMin = Math.ceil(estBatches * 0.5)

    logger.info({
      remainingChunks: remaining,
      estimatedBatches: estBatches,
      estimatedCostUsd: estCost,
      estimatedTimeMin: estTimeMin,
    }, 'Step 2: Chunk count and estimates')

    if (remaining === 0) {
      logger.info('No unprocessed chunks remaining. Nothing to do.')
      return
    }

    if (dryRun) {
      logger.info('Dry-run mode -- no extraction performed')
      return
    }

    // Step 3: Run extraction
    logger.info({
      maxBatches,
      maxCostUsd: maxCost,
      maxTimeMin: maxTime,
      batchSize,
    }, 'Step 3: Starting bulk extraction...')

    const stats = await extractEntitiesBatch(db, {
      maxBatches,
      maxCostUsd: maxCost,
      maxTimeMinutes: maxTime,
      chunkBatchSize: batchSize,
    }, qdrantClient)

    logger.info({
      batches: stats.totalBatches,
      chunks: stats.totalChunks,
      entities: stats.totalEntities,
      relations: stats.totalRelations,
      costUsd: stats.totalCostUsd.toFixed(2),
      remaining: stats.remainingUnprocessed,
      stoppedReason: stats.stoppedReason,
    }, '=== Entity Extraction Results ===')
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  const errMsg = err instanceof Error ? err.message : String(err)
  logger.error({ error: errMsg }, 'Entity extraction failed')
  process.exit(1)
})
