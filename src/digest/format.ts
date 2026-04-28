/**
 * Formatter: turn DigestResult JSON into Telegram messages and per-project
 * vault append entries.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logging/logger.js'
import type {
  DigestResult,
  DigestProject,
  DigestItem,
  DigestGeneralUpdate,
  ProjectStatus as DigestProjectStatus,
} from './schema.js'

const STATUS_EMOJI: Record<DigestProjectStatus, string> = {
  ok: '🟢',
  attention: '🟡',
  blocked: '🔴',
}

const RU_MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

function ruDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getDate()} ${RU_MONTHS[d.getMonth()]}`
}

const TG_MAX_LEN = 3500 // safety margin under Telegram's 4096

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderItemLine(item: DigestItem | DigestGeneralUpdate): string {
  const text = escapeHtml(item.one_line)
  const link = (item as DigestItem).link
  if (link) {
    return `• <a href="${escapeHtml(link)}">${text}</a>`
  }
  return `• ${text}`
}

function renderProject(p: DigestProject): string {
  const lines: string[] = []
  const emoji = STATUS_EMOJI[p.status]
  lines.push(`${emoji} <b>${escapeHtml(p.project_name)}</b>`)
  // Sort items by importance desc within project
  const sorted = [...p.items].sort((a, b) => b.importance - a.importance)
  for (const it of sorted) {
    lines.push(renderItemLine(it))
  }
  return lines.join('\n')
}

/**
 * Render Telegram messages for one company. Splits into chunks if a single
 * message would exceed Telegram's character limit.
 */
function renderCompany(
  companyLabel: string,
  date: string,
  company: DigestResult['companies']['astrocat'],
): string[] {
  const header = `📅 <b>Дайджест ${ruDate(date)} — ${companyLabel}</b>`
  const blocks: string[] = []

  // Section 1: project blocks
  for (const p of company.projects) {
    blocks.push(renderProject(p))
  }

  // Section 2: general updates (no project)
  if (company.general_updates.length > 0) {
    const sorted = [...company.general_updates].sort((a, b) => b.importance - a.importance)
    const lines = ['<b>📌 Общие апдейты</b>']
    for (const g of sorted) lines.push(renderItemLine(g))
    blocks.push(lines.join('\n'))
  }

  // Section 3: silent projects (single line)
  if (company.silent_projects.length > 0) {
    blocks.push(`<i>Без апдейтов:</i> ${escapeHtml(company.silent_projects.join(', '))}`)
  }

  // Pack blocks into messages within TG_MAX_LEN
  const messages: string[] = []
  let current = header
  for (const block of blocks) {
    if (current.length + block.length + 2 > TG_MAX_LEN) {
      messages.push(current)
      current = block
    } else {
      current += '\n\n' + block
    }
  }
  if (current.length > 0) messages.push(current)
  return messages
}

export function formatDigestForTelegram(result: DigestResult): {
  astrocat: string[]
  highground: string[]
} {
  return {
    astrocat: renderCompany('AstroCat', result.digest_date, result.companies.astrocat),
    highground: renderCompany('Highground', result.digest_date, result.companies.highground),
  }
}

/**
 * Append today's items into per-project markdown logs in the vault.
 * Existing file format: append a `## YYYY-MM-DD` block; create file with frontmatter
 * if it doesn't exist.
 */
export function appendDigestToVault(result: DigestResult): void {
  const projectsDir = join(process.cwd(), 'vault', 'projects')
  if (!existsSync(projectsDir)) {
    logger.warn({ projectsDir }, 'Vault projects dir missing — skipping append')
    return
  }

  for (const company of [result.companies.astrocat, result.companies.highground]) {
    for (const p of company.projects) {
      try {
        appendProjectEntry(projectsDir, p, result.digest_date)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.warn({ project: p.project_name, error: msg }, 'Vault append failed')
      }
    }
  }
}

function appendProjectEntry(projectsDir: string, p: DigestProject, date: string): void {
  // Filename matches the canonical project card naming.
  const filename = `${p.project_name}.md`
  const path = join(projectsDir, filename)

  const blockLines: string[] = [`## ${date}`]
  for (const it of [...p.items].sort((a, b) => b.importance - a.importance)) {
    const tag = `[${it.type}]`
    const importance = it.importance >= 4 ? ` (★${it.importance})` : ''
    const link = it.link ? ` — ${it.link}` : ''
    blockLines.push(`- ${tag}${importance} ${it.one_line}${link}`)
    if (it.detail) {
      blockLines.push(`  > ${it.detail.replace(/\n/g, ' ')}`)
    }
  }
  const block = blockLines.join('\n') + '\n'

  if (!existsSync(path)) {
    // Create a new project log file.
    const header =
      `---\ntype: project_log\nproject: ${p.project_name}\ncompany: unknown\n---\n\n# ${p.project_name} — daily log\n\n`
    writeFileSync(path, header + block + '\n', 'utf-8')
    logger.info({ project: p.project_name, items: p.items.length }, 'Vault project log created')
    return
  }

  // Skip if today's block already present (avoids duplicates on retry).
  const existing = readFileSync(path, 'utf-8')
  if (existing.includes(`## ${date}\n`)) {
    logger.info({ project: p.project_name, date }, 'Vault project log: today already present, skipping')
    return
  }
  appendFileSync(path, '\n' + block + '\n', 'utf-8')
  logger.info({ project: p.project_name, items: p.items.length, date }, 'Vault project log appended')
}

/**
 * Save the raw JSON snapshot for debugging / future feedback queries.
 */
export function saveDigestJson(result: DigestResult): void {
  try {
    const dir = join(process.cwd(), 'vault', '_digest', 'json')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, `${result.digest_date}.json`)
    writeFileSync(path, JSON.stringify(result, null, 2), 'utf-8')
    logger.info({ path }, 'Digest JSON saved')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.warn({ error: msg }, 'Saving digest JSON failed (non-critical)')
  }
}
