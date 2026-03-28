/**
 * Vault Reader — reads the Obsidian vault (markdown + YAML frontmatter)
 * and provides a unified API for all KB consumers.
 *
 * Replaces: kb-facade.ts (entity queries), registry/reader.ts, registry/knowledge-map-builder.ts
 */

import matter from 'gray-matter'
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { logger } from '../logging/logger.js'
import type { EntityType } from './types.js'

// ── Types ──

export interface ProjectStatus {
  project: string
  status: string
  current_focus: string
  updated_at: string
  milestones: string[]
  open_tasks?: number
  overdue_tasks?: number
  last_slack_activity?: string
}

export interface ProjectCard {
  name: string
  aliases: string[]
  company: string
  status: string
  client: string | null
  display_name: string
  slack_channels: Record<string, string>
  team_internal: string[]
  team_external: Record<string, string[]>
  processes: string[]
  resources: string[]
  drive_docs: string[]
  clickup_lists: Array<{ list: string; chunks: number }>
  notion_pages: string[]
  current_status: ProjectStatus | null
  note: string | null
  platform: string | null
}

export interface FacadeEntity {
  id: string
  type: EntityType
  name: string
  company: string | null
  metadata?: Record<string, unknown> | null
}

export interface FacadeAlias {
  entityId: string
  alias: string
}

// ── Internal types ──

interface VaultEntry {
  filename: string
  frontmatter: Record<string, unknown>
  body: string
}

// ── Cache ──

const VAULT_DIR = join(process.cwd(), 'vault')
const CACHE_TTL_MS = 60 * 60 * 1000

let projectEntries: Map<string, VaultEntry> | null = null
let peopleEntries: Map<string, VaultEntry> | null = null
let companyCodeMap: Map<string, string> | null = null
let aliasIndex: Map<string, { type: 'project' | 'person'; key: string }> | null = null
let knowledgeMapCache: string | null = null
let cacheTimestamp = 0

// ── Utilities ──

function strip(s: unknown): string {
  if (typeof s !== 'string') return ''
  return s.replace(/\[\[/g, '').replace(/\]\]/g, '').trim()
}

function stripArray(arr: unknown): string[] {
  if (!Array.isArray(arr)) return []
  return arr.map(strip).filter(Boolean)
}

function readMdFiles(dir: string): Map<string, VaultEntry> {
  const map = new Map<string, VaultEntry>()
  if (!existsSync(dir)) return map
  for (const file of readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_'))) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8')
      const { data, content } = matter(raw)
      const filename = basename(file, '.md')
      map.set(filename, { filename, frontmatter: data as Record<string, unknown>, body: content })
    } catch {
      // skip malformed files
    }
  }
  return map
}

function resolveCompanyCode(raw: unknown): string {
  ensureLoaded()
  const name = strip(raw)
  if (!name) return ''
  const lower = name.toLowerCase()
  if (lower === 'astrocat' || lower === 'ac') return 'ac'
  if (lower === 'highground' || lower === 'hg') return 'hg'
  return companyCodeMap!.get(name) ?? lower
}

// ── Loading ──

function ensureLoaded(): void {
  if (projectEntries && Date.now() - cacheTimestamp < CACHE_TTL_MS) return
  loadAll()
}

function loadAll(): void {
  // Companies
  companyCodeMap = new Map()
  const compDir = join(VAULT_DIR, 'companies')
  if (existsSync(compDir)) {
    for (const file of readdirSync(compDir).filter(f => f.endsWith('.md'))) {
      const name = basename(file, '.md')
      const lower = name.toLowerCase()
      if (lower.includes('astrocat') || lower.includes('astro cat')) companyCodeMap.set(name, 'ac')
      else if (lower.includes('highground') || lower.includes('high ground')) companyCodeMap.set(name, 'hg')
    }
  }

  // Projects
  projectEntries = readMdFiles(join(VAULT_DIR, 'projects'))

  // People
  peopleEntries = readMdFiles(join(VAULT_DIR, 'people', 'internal'))

  // Alias index
  aliasIndex = new Map()
  for (const [key, entry] of projectEntries) {
    const fm = entry.frontmatter
    aliasIndex.set(key.toLowerCase(), { type: 'project', key })
    const name = strip(fm.display_name) || key
    if (name.toLowerCase() !== key.toLowerCase()) aliasIndex.set(name.toLowerCase(), { type: 'project', key })
    for (const alias of stripArray(fm.aliases)) {
      aliasIndex.set(alias.toLowerCase(), { type: 'project', key })
    }
  }
  for (const [key, entry] of peopleEntries) {
    const fm = entry.frontmatter
    aliasIndex.set(key.toLowerCase(), { type: 'person', key })
    const name = strip(fm.display_name) || key
    if (name.toLowerCase() !== key.toLowerCase()) aliasIndex.set(name.toLowerCase(), { type: 'person', key })
    for (const alias of stripArray(fm.aliases)) {
      aliasIndex.set(alias.toLowerCase(), { type: 'person', key })
    }
  }

  cacheTimestamp = Date.now()
  logger.info({ projects: projectEntries.size, people: peopleEntries.size, aliases: aliasIndex.size }, 'Vault loaded')
}

