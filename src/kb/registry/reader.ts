/**
 * Registry Reader — loads and merges YAML-based Knowledge Registry files.
 *
 * Provides:
 * - loadProjectCard(name) → full project card with team, channels, docs, status
 * - loadSection(section) → cross-project data (people, processes, drive, clickup, wiki, channels)
 * - fuzzy project name matching (aliases, case-insensitive, word-boundary for short terms)
 * - In-memory cache with explicit refresh()
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { logger } from '../../logging/logger.js'

const REGISTRY_DIR = join(fileURLToPath(import.meta.url), '..')

// ─── Types ───

export interface ProjectCard {
  name: string
  aliases: string[]
  company: string
  status: string
  platform?: string[]
  note?: string
  slack_channels: Record<string, string>
  team_internal: Array<{ name: string; role: string; status: string }>
  team_external: Record<string, { note: string; contacts: Array<{ name: string; role: string; status: string }> }>
  processes: Array<{ name: string; cadence: string; description?: string }>
  resources: Array<{ name: string; type: string; description?: string }>
  drive_docs: Array<{ title: string; url: string; type: string; owner: string; last_modified?: string; description?: string }>
  clickup_lists: Array<{ list: string; chunks: number; note?: string }>
  notion_pages: string[]
  current_status: ProjectStatus | null
}

export interface ProjectStatus {
  project: string
  status: string
  current_focus: string
  monitoring: { slack: string[]; clickup: string | false; jira?: string }
  updated_at: string
  open_tasks?: number
  overdue_tasks?: number
  last_slack_activity?: string
}

interface DriveDoc {
  title: string
  url: string
  type: string
  owner: string
  last_modified?: string
  description?: string
  project?: string
}

interface DriveCatalog {
  project?: string
  projects?: Array<{ name: string; aliases?: string[]; status?: string }>
  documents: DriveDoc[]
}

interface ClickUpList {
  list: string
  chunks: number
  project: string
  company: string
  note?: string
}

// ─── Cache ───

let projectsCache: Map<string, ProjectCard> | null = null
let statusCache: { astrocat: ProjectStatus[]; highground: ProjectStatus[] } | null = null
let driveIndex: Map<string, DriveDoc[]> | null = null
let clickupLists: ClickUpList[] | null = null

// ─── YAML loader ───

function loadYaml<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null
    const content = readFileSync(filePath, 'utf-8')
    return yaml.load(content) as T
  } catch (error) {
    logger.warn({ filePath, error: error instanceof Error ? error.message : String(error) }, 'Failed to load YAML')
    return null
  }
}

// ─── Fuzzy matching ───

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fuzzyMatch(query: string, candidates: string[]): boolean {
  const lower = query.toLowerCase()
  return candidates.some((term) => {
    const t = term.toLowerCase()
    if (t.length <= 3) {
      return new RegExp(`\\b${escapeRegex(t)}\\b`, 'i').test(lower)
    }
    return lower.includes(t)
  })
}

/**
 * Find a project by name or alias. Case-insensitive, supports fuzzy matching.
 */
export function findProject(query: string): ProjectCard | null {
  ensureProjectsLoaded()
  const lower = query.toLowerCase()

  // Exact match on name
  for (const [, card] of projectsCache!) {
    if (card.name.toLowerCase() === lower) return card
  }

  // Alias match
  for (const [, card] of projectsCache!) {
    const allTerms = [card.name, ...card.aliases]
    if (fuzzyMatch(query, allTerms)) return card
  }

  return null
}

// ─── Loaders ───

