/**
 * Entity Discovery — detects new people and projects in Slack/ClickUp
 * that are not yet registered in the YAML Knowledge Registry.
 *
 * Runs after nightly ingestion. Produces a report that can be:
 * 1. Logged for review
 * 2. Included in digest as a "registry gaps" section
 *
 * Does NOT auto-create YAML files — only reports gaps.
 */

import { SLACK_WORKSPACES, fetchSlackChannels } from '../../mcp/briefing/slack.js'
import { readFileSync, readdirSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { logger } from '../../logging/logger.js'
import { env } from '../../config/env.js'

const REGISTRY_DIR = join(fileURLToPath(import.meta.url), '..')
const REPORT_FILE = join(REGISTRY_DIR, '_discovery-report.yaml')

export interface DiscoveryReport {
  generated_at: string
  unknown_slack_users: Array<{ name: string; workspace: string }>
  unknown_channels: Array<{ name: string; workspace: string; members: number }>
  unknown_clickup_lists: Array<{ name: string; space: string }>
  stale_projects: Array<{ name: string; last_updated: string; days_stale: number }>
}

/**
 * Run entity discovery against Slack and ClickUp APIs.
 * Returns a report of entities not found in the YAML registry.
 */
export async function runEntityDiscovery(): Promise<DiscoveryReport> {
  logger.info('Starting entity discovery')

  const report: DiscoveryReport = {
    generated_at: new Date().toISOString(),
    unknown_slack_users: [],
    unknown_channels: [],
    unknown_clickup_lists: [],
    stale_projects: [],
  }

  // Load known names from YAML
  const knownPeople = loadKnownPeople()
  const knownChannels = loadKnownChannels()
  const knownClickUpLists = loadKnownClickUpLists()

  // Discover unknown Slack users (from user cache)
  try {
    const slackUsers = await fetchAllSlackUsers()
    for (const user of slackUsers) {
      if (!isKnownPerson(user.name, knownPeople)) {
        report.unknown_slack_users.push(user)
      }
    }
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Entity discovery: Slack users fetch failed')
  }

  // Discover unknown Slack channels
  for (const ws of SLACK_WORKSPACES) {
    try {
      const headers = { Authorization: `Bearer ${ws.token}` }
      const channels = await fetchSlackChannels(headers, ws.teamId)
      for (const ch of channels) {
        if (!knownChannels.has(ch.name.toLowerCase())) {
          report.unknown_channels.push({
            name: ch.name,
            workspace: ws.label,
            members: ch.num_members ?? 0,
          })
        }
      }
    } catch (error) {
      logger.warn({ workspace: ws.label, error: error instanceof Error ? error.message : String(error) }, 'Entity discovery: Slack channels fetch failed')
    }
  }

  // Discover unknown ClickUp lists
  try {
    const clickupLists = await fetchAllClickUpLists()
    for (const list of clickupLists) {
      if (!isKnownClickUpList(list.name, knownClickUpLists)) {
        report.unknown_clickup_lists.push(list)
      }
    }
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Entity discovery: ClickUp lists fetch failed')
  }

  // Detect stale project statuses
  const statusFile = join(REGISTRY_DIR, 'projects', '_current-status.yaml')
  if (existsSync(statusFile)) {
    const data = loadYaml<Record<string, unknown>>(statusFile)
    if (data) {
      const now = new Date()
      for (const company of ['astrocat', 'highground']) {
        const projects = (data[company] as Array<Record<string, unknown>>) ?? []
        for (const p of projects) {
          if (p.status !== 'active') continue
          const updatedAt = p.updated_at as string
          if (!updatedAt || updatedAt === 'TBD') {
            report.stale_projects.push({ name: p.project as string, last_updated: 'never', days_stale: 999 })
            continue
          }
          const daysSince = Math.floor((now.getTime() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24))
          if (daysSince > 3) {
            report.stale_projects.push({ name: p.project as string, last_updated: updatedAt, days_stale: daysSince })
          }
        }
      }
    }
  }

  // Write report
  writeDiscoveryReport(report)

  const totalGaps = report.unknown_slack_users.length + report.unknown_channels.length +
    report.unknown_clickup_lists.length + report.stale_projects.length
  logger.info({
    unknownUsers: report.unknown_slack_users.length,
    unknownChannels: report.unknown_channels.length,
    unknownLists: report.unknown_clickup_lists.length,
    staleProjects: report.stale_projects.length,
    totalGaps,
  }, 'Entity discovery complete')

  return report
}

/**
 * Load the latest discovery report (if exists).
 */
export function loadDiscoveryReport(): DiscoveryReport | null {
  return loadYaml<DiscoveryReport>(REPORT_FILE)
}

// ─── Internal helpers ───

function loadKnownPeople(): Set<string> {
  const names = new Set<string>()
  const dir = join(REGISTRY_DIR, 'people', 'internal')
  if (!existsSync(dir)) return names

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    const data = loadYaml<{ name?: string; aliases?: string[] }>(join(dir, file))
    if (data?.name) {
      names.add(data.name.toLowerCase())
      for (const alias of data.aliases ?? []) {
        names.add(alias.toLowerCase())
      }
    }
    // Handle _former.yaml
    const former = data as unknown as { former?: Array<{ name: string; aliases?: string[] }> }
    if (former?.former) {
      for (const f of former.former) {
        names.add(f.name.toLowerCase())
        for (const alias of f.aliases ?? []) {
          names.add(alias.toLowerCase())
        }
      }
    }
  }

  return names
}