// ── Status parser ──

function parseStatusSection(body: string, projectName: string): ProjectStatus | null {
  const match = body.match(/## Статус\s*\n([\s\S]*?)(?=\n## |\n$|$)/)
  if (!match) return null
  const section = match[1]

  const updated = section.match(/Последнее обновление:\s*(.+)/)?.[1]?.trim() ?? ''
  const focus = section.match(/Текущий фокус:\s*([\s\S]*?)(?=\nПоследние вехи:|$)/)?.[1]?.trim() ?? ''
  const milestones: string[] = []
  const milestoneRe = /^- \d{4}-\d{2}-\d{2}:\s*.+$/gm
  let m
  while ((m = milestoneRe.exec(section)) !== null) {
    milestones.push(m[0].replace(/^- /, ''))
  }

  if (!updated && !focus) return null
  return { project: projectName, status: 'active', current_focus: focus, updated_at: updated, milestones }
}

// ── Section parsers ──

function parseChannels(body: string): Record<string, string> {
  const channels: Record<string, string> = {}
  const re = /^- #([\w-]+)\s*(?:\([^)]*\))?\s*—?\s*(.*)$/gm
  let m
  while ((m = re.exec(body)) !== null) {
    channels[`#${m[1]}`] = m[2]?.trim() ?? ''
  }
  return channels
}

function parseTeam(body: string): string[] {
  const teamSection = body.match(/## Команда\s*\n([\s\S]*?)(?=\n## |\n$|$)/)
  if (!teamSection) return []
  const members: string[] = []
  const re = /\[\[([^\]]+)\]\]/g
  let m
  while ((m = re.exec(teamSection[1])) !== null) {
    members.push(m[1])
  }
  return members
}

function parseResources(body: string): string[] {
  const section = body.match(/## Ресурсы\s*\n([\s\S]*?)(?=\n## |\n$|$)/)
  if (!section) return []
  return section[1].split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2).trim())
}

function parseDocs(body: string): string[] {
  const section = body.match(/## Документация\s*\n([\s\S]*?)(?=\n## |\n$|$)/)
  if (!section) return []
  return section[1].split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2).trim())
}

// ── kb-facade replacements ──

export function findEntitiesByType(type: EntityType): FacadeEntity[] {
  ensureLoaded()
  if (type === 'project') {
    return [...projectEntries!.values()].map(e => ({
      id: e.filename,
      type: 'project' as EntityType,
      name: e.filename,
      company: resolveCompanyCode(e.frontmatter.company),
      metadata: {
        display_name: strip(e.frontmatter.display_name) || e.filename,
        aliases: stripArray(e.frontmatter.aliases),
        client: strip(e.frontmatter.client) || null,
        status: (e.frontmatter.status as string) ?? 'active',
      },
    }))
  }
  if (type === 'person') {
    return [...peopleEntries!.values()].map(e => ({
      id: e.filename,
      type: 'person' as EntityType,
      name: e.filename,
      company: resolveCompanyCode(Array.isArray(e.frontmatter.company) ? e.frontmatter.company[0] : e.frontmatter.company),
      metadata: {
        display_name: strip(e.frontmatter.display_name) || e.filename,
        role: (e.frontmatter.role as string) ?? '',
        aliases: stripArray(e.frontmatter.aliases),
      },
    }))
  }
  return []
}

