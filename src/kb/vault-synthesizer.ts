/**
 * Vault Synthesizer — periodically updates vault project statuses
 * from fresh Slack data via Claude LLM synthesis.
 *
 * Flow: getAllProjects → for each active project:
 *   fetch Slack channels + #standups → Claude synthesis → write to status file
 *   → rotate old updates to archive → notify if significant
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logging/logger.js'
import { callClaude } from '../llm/client.js'
import { loadPromptCached } from './vault-loader.js'
import { fetchRecentMessages, type ChannelMessages } from './vault-slack-fetcher.js'
import { getAllProjects, loadProjectCard, refreshKnowledgeMap, type ProjectCard } from './vault-reader.js'
import { sendTelegramMessage } from '../telegram/sender.js'

const VAULT_DIR = join(process.cwd(), 'vault')
const MAX_UPDATES = 30
const BATCH_SIZE = 5

// ── Types ──

interface UpdateEntry { date: string; text: string }

interface SynthResult {
  updates: UpdateEntry[]
  current_focus: string
  alerts: string[]
  team_changes: string[]
  significance: 'none' | 'low' | 'high'
}

export interface SynthesizerStats {
  projectsProcessed: number
  projectsUpdated: number
  projectsSkipped: number
  errors: number
  highSignificance: number
  durationMs: number
}

let isRunning = false

// ── Channel helpers ──

function extractChannelNames(card: ProjectCard): string[] {
  return Object.keys(card.slack_channels).map(ch => ch.replace(/^#/, ''))
}

function formatMessagesForLLM(channelData: ChannelMessages[]): string {
  const lines: string[] = []
  for (const ch of channelData) {
    lines.push(`--- ${ch.channel} (${ch.workspace}) ---`)
    for (const m of ch.messages) {
      const date = new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace('T', ' ')
      lines.push(`[${date}] ${m.user}: ${m.text}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ── Status file I/O ──

function statusFilePath(projectName: string): string {
  return join(VAULT_DIR, 'projects', `${projectName} — Статусы.md`)
}

function archiveFilePath(projectName: string): string {
  return join(VAULT_DIR, 'projects', '_archive', `${projectName}.md`)
}

function readExistingUpdates(projectName: string): UpdateEntry[] {
  const path = statusFilePath(projectName)
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf-8')
  const updates: UpdateEntry[] = []
  const re = /^### (\d{4}-\d{2}-\d{2})\n([\s\S]*?)(?=\n### \d{4}|\n$|$)/gm
  let m
  while ((m = re.exec(raw)) !== null) {
    const date = m[1]
    const bullets = m[2].trim().split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2).trim())
    for (const text of bullets) {
      updates.push({ date, text })
    }
  }
  return updates
}

function writeStatusFile(projectName: string, focus: string, updates: UpdateEntry[]): void {
  // Group by date
  const byDate = new Map<string, string[]>()
  for (const u of updates) {
    const list = byDate.get(u.date) ?? []
    list.push(u.text)
    byDate.set(u.date, list)
  }

  const sortedDates = [...byDate.keys()].sort().reverse()

  const lines = [
    '---',
    'type: project_status',
    `project: "[[${projectName}]]"`,
    '---',
    '',
    `# ${projectName} — Актуальные статусы`,
    '',
    `> Последние ${MAX_UPDATES} апдейтов. Более старые → [[_archive/${projectName}|Архив статусов]]`,
    '',
    '## Текущий фокус',
    focus || 'нет данных',
    '',
    '## Апдейты',
  ]

  for (const date of sortedDates) {
    lines.push('', `### ${date}`)
    for (const text of byDate.get(date)!) {
      lines.push(`- ${text}`)
    }
  }
  lines.push('')

  writeFileSync(statusFilePath(projectName), lines.join('\n'), 'utf-8')
}

function rotateToArchive(projectName: string, overflow: UpdateEntry[]): void {
  if (overflow.length === 0) return
  const path = archiveFilePath(projectName)

  let existing = ''
  if (existsSync(path)) {
    existing = readFileSync(path, 'utf-8')
  } else {
    existing = [
      '---',
      'type: project_status_archive',
      `project: "[[${projectName}]]"`,
      '---',
      '',
      `# ${projectName} — Архив статусов`,
      '',
      '> Файл может быть большим. При чтении используйте поиск или ограничение строк — НЕ читайте целиком.',
      `> Актуальные статусы: [[projects/${projectName} — Статусы|Актуальные статусы]]`,
      '',
    ].join('\n')
  }

  // Group overflow by date and append
  const byDate = new Map<string, string[]>()
  for (const u of overflow) {
    const list = byDate.get(u.date) ?? []
    list.push(u.text)
    byDate.set(u.date, list)
  }

  const newLines: string[] = []
  for (const [date, texts] of [...byDate.entries()].sort().reverse()) {
    newLines.push(`### ${date}`)
    for (const text of texts) newLines.push(`- ${text}`)
    newLines.push('')
  }

  // Insert after header
  const headerEnd = existing.lastIndexOf('---\n\n')
  if (headerEnd > 0) {
    const insertPos = existing.indexOf('\n', headerEnd + 4) + 1
    existing = existing.slice(0, insertPos) + '\n' + newLines.join('\n') + existing.slice(insertPos)
  } else {
    existing += '\n' + newLines.join('\n')
  }

  writeFileSync(path, existing, 'utf-8')
}

// ── Synthesis ──

async function synthesizeProject(
  card: ProjectCard,
  lookbackHours: number,
): Promise<SynthResult | null> {
  const channelNames = [...extractChannelNames(card), 'standups']
  const channelData = await fetchRecentMessages(channelNames, lookbackHours)

  const totalMessages = channelData.reduce((sum, ch) => sum + ch.messages.length, 0)
  if (totalMessages === 0) return null

  // Get existing updates for dedup context
  const existingUpdates = readExistingUpdates(card.name)
  const existingContext = existingUpdates.slice(0, 10).map(u => `[${u.date}] ${u.text}`).join('\n')

  const systemPrompt = loadPromptCached('prompts/vault-synthesizer.md')
  const userPrompt = [
    `Проект: ${card.name} (${card.company.toUpperCase()})`,
    `Текущий статус: ${card.status}`,
    '',
    existingContext ? `Уже записанные апдейты (для дедупликации — НЕ повторяй):\n${existingContext}\n` : '',
    `Свежие сообщения из Slack (${totalMessages} шт, за последние ${lookbackHours}ч):`,
    '',
    formatMessagesForLLM(channelData),
  ].join('\n')

  try {
    const response = await callClaude(
      `${userPrompt}\n\nОтветь ТОЛЬКО JSON, без markdown и пояснений.`,
      { system: systemPrompt, timeoutMs: 60_000 },
    )
    return parseSynthResult(response.text)
  } catch (error) {
    logger.warn({ project: card.name, error }, 'Vault synth: Claude call failed')
    return null
  }
}

function parseSynthResult(text: string): SynthResult | null {
  try {
    const parsed = JSON.parse(text)
    if (!parsed.significance) return null
    return {
      updates: Array.isArray(parsed.updates) ? parsed.updates.filter((u: UpdateEntry) => u.date && u.text) : [],
      current_focus: parsed.current_focus ?? '',
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
      team_changes: Array.isArray(parsed.team_changes) ? parsed.team_changes : [],
      significance: ['none', 'low', 'high'].includes(parsed.significance) ? parsed.significance : 'none',
    }
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      try { return parseSynthResult(match[0]) } catch { /* give up */ }
    }
    logger.warn({ text: text.slice(0, 200) }, 'Vault synth: failed to parse Claude response')
    return null
  }
}

