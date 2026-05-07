/**
 * Wiki audit orchestrator.
 *
 * Scans Notion + ClickUp Docs, maps each page to a vault project (active only),
 * generates AI summaries, and writes a Google Sheet to Drive at:
 *   "Astro Cat Space / Company Wiki / Проектная документация / _audit/Wiki Content Audit"
 *
 * Usage:
 *   npx tsx scripts/wiki-audit/index.ts                    # full run
 *   npx tsx scripts/wiki-audit/index.ts --dry-run          # collect, write CSV locally, skip Drive + summaries
 *   npx tsx scripts/wiki-audit/index.ts --limit 5          # 5 items per source (for testing)
 *   npx tsx scripts/wiki-audit/index.ts --no-summary       # skip AI summary generation
 *   npx tsx scripts/wiki-audit/index.ts --skip-notion      # only ClickUp
 *   npx tsx scripts/wiki-audit/index.ts --skip-clickup     # only Notion
 *   npx tsx scripts/wiki-audit/index.ts --csv path.csv     # also write CSV alongside Sheet
 *
 * Required ENV: NOTION_TOKEN, CLICKUP_API_KEY, CLICKUP_TEAM_ID.
 * Google credentials: ~/.google_workspace_mcp/credentials/dariy@astrocat.co.json
 */

import 'dotenv/config'
import { resolveGoogleTokens, GOOGLE_ACCOUNTS } from '../../src/mcp/briefing/google-auth.js'
import { NotionClient } from '../lib/notion-client.js'
import { ClickUpClient } from '../lib/clickup-client.js'
import { DriveClient } from '../lib/drive-client.js'
import { loadProjectMatchers } from './project-matcher.js'
import { scanNotion } from './notion-scanner.js'
import { scanClickUp } from './clickup-scanner.js'
import { summarizeRows } from './summarizer.js'
import { writeSheet, writeCsvToFile } from './sheet-writer.js'
import type { AuditRow } from './types.js'

const args = process.argv.slice(2)
function arg(name: string): string | null {
  const i = args.indexOf(name)
  if (i === -1) return null
  return args[i + 1] ?? null
}
function flag(name: string): boolean {
  return args.includes(name)
}

const DRY_RUN = flag('--dry-run')
const NO_SUMMARY = flag('--no-summary')
const SKIP_NOTION = flag('--skip-notion')
const SKIP_CLICKUP = flag('--skip-clickup')
const LIMIT = arg('--limit') ? parseInt(arg('--limit')!, 10) : undefined
const CSV_PATH = arg('--csv')
const SHEET_NAME = arg('--sheet-name') ?? `Wiki Content Audit ${new Date().toISOString().slice(0, 10)}`
const PROJECT_FILTER = arg('--project')

