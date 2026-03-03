#!/usr/bin/env node
/**
 * Manual KB ingestion — run a single source adapter.
 * Usage: npx tsx src/kb/ingest-manual.ts <source>
 *
 * Sources: slack, gmail, clickup, calendar, drive, notion
 * Example: npx tsx src/kb/ingest-manual.ts slack
 */
import 'dotenv/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { QdrantClient } from '@qdrant/js-client-rest'
import * as schema from '../db/schema.js'
import { KBVectorStore } from './vector-store.js'
import { runIngestion } from './ingestion/runner.js'
import { createSlackAdapters } from './ingestion/slack.js'
import { createGmailAdapters } from './ingestion/gmail.js'
import { createClickUpAdapter } from './ingestion/clickup.js'
import { createCalendarAdapters } from './ingestion/calendar.js'
import { createDriveAdapters } from './ingestion/drive.js'
import { createNotionAdapter } from './ingestion/notion.js'
import type { SourceAdapter } from './ingestion/types.js'

const source = process.argv[2]
if (!source) {
  console.log('Usage: npx tsx src/kb/ingest-manual.ts <source>')
  console.log('Sources: slack, gmail, clickup, calendar, drive, notion, all')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const db = drizzle(pool, { schema })
const qdrantClient = new QdrantClient({ url: process.env.QDRANT_URL ?? 'http://localhost:6333' })
const vectorStore = new KBVectorStore(qdrantClient)

await vectorStore.ensureCollection()

const adapters: SourceAdapter[] = []

if (source === 'slack' || source === 'all') {
  adapters.push(...createSlackAdapters())
}
if (source === 'gmail' || source === 'all') {
  adapters.push(...await createGmailAdapters())
}
if (source === 'clickup' || source === 'all') {
  const clickup = createClickUpAdapter()
  if (clickup) adapters.push(clickup)
  else console.log('  ClickUp: not configured (skipped)')
}
if (source === 'calendar' || source === 'all') {
  adapters.push(...await createCalendarAdapters())
}
if (source === 'drive' || source === 'all') {
  adapters.push(...await createDriveAdapters())
}
if (source === 'notion' || source === 'all') {
  const notion = createNotionAdapter()
  if (notion) adapters.push(notion)
  else console.log('  Notion: not configured (skipped)')
}

if (adapters.length === 0) {
  console.log(`No adapters found for source: ${source}`)
  await pool.end()
  process.exit(1)
}

console.log(`\nRunning ingestion for: ${adapters.map(a => a.name).join(', ')}\n`)

const stats = await runIngestion(db, vectorStore, adapters)

console.log('\n=== Results ===')
for (const s of stats) {
  console.log(`  ${s.adapter}:`)
  console.log(`    Fetched: ${s.itemsFetched} items`)
  console.log(`    Created: ${s.chunksCreated} chunks`)
  console.log(`    Skipped: ${s.chunksSkipped} (duplicates)`)
  console.log(`    Errors:  ${s.errors}`)
  console.log(`    Time:    ${s.durationMs}ms`)
}

const totalCreated = stats.reduce((sum, s) => sum + s.chunksCreated, 0)
const totalErrors = stats.reduce((sum, s) => sum + s.errors, 0)
console.log(`\nTotal: ${totalCreated} chunks created, ${totalErrors} errors`)

await pool.end()
