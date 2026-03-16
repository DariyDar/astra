/**
 * Knowledge Map Builder — generates a compact text index (~500-600 tokens)
 * from all YAML registry files for injection into Claude's system prompt.
 *
 * The map gives Claude an "table of contents" of all available organizational data,
 * enabling efficient navigation via kb_registry() tool calls.
 */

import { getAllProjects, getAllStatuses, loadProjectCard, refresh as refreshReader } from './reader.js'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { logger } from '../../logging/logger.js'

const REGISTRY_DIR = join(fileURLToPath(import.meta.url), '..')

const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

let cachedMap: string | null = null
let cachedAt: number = 0

/**
 * Build the knowledge map from YAML registry files.
 * Returns a compact text representation suitable for system prompt injection.
 */
export function buildKnowledgeMap(): string {
  const projects = getAllProjects()

  // Group projects by company
  const acProjects = projects.filter((p) => p.company === 'ac')
  const hgProjects = projects.filter((p) => p.company === 'hg')

  const formatList = (items: typeof projects): string => {
    return items
      .map((p) => {
        const suffix = p.status === 'inactive' ? ' [inactive]' : p.status === 'finished' ? ' [finished]' : ''
        return `${p.name}${suffix}`
      })
      .join(', ')
  }

  // Count resources
  const peopleCount = countPeople()
  const externalOrgCount = countExternalOrgs()
  const channelCount = countChannels()
  const clickupInfo = getClickUpSummary()
  const driveDocCount = countDriveDocs()
  const notionInfo = getNotionSummary()
  const processCount = countProcesses()

  // Get statuses summary
  const statuses = getAllStatuses()
  const activeStatuses = [...statuses.astrocat, ...statuses.highground]
    .filter((s) => s.current_focus !== 'TBD' && s.status === 'active')

  const lines = [
    `## Organizational Knowledge`,
    `You have a structured registry of ALL projects, people, documents, and resources.`,
    ``,
    `Projects (${projects.length}):`,
    `AC: ${formatList(acProjects)}`,
    `HG: ${formatList(hgProjects)}`,
    ``,
    `Resources indexed:`,
    `- ${peopleCount} people (internal) + ${externalOrgCount} external orgs`,
    `- ~${channelCount} Slack channels (classified by project)`,
    `- ${clickupInfo}`,
    `- ~${driveDocCount} Google Drive documents (with URLs, per-project catalogs)`,
    `- ${notionInfo}`,
    `- ${processCount} process descriptions`,
  ]

  if (activeStatuses.length > 0) {
    lines.push(``)
    lines.push(`Active project statuses (${activeStatuses.length} with data):`)
    for (const s of activeStatuses.slice(0, 5)) {
      const focus = s.current_focus.length > 80 ? s.current_focus.slice(0, 80) + '...' : s.current_focus
      lines.push(`- ${s.project}: ${focus}`)
    }
    if (activeStatuses.length > 5) {
      lines.push(`- ... and ${activeStatuses.length - 5} more`)
    }
  }

  // Naming conventions
  const namingRules = buildNamingConventions()
  if (namingRules) {
    lines.push(``)
    lines.push(namingRules)
  }

  // Freshness indicator
  const statusFile = join(REGISTRY_DIR, 'projects', '_current-status.yaml')
  let lastStatusUpdate = 'unknown'
  if (existsSync(statusFile)) {
    const stat = statSync(statusFile)
    lastStatusUpdate = stat.mtime.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  }
  lines.push(``)
  lines.push(`Registry data freshness: last updated ${lastStatusUpdate}`)

  lines.push(``)
  lines.push(`Navigation: call kb_registry(project="X") to get full project card (team, channels, docs with URLs, tasks, status).`)
  lines.push(`Call kb_registry(section="processes"|"wiki"|"drive"|"people"|"channels") for cross-project info.`)

  // Quick Reference — compact per-project channels/lists
  lines.push(``)
  lines.push(buildQuickReference(acProjects, hgProjects))

  // Key company-wide documents
  lines.push(``)
  lines.push(buildKeyDocuments())

  cachedMap = lines.join('\n')
  cachedAt = Date.now()
  return cachedMap
}

