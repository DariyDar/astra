/**
 * Wiki transfer — read decisions from the audit Sheet and migrate articles
 * marked as «Переносим» / «Archive» from ClickUp Docs and Notion to Google
 * Drive (Company Wiki/Проектная документация/<project>/...).
 *
 * Usage:
 *   npx tsx scripts/wiki-transfer/index.ts --sheet <sheetId> [--limit N] [--no-polish] [--dry-run]
 *   npx tsx scripts/wiki-transfer/index.ts --sheet <sheetId> --pick <substr>     # transfer only matching rows
 *   npx tsx scripts/wiki-transfer/index.ts --sheet <sheetId> --demo              # 1 ClickUp + 1 Notion only
 *
 * The Sheet must have the columns produced by scripts/wiki-audit (Источник,
 * Проект, Название, Ссылка, Action). Action recognized values (case-insensitive):
 *   - «переносим» (or any prefix of it)         → into <Project>/
 *   - «архив» / «archive»                       → into <Project>/archive/
 *   - «переносим в отдел <X> / <Y>»             → into Department path
 *
 * Required ENV: NOTION_TOKEN, CLICKUP_API_KEY, CLICKUP_TEAM_ID.
 */

import 'dotenv/config'
import { resolveGoogleTokens, GOOGLE_ACCOUNTS } from '../../src/mcp/briefing/google-auth.js'
import { NotionClient } from '../lib/notion-client.js'
import { ClickUpClient, flattenPages } from '../lib/clickup-client.js'
import { DriveClient } from '../lib/drive-client.js'
import { pageToHtml as notionPageToHtml, refreshNotionMediaUrl } from '../lib/notion-to-html.js'
import { markdownToHtml, sanitizeWikiHtml } from '../lib/markdown-to-html.js'
import { MediaDownloader, rewriteImagesInHtml, makeSlug } from '../lib/media-downloader.js'
import { polishHtml } from '../lib/html-polish.js'
import { parseAction, type ActionDecision } from './action-parser.js'

const args = process.argv.slice(2)
function arg(name: string): string | null {
  const i = args.indexOf(name)
  if (i === -1) return null
  return args[i + 1] ?? null
}
function flag(name: string): boolean {
  return args.includes(name)
}

const SHEET_ID = arg('--sheet')
const LIMIT = arg('--limit') ? parseInt(arg('--limit')!, 10) : 0
const START = arg('--start') ? parseInt(arg('--start')!, 10) : 0
const PICK = arg('--pick')
const DEMO = flag('--demo')
const DRY_RUN = flag('--dry-run')
const NO_POLISH = flag('--no-polish')
const SKIP_MEDIA = flag('--skip-media')

interface AuditRow {
  source: 'ClickUp' | 'Notion'
  project: string
  title: string
  url: string
  action: string
}

