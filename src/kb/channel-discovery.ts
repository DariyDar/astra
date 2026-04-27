/**
 * Auto Channel Discovery — finds Slack channels not classified anywhere
 * in the vault. Compares against:
 *   1. project cards (`slack_channels` field)
 *   2. the channel index at vault/channels/Slack Channels.md
 * Only flags channels missing from BOTH sources.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SLACK_WORKSPACES, fetchSlackChannels } from '../mcp/briefing/slack.js'
import { getAllProjects, loadProjectCard } from './vault-reader.js'
import { sendTelegramMessage } from '../telegram/sender.js'
import { logger } from '../logging/logger.js'

/**
 * Load channel names from `vault/channels/Slack Channels.md`.
 * The file is a hand-maintained markdown index where each row in any of the
 * tables starts with `| #channel-name |`. We don't care about the categories
 * here — we just need the set of channels the user has already classified.
 */
function loadIndexedChannels(): Set<string> {
  const path = resolve(process.cwd(), 'vault', 'channels', 'Slack Channels.md')
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (error) {
    logger.warn({ path, error }, 'Channel discovery: vault channel index not readable')
    return new Set()
  }

  const out = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    // Match table rows where the first cell is a Slack channel literal,
    // i.e. starts with `#`. This skips header rows (`| Канал |`) and
    // separator rows (`|---|`).
    const m = line.match(/^\s*\|\s*#([a-z0-9][a-z0-9_-]*)\s*\|/i)
    if (!m) continue
    out.add(m[1].toLowerCase())
  }
  return out
}

interface DiscoveredChannel {
  name: string
  workspace: string
  members: number
}

export async function runChannelDiscovery(): Promise<void> {
  // 1. Get all Slack channels from both workspaces
  const slackChannels: DiscoveredChannel[] = []

  for (const ws of SLACK_WORKSPACES) {
    const headers = { Authorization: `Bearer ${ws.token}` }
    try {
      const channels = await fetchSlackChannels(headers, ws.teamId)
      for (const ch of channels) {
        slackChannels.push({
          name: ch.name,
          workspace: ws.label,
          members: ch.num_members ?? 0,
        })
      }
    } catch (error) {
      logger.warn({ workspace: ws.label, error }, 'Channel discovery: failed to fetch channels')
    }
  }

  if (slackChannels.length === 0) {
    logger.warn('Channel discovery: no channels fetched from any workspace')
    return
  }

  // 2. Get all known channels: (a) those mapped to project cards,
  //    (b) those listed in the vault channel index file.
  const knownChannels = loadIndexedChannels()
  const projects = getAllProjects()

  for (const p of projects) {
    const card = loadProjectCard(p.name)
    if (!card) continue
    for (const ch of Object.keys(card.slack_channels)) {
      knownChannels.add(ch.replace(/^#/, '').toLowerCase())
    }
  }
  logger.info({ knownChannels: knownChannels.size }, 'Channel discovery: known channels loaded')

  // 3. Find unknown channels (>3 members, not internal/test/bot)
  const unknown = slackChannels.filter(ch =>
    !knownChannels.has(ch.name.toLowerCase()) &&
    ch.members > 3 &&
    !ch.name.startsWith('_') &&
    !ch.name.includes('test') &&
    !ch.name.includes('bot'),
  )

  if (unknown.length === 0) {
    logger.info('Channel discovery: no new channels found')
    return
  }

  // 4. Send Telegram notification
  const lines = [
    `<b>🔍 Новые Slack каналы (${unknown.length})</b>`,
    '',
    ...unknown.slice(0, 10).map(ch =>
      `• <b>#${ch.name}</b> (${ch.workspace.toUpperCase()}, ${ch.members} чел.)`,
    ),
  ]

  if (unknown.length > 10) {
    lines.push(`... и ещё ${unknown.length - 10}`)
  }

  lines.push('', 'Скажите к какому проекту отнести, или "игнорировать".')

  try {
    await sendTelegramMessage(lines.join('\n'))
    logger.info({ count: unknown.length }, 'Channel discovery: notification sent')
  } catch (error) {
    logger.warn({ error }, 'Channel discovery: failed to send notification')
  }
}