/**
 * Get the cached knowledge map, or build it if not cached or stale (>1 hour).
 */
export function getKnowledgeMap(): string {
  if (!cachedMap || Date.now() - cachedAt > CACHE_TTL_MS) {
    refreshReader()
    return buildKnowledgeMap()
  }
  return cachedMap
}

/**
 * Refresh the knowledge map by re-reading all YAML files.
 */
export function refreshKnowledgeMap(): void {
  refreshReader()
  cachedMap = null
  buildKnowledgeMap()
  logger.info({ mapLength: cachedMap!.length }, 'Knowledge map refreshed')
}

// ─── Quick Reference & Key Docs ───

/**
 * Build a compact per-project quick reference with Slack channels and ClickUp lists.
 * Saves 1 tool call per query by giving Claude channel/list names upfront.
 */
function buildQuickReference(
  acProjects: Array<{ name: string; company: string; status: string; aliases: string[] }>,
  hgProjects: Array<{ name: string; company: string; status: string; aliases: string[] }>,
): string {
  const formatProjectRef = (projects: Array<{ name: string; status: string }>): string => {
    const parts: string[] = []
    for (const p of projects.filter((pr) => pr.status === 'active')) {
      const card = loadProjectCardSafe(p.name)
      if (!card) {
        parts.push(p.name)
        continue
      }
      const channels = Object.keys(card.slack_channels)
      const cuLists = card.clickup_lists
      const extras: string[] = []
      if (channels.length > 0) extras.push(`Slack: ${channels.slice(0, 3).join(', ')}`)
      if (cuLists.length > 0) extras.push(`ClickUp: ~${cuLists.reduce((s, l) => s + l.chunks, 0)}`)
      parts.push(extras.length > 0 ? `${p.name} (${extras.join(' | ')})` : p.name)
    }
    return parts.join(', ')
  }

  return [
    `Project Quick Reference:`,
    `AC active: ${formatProjectRef(acProjects)}`,
    `HG active: ${formatProjectRef(hgProjects)}`,
  ].join('\n')
}

/**
 * Build a compact list of key company-wide documents from Drive.
 */
function buildKeyDocuments(): string {
  const docsFile = join(REGISTRY_DIR, 'resources', 'drive', 'company-ops.yaml')
  const data = loadYamlFile<{ documents: Array<{ title: string; description?: string }> }>(docsFile)
  if (!data?.documents) return ''

  const keyDocs = data.documents
    .filter((d) => /staff|forecast|budget|p&l|board|art planning|отпуска/i.test(`${d.title} ${d.description ?? ''}`))
    .slice(0, 8)

  if (keyDocs.length === 0) return ''

  const lines = ['Key company documents (Drive): ' + keyDocs.map((d) => d.title).join(', ')]
  lines.push('→ Use kb_registry(section="drive") for full list with URLs, then Drive tools to read content.')
  return lines.join('\n')
}

/**
 * Safely load a project card without throwing — returns null if not found.
 */
function loadProjectCardSafe(name: string): { slack_channels: Record<string, string>; clickup_lists: Array<{ list: string; chunks: number }> } | null {
  try {
    return loadProjectCard(name)
  } catch {
    return null
  }
}

// ─── Counters ───

function countPeople(): number {
  const dir = join(REGISTRY_DIR, 'people', 'internal')
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter((f) => f.endsWith('.yaml') && !f.startsWith('_')).length
}

function countExternalOrgs(): number {
  const dir = join(REGISTRY_DIR, 'people', 'external')
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter((f) => f.endsWith('.yaml')).length
}

