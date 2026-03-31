/**
 * Auto Channel Discovery — finds Slack channels not mapped to any vault project.
 * No LLM calls. Fetches channels from both workspaces, compares against vault
 * project cards, and notifies via Telegram about unknown channels worth mapping.
 */

import { SLACK_WORKSPACES, fetchSlackChannels } from '../mcp/briefing/slack.js'
import { getAllProjects, loadProjectCard } from './vault-reader.js'
import { sendTelegramMessage } from '../telegram/sender.js'
import { logger } from '../logging/logger.js'

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

  // 2. Get all known channels from vault project cards
  const knownChannels = new Set<string>()
  const projects = getAllProjects()

  for (const p of projects) {
    const card = loadProjectCard(p.name)
    if (!card) continue
    for (const ch of Object.keys(card.slack_channels)) {
      knownChannels.add(ch.replace(/^#/, '').toLowerCase())
    }
  }

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