export function findEntityByName(name: string): FacadeEntity | null {
  ensureLoaded()
  const ref = aliasIndex!.get(name.toLowerCase())
  if (!ref) return null
  const entries = ref.type === 'project' ? projectEntries! : peopleEntries!
  const entry = entries.get(ref.key)
  if (!entry) return null
  return {
    id: entry.filename,
    type: ref.type as EntityType,
    name: entry.filename,
    company: resolveCompanyCode(entry.frontmatter.company),
    metadata: entry.frontmatter,
  }
}

export function getAliasesForEntityIds(ids: string[]): FacadeAlias[] {
  ensureLoaded()
  const result: FacadeAlias[] = []
  for (const id of ids) {
    const projEntry = projectEntries!.get(id)
    const personEntry = peopleEntries!.get(id)
    const entry = projEntry ?? personEntry
    if (!entry) continue
    result.push({ entityId: id, alias: entry.filename })
    for (const alias of stripArray(entry.frontmatter.aliases)) {
      result.push({ entityId: id, alias })
    }
  }
  return result
}

// ── registry/reader replacements ──

export function getAllProjects(): Array<{ name: string; company: string; status: string; aliases: string[] }> {
  ensureLoaded()
  return [...projectEntries!.values()].map(e => ({
    name: e.filename,
    company: resolveCompanyCode(e.frontmatter.company),
    status: (e.frontmatter.status as string) ?? 'active',
    aliases: stripArray(e.frontmatter.aliases),
  }))
}

export function getAllStatuses(): { astrocat: ProjectStatus[]; highground: ProjectStatus[] } {
  ensureLoaded()
  const result: { astrocat: ProjectStatus[]; highground: ProjectStatus[] } = { astrocat: [], highground: [] }
  for (const entry of projectEntries!.values()) {
    const code = resolveCompanyCode(entry.frontmatter.company)
    const status = parseStatusSection(entry.body, entry.filename)
    if (!status) continue
    status.status = (entry.frontmatter.status as string) ?? 'active'
    if (code === 'ac') result.astrocat.push(status)
    else if (code === 'hg') result.highground.push(status)
  }
  return result
}

export function findProject(query: string): ProjectCard | null {
  ensureLoaded()
  const lower = query.toLowerCase()
  const ref = aliasIndex!.get(lower)
  if (ref?.type === 'project') return buildProjectCard(ref.key)

  // Fuzzy: word boundary match for short queries
  for (const [key, entry] of projectEntries!) {
    const allTerms = [key, strip(entry.frontmatter.display_name), ...stripArray(entry.frontmatter.aliases)]
    for (const term of allTerms) {
      if (term.toLowerCase() === lower) return buildProjectCard(key)
    }
  }
  return null
}

export function loadProjectCard(name: string): ProjectCard | null {
  return findProject(name)
}

function buildProjectCard(key: string): ProjectCard | null {
  ensureLoaded()
  const entry = projectEntries!.get(key)
  if (!entry) return null
  const fm = entry.frontmatter

  return {
    name: key,
    aliases: stripArray(fm.aliases),
    company: resolveCompanyCode(fm.company),
    status: (fm.status as string) ?? 'active',
    client: strip(fm.client) || null,
    display_name: strip(fm.display_name) || key,
    slack_channels: parseChannels(entry.body),
    team_internal: parseTeam(entry.body),
    team_external: {},
    processes: [],
    resources: parseResources(entry.body),
    drive_docs: parseDocs(entry.body),
    clickup_lists: [],
    notion_pages: [],
    current_status: parseStatusSection(entry.body, key),
    note: (fm.note as string) ?? null,
    platform: (fm.platform as string) ?? null,
  }
}

export function findCompanyProjects(query: string): { company: string; projects: ProjectCard[] } | null {
  ensureLoaded()
  const lower = query.toLowerCase()
  let code = ''
  if (/astrocat|ac/.test(lower)) code = 'ac'
  else if (/highground|hg/.test(lower)) code = 'hg'
  else return null

  const projects = [...projectEntries!.entries()]
    .filter(([, e]) => resolveCompanyCode(e.frontmatter.company) === code)
    .map(([key]) => buildProjectCard(key)!)
    .filter(Boolean)

  return { company: code === 'ac' ? 'AstroCat' : 'Highground', projects }
}