function ensureProjectsLoaded(): void {
  if (projectsCache) return
  projectsCache = new Map()

  const projectsDir = join(REGISTRY_DIR, 'projects')
  if (!existsSync(projectsDir)) return

  const files = readdirSync(projectsDir).filter((f) => f.endsWith('.yaml') && !f.startsWith('_'))

  // Load statuses
  ensureStatusLoaded()

  // Load drive index
  ensureDriveLoaded()

  // Load ClickUp
  ensureClickUpLoaded()

  for (const file of files) {
    const data = loadYaml<Record<string, unknown>>(join(projectsDir, file))
    if (!data || !data.name) continue

    const name = data.name as string
    const aliases = (data.aliases as string[]) ?? []
    const company = (data.company as string) ?? ''
    const status = (data.status as string) ?? 'active'

    // Parse team_internal
    const teamRaw = (data.team_internal as Array<Record<string, string>>) ?? []
    const team_internal = teamRaw.map((t) => ({
      name: t.name ?? '',
      role: t.role ?? '',
      status: t.status ?? 'active',
    }))

    // Parse team_external
    const teamExtRaw = (data.team_external ?? {}) as Record<string, Record<string, unknown>>
    const team_external: Record<string, { note: string; contacts: Array<{ name: string; role: string; status: string }> }> = {}
    for (const [key, val] of Object.entries(teamExtRaw)) {
      const contactsRaw = (val.contacts as Array<Record<string, string>>) ?? []
      team_external[key] = {
        note: (val.note as string) ?? '',
        contacts: contactsRaw.map((c) => ({ name: c.name ?? '', role: c.role ?? '', status: c.status ?? 'active' })),
      }
    }

    // Parse slack_channels
    const slackRaw = (data.slack_channels ?? {}) as Record<string, string>

    // Parse processes
    const processesRaw = (data.processes as Array<Record<string, string>>) ?? []
    const processes = processesRaw.map((p) => ({
      name: p.name ?? '',
      cadence: p.cadence ?? '',
      description: p.description,
    }))

    // Parse resources
    const resourcesRaw = (data.resources as Array<Record<string, string>>) ?? []
    const resources = resourcesRaw.map((r) => ({
      name: r.name ?? '',
      type: r.type ?? '',
      description: r.description,
    }))

    // Get Drive docs for this project
    const driveDocs = getDriveDocsForProject(name, aliases)

    // Get ClickUp lists for this project
    const cuLists = getClickUpListsForProject(name, aliases)

    // Get Notion pages for this project
    const notionPages = getNotionPagesForProject(name)

    // Get current status
    const currentStatus = findStatusForProject(name)

    const card: ProjectCard = {
      name,
      aliases,
      company,
      status,
      platform: data.platform as string[] | undefined,
      note: data.note as string | undefined,
      slack_channels: slackRaw,
      team_internal,
      team_external,
      processes,
      resources,
      drive_docs: driveDocs,
      clickup_lists: cuLists,
      notion_pages: notionPages,
      current_status: currentStatus,
    }

    projectsCache.set(name, card)
  }
}

function ensureStatusLoaded(): void {
  if (statusCache) return
  const statusFile = join(REGISTRY_DIR, 'projects', '_current-status.yaml')
  const data = loadYaml<Record<string, unknown>>(statusFile)
  if (!data) {
    statusCache = { astrocat: [], highground: [] }
    return
  }
  statusCache = {
    astrocat: (data.astrocat as ProjectStatus[]) ?? [],
    highground: (data.highground as ProjectStatus[]) ?? [],
  }
}

function findStatusForProject(projectName: string): ProjectStatus | null {
  ensureStatusLoaded()
  const all = [...statusCache!.astrocat, ...statusCache!.highground]
  return all.find((s) => s.project.toLowerCase() === projectName.toLowerCase()) ?? null
}

function ensureDriveLoaded(): void {
  if (driveIndex) return
  driveIndex = new Map()

  const driveDir = join(REGISTRY_DIR, 'resources', 'drive')
  if (!existsSync(driveDir)) return

  const files = readdirSync(driveDir).filter((f) => f.endsWith('.yaml') && !f.startsWith('_'))

  for (const file of files) {
    const data = loadYaml<DriveCatalog>(join(driveDir, file))
    if (!data?.documents) continue

    // Single-project catalog
    if (data.project) {
      const existing = driveIndex.get(data.project.toLowerCase()) ?? []
      existing.push(...data.documents)
      driveIndex.set(data.project.toLowerCase(), existing)
    }

    // Multi-project catalog (small-projects.yaml, company-ops.yaml)
    if (data.projects) {
      for (const p of data.projects) {
        // Docs with project field go to that project
        for (const doc of data.documents) {
          if (doc.project) {
            const key = doc.project.toLowerCase()
            const existing = driveIndex.get(key) ?? []
            existing.push(doc)
            driveIndex.set(key, existing)
          }
        }
      }
    }

    // company-ops has no project per doc → store under "_company-ops"
    if (!data.project && !data.projects) {
      const key = basename(file, '.yaml')
      const existing = driveIndex.get(key) ?? []
      existing.push(...data.documents)
      driveIndex.set(key, existing)
    }
  }
}

