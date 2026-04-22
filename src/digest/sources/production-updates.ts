/**
 * Fetch upcoming milestones from Production Updates Tracker (Google Sheets).
 * READ-ONLY — never writes to the spreadsheet.
 *
 * Returns milestones within the next 30 days + any overdue ones.
 * Excludes milestones marked as "done" in vault project cards.
 */

import { resolveGoogleTokens } from '../../mcp/briefing/google-auth.js'
import { loadProjectCard } from '../../kb/vault-reader.js'
import { logger } from '../../logging/logger.js'

const SPREADSHEET_ID = '1pl6YGKvCJmWIFMURl1U9A_xsu10suLpSvWJOHhtr3MY'
const SHEET_RANGE = 'Milestones!A1:M200'
const GOOGLE_ACCOUNT = 'dariy@astrocat.co'
const LOOKAHEAD_DAYS = 30

/** Project code mapping from spreadsheet to vault project names */
const PROJECT_CODE_MAP: Record<string, string> = {
  'STT': 'Star Trek Timelines',
  'OT': 'Oregon Trail',
  'SB F2P': 'SpongeBob Krusty Cook-Off',
  'SB N': 'SpongeBob Get Cookin',
  'MTW': 'Motor World Car Factory',
  'UAM': 'Motor World Car Factory',
}

export interface ProductionMilestone {
  project: string
  projectCode: string
  name: string
  deadline: Date
  daysUntil: number
  isOverdue: boolean
}

function parseUSDate(dateStr: string): Date | null {
  // Format: M/D/YYYY or MM/DD/YYYY
  const parts = dateStr.split('/')
  if (parts.length !== 3) return null
  const month = parseInt(parts[0]) - 1
  const day = parseInt(parts[1])
  const year = parseInt(parts[2])
  if (isNaN(month) || isNaN(day) || isNaN(year)) return null
  return new Date(year, month, day)
}

/**
 * Check if a milestone is marked as completed in vault.
 * Looks at project card's current_status.milestones for a matching entry
 * with [done], [closed], [complete] suffix.
 */
function isMilestoneClosedInVault(projectName: string, milestoneName: string): boolean {
  try {
    const card = loadProjectCard(projectName)
    if (!card?.current_status?.milestones) return false
    const lower = milestoneName.toLowerCase()
    return card.current_status.milestones.some((m: string) => {
      const ml = m.toLowerCase()
      return ml.includes(lower) && (ml.includes('[done]') || ml.includes('[closed]') || ml.includes('[complete]'))
    })
  } catch {
    return false
  }
}

export async function fetchProductionMilestones(): Promise<ProductionMilestone[]> {
  const tokens = await resolveGoogleTokens()
  const token = tokens.get(GOOGLE_ACCOUNT)
  if (!token) {
    logger.warn('Production updates: no Google token, skipping')
    return []
  }

  const range = encodeURIComponent(SHEET_RANGE)
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
  )

  if (!resp.ok) {
    const text = await resp.text()
    logger.warn({ status: resp.status, body: text.slice(0, 200) }, 'Production updates: Sheets API error')
    return []
  }

  const data = await resp.json() as { values?: string[][] }
  const rows = data.values
  if (!rows || rows.length < 2) return []

  // Header: Client | Code | Name | Project | Description | Contract | Milestone date | Delivery date | Amount | Invoice | Invoice Due | Sent | Paid
  // Cols:   0        1      2      3         4             5          6                7               8        9         10            11     12
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const lookaheadEnd = new Date(todayStart.getTime() + LOOKAHEAD_DAYS * 86400_000)

  const milestones: ProductionMilestone[] = []

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const projectCode = (row[3] ?? '').trim()
    const name = (row[2] ?? '').trim()
    const dateStr = (row[6] ?? '').trim()
    const sent = (row[11] ?? '').trim().toUpperCase()
    const paid = (row[12] ?? '').trim().toUpperCase()

    if (!projectCode || !name || !dateStr) continue

    // Skip milestones already delivered or paid
    if (sent === 'TRUE' || paid === 'TRUE') continue

    const deadline = parseUSDate(dateStr)
    if (!deadline) continue

    // Only include upcoming within lookahead window — skip overdue (past deadlines)
    if (deadline < todayStart) continue
    if (deadline > lookaheadEnd) continue

    const projectName = PROJECT_CODE_MAP[projectCode] ?? projectCode
    const daysUntil = Math.ceil((deadline.getTime() - todayStart.getTime()) / 86400_000)
    const isOverdue = false // We no longer show overdue

    // Skip if marked as done in vault (additional check)
    if (isMilestoneClosedInVault(projectName, name)) continue

    milestones.push({
      project: projectName,
      projectCode,
      name,
      deadline,
      daysUntil,
      isOverdue,
    })
  }

  // Sort: overdue first (most overdue first), then by deadline ascending
  milestones.sort((a, b) => {
    if (a.isOverdue && !b.isOverdue) return -1
    if (!a.isOverdue && b.isOverdue) return 1
    return a.deadline.getTime() - b.deadline.getTime()
  })

  logger.info({ total: milestones.length, overdue: milestones.filter(m => m.isOverdue).length }, 'Production milestones fetched')
  return milestones
}

/** Format milestones as text for the digest orchestrator prompt */
export function formatMilestonesForDigest(milestones: ProductionMilestone[]): string {
  if (milestones.length === 0) return ''

  const lines: string[] = ['--- ПРИБЛИЖАЮЩИЕСЯ МАЙЛСТОУНЫ (Production Updates) ---']

  for (const m of milestones) {
    const dateStr = m.deadline.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
    let urgency = ''
    if (m.isOverdue) urgency = ` ⚠️ ПРОСРОЧЕН на ${Math.abs(m.daysUntil)} дн.`
    else if (m.daysUntil <= 3) urgency = ` 🔴 через ${m.daysUntil} дн.`
    else if (m.daysUntil <= 7) urgency = ` 🟡 через ${m.daysUntil} дн.`
    else urgency = ` через ${m.daysUntil} дн.`

    lines.push(`[${m.projectCode}] ${m.name} — ${dateStr}${urgency}`)
  }

  return lines.join('\n')
}