export function loadSection(section: string): string {
  ensureLoaded()
  if (section === 'people') {
    const lines = [...peopleEntries!.values()].map(e => {
      const role = (e.frontmatter.role as string) ?? ''
      const status = (e.frontmatter.status as string) ?? 'active'
      return `- ${e.filename}: ${role}${status === 'left' ? ' (left)' : ''}`
    })
    return `Сотрудники (${lines.length}):\n${lines.join('\n')}`
  }
  if (section === 'processes') {
    const file = join(VAULT_DIR, 'processes', 'Overview.md')
    if (!existsSync(file)) return 'No processes overview found.'
    return readFileSync(file, 'utf-8')
  }
  if (section === 'channels') {
    const file = join(VAULT_DIR, 'channels', 'Slack Channels.md')
    if (!existsSync(file)) return 'No channels file found.'
    return readFileSync(file, 'utf-8')
  }
  return `Section "${section}" — see individual project cards for embedded resources.`
}

export function formatProjectCard(card: ProjectCard): string {
  const lines: string[] = [`# ${card.name}`]
  if (card.client) lines.push(`Client: ${card.client}`)
  lines.push(`Company: ${card.company.toUpperCase()} | Status: ${card.status}`)
  if (card.display_name !== card.name) lines.push(`Display name: ${card.display_name}`)
  if (card.aliases.length) lines.push(`Aliases: ${card.aliases.join(', ')}`)
  if (card.team_internal.length) lines.push(`\nTeam: ${card.team_internal.join(', ')}`)
  const chNames = Object.keys(card.slack_channels)
  if (chNames.length) lines.push(`\nSlack channels: ${chNames.join(', ')}`)
  if (card.resources.length) lines.push(`\nResources:\n${card.resources.map(r => `- ${r}`).join('\n')}`)
  if (card.drive_docs.length) lines.push(`\nDocumentation:\n${card.drive_docs.map(d => `- ${d}`).join('\n')}`)
  if (card.current_status) {
    lines.push(`\nStatus (${card.current_status.updated_at}): ${card.current_status.current_focus}`)
    if (card.current_status.milestones.length) {
      lines.push(`Milestones:\n${card.current_status.milestones.map(m => `- ${m}`).join('\n')}`)
    }
  }
  return lines.join('\n')
}

// ── Knowledge map ──

export function buildKnowledgeMap(): string {
  ensureLoaded()
  const projects = getAllProjects()
  const acProjects = projects.filter(p => p.company === 'ac')
  const hgProjects = projects.filter(p => p.company === 'hg')

  const fmtList = (items: typeof projects) => items.map(p => {
    const suffix = p.status === 'inactive' ? ' [inactive]' : p.status === 'finished' ? ' [finished]' : p.status === 'frozen' ? ' [frozen]' : ''
    return `${p.name}${suffix}`
  }).join(', ')

  const statuses = getAllStatuses()
  const activeStatuses = [...statuses.astrocat, ...statuses.highground]
    .filter(s => s.current_focus && s.status === 'active')

  const lines = [
    `## Organizational Knowledge`,
    `You have a structured registry of ALL projects, people, documents, and resources.`,
    ``,
    `Projects (${projects.length}):`,
    `AC: ${fmtList(acProjects)}`,
    `HG: ${fmtList(hgProjects)}`,
    ``,
    `Resources indexed:`,
    `- ${peopleEntries!.size} people (internal)`,
    `- Slack channels per project (see Quick Reference)`,
  ]

  if (activeStatuses.length > 0) {
    lines.push(``, `Active project statuses (${activeStatuses.length} with data):`)
    for (const s of activeStatuses.slice(0, 5)) {
      const focus = s.current_focus.length > 80 ? s.current_focus.slice(0, 80) + '...' : s.current_focus
      lines.push(`- ${s.project}: ${focus}`)
    }
    if (activeStatuses.length > 5) lines.push(`- ... and ${activeStatuses.length - 5} more`)
  }

  // Naming conventions
  const mappings: string[] = []
  for (const entry of peopleEntries!.values()) {
    const aliases = stripArray(entry.frontmatter.aliases)
    const englishAlias = aliases.find(a => /[a-zA-Z]/.test(a))
    if (englishAlias) mappings.push(`${englishAlias} → ${entry.filename}`)
  }
  if (mappings.length) {
    lines.push(``, `Naming conventions (ALWAYS use Russian names in responses):`, mappings.join(', '))
  }

  // Freshness
  const vaultStat = statSync(join(VAULT_DIR, 'README.md'))
  lines.push(``, `Vault data freshness: ${vaultStat.mtime.toISOString().slice(0, 16).replace('T', ' ')} UTC`)

  lines.push(``, `Navigation: call kb_registry(project="X") to get full project card.`)
  lines.push(`Call kb_registry(section="processes"|"people"|"channels") for cross-project info.`)

  // Quick reference
  const fmtRef = (items: typeof projects) => items
    .filter(p => p.status === 'active')
    .map(p => {
      const card = buildProjectCard(p.name)
      if (!card) return p.name
      const ch = Object.keys(card.slack_channels)
      return ch.length ? `${p.name} (${ch.slice(0, 3).join(', ')})` : p.name
    }).join(', ')

  lines.push(``, `Project Quick Reference:`)
  lines.push(`AC active: ${fmtRef(acProjects)}`)
  lines.push(`HG active: ${fmtRef(hgProjects)}`)

  knowledgeMapCache = lines.join('\n')
  return knowledgeMapCache
}