function getDriveDocsForProject(name: string, aliases: string[]): DriveDoc[] {
  ensureDriveLoaded()
  const lower = name.toLowerCase()

  // Direct match
  if (driveIndex!.has(lower)) return driveIndex!.get(lower)!

  // Try aliases
  for (const alias of aliases) {
    if (driveIndex!.has(alias.toLowerCase())) return driveIndex!.get(alias.toLowerCase())!
  }

  return []
}

function ensureClickUpLoaded(): void {
  if (clickupLists) return
  const cuFile = join(REGISTRY_DIR, 'resources', 'clickup', 'tasks.yaml')
  const data = loadYaml<{ clickup_lists: ClickUpList[] }>(cuFile)
  clickupLists = data?.clickup_lists ?? []
}

function getClickUpListsForProject(name: string, aliases: string[]): Array<{ list: string; chunks: number; note?: string }> {
  ensureClickUpLoaded()
  const terms = [name, ...aliases].map((t) => t.toLowerCase())

  return clickupLists!
    .filter((l) => {
      if (!l.project) return false
      const projLower = l.project.toLowerCase()
      return terms.some((t) => projLower.includes(t) || t.includes(projLower))
    })
    .map((l) => ({ list: l.list, chunks: l.chunks, note: l.note }))
}

function getNotionPagesForProject(name: string): string[] {
  const wikiFile = join(REGISTRY_DIR, 'resources', 'notion-wiki', 'pages.yaml')
  const data = loadYaml<{ notion: Record<string, unknown> }>(wikiFile)
  if (!data?.notion) return []

  // Find project section by scanning keys
  const lower = name.toLowerCase().replace(/[^a-z0-9]/g, '_')
  for (const [key, val] of Object.entries(data.notion)) {
    if (key === 'summary') continue
    const section = val as { project?: string; pages?: string[] }
    if (section.project?.toLowerCase() === name.toLowerCase()) {
      return section.pages ?? []
    }
    // Try key match
    if (key.toLowerCase().replace(/[^a-z0-9]/g, '_').includes(lower)) {
      return (section as { pages?: string[] }).pages ?? []
    }
  }

  return []
}

// ─── Public API ───

/**
 * Load full project card by name or alias.
 */
export function loadProjectCard(projectName: string): ProjectCard | null {
  return findProject(projectName)
}

/**
 * Get all projects as a list of summaries (for knowledge map).
 */
export function getAllProjects(): Array<{ name: string; company: string; status: string; aliases: string[] }> {
  ensureProjectsLoaded()
  return [...projectsCache!.values()].map((c) => ({
    name: c.name,
    company: c.company,
    status: c.status,
    aliases: c.aliases,
  }))
}

/**
 * Get all project statuses.
 */
export function getAllStatuses(): { astrocat: ProjectStatus[]; highground: ProjectStatus[] } {
  ensureStatusLoaded()
  return statusCache!
}

/**
 * Load a section of the registry.
 */
export function loadSection(section: string): string {
  switch (section) {
    case 'people':
      return loadPeopleSection()
    case 'processes':
      return loadProcessesSection()
    case 'drive':
      return loadDriveSection()
    case 'clickup':
      return loadClickUpSection()
    case 'wiki':
      return loadWikiSection()
    case 'channels':
      return loadChannelsSection()
    default:
      return `Unknown section: ${section}. Available: people, processes, drive, clickup, wiki, channels`
  }
}