// ── Apply updates ──

function applyUpdates(projectName: string, result: SynthResult): { updated: boolean; changes: string[] } {
  if (result.significance === 'none' || result.updates.length === 0) {
    return { updated: false, changes: [] }
  }

  const existing = readExistingUpdates(projectName)
  const merged = [...result.updates, ...existing]

  // Keep only MAX_UPDATES, rotate rest to archive
  const active = merged.slice(0, MAX_UPDATES)
  const overflow = merged.slice(MAX_UPDATES)

  writeStatusFile(projectName, result.current_focus || existing[0]?.text || '', active)
  rotateToArchive(projectName, overflow)

  return {
    updated: true,
    changes: [`+${result.updates.length} updates (total ${active.length}, archived ${overflow.length})`],
  }
}

// ── Notification ──

function buildNotification(results: Map<string, SynthResult>): string | null {
  const highItems: string[] = []
  for (const [project, result] of results) {
    if (result.significance !== 'high') continue
    const parts: string[] = [`<b>${project}</b>`]
    if (result.alerts.length > 0) parts.push(...result.alerts.map(a => `⚠️ ${a}`))
    if (result.team_changes.length > 0) parts.push(...result.team_changes.map(t => `👤 ${t}`))
    if (result.current_focus) parts.push(result.current_focus)
    highItems.push(parts.join('\n'))
  }
  return highItems.length > 0 ? `<b>🔔 KB Alert</b>\n\n${highItems.join('\n\n')}` : null
}

// ── Main runner ──

export async function runVaultSynthesizer(lookbackHours = 4): Promise<SynthesizerStats> {
  if (isRunning) {
    logger.warn('Vault synthesizer already running, skipping')
    return { projectsProcessed: 0, projectsUpdated: 0, projectsSkipped: 0, errors: 0, highSignificance: 0, durationMs: 0 }
  }

  isRunning = true
  const startTime = Date.now()
  const stats: SynthesizerStats = {
    projectsProcessed: 0, projectsUpdated: 0, projectsSkipped: 0,
    errors: 0, highSignificance: 0, durationMs: 0,
  }
  const significantResults = new Map<string, SynthResult>()

  try {
    const projects = getAllProjects().filter(p => p.status === 'active')
    logger.info({ total: projects.length, lookbackHours }, 'Vault synthesizer starting')

    const projectsWithChannels: Array<{ name: string; card: ProjectCard }> = []
    for (const project of projects) {
      const card = loadProjectCard(project.name)
      if (!card || extractChannelNames(card).length === 0) { stats.projectsSkipped++; continue }
      projectsWithChannels.push({ name: project.name, card })
    }

    for (let i = 0; i < projectsWithChannels.length; i += BATCH_SIZE) {
      const batch = projectsWithChannels.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.allSettled(
        batch.map(async ({ name, card }) => {
          stats.projectsProcessed++
          const result = await synthesizeProject(card, lookbackHours)
          if (!result || result.significance === 'none') return

          const { updated } = applyUpdates(name, result)
          if (updated) stats.projectsUpdated++

          if (result.significance === 'high') {
            stats.highSignificance++
            significantResults.set(name, result)
          }

          logger.debug({ project: name, significance: result.significance, updated }, 'Vault synth: project processed')
        }),
      )
      for (const r of batchResults) {
        if (r.status === 'rejected') stats.errors++
      }
    }

    if (stats.projectsUpdated > 0) refreshKnowledgeMap()

    const notification = buildNotification(significantResults)
    if (notification) {
      try { await sendTelegramMessage(notification) } catch (error) {
        logger.warn({ error }, 'Vault synth: Telegram notification failed')
      }
    }
  } finally {
    isRunning = false
    stats.durationMs = Date.now() - startTime
    logger.info(stats, 'Vault synthesizer complete')
  }

  return stats
}