export function getKnowledgeMap(): string {
  if (!knowledgeMapCache || Date.now() - cacheTimestamp > CACHE_TTL_MS) {
    return buildKnowledgeMap()
  }
  return knowledgeMapCache
}

export function refreshKnowledgeMap(): void {
  refresh()
  buildKnowledgeMap()
  logger.info({ mapLength: knowledgeMapCache!.length }, 'Vault knowledge map refreshed')
}

// ── Write operations ──

export interface VaultUpdateResult {
  success: boolean
  file: string
  changes: string[]
}

/**
 * Update a section in a vault markdown file.
 * Finds the section by heading (## SectionName) and replaces content between auto-updated markers.
 */
export function updateSection(filePath: string, sectionName: string, newContent: string): boolean {
  if (!existsSync(filePath)) return false
  const raw = readFileSync(filePath, 'utf-8')
  const sectionRe = new RegExp(`(## ${sectionName}\\s*\\n<!-- auto-updated[^>]*-->\\n)[\\s\\S]*?(<!-- /auto-updated -->)`)
  if (!sectionRe.test(raw)) return false
  const updated = raw.replace(sectionRe, `$1${newContent}\n$2`)
  writeFileSync(filePath, updated, 'utf-8')
  refresh()
  return true
}

/**
 * Update frontmatter field in a vault file.
 */
export function updateFrontmatter(filePath: string, field: string, value: unknown): boolean {
  if (!existsSync(filePath)) return false
  const raw = readFileSync(filePath, 'utf-8')
  const { data, content } = matter(raw)
  data[field] = value
  const updated = matter.stringify(content, data)
  writeFileSync(filePath, updated, 'utf-8')
  refresh()
  return true
}

/**
 * Add a person to a project's team section.
 */
