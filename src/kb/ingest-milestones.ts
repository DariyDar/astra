#!/usr/bin/env node
/**
 * One-shot script to fetch Netflix milestones from Google Sheets and
 * ingest them as KB facts for SpongeBob Get Cookin' entity.
 *
 * Usage:
 *   npx tsx src/kb/ingest-milestones.ts
 */

import 'dotenv/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, and } from 'drizzle-orm'
import pg from 'pg'
import * as schema from '../db/schema.js'
import { kbEntities, kbAliases } from '../db/schema.js'
import { addFact } from './repository.js'
import { resolveGoogleTokens } from '../mcp/briefing/google-auth.js'
import { logger } from '../logging/logger.js'

const SPREADSHEET_ID = '1CdcaKnY6qnsJNBT8lQAwzlYRjtrFEtq8LnGW3RtQT1k'
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files'

interface MilestoneRow {
  code: string       // M00, M01, ...
  details: string    // milestone description
  date: Date         // delivery date
  notes: string      // additional notes
}

function parseDate(dateStr: string): Date | null {
  // Format: "M/D/YY" or "MM/DD/YY"
  const parts = dateStr.trim().split('/')
  if (parts.length !== 3) return null

  const month = parseInt(parts[0], 10) - 1
  const day = parseInt(parts[1], 10)
  let year = parseInt(parts[2], 10)
  // Convert 2-digit year: 25 → 2025, 26 → 2026, etc.
  if (year < 100) year += 2000

  const d = new Date(year, month, day)
  return isNaN(d.getTime()) ? null : d
}

function parseTsv(content: string): MilestoneRow[] {
  const lines = content.trim().split('\n')
  // Skip header
  const rows: MilestoneRow[] = []

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    if (cols.length < 3) continue

    const code = cols[0]?.trim()
    const details = cols[1]?.trim()
    const dateStr = cols[2]?.trim()
    const notes = cols[3]?.trim() || ''

    if (!code || !details || !dateStr) continue

    const date = parseDate(dateStr)
    if (!date) {
      logger.warn({ code, dateStr }, 'Could not parse date')
      continue
    }

    rows.push({ code, details, date, notes })
  }

  return rows
}

async function findEntityId(
  db: ReturnType<typeof drizzle<typeof schema>>,
  name: string,
): Promise<number | null> {
  // Try exact match first
  const [entity] = await db.select({ id: kbEntities.id })
    .from(kbEntities)
    .where(eq(kbEntities.name, name))
    .limit(1)
  if (entity) return entity.id

  // Try via aliases
  const [alias] = await db.select({ entityId: kbAliases.entityId })
    .from(kbAliases)
    .where(eq(kbAliases.alias, name))
    .limit(1)
  if (alias) return alias.entityId

  return null
}

async function main(): Promise<void> {
  logger.info('Fetching Netflix milestones from Google Sheets')

  // Get access token
  const tokens = await resolveGoogleTokens()
  const token = tokens.get('dariy@astrocat.co')
  if (!token) {
    logger.error('No access token for dariy@astrocat.co')
    process.exit(1)
  }

  // Fetch spreadsheet via Drive API export
  const url = `${DRIVE_API}/${SPREADSHEET_ID}/export?mimeType=${encodeURIComponent('text/tab-separated-values')}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const body = await res.text()
    logger.error({ status: res.status, body }, 'Failed to export spreadsheet')
    process.exit(1)
  }

  const content = await res.text()
  const milestones = parseTsv(content)
  logger.info({ count: milestones.length }, 'Parsed milestones')

  // Connect to DB
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const db = drizzle(pool, { schema })

  // Find SpongeBob Get Cookin' entity
  const entityId = await findEntityId(db, "SpongeBob Get Cookin'")
  if (!entityId) {
    logger.error("Entity 'SpongeBob Get Cookin'' not found in KB")
    await pool.end()
    process.exit(1)
  }
  logger.info({ entityId }, "Found SpongeBob Get Cookin' entity")

  let created = 0
  let skipped = 0

  for (const m of milestones) {
    const statusStr = m.notes.toLowerCase().includes('completed') ? ' [Completed]' : ''
    const notesStr = m.notes && !m.notes.toLowerCase().includes('completed')
      ? ` — ${m.notes}`
      : ''

    const text = `${m.code}: ${m.details}${statusStr}${notesStr}`

    try {
      const id = await addFact(db, {
        entityId,
        factDate: m.date,
        factType: 'milestone',
        text,
        source: 'clickup', // Using clickup as source since it's a project management artifact
        confidence: 1.0,
        metadata: {
          milestoneCode: m.code,
          deliveryDate: m.date.toISOString().split('T')[0],
          completed: m.notes.toLowerCase().includes('completed'),
          notes: m.notes || undefined,
          spreadsheetId: SPREADSHEET_ID,
        },
      })

      // Check if it was a new fact or existing
      // addFact returns existing ID if duplicate, but we can't tell from the return value alone
      // So we just count all
      created++
      logger.info({ milestone: m.code, date: m.date.toISOString().split('T')[0], factId: id }, 'Milestone fact added')
    } catch (error) {
      skipped++
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn({ milestone: m.code, error: msg }, 'Failed to add milestone fact')
    }
  }

  logger.info({ created, skipped, total: milestones.length }, 'Milestone ingestion complete')

  await pool.end()
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ error: msg }, 'Milestone ingestion failed')
    process.exit(1)
  })
