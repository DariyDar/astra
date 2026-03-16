/**
 * Slack Channel Sync — fetches ALL channels from both workspaces
 * and merges new ones into slack-channels.yaml.
 *
 * Existing curated entries (with descriptions, categories, etc.) are preserved.
 * New channels get added to an "auto_discovered" section with minimal metadata.
 *
 * Runs as part of nightly ingestion to keep the channel registry complete.
 */

import { SLACK_WORKSPACES, fetchSlackChannels } from '../../mcp/briefing/slack.js'
import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { logger } from '../../logging/logger.js'

const REGISTRY_DIR = join(fileURLToPath(import.meta.url), '..')
const CHANNELS_FILE = join(REGISTRY_DIR, 'channels', 'slack-channels.yaml')

interface ChannelEntry {
  channel: string
  workspace: string
  status?: string
  category?: string
  msgs?: number
  description?: string
  search_value?: string
  use_for?: string[]
}

/**
 * Sync Slack channels from API into the YAML registry.
 * Returns count of newly discovered channels.
 */
export async function syncSlackChannels(): Promise<number> {
  logger.info('Starting Slack channel sync')

  // Load existing curated channels
  const existingChannelNames = loadExistingChannelNames()

  // Fetch all channels from API
  const newChannels: ChannelEntry[] = []

  for (const ws of SLACK_WORKSPACES) {
    try {
      const headers = { Authorization: `Bearer ${ws.token}` }
      const apiChannels = await fetchSlackChannels(headers, ws.teamId)

      for (const ch of apiChannels) {
        const key = `${ch.name}:${ws.label}`.toLowerCase()
        if (!existingChannelNames.has(key)) {
          newChannels.push({
            channel: ch.name,
            workspace: ws.label.toLowerCase(),
            status: 'active',
            category: 'uncategorized',
            msgs: 0,
            description: `Auto-discovered channel (${ch.num_members ?? 0} members)`,
            search_value: 'low',
          })
        }
      }
    } catch (error) {
      logger.warn({
        workspace: ws.label,
        error: error instanceof Error ? error.message : String(error),
      }, 'Channel sync: failed to fetch channels')
    }
  }

  if (newChannels.length === 0) {
    logger.info('Channel sync: no new channels found')
    return 0
  }

  // Append new channels to the YAML file
  appendNewChannels(newChannels)

  logger.info({ count: newChannels.length }, 'Channel sync: new channels added')
  return newChannels.length
}

function loadExistingChannelNames(): Set<string> {
  const names = new Set<string>()
  if (!existsSync(CHANNELS_FILE)) return names

  const content = readFileSync(CHANNELS_FILE, 'utf-8')
  const data = yaml.load(content) as Record<string, unknown> | null
  if (!data) return names

  for (const entries of Object.values(data)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const ch = entry as Record<string, unknown>
      if (ch.channel && ch.workspace) {
        names.add(`${ch.channel}:${ch.workspace}`.toLowerCase())
      }
    }
  }

  // Also scan project YAMLs for project-level channels
  const projectsDir = join(REGISTRY_DIR, 'projects')
  if (existsSync(projectsDir)) {
    for (const file of readdirSync(projectsDir).filter((f) => f.endsWith('.yaml') && !f.startsWith('_'))) {
      try {
        const projContent = readFileSync(join(projectsDir, file), 'utf-8')
        const proj = yaml.load(projContent) as { slack_channels?: Record<string, string>; company?: string } | null
        if (proj?.slack_channels && proj.company) {
          const ws = proj.company === 'ac' ? 'ac' : 'hg'
          for (const ch of Object.keys(proj.slack_channels)) {
            names.add(`${ch}:${ws}`.toLowerCase())
          }
        }
      } catch {
        // Skip malformed files
      }
    }
  }

  return names
}

function appendNewChannels(channels: ChannelEntry[]): void {
  if (!existsSync(CHANNELS_FILE)) return

  const content = readFileSync(CHANNELS_FILE, 'utf-8')
  const data = yaml.load(content) as Record<string, ChannelEntry[]> | null
  if (!data) return

  // Add to "auto_discovered" section
  if (!data.auto_discovered) {
    data.auto_discovered = []
  }
  data.auto_discovered.push(...channels)

  const header = [
    '# Полный реестр Slack-каналов AstroCat (AC) и Highground (HG)',
    '# Каждый канал: workspace, категория, описание, статус (active/historical/dead)',
    '# Используется Astra для навигации по источникам информации',
    '# auto_discovered секция заполняется автоматически — можно перемещать в нужные категории',
    '',
  ].join('\n')

  const yamlContent = yaml.dump(data, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
  })

  const tmpFile = CHANNELS_FILE + '.tmp'
  writeFileSync(tmpFile, header + '\n' + yamlContent, 'utf-8')
  renameSync(tmpFile, CHANNELS_FILE)
}