function countChannels(): number {
  // Count from slack-channels.yaml (organizational + legacy)
  const chFile = join(REGISTRY_DIR, 'channels', 'slack-channels.yaml')
  const data = loadYamlFile<Record<string, unknown[]>>(chFile)
  let count = 0
  if (data) {
    for (const channels of Object.values(data)) {
      if (Array.isArray(channels)) count += channels.length
    }
  }

  // Also count project-level channels from projects/*.yaml
  const channelNames = new Set<string>()
  const projectsDir = join(REGISTRY_DIR, 'projects')
  if (existsSync(projectsDir)) {
    for (const file of readdirSync(projectsDir).filter((f) => f.endsWith('.yaml') && !f.startsWith('_'))) {
      const proj = loadYamlFile<{ slack_channels?: Record<string, string> }>(join(projectsDir, file))
      if (proj?.slack_channels) {
        for (const ch of Object.keys(proj.slack_channels)) {
          channelNames.add(ch)
        }
      }
    }
  }

  return count + channelNames.size
}

function getClickUpSummary(): string {
  const cuFile = join(REGISTRY_DIR, 'resources', 'clickup', 'tasks.yaml')
  const data = loadYamlFile<{ clickup_lists: Array<{ list: string; chunks: number }> }>(cuFile)
  if (!data?.clickup_lists) return 'ClickUp data not available'
  const total = data.clickup_lists.reduce((sum, l) => sum + l.chunks, 0)
  return `${data.clickup_lists.length} ClickUp lists (${total.toLocaleString()} tasks)`
}

function countDriveDocs(): number {
  const driveDir = join(REGISTRY_DIR, 'resources', 'drive')
  if (!existsSync(driveDir)) return 0
  const files = readdirSync(driveDir).filter((f) => f.endsWith('.yaml') && !f.startsWith('_'))
  let count = 0
  for (const file of files) {
    const data = loadYamlFile<{ documents: unknown[] }>(join(driveDir, file))
    if (data?.documents) count += data.documents.length
  }
  return count
}

function getNotionSummary(): string {
  const wikiFile = join(REGISTRY_DIR, 'resources', 'notion-wiki', 'pages.yaml')
  const data = loadYamlFile<{ notion: { summary?: { total_pages: number; total_chunks: number } } }>(wikiFile)
  if (!data?.notion?.summary) return 'Notion/Wiki data not available'
  const s = data.notion.summary
  return `${s.total_pages.toLocaleString()} Notion pages (${s.total_chunks.toLocaleString()} chunks)`
}

function countProcesses(): number {
  const overviewFile = join(REGISTRY_DIR, 'processes', '_overview.yaml')
  const data = loadYamlFile<{ cross_project?: unknown[]; per_project?: unknown[] }>(overviewFile)
  if (!data) return 0
  return (data.cross_project?.length ?? 0) + (data.per_project?.length ?? 0)
}

/**
 * Build a compact naming conventions block for the system prompt.
 * Maps English names (from Slack/Gmail) → canonical Russian names + short forms.
 */
function buildNamingConventions(): string | null {
  const dir = join(REGISTRY_DIR, 'people', 'internal')
  if (!existsSync(dir)) return null

  const mappings: string[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml') && !f.startsWith('_'))) {
    const data = loadYamlFile<{ name: string; aliases?: string[] }>(join(dir, file))
    if (!data?.name || !data.aliases?.length) continue

    // Find English alias(es) and short Russian names
    const englishAliases = data.aliases.filter((a) => /[a-zA-Z]/.test(a))
    const shortRussian = data.aliases.filter((a) => /[а-яА-ЯёЁ]/.test(a) && a !== data.name)

    if (englishAliases.length > 0) {
      const shortForm = shortRussian.length > 0 ? ` (${shortRussian[0].split(' ')[0]})` : ''
      mappings.push(`${englishAliases[0]} → ${data.name}${shortForm}`)
    }
  }

  if (mappings.length === 0) return null

  return `Naming conventions (ALWAYS use Russian names in responses):\n${mappings.join(', ')}`
}

function loadYamlFile<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null
    const content = readFileSync(filePath, 'utf-8')
    return yaml.load(content) as T
  } catch {
    return null
  }
}