function loadPeopleSection(): string {
  const dir = join(REGISTRY_DIR, 'people', 'internal')
  if (!existsSync(dir)) return 'No people directory found'

  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') && !f.startsWith('_'))
  const people: Array<{ name: string; role: string; company: string; status: string }> = []

  for (const file of files) {
    const data = loadYaml<Record<string, unknown>>(join(dir, file))
    if (!data?.name) continue
    people.push({
      name: data.name as string,
      role: (data.role as string) ?? '',
      company: Array.isArray(data.company) ? (data.company as string[]).join(', ') : (data.company as string) ?? '',
      status: (data.status as string) ?? 'active',
    })
  }

  // Also load former employees
  const formerFile = join(dir, '_former.yaml')
  const formerData = loadYaml<{ former: Array<Record<string, unknown>> }>(formerFile)
  if (formerData?.former) {
    for (const f of formerData.former) {
      people.push({
        name: (f.name as string) ?? '',
        role: (f.role as string) ?? '',
        company: '',
        status: 'former',
      })
    }
  }

  const lines = ['## Internal People\n']
  const active = people.filter((p) => p.status === 'active')
  const former = people.filter((p) => p.status === 'former')

  for (const p of active) {
    lines.push(`- **${p.name}** — ${p.role} (${p.company})`)
  }

  if (former.length > 0) {
    lines.push(`\n### Former (${former.length})`)
    for (const p of former) {
      lines.push(`- ${p.name} — ${p.role}`)
    }
  }

  // External people
  const extDir = join(REGISTRY_DIR, 'people', 'external')
  if (existsSync(extDir)) {
    const extFiles = readdirSync(extDir).filter((f) => f.endsWith('.yaml'))
    lines.push(`\n## External Organizations (${extFiles.length})`)
    for (const file of extFiles) {
      const name = basename(file, '.yaml').replace(/-/g, ' ')
      lines.push(`- ${name}`)
    }
  }

  return lines.join('\n')
}

function loadProcessesSection(): string {
  const overviewFile = join(REGISTRY_DIR, 'processes', '_overview.yaml')
  const data = loadYaml<Record<string, unknown>>(overviewFile)
  if (!data) return 'No processes overview found'

  const lines = ['## Processes\n']

  // Cross-project
  const cross = (data.cross_project as Array<Record<string, string>>) ?? []
  if (cross.length > 0) {
    lines.push('### Cross-project')
    for (const p of cross) {
      lines.push(`- **${p.name}** (${p.cadence}) — projects: ${p.projects}`)
    }
  }

  // Per-project
  const perProject = (data.per_project as Array<Record<string, string>>) ?? []
  if (perProject.length > 0) {
    lines.push('\n### Per-project')
    let currentProject = ''
    for (const p of perProject) {
      if (p.project !== currentProject) {
        currentProject = p.project
        lines.push(`\n**${currentProject}:**`)
      }
      lines.push(`  - ${p.name} (${p.cadence})`)
    }
  }

  return lines.join('\n')
}

function loadDriveSection(): string {
  const indexFile = join(REGISTRY_DIR, 'resources', 'drive', '_index.yaml')
  const data = loadYaml<{ catalogs: Array<Record<string, unknown>> }>(indexFile)
  if (!data?.catalogs) return 'No Drive index found'

  const lines = ['## Google Drive Catalogs\n']
  for (const cat of data.catalogs) {
    const project = (cat.project as string) ?? (cat.scope as string) ?? 'Unknown'
    const desc = (cat.description as string) ?? ''
    const file = cat.file as string
    lines.push(`- **${project}** (${file}): ${desc}`)
  }

  return lines.join('\n')
}

function loadClickUpSection(): string {
  ensureClickUpLoaded()
  const lines = ['## ClickUp Lists\n']
  for (const l of clickupLists!) {
    const note = l.note ? ` — ${l.note}` : ''
    lines.push(`- **${l.list}** (${l.chunks} tasks, ${l.project})${note}`)
  }
  return lines.join('\n')
}

function loadWikiSection(): string {
  const wikiFile = join(REGISTRY_DIR, 'resources', 'notion-wiki', 'pages.yaml')
  const data = loadYaml<{ notion: Record<string, unknown> }>(wikiFile)
  if (!data?.notion) return 'No Notion/Wiki data found'

  const lines = ['## Notion / Wiki Pages\n']

  for (const [key, val] of Object.entries(data.notion)) {
    if (key === 'summary') {
      const summary = val as Record<string, unknown>
      lines.push(`Total: ${summary.total_pages} pages, ${summary.total_chunks} chunks\n`)
      continue
    }
    const section = val as { project?: string; pages?: string[] }
    const project = section.project ?? key
    const pages = section.pages ?? []
    lines.push(`**${project}** (${pages.length} pages):`)
    for (const page of pages.slice(0, 5)) {
      lines.push(`  - ${page}`)
    }
    if (pages.length > 5) {
      lines.push(`  - ... and ${pages.length - 5} more`)
    }
  }

  return lines.join('\n')
}

