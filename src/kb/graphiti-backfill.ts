#!/usr/bin/env node
/**
 * Backfill Graphiti knowledge graph from all configured sources.
 *
 * Resets watermarks for selected sources (or all), then runs graphiti-runner
 * which fetches items and sends them as episodes to Graphiti.
 *
 * Usage:
 *   npx tsx src/kb/graphiti-backfill.ts              # All sources
 *   npx tsx src/kb/graphiti-backfill.ts slack         # Slack only
 *   npx tsx src/kb/graphiti-backfill.ts gmail,clickup # Gmail + ClickUp
 *
 * The adapters' INITIAL_LOOKBACK_DAYS controls how far back data is fetched
 * on first run (when watermark is empty). Default: 90 days for most sources.
 */
import 'dotenv/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema.js'
import { runGraphitiIngestion } from './ingestion/graphiti-runner.js'
import { createSlackAdapters } from './ingestion/slack.js'
import { createGmailAdapters } from './ingestion/gmail.js'
import { createClickUpAdapter } from './ingestion/clickup.js'
import { createCalendarAdapters } from './ingestion/calendar.js'
import { createDriveAdapters } from './ingestion/drive.js'
import { createNotionAdapter } from './ingestion/notion.js'
import type { SourceAdapter } from './ingestion/types.js'

const sourceFilter = process.argv[2]?.split(',').map((s) => s.trim().toLowerCase()) ?? []

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const db = drizzle(pool, { schema })

  // Build adapters
  const allAdapters: SourceAdapter[] = []
  allAdapters.push(...createSlackAdapters())
  allAdapters.push(...await createGmailAdapters())
  allAdapters.push(...await createCalendarAdapters())
  allAdapters.push(...await createDriveAdapters())
  const clickup = createClickUpAdapter()
  if (clickup) allAdapters.push(clickup)
  const notion = createNotionAdapter()
  if (notion) allAdapters.push(notion)

  // Filter if specific sources requested
  const adapters = sourceFilter.length > 0
    ? allAdapters.filter((a) => sourceFilter.some((f) => a.name.startsWith(f) || a.source === f))
    : allAdapters

  if (adapters.length === 0) {
    console.error('No adapters matched. Available:', allAdapters.map((a) => a.name).join(', '))
    await pool.end()
    process.exit(1)
  }

  console.log(`Backfill: ${adapters.length} adapters: ${adapters.map((a) => a.name).join(', ')}`)

  // Reset watermarks for selected adapters
  for (const adapter of adapters) {
    await db.execute(sql`DELETE FROM kb_ingestion_state WHERE source = ${adapter.name}`)
    console.log(`  Reset watermark: ${adapter.name}`)
  }

  // Run Graphiti ingestion
  const startTime = Date.now()
  const stats = await runGraphitiIngestion(db, adapters)

  const totalCreated = stats.reduce((sum, s) => sum + s.episodesCreated, 0)
  const totalErrors = stats.reduce((sum, s) => sum + s.errors, 0)
  const durationMin = ((Date.now() - startTime) / 60_000).toFixed(1)

  console.log('\n── Backfill complete ──')
  for (const s of stats) {
    console.log(`  ${s.adapter}: ${s.episodesCreated} episodes, ${s.errors} errors, ${(s.durationMs / 1000).toFixed(0)}s`)
  }
  console.log(`\n  Total: ${totalCreated} episodes, ${totalErrors} errors, ${durationMin} min`)

  await pool.end()
}

main().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
