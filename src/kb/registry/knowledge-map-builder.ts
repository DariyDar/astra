/**
 * Knowledge Map Builder — generates a compact text index (~500-600 tokens)
 * from all YAML registry files for injection into Claude's system prompt.
 *
 * The map gives Claude an "table of contents" of all available organizational data,
 * enabling efficient navigation via kb_registry() tool calls.
 */

import { getAllProjects, getAllStatuses, refresh as refreshReader } from './reader.js'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { logger } from '../../logging/logger.js'

const REGISTRY_DIR = join(fileURLToPath(import.meta.url), '..')

let cachedMap: string | null = null

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

  lines.push(``)
  lines.push(`Navigation: call kb_registry(project="X") to get full project card (team, channels, docs with URLs, tasks, status).`)
  lines.push(`Call kb_registry(section="processes"|"wiki"|"drive"|"people"|"channels") for cross-project info.`)

  cachedMap = lines.join('\n')
  return cachedMap
}

/**
 * Get the cached knowledge map, or build it if not cached.
 */
export function getKnowledgeMap(): string {
  if (!cachedMap) {
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
  const chFile = join(REGISTRY_DIR, 'channels', 'slack-channels.yaml')
  const data = loadYamlFile<Record<string, unknown[]>>(chFile)
  if (!data) return 0
  let count = 0
  for (const channels of Object.values(data)) {
    if (Array.isArray(channels)) count += channels.length
  }
  return count
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

function loadYamlFile<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null
    const content = readFileSync(filePath, 'utf-8')
    return yaml.load(content) as T
  } catch {
    return null
  }
}