async function fetchSheetRows(token: string, sheetId: string): Promise<AuditRow[]> {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${sheetId}/export?mimeType=text/csv`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!resp.ok) throw new Error(`Sheet export ${resp.status}: ${await resp.text()}`)
  const csv = await resp.text()
  return parseCsv(csv)
}

function parseCsv(csv: string): AuditRow[] {
  const lines: string[][] = []
  let i = 0
  let cur: string[] = []
  let cell = ''
  let inQuotes = false
  while (i < csv.length) {
    const ch = csv[i]
    if (inQuotes) {
      if (ch === '"' && csv[i + 1] === '"') { cell += '"'; i += 2; continue }
      if (ch === '"') { inQuotes = false; i++; continue }
      cell += ch; i++; continue
    }
    if (ch === '"') { inQuotes = true; i++; continue }
    if (ch === ',') { cur.push(cell); cell = ''; i++; continue }
    if (ch === '\n') { cur.push(cell); lines.push(cur); cur = []; cell = ''; i++; continue }
    if (ch === '\r') { i++; continue }
    cell += ch; i++
  }
  if (cell.length || cur.length) { cur.push(cell); lines.push(cur) }
  if (lines.length === 0) return []

  const header = lines[0].map(h => h.trim())
  const idx = (name: string): number => header.findIndex(h => h === name)
  const cols = {
    src: idx('Источник'),
    proj: idx('Проект'),
    title: idx('Название'),
    url: idx('Ссылка'),
    action: idx('Action'),
  }
  const rows: AuditRow[] = []
  for (let r = 1; r < lines.length; r++) {
    const row = lines[r]
    if (!row || row.length < 2) continue
    rows.push({
      source: (row[cols.src] ?? '') as AuditRow['source'],
      project: row[cols.proj] ?? '',
      title: row[cols.title] ?? '',
      url: row[cols.url] ?? '',
      action: row[cols.action] ?? '',
    })
  }
  return rows
}

function extractClickUpIds(url: string): { docId: string; pageId: string } | null {
  const m = url.match(/dc\/([a-z0-9]+-\d+)\/([a-z0-9]+-\d+)/i)
  if (!m) return null
  return { docId: m[1], pageId: m[2] }
}

function extractNotionId(url: string): string | null {
  const m = url.match(/([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  return m ? m[1].replace(/-/g, '') : null
}

async function ensureFolderPath(drive: DriveClient, segments: string[]): Promise<string> {
  let parent = await drive.findFolder('Company Wiki')
  if (!parent) throw new Error('Drive folder "Company Wiki" not found')
  for (const seg of segments) {
    parent = await drive.findOrCreateFolder(seg, parent)
  }
  return parent
}

interface TransferResult {
  ok: boolean
  fileId?: string
  link?: string
  error?: string
  mediaReplaced?: number
  mediaSkipped?: number
  polishedFromBytes?: number
  polishedToBytes?: number
}

async function transferRow(
  row: AuditRow,
  decision: ActionDecision,
  drive: DriveClient,
  driveToken: string,
  notion: NotionClient | null,
  clickup: ClickUpClient | null,
): Promise<TransferResult> {
  // 1. Resolve target folder path
  const segments = ['Проектная документация']
  if (decision.kind === 'archive') {
    if (row.project) {
      segments.push(row.project, 'archive')
    } else {
      segments.push('_unsorted', 'archive')
    }
  } else if (decision.kind === 'department') {
    segments.length = 0
    segments.push('Departments', ...decision.path)
  } else if (decision.kind === 'transfer') {
    if (row.project) {
      segments.push(row.project, ...decision.subpath)
    } else {
      // Unmapped row: still useful, drop into _unsorted/ for manual triage
      segments.push('_unsorted', ...decision.subpath)
    }
  } else {
    return { ok: false, error: 'unknown decision' }
  }

  const targetFolderId = await ensureFolderPath(drive, segments)
  const mediaFolderId = await drive.findOrCreateFolder('media', targetFolderId)

  // 2. Fetch source content
  let html = ''
  let notionImageBlocks: Map<string, string> | null = null
  if (row.source === 'ClickUp') {
    if (!clickup) return { ok: false, error: 'ClickUp client not initialized' }
    const ids = extractClickUpIds(row.url)
    if (!ids) return { ok: false, error: 'cannot parse ClickUp URL' }
    const pages = await clickup.getDocPages(ids.docId)
    const flat = flattenPages(pages)
    const page = flat.find(p => p.id === ids.pageId)
    if (!page) return { ok: false, error: `page ${ids.pageId} not found in doc ${ids.docId}` }
    const md = page.content ?? ''
    const body = markdownToHtml(md)
    html = `<h1>${escapeForTitle(row.title)}</h1>\n${body}`
  } else if (row.source === 'Notion') {
    if (!notion) return { ok: false, error: 'Notion client not initialized' }
    const pageId = extractNotionId(row.url)
    if (!pageId) return { ok: false, error: 'cannot parse Notion URL' }
    const result = await notionPageToHtml(notion, pageId, row.title)
    html = result.html
    notionImageBlocks = result.imageBlocks
  } else {
    return { ok: false, error: `unknown source: ${row.source}` }
  }

  html = sanitizeWikiHtml(html)

  // 3. Download media and rewrite URLs
  let mediaReplaced = 0
  let mediaSkipped = 0
  if (!SKIP_MEDIA) {
    const downloader = new MediaDownloader(driveToken, mediaFolderId)
    const slug = makeSlug(row.title)
    const refresher = notionImageBlocks && notion
      ? async (originalUrl: string): Promise<string | null> => {
          const blockId = notionImageBlocks!.get(originalUrl)
          if (!blockId) return null
          return refreshNotionMediaUrl(notion!, blockId)
        }
      : undefined
    const result = await rewriteImagesInHtml(html, downloader, slug, refresher)
    html = result.html
    mediaReplaced = result.replaced
    mediaSkipped = result.skipped
  }

  // 4. LLM polish
  let polishFrom = html.length
  let polishTo = polishFrom
  if (!NO_POLISH) {
    const polished = await polishHtml(html)
    html = polished.html
    polishFrom = polished.inputChars
    polishTo = polished.outputChars
  }

  // 5. Wrap in full HTML doc for Drive import
  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeForTitle(row.title)}</title></head><body>${html}</body></html>`

  if (DRY_RUN) {
    return {
      ok: true,
      fileId: '<dry-run>',
      link: `[dry-run] would upload to ${segments.join(' / ')}`,
      mediaReplaced,
      mediaSkipped,
      polishedFromBytes: polishFrom,
      polishedToBytes: polishTo,
    }
  }

  // 6. Upload to Drive as Google Doc
  const fileId = await drive.uploadAsGoogleDoc(row.title, fullHtml, targetFolderId)
  const link = await drive.getFileLink(fileId)

  return {
    ok: true,
    fileId,
    link,
    mediaReplaced,
    mediaSkipped,
    polishedFromBytes: polishFrom,
    polishedToBytes: polishTo,
  }
}