async function main(): Promise<void> {
  console.log('=== Wiki Content Audit ===')
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no Drive upload, no summaries)' : 'LIVE'}`)

  const matchers = loadProjectMatchers()
  console.log(`Loaded ${matchers.length} active projects from vault`)
  const filteredMatchers = PROJECT_FILTER
    ? matchers.filter(m =>
        m.name.toLowerCase().includes(PROJECT_FILTER.toLowerCase()) ||
        m.aliases.some(a => a.toLowerCase().includes(PROJECT_FILTER.toLowerCase())),
      )
    : matchers
  if (PROJECT_FILTER) {
    console.log(`Filtered to ${filteredMatchers.length} projects matching "${PROJECT_FILTER}"`)
  }

  const rows: AuditRow[] = []

  if (!SKIP_NOTION) {
    if (!process.env.NOTION_TOKEN) {
      console.warn('[notion] NOTION_TOKEN missing — skipping')
    } else {
      const notion = new NotionClient(process.env.NOTION_TOKEN)
      const notionRows = await scanNotion(notion, filteredMatchers, { limit: LIMIT })
      rows.push(...notionRows)
      console.log(`[notion] collected ${notionRows.length} rows`)
    }
  }

  if (!SKIP_CLICKUP) {
    if (!process.env.CLICKUP_API_KEY || !process.env.CLICKUP_TEAM_ID) {
      console.warn('[clickup] CLICKUP_API_KEY or CLICKUP_TEAM_ID missing — skipping')
    } else {
      const clickup = new ClickUpClient(process.env.CLICKUP_API_KEY, process.env.CLICKUP_TEAM_ID)
      const clickupRows = await scanClickUp(clickup, filteredMatchers, { limit: LIMIT })
      rows.push(...clickupRows)
      console.log(`[clickup] collected ${clickupRows.length} rows`)
    }
  }

  if (PROJECT_FILTER) {
    const before = rows.length
    const filteredNames = new Set(filteredMatchers.map(m => m.name))
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].project && !filteredNames.has(rows[i].project)) rows.splice(i, 1)
    }
    console.log(`Filtered rows by project: ${before} → ${rows.length}`)
  }

  // Sort by Project (empty last), then Source, then Title
  rows.sort((a, b) => {
    const ap = a.project || '￿'
    const bp = b.project || '￿'
    if (ap !== bp) return ap.localeCompare(bp, 'ru')
    if (a.source !== b.source) return a.source.localeCompare(b.source)
    return a.title.localeCompare(b.title, 'ru')
  })

  console.log(`\nTotal: ${rows.length} rows`)
  printSummary(rows)

  if (!NO_SUMMARY && !DRY_RUN) {
    await summarizeRows(rows)
  }

  if (CSV_PATH) {
    writeCsvToFile(rows, CSV_PATH)
    console.log(`✅ CSV written: ${CSV_PATH}`)
  }

  if (DRY_RUN) {
    console.log('Dry-run: skipping Drive upload')
    if (!CSV_PATH) {
      const localCsv = `wiki-audit-${new Date().toISOString().slice(0, 10)}.csv`
      writeCsvToFile(rows, localCsv)
      console.log(`✅ CSV written: ${localCsv}`)
    }
    return
  }

  // Resolve Google token
  const tokens = await resolveGoogleTokens()
  const account = GOOGLE_ACCOUNTS[0]
  const token = tokens.get(account)
  if (!token) {
    throw new Error(`No Google access token for ${account}. Re-auth via google-workspace-mcp.`)
  }
  const drive = new DriveClient(token)

  // Find/create target folder: Company Wiki/Проектная документация/_audit
  console.log('Resolving Drive target folder...')
  const wikiRoot = await drive.findFolder('Company Wiki')
  if (!wikiRoot) throw new Error('Drive folder "Company Wiki" not found')
  const projectDocsFolder = await drive.findOrCreateFolder('Проектная документация', wikiRoot)
  const auditFolder = await drive.findOrCreateFolder('_audit', projectDocsFolder)

  console.log(`Uploading sheet "${SHEET_NAME}"...`)
  const { sheetId, link } = await writeSheet(drive, rows, auditFolder, SHEET_NAME)
  console.log(`\n✅ Sheet ready: ${link}`)
  console.log(`   ID: ${sheetId}`)
}

function printSummary(rows: AuditRow[]): void {
  const byProject = new Map<string, number>()
  const bySource = new Map<string, number>()
  let withImages = 0
  let withGifs = 0
  let unmapped = 0
  for (const r of rows) {
    byProject.set(r.project || '(unmapped)', (byProject.get(r.project || '(unmapped)') ?? 0) + 1)
    bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1)
    if (r.hasImages) withImages++
    if (r.hasGifs) withGifs++
    if (!r.project) unmapped++
  }
  console.log('\nBy source:')
  for (const [k, v] of bySource) console.log(`  ${k}: ${v}`)
  console.log(`Unmapped: ${unmapped}`)
  console.log(`With images: ${withImages}, gifs: ${withGifs}`)
  console.log('\nTop projects:')
  const sorted = [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
  for (const [k, v] of sorted) console.log(`  ${v}× ${k}`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