function loadChannelsSection(): string {
  const chFile = join(REGISTRY_DIR, 'channels', 'slack-channels.yaml')
  const data = loadYaml<Record<string, unknown>>(chFile)
  if (!data) return 'No channels data found'

  const lines = ['## Slack Channels\n']

  for (const [category, channels] of Object.entries(data)) {
    if (typeof channels !== 'object' || !Array.isArray(channels)) continue
    lines.push(`### ${category} (${channels.length})`)
    for (const ch of channels.slice(0, 10) as Array<Record<string, unknown>>) {
      const name = ch.channel as string
      const ws = ch.workspace as string
      const desc = (ch.description as string) ?? ''
      const shortDesc = desc.split('.')[0].trim()
      lines.push(`- **${name}** (${ws}) — ${shortDesc}`)
    }
    if (channels.length > 10) {
      lines.push(`- ... and ${channels.length - 10} more`)
    }
  }

  return lines.join('\n')
}

/**
 * Format a project card as readable text for Claude.
 */
export function formatProjectCard(card: ProjectCard): string {
  const lines: string[] = []

  lines.push(`# ${card.name}`)
  if (card.aliases.length > 0) lines.push(`Aliases: ${card.aliases.join(', ')}`)
  lines.push(`Company: ${card.company} | Status: ${card.status}`)
  if (card.platform) lines.push(`Platform: ${card.platform.join(', ')}`)
  if (card.note) lines.push(`\n${card.note.trim()}`)

  // Current status
  if (card.current_status) {
    const s = card.current_status
    lines.push(`\n## Current Status (${s.updated_at})`)
    lines.push(s.current_focus)
    if (s.open_tasks !== undefined) lines.push(`Open tasks: ${s.open_tasks}, Overdue: ${s.overdue_tasks ?? 0}`)
  }

  // Team
  if (card.team_internal.length > 0) {
    lines.push(`\n## Team (${card.team_internal.length})`)
    for (const t of card.team_internal) {
      lines.push(`- ${t.name} — ${t.role}`)
    }
  }

  // External team
  const extKeys = Object.keys(card.team_external)
  if (extKeys.length > 0) {
    lines.push('\n## External')
    for (const [key, val] of Object.entries(card.team_external)) {
      lines.push(`- ${key}: ${val.note}`)
      for (const c of val.contacts) {
        lines.push(`  - ${c.name} — ${c.role}`)
      }
    }
  }

  // Slack channels
  const chKeys = Object.keys(card.slack_channels)
  if (chKeys.length > 0) {
    lines.push('\n## Slack Channels')
    for (const [ch, desc] of Object.entries(card.slack_channels)) {
      lines.push(`- #${ch} — ${desc}`)
    }
  }

  // Processes
  if (card.processes.length > 0) {
    lines.push('\n## Processes')
    for (const p of card.processes) {
      lines.push(`- ${p.name} (${p.cadence})`)
    }
  }

  // Drive docs
  if (card.drive_docs.length > 0) {
    lines.push(`\n## Google Drive Documents (${card.drive_docs.length})`)
    for (const d of card.drive_docs) {
      const desc = d.description ? ` — ${d.description.trim().split('\n')[0]}` : ''
      lines.push(`- [${d.type}] ${d.title}${desc}`)
      lines.push(`  URL: ${d.url}`)
    }
  }

  // ClickUp
  if (card.clickup_lists.length > 0) {
    lines.push('\n## ClickUp Lists')
    for (const l of card.clickup_lists) {
      lines.push(`- ${l.list} (${l.chunks} tasks)`)
    }
  }

  // Notion pages
  if (card.notion_pages.length > 0) {
    lines.push(`\n## Notion/Wiki Pages (${card.notion_pages.length})`)
    for (const p of card.notion_pages) {
      lines.push(`- ${p}`)
    }
  }

  // Resources
  if (card.resources.length > 0) {
    lines.push('\n## Other Resources')
    for (const r of card.resources) {
      lines.push(`- ${r.name} (${r.type})`)
    }
  }

  return lines.join('\n')
}

/**
 * Invalidate all caches. Call after YAML files are updated.
 */
export function refresh(): void {
  projectsCache = null
  statusCache = null
  driveIndex = null
  clickupLists = null
}