function escapeForTitle(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function main(): Promise<void> {
  if (!SHEET_ID) throw new Error('--sheet <id> is required')

  console.log('=== Wiki Transfer ===')
  console.log(`Sheet: ${SHEET_ID}`)
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}, polish=${!NO_POLISH}, media=${!SKIP_MEDIA}`)

  let tokens = await resolveGoogleTokens()
  let driveToken = tokens.get(GOOGLE_ACCOUNTS[0]) ?? [...tokens.values()][0]
  if (!driveToken) throw new Error('No Google access token')
  let drive = new DriveClient(driveToken)

  /** Always re-read tokens from credentials.json before each row.
   * resolveGoogleTokens calls Google's refresh endpoint when expiry
   * is < 5 min away. Forcing a re-read every row is cheap (file read
   * + occasional refresh) and guarantees we never use a stale token. */
  async function refreshTokenForRow(): Promise<void> {
    tokens = await resolveGoogleTokens()
    const fresh = tokens.get(GOOGLE_ACCOUNTS[0]) ?? [...tokens.values()][0]
    if (!fresh) throw new Error('Token refresh returned empty')
    if (fresh !== driveToken) {
      driveToken = fresh
      drive = new DriveClient(driveToken)
      console.log('  [token rotated]')
    }
  }

  const rawRows = await fetchSheetRows(driveToken, SHEET_ID)
  console.log(`Fetched ${rawRows.length} rows from Sheet`)

  // Filter rows with non-empty Action
  let rows = rawRows.filter(r => r.action.trim())
  console.log(`With Action: ${rows.length}`)

  if (PICK) {
    const term = PICK.toLowerCase()
    rows = rows.filter(r => r.title.toLowerCase().includes(term) || r.project.toLowerCase().includes(term))
    console.log(`After --pick "${PICK}": ${rows.length}`)
  }

  if (DEMO) {
    const cu = rows.find(r => r.source === 'ClickUp' && parseAction(r.action).kind === 'transfer')
    const no = rows.find(r => r.source === 'Notion' && parseAction(r.action).kind === 'transfer')
    rows = [cu, no].filter(Boolean) as AuditRow[]
    console.log(`Demo: ${rows.length} rows (1 ClickUp + 1 Notion)`)
  }

  if (START > 0) {
    console.log(`Starting from index ${START} (skipping ${START} rows)`)
    rows = rows.slice(START)
  }
  if (LIMIT > 0) rows = rows.slice(0, LIMIT)

  const notion = process.env.NOTION_TOKEN ? new NotionClient(process.env.NOTION_TOKEN) : null
  const clickup = process.env.CLICKUP_API_KEY && process.env.CLICKUP_TEAM_ID
    ? new ClickUpClient(process.env.CLICKUP_API_KEY, process.env.CLICKUP_TEAM_ID)
    : null

  let success = 0
  let errors = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const decision = parseAction(row.action)
    if (decision.kind === 'unknown' || decision.kind === 'skip') {
      console.log(`[${i + 1}/${rows.length}] SKIP "${row.title}" — action="${row.action}"`)
      continue
    }
    console.log(`\n[${i + 1}/${rows.length}] ${row.source} | ${row.project || '(unmapped)'} | ${row.title}`)
    console.log(`  → ${decision.kind}${decision.kind === 'department' ? ' / ' + decision.path.join(' / ') : ''}${decision.kind === 'transfer' && decision.subpath.length ? ' / ' + decision.subpath.join(' / ') : ''}`)
    try {
      await refreshTokenForRow()
      // Hard 12-min timeout per row — guards against hung awaits in
      // Drive uploads / Claude CLI / Notion fetch.
      const result = await Promise.race([
        transferRow(row, decision, drive, driveToken, notion, clickup),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('row timeout (12 min)')), 12 * 60_000),
        ),
      ])
      if (result.ok) {
        success++
        const stats = [
          `media=${result.mediaReplaced}+${result.mediaSkipped} skipped`,
          `polish=${result.polishedFromBytes}→${result.polishedToBytes}`,
        ].join(', ')
        console.log(`  ✅ ${result.link} (${stats})`)
      } else {
        errors++
        console.log(`  ❌ ${result.error}`)
      }
    } catch (e) {
      errors++
      console.log(`  ❌ exception: ${(e as Error).message.slice(0, 200)}`)
    }
  }

  console.log(`\n=== Done: ${success} ok, ${errors} errors ===`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