function loadKnownChannels(): Set<string> {
  const channels = new Set<string>()

  // From slack-channels.yaml
  const chFile = join(REGISTRY_DIR, 'channels', 'slack-channels.yaml')
  const data = loadYaml<Record<string, unknown[]>>(chFile)
  if (data) {
    for (const entries of Object.values(data)) {
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        const ch = entry as Record<string, unknown>
        if (ch.channel) channels.add((ch.channel as string).toLowerCase())
      }
    }
  }

  // From project YAMLs
  const projectsDir = join(REGISTRY_DIR, 'projects')
  if (existsSync(projectsDir)) {
    for (const file of readdirSync(projectsDir).filter((f) => f.endsWith('.yaml') && !f.startsWith('_'))) {
      const proj = loadYaml<{ slack_channels?: Record<string, string> }>(join(projectsDir, file))
      if (proj?.slack_channels) {
        for (const ch of Object.keys(proj.slack_channels)) {
          channels.add(ch.toLowerCase())
        }
      }
    }
  }

  return channels
}

function loadKnownClickUpLists(): Set<string> {
  const lists = new Set<string>()
  const cuFile = join(REGISTRY_DIR, 'resources', 'clickup', 'tasks.yaml')
  const data = loadYaml<{ clickup_lists: Array<{ list: string }> }>(cuFile)
  if (data?.clickup_lists) {
    for (const l of data.clickup_lists) {
      lists.add(l.list.toLowerCase())
    }
  }
  return lists
}

function isKnownPerson(displayName: string, known: Set<string>): boolean {
  const lower = displayName.toLowerCase()
  if (known.has(lower)) return true
  // Try first name match
  const firstName = lower.split(' ')[0]
  if (firstName.length > 2 && known.has(firstName)) return true
  // Try without diacritics
  for (const k of known) {
    if (k.includes(lower) || lower.includes(k)) return true
  }
  return false
}

function isKnownClickUpList(listName: string, known: Set<string>): boolean {
  const lower = listName.toLowerCase()
  if (known.has(lower)) return true
  for (const k of known) {
    if (k.includes(lower) || lower.includes(k)) return true
  }
  return false
}

async function fetchAllSlackUsers(): Promise<Array<{ name: string; workspace: string }>> {
  const users: Array<{ name: string; workspace: string }> = []
  for (const ws of SLACK_WORKSPACES) {
    const headers = { Authorization: `Bearer ${ws.token}` }
    let cursor = ''
    do {
      const params = new URLSearchParams({ limit: '200', include_locale: 'false' })
      if (cursor) params.set('cursor', cursor)
      const res = await fetch(`https://slack.com/api/users.list?${params}`, { headers })
      const data = await res.json() as {
        ok: boolean
        members?: Array<{ id: string; real_name?: string; profile?: { display_name?: string; real_name?: string }; is_bot?: boolean; deleted?: boolean }>
        response_metadata?: { next_cursor?: string }
      }
      if (!data.ok || !data.members) break
      for (const m of data.members) {
        if (m.is_bot || m.deleted) continue
        const name = m.profile?.display_name || m.profile?.real_name || m.real_name || ''
        if (name && name !== 'Slackbot') {
          users.push({ name, workspace: ws.label })
        }
      }
      cursor = data.response_metadata?.next_cursor ?? ''
    } while (cursor)
  }
  return users
}

async function fetchAllClickUpLists(): Promise<Array<{ name: string; space: string }>> {
  const apiKey = env.CLICKUP_API_KEY
  const teamId = env.CLICKUP_TEAM_ID
  if (!apiKey || !teamId) return []

  const headers = { Authorization: apiKey }
  const lists: Array<{ name: string; space: string }> = []

  // Get spaces
  const spacesRes = await fetch(`https://api.clickup.com/api/v2/team/${teamId}/space?archived=false`, { headers })
  const spacesData = await spacesRes.json() as { spaces?: Array<{ id: string; name: string }> }
  if (!spacesData.spaces) return []

  for (const space of spacesData.spaces) {
    // Get folders
    const foldersRes = await fetch(`https://api.clickup.com/api/v2/space/${space.id}/folder?archived=false`, { headers })
    const foldersData = await foldersRes.json() as { folders?: Array<{ id: string; name: string; lists?: Array<{ id: string; name: string }> }> }
    if (foldersData.folders) {
      for (const folder of foldersData.folders) {
        for (const list of folder.lists ?? []) {
          lists.push({ name: list.name, space: space.name })
        }
      }
    }

    // Get folderless lists
    const listsRes = await fetch(`https://api.clickup.com/api/v2/space/${space.id}/list?archived=false`, { headers })
    const listsData = await listsRes.json() as { lists?: Array<{ id: string; name: string }> }
    if (listsData.lists) {
      for (const list of listsData.lists) {
        lists.push({ name: list.name, space: space.name })
      }
    }
  }

  return lists
}

function writeDiscoveryReport(report: DiscoveryReport): void {
  const yamlContent = yaml.dump(report, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  })
  const header = '# Entity Discovery Report\n# Auto-generated — do NOT edit manually\n\n'
  const tmpFile = REPORT_FILE + '.tmp'
  writeFileSync(tmpFile, header + yamlContent, 'utf-8')
  renameSync(tmpFile, REPORT_FILE)
}

function loadYaml<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null
    const content = readFileSync(filePath, 'utf-8')
    return yaml.load(content) as T
  } catch {
    return null
  }
}
