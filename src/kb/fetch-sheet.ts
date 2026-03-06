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

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files'

async function main(): Promise<void> {
  const fileId = process.argv[2]
  const format = process.argv[3] || 'tsv'

  if (!fileId) {
    console.error('Usage: npx tsx src/kb/fetch-sheet.ts <file-id> [tsv|csv]')
    console.error('  file-id: Google Drive file ID (from the spreadsheet URL)')
    console.error('  format: export format, default "tsv"')
    process.exit(1)
  }

  // Get access token
  const tokens = await resolveGoogleTokens()
  const token = tokens.get('dariy@astrocat.co')

  if (!token) {
    logger.error('No access token for dariy@astrocat.co')
    process.exit(1)
  }

  // Use Drive API to export the spreadsheet as TSV/CSV
  const mimeType = format === 'csv' ? 'text/csv' : 'text/tab-separated-values'
  const url = `${DRIVE_API}/${fileId}/export?mimeType=${encodeURIComponent(mimeType)}`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    const errBody = await res.text()
    logger.error({ status: res.status, body: errBody }, 'Failed to export file via Drive API')
    process.exit(1)
  }

  const content = await res.text()
  console.log(content)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ error: msg }, 'Failed to fetch spreadsheet')
    process.exit(1)
  })
