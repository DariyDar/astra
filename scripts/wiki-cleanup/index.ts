/**
 * Wiki cleanup — fix formatting of existing Wiki articles whose import
 * left raw markdown markers (#, **bold**) or no <h2>/<h3> structure.
 *
 * Pipeline per article:
 *   1. GET /export?mimeType=text/html  → existing wiki-portal HTML.
 *   2. Detect raw markdown markers and pre-convert them (so polish has
 *      a head start; otherwise Haiku might miss them).
 *   3. sanitizeWikiHtml + polish (strict: no content removal).
 *   4. PATCH back into the same Doc via /upload.
 *
 * Usage:
 *   npx tsx scripts/wiki-cleanup/index.ts                 # all 25 known
 *   npx tsx scripts/wiki-cleanup/index.ts --pick clickup  # filter by title/path substring
 *   npx tsx scripts/wiki-cleanup/index.ts --limit 2 --dry-run
 */

import 'dotenv/config'
import { resolveGoogleTokens, GOOGLE_ACCOUNTS } from '../../src/mcp/briefing/google-auth.js'
import { sanitizeWikiHtml, markdownToHtml } from '../lib/markdown-to-html.js'
import { polishHtml } from '../lib/html-polish.js'

interface Target {
  fileId: string
  title: string
  folderPath: string
}

// 25 broken articles identified by scripts/wiki-format-audit.
// Sorted by severity (3 → 2 → 1 signal classes).
const TARGETS: Target[] = [
  { fileId: '1imyI_DjJnE36cdVB16gSBWajbvDT36TgU9zBPWXiHSg', title: 'Managing Your Workflow in ClickUp', folderPath: 'Productivity Resources' },
  { fileId: '1UcfbtymxeoDQ9JWOH51amYH5gBC5XenivAYH7ebUqzc', title: 'Onboarding onto a new project', folderPath: 'Departments/QA' },
  { fileId: '1bFp_n6kTepRUc_1ZdP3PFjht9SprCmUhZpLz6dcNq44', title: 'ClickUp Resources', folderPath: 'Productivity Resources' },
  { fileId: '1ns-Pv0hAoaMxrJNoNheJDYS5RF9as8MBN8HWXblqUNg', title: 'Как работать с этой Вики', folderPath: '(root)' },
  { fileId: '12Vr2f4T9EfEfVd1GBpv7NujNt9kZEWt2bbxGxvbf64w', title: 'Sales', folderPath: 'Departments/Sales' },
  { fileId: '1blFlHwUcgWAGcBROf_ykQGk8GBzRxuC0EWn6_aBHCNA', title: 'Tool 3', folderPath: 'Systems & Tools' },
  { fileId: '1gRThKLWVsbNO14aG-EsOGlkDEmT-DpmulUwN_ARj6uE', title: 'Perfomance testing', folderPath: 'Departments/QA/Perfomance testing' },
  { fileId: '1OpDFhx-u7icKC1sxusAhWW8N3WjDM45c5H31ixGZpNk', title: 'Transferring an App on App Store Connect — Initiator Side', folderPath: 'Distribution & Deployment' },
  { fileId: '1y9e2CyVToSBUc23zW5cLgSAt8-f04rxtiesDS0m19V0', title: 'Facebook App Transfer', folderPath: 'Distribution & Deployment' },
  { fileId: '10qJWRvwsu4UENaneCuJ4eKguAPgg6LlvFC1aH_M5BRk', title: 'Marketing', folderPath: 'Departments/Marketing' },
  { fileId: '1M45jNSrV3xs3a-PDQQwx0S9iGgSJRk2KifSlYKN141c', title: 'Transferring an App on App Store Connect — Recipient Side', folderPath: 'Distribution & Deployment' },
  { fileId: '1ogJZMlctxxZ917jkC_m-hd9iaPYNuAP5c8DJ0w1b3OU', title: 'Resources (HR)', folderPath: 'Departments/HR' },
  { fileId: '1fWLaOZGxy_a0n_Ytz-8FiDvPmGxw8viy_nT1oeAlZ6I', title: 'Resources (Marketing)', folderPath: 'Departments/Marketing' },
  { fileId: '16Tv8iNoB3nXq0jk91jzS8k58VJL1efDjakPhDYlS4Cw', title: 'Resources (Sales)', folderPath: 'Departments/Sales' },
  { fileId: '1Q3dyMgso8U7ef4Vi5lP4j8oWAMy5aFhZsY6MKJlu8jk', title: 'Tool 1', folderPath: 'Systems & Tools' },
  { fileId: '1CukksRbXcM2Uc-6PvPHaMZAY7cVXE8uzvzGzj53MP-s', title: 'Кафетерий бенефитов', folderPath: 'Кабинет HR' },
  { fileId: '1jMwNorVVyAT3pLJG5UCFBXm5n_mOBecUvJA-NAp0C2M', title: 'Tool 2', folderPath: 'Systems & Tools' },
  { fileId: '1IS66x_Mr2qoqRoOZFdqtbmBhyKlyZRcLkBF4-sLXnX8', title: 'QA documentation', folderPath: 'Departments/QA' },
  { fileId: '19f28bUcc3U5KMY6SbLklP8LFCEefLcy6Qtwdg7XSEuw', title: 'QA syncs', folderPath: 'Departments/QA' },
  { fileId: '1CBlnziVDJnJCJ-Zklq14T3hQ3ayes2v72vtIDLs60wY', title: 'List of questions', folderPath: 'Departments/QA/Perfomance testing' },
  { fileId: '1Yv6IaJ04EJQUMHdFNqS7wMQbVkyZhkOFwPq9lT4CO1U', title: 'Tools tips', folderPath: 'Departments/QA/Perfomance testing' },
  { fileId: '1zo91konu4YGIaaodyKE84WWWwdElG0tg0HHON_a4mc4', title: 'Creating and setting up a Facebook application', folderPath: 'Departments/Development' },
  { fileId: '1Tb5TMsC8tem2cTvswi40k3ABepFSeFeohVAVxMrl898', title: 'Development', folderPath: 'Departments/Development' },
  { fileId: '1SEZn95Y0OgNk24rWUzdRtS7E1ytKNLQSu-4dXxfLIAw', title: 'Sign in with Apple User Transfer', folderPath: 'Distribution & Deployment' },
  { fileId: '1Nu6jwrVDvic73aWF9PPSG8QmQOg2mPwF9pPJKId1tUQ', title: 'Онбординг', folderPath: 'Кабинет HR' },
]