export function addTeamMember(projectName: string, personDisplayName: string, role: string): VaultUpdateResult {
  ensureLoaded()
  const ref = aliasIndex!.get(projectName.toLowerCase())
  if (!ref || ref.type !== 'project') return { success: false, file: '', changes: ['Project not found: ' + projectName] }

  const filePath = join(VAULT_DIR, 'projects', ref.key + '.md')
  const raw = readFileSync(filePath, 'utf-8')
  const entry = `- ${role}: [[${personDisplayName}]]`

  if (raw.includes(`[[${personDisplayName}]]`)) {
    return { success: true, file: ref.key, changes: ['Already in team'] }
  }

  const marker = '<!-- /auto-updated -->'
  const teamSection = raw.match(/## Команда[\s\S]*?<!-- \/auto-updated -->/)
  if (!teamSection) return { success: false, file: ref.key, changes: ['No team section found'] }

  const updated = raw.replace(teamSection[0], teamSection[0].replace(marker, entry + '\n' + marker))
  writeFileSync(filePath, updated, 'utf-8')
  refresh()
  return { success: true, file: ref.key, changes: [`Added ${personDisplayName} as ${role}`] }
}

/**
 * Remove a person from a project's team section.
 */
export function removeTeamMember(projectName: string, personDisplayName: string): VaultUpdateResult {
  ensureLoaded()
  const ref = aliasIndex!.get(projectName.toLowerCase())
  if (!ref || ref.type !== 'project') return { success: false, file: '', changes: ['Project not found'] }

  const filePath = join(VAULT_DIR, 'projects', ref.key + '.md')
  const raw = readFileSync(filePath, 'utf-8')
  const lineRe = new RegExp(`^- [^\\n]*\\[\\[${personDisplayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\][^\\n]*\\n?`, 'gm')
  if (!lineRe.test(raw)) return { success: true, file: ref.key, changes: ['Not in team'] }

  const updated = raw.replace(lineRe, '')
  writeFileSync(filePath, updated, 'utf-8')
  refresh()
  return { success: true, file: ref.key, changes: [`Removed ${personDisplayName}`] }
}

/**
 * Mark a person as left (fired/quit).
 */
export function markPersonLeft(personName: string): VaultUpdateResult {
  ensureLoaded()
  const ref = aliasIndex!.get(personName.toLowerCase())
  if (!ref || ref.type !== 'person') return { success: false, file: '', changes: ['Person not found: ' + personName] }

  const filePath = join(VAULT_DIR, 'people', 'internal', ref.key + '.md')
  const changes: string[] = []

  // Update frontmatter status
  updateFrontmatter(filePath, 'status', 'left')
  changes.push('Set status: left')

  // Remove from all project team sections
  ensureLoaded()
  for (const [projKey, projEntry] of projectEntries!) {
    if (projEntry.body.includes(`[[${ref.key}]]`)) {
      const result = removeTeamMember(projKey, ref.key)
      if (result.success) changes.push(`Removed from ${projKey}`)
    }
  }

  refresh()
  return { success: true, file: ref.key, changes }
}

/**
 * Update project status section.
 */
export function updateProjectStatus(projectName: string, focus: string, milestones?: string[]): VaultUpdateResult {
  ensureLoaded()
  const ref = aliasIndex!.get(projectName.toLowerCase())
  if (!ref || ref.type !== 'project') return { success: false, file: '', changes: ['Project not found'] }

  const filePath = join(VAULT_DIR, 'projects', ref.key + '.md')
  const today = new Date().toISOString().slice(0, 10)
  const lines = [`Последнее обновление: ${today}`, '', `Текущий фокус: ${focus}`]
  if (milestones?.length) {
    lines.push('', 'Последние вехи:')
    for (const m of milestones) lines.push(`- ${m}`)
  }

  const success = updateSection(filePath, 'Статус', lines.join('\n'))
  refresh()
  return { success, file: ref.key, changes: success ? ['Status updated'] : ['Failed to update status section'] }
}

/**
 * Add a project to a person's projects list.
 */
export function addProjectToPerson(personName: string, projectName: string, role: string): VaultUpdateResult {
  ensureLoaded()
  const ref = aliasIndex!.get(personName.toLowerCase())
  if (!ref || ref.type !== 'person') return { success: false, file: '', changes: ['Person not found'] }

  const filePath = join(VAULT_DIR, 'people', 'internal', ref.key + '.md')
  const raw = readFileSync(filePath, 'utf-8')
  const entry = `- [[${projectName}]] — ${role} (активен)`

  if (raw.includes(`[[${projectName}]]`)) {
    return { success: true, file: ref.key, changes: ['Already listed'] }
  }

  const marker = '<!-- /auto-updated -->'
  const section = raw.match(/## Проекты[\s\S]*?<!-- \/auto-updated -->/)
  if (!section) return { success: false, file: ref.key, changes: ['No projects section'] }

  const updated = raw.replace(section[0], section[0].replace(marker, entry + '\n' + marker))
  writeFileSync(filePath, updated, 'utf-8')
  refresh()
  return { success: true, file: ref.key, changes: [`Added ${projectName} (${role})`] }
}

// ── Cache control ──

export function refresh(): void {
  projectEntries = null
  peopleEntries = null
  companyCodeMap = null
  aliasIndex = null
  knowledgeMapCache = null
  cacheTimestamp = 0
}
