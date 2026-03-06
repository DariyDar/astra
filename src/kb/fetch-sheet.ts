#!/usr/bin/env node
/**
 * One-shot script to fetch a Google Spreadsheet and print its content.
 *
 * Usage:
 *   npx tsx src/kb/fetch-sheet.ts <spreadsheet-id> [sheet-name-or-range]
 *
 * Example:
 *   npx tsx src/kb/fetch-sheet.ts 1CdcaKnY6qnsJNBT8lQAwzlYRjtrFEtq8LnGW3RtQT1k
 */

import 'dotenv/config'
import { resolveGoogleTokens } from '../mcp/briefing/google-auth.js'
import { logger } from '../logging/logger.js'

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'

async function main(): Promise<void> {
  const spreadsheetId = process.argv[2]
  const range = process.argv[3] || 'Sheet1'

  if (!spreadsheetId) {
    console.error('Usage: npx tsx src/kb/fetch-sheet.ts <spreadsheet-id> [range]')
    process.exit(1)
  }

  // Get access token
  const tokens = await resolveGoogleTokens()
  const token = tokens.get('dariy@astrocat.co')

  if (!token) {
    logger.error('No access token for dariy@astrocat.co')
    process.exit(1)
  }

  // First, get spreadsheet metadata to see available sheets
  const metaUrl = `${SHEETS_API}/${spreadsheetId}?fields=sheets.properties.title`
  const metaRes = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!metaRes.ok) {
    const errBody = await metaRes.text()
    logger.error({ status: metaRes.status, body: errBody }, 'Failed to fetch spreadsheet metadata')
    process.exit(1)
  }

  const meta = (await metaRes.json()) as { sheets: Array<{ properties: { title: string } }> }
  const sheetNames = meta.sheets.map((s) => s.properties.title)
  console.log('Available sheets:', sheetNames.join(', '))

  // Fetch values from each sheet (or specified range)
  const sheetsToFetch = process.argv[3] ? [range] : sheetNames

  for (const sheet of sheetsToFetch) {
    const url = `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(sheet)}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      const errBody = await res.text()
      logger.error({ status: res.status, sheet, body: errBody }, 'Failed to fetch sheet values')
      continue
    }

    const data = (await res.json()) as { values?: string[][] }
    console.log(`\n=== ${sheet} ===`)

    if (!data.values || data.values.length === 0) {
      console.log('(empty)')
      continue
    }

    for (const row of data.values) {
      console.log(row.join('\t'))
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ error: msg }, 'Failed to fetch spreadsheet')
    process.exit(1)
  })