const args = process.argv.slice(2)
function arg(name: string): string | null {
  const i = args.indexOf(name)
  if (i === -1) return null
  return args[i + 1] ?? null
}
function flag(name: string): boolean { return args.includes(name) }

const PICK = arg('--pick')
const LIMIT = arg('--limit') ? parseInt(arg('--limit')!, 10) : 0
const DRY_RUN = flag('--dry-run')

async function exportDocHtml(token: string, fileId: string): Promise<string> {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/html`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) },
  )
  if (!resp.ok) throw new Error(`export ${resp.status}`)
  return await resp.text()
}

async function patchDocHtml(token: string, fileId: string, html: string): Promise<void> {
  const resp = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/html' },
      body: html,
      signal: AbortSignal.timeout(120_000),
    },
  )
  if (!resp.ok) throw new Error(`patch ${resp.status} ${(await resp.text()).slice(0, 200)}`)
}

/**
 * Convert raw markdown markers visible inside <p>...</p> back into proper
 * HTML structure. This is the «pre-flight»: gives Haiku a head start so
 * it doesn't silently leave «# heading» as plain text.
 */
function premigrateMarkdown(html: string): string {
  // Strip Drive's wrapper styling — keep only body
  let body = html
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)
  if (bodyMatch) body = bodyMatch[1]

  // Replace <p># Heading</p> → <h2>Heading</h2>, <p>## …</p> → <h3>…</h3>
  body = body.replace(/<p[^>]*>\s*(#{1,6})\s+([^<]+?)\s*<\/p>/g, (_, hashes: string, content: string) => {
    const lvl = Math.min(6, hashes.length + 1) // # → h2 (h1 is title), ## → h3
    return `<h${lvl}>${content.trim()}</h${lvl}>`
  })

  // Same but inside <span>: <p><span>## X</span></p>
  body = body.replace(/<p[^>]*>\s*<span[^>]*>\s*(#{1,6})\s+([^<]+?)\s*<\/span>\s*<\/p>/g, (_, hashes: string, content: string) => {
    const lvl = Math.min(6, hashes.length + 1)
    return `<h${lvl}>${content.trim()}</h${lvl}>`
  })

  // Replace inline **bold** and __bold__ inside HTML text
  body = body.replace(/\*\*([^*\n<>]{1,200}?)\*\*/g, '<strong>$1</strong>')
  body = body.replace(/__([^_\n<>]{1,200}?)__/g, '<strong>$1</strong>')

  return body
}

async function processOne(target: Target, token: string): Promise<{ ok: boolean; error?: string; from?: number; to?: number }> {
  let html: string
  try {
    html = await exportDocHtml(token, target.fileId)
  } catch (e) {
    return { ok: false, error: `export: ${(e as Error).message}` }
  }
  const inputLen = html.length

  // 1. Pre-migrate markdown markers
  let body = premigrateMarkdown(html)

  // 2. Sanitize against allow-list (drops style/class)
  body = sanitizeWikiHtml(body)

  // 3. Polish via Haiku
  if (!DRY_RUN) {
    const polished = await polishHtml(body)
    body = polished.html
  }

  // 4. Wrap in minimal HTML doc and PATCH back
  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(target.title)}</title></head><body>${body}</body></html>`

  if (DRY_RUN) {
    return { ok: true, from: inputLen, to: fullHtml.length }
  }

  try {
    await patchDocHtml(token, target.fileId, fullHtml)
  } catch (e) {
    return { ok: false, error: `patch: ${(e as Error).message}` }
  }
  return { ok: true, from: inputLen, to: fullHtml.length }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function main(): Promise<void> {
  console.log('=== Wiki Cleanup ===')
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`)

  let targets = TARGETS
  if (PICK) {
    const term = PICK.toLowerCase()
    targets = targets.filter(t => t.title.toLowerCase().includes(term) || t.folderPath.toLowerCase().includes(term))
  }
  if (LIMIT > 0) targets = targets.slice(0, LIMIT)
  console.log(`Targets: ${targets.length}`)

  const tokens = await resolveGoogleTokens()
  const token = tokens.get(GOOGLE_ACCOUNTS[0]) ?? [...tokens.values()][0]
  if (!token) throw new Error('No Google token')

  let ok = 0
  let err = 0
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    console.log(`\n[${i + 1}/${targets.length}] ${t.folderPath} / ${t.title}`)
    const result = await processOne(t, token)
    if (result.ok) {
      ok++
      console.log(`  ✅ ${result.from}→${result.to} bytes`)
    } else {
      err++
      console.log(`  ❌ ${result.error}`)
    }
  }
  console.log(`\n=== Done: ${ok} ok, ${err} errors ===`)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
