#!/usr/bin/env node
/**
 * Manual knowledge extraction — unified extraction (entities + facts + documents).
 * Usage: npx tsx src/kb/extract-knowledge-manual.ts [options]
 *
 * Options:
 *   --max-batches N   Max number of batches (default: 200)
 *   --max-time N      Max time in minutes (default: 60)
 *   --batch-size N    Chunks per batch (default: 100)
 *   --delay N         Seconds between batches to avoid rate limits (default: 10)
 *   --provider P      LLM provider: gemini (default) or claude
 *   --sources S       Comma-separated sources to process (e.g. slack,clickup). All if omitted
 *   --skip-mark       Skip marking low-value chunks (if already done)
 *   --dry-run         Only count chunks and estimate, don't extract
 *   --reset-source S  Reset extraction flags for source S before running
 *   --reset-all       Reset ALL extraction flags before running
 */
import 'dotenv/config'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { QdrantClient } from '@qdrant/js-client-rest'
import * as schema from '../db/schema.js'
import { extractKnowledgeBatch, markLowValueChunks, type LlmProvider } from './knowledge-extractor.js'
import { countUnprocessedChunks, resetExtractionFlags } from './repository.js'
import { logger } from '../logging/logger.js'
import type { ChunkSource } from './types.js'

function parseArg(flag: string, defaultVal: number): number {
  const idx = process.argv.indexOf(flag)
  if (idx === -1 || idx + 1 >= process.argv.length) return defaultVal
  const val = Number(process.argv[idx + 1])
  return Number.isFinite(val) ? val : defaultVal
}

function parseStringArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag)
  if (idx === -1 || idx + 1 >= process.argv.length) return null
  return process.argv[idx + 1]
}

const maxBatches = parseArg('--max-batches', 200)
const maxTime = parseArg('--max-time', 60)
const batchSize = parseArg('--batch-size', 100)
const delay = parseArg('--delay', 10)
const provider = (parseStringArg('--provider') ?? 'gemini') as LlmProvider
const sourcesArg = parseStringArg('--sources')
const sources = sourcesArg ? sourcesArg.split(',').map((s) => s.trim()) : undefined
const skipMark = process.argv.includes('--skip-mark')
const dryRun = process.argv.includes('--dry-run')
const resetSource = parseStringArg('--reset-source')
const resetAll = process.argv.includes('--reset-all')

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const db = drizzle(pool, { schema })
  const qdrantClient = new QdrantClient({ url: process.env.QDRANT_URL ?? 'http://localhost:6333' })

  try {
    // Step 0: Reset extraction flags if requested
    if (resetAll) {
      logger.info('Step 0: Resetting ALL extraction flags...')
      const resetCount = await resetExtractionFlags(db)
      logger.info({ resetCount }, 'Extraction flags reset')
    } else if (resetSource) {
      logger.info({ source: resetSource }, 'Step 0: Resetting extraction flags for source...')
      const resetCount = await resetExtractionFlags(db, { source: resetSource as ChunkSource })
      logger.info({ resetCount, source: resetSource }, 'Extraction flags reset')
    }

    // Step 1: Mark low-value chunks
    if (!skipMark) {
      logger.info('Step 1: Marking low-value chunks as processed...')
      const marked = await markLowValueChunks(db)
      logger.info({ marked }, 'Low-value chunks marked')
    } else {
      logger.info('Step 1: Skipped (--skip-mark)')
    }

    // Step 2: Count remaining
    const remaining = await countUnprocessedChunks(db, sources)
    const estBatches = Math.ceil(remaining / batchSize)
    const estTimeMin = Math.ceil(estBatches * 0.2) // ~12s per batch with rate limiter

    logger.info({
      remainingChunks: remaining,
      estimatedBatches: estBatches,
      estimatedTimeMin: estTimeMin,
      provider,
      sources: sources ?? 'all',
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
      maxTimeMin: maxTime,
      batchSize,
      interBatchDelaySec: delay,
      provider,
    }, 'Step 3: Starting knowledge extraction...')

    const stats = await extractKnowledgeBatch(db, {
      maxBatches,
      maxTimeMinutes: maxTime,
      chunkBatchSize: batchSize,
      interBatchDelaySec: delay,
      provider,
      sources,
    }, qdrantClient)

    logger.info({
      batches: stats.totalBatches,
      chunks: stats.totalChunks,
      entities: stats.totalEntities,
      relations: stats.totalRelations,
      facts: stats.totalFacts,
      documents: stats.totalDocuments,
      remaining: stats.remainingUnprocessed,
      stoppedReason: stats.stoppedReason,
    }, '=== Knowledge Extraction Results ===')
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  const errMsg = err instanceof Error ? err.message : String(err)
  logger.error({ error: errMsg }, 'Knowledge extraction failed')
  process.exit(1)
})
