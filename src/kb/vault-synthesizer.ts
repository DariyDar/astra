/**
 * Vault Synthesizer — periodically updates vault project statuses
 * from fresh Slack data via Claude LLM synthesis.
 *
 * Flow: getAllProjects → collect Slack data for all → batch projects by token count
 *   → one Claude call per batch → parse results → write status files → notify
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logging/logger.js'
import { callClaude } from '../llm/client.js'
import { loadPromptCached } from './vault-loader.js'
import { fetchRecentMessages, type ChannelMessages } from './vault-slack-fetcher.js'
import { getAllProjects, loadProjectCard, refreshKnowledgeMap, type ProjectCard } from './vault-reader.js'
import { sendTelegramMessage } from '../telegram/sender.js'
import { loadSynthState, saveSynthState, calculateLookback } from './synth-state.js'

const VAULT_DIR = join(process.cwd(), 'vault')
const MAX_UPDATES = 30
const BATCH_TOKEN_LIMIT = 10_000
const SLACK_FETCH_CONCURRENCY = 5

// ── Types ──

interface UpdateEntry { date: string; text: string }

interface SynthResult {
  updates: UpdateEntry[]
  current_focus: string
  alerts: string[]
  team_changes: string[]
  significance: 'none' | 'low' | 'high'
}

interface BatchSynthResult {
  projects: Record<string, SynthResult>
}

interface ProjectSlackData {
  name: string
  card: ProjectCard
  messages: ChannelMessages[]
  existingUpdates: UpdateEntry[]
  formattedPrompt: string
  estimatedTokens: number
}

export interface SynthesizerStats {
  projectsProcessed: number
  projectsUpdated: number
  projectsSkipped: number
  errors: number
  highSignificance: number
  durationMs: number
  llmCalls: number
}

let isRunning = false

// ── Token estimation ──

function estimateTokens(text: string): number {
  // ~1 token per 3 chars for mixed ru/en text
  return Math.ceil(text.length / 3)
}

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

// ── Step 1: Collect all Slack data ──

function buildProjectPromptBlock(data: ProjectSlackData): string {
  const totalMessages = data.messages.reduce((sum, ch) => sum + ch.messages.length, 0)
  const existingContext = data.existingUpdates.slice(0, 10).map(u => `[${u.date}] ${u.text}`).join('\n')

  return [
    `=== PROJECT: ${data.card.name} (${data.card.company.toUpperCase()}) ===`,
    `Текущий статус: ${data.card.status}`,
    '',
    existingContext ? `Уже записанные апдейты (для дедупликации — НЕ повторяй):\n${existingContext}\n` : '',
    `Свежие сообщения из Slack (${totalMessages} шт):`,
    '',
    formatMessagesForLLM(data.messages),
  ].join('\n')
}

async function collectSlackData(
  projectsWithChannels: Array<{ name: string; card: ProjectCard }>,
  lookbackHours: number,
): Promise<ProjectSlackData[]> {
  const results: ProjectSlackData[] = []

  // Fetch Slack data in concurrent batches
  for (let i = 0; i < projectsWithChannels.length; i += SLACK_FETCH_CONCURRENCY) {
    const batch = projectsWithChannels.slice(i, i + SLACK_FETCH_CONCURRENCY)
    const fetched = await Promise.allSettled(
      batch.map(async ({ name, card }) => {
        const channelNames = [...extractChannelNames(card), 'standups']
        const channelData = await fetchRecentMessages(channelNames, lookbackHours)
        const totalMessages = channelData.reduce((sum, ch) => sum + ch.messages.length, 0)
        if (totalMessages === 0) return null

        const existingUpdates = readExistingUpdates(name)
        const data: ProjectSlackData = {
          name,
          card,
          messages: channelData,
          existingUpdates,
          formattedPrompt: '', // filled below
          estimatedTokens: 0,
        }
        data.formattedPrompt = buildProjectPromptBlock(data)
        data.estimatedTokens = estimateTokens(data.formattedPrompt)
        return data
      }),
    )
    for (const r of fetched) {
      if (r.status === 'fulfilled' && r.value) results.push(r.value)
    }
  }

  return results
}

// ── Step 2: Create token-bounded batches ──

function createBatches(projects: ProjectSlackData[]): ProjectSlackData[][] {
  const batches: ProjectSlackData[][] = []
  let currentBatch: ProjectSlackData[] = []
  let currentTokens = 0

  for (const project of projects) {
    // If a single project exceeds the limit, it gets its own batch
    if (project.estimatedTokens > BATCH_TOKEN_LIMIT) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch)
        currentBatch = []
        currentTokens = 0
      }
      batches.push([project])
      continue
    }

    // Would adding this project exceed the limit?
    if (currentTokens + project.estimatedTokens > BATCH_TOKEN_LIMIT && currentBatch.length > 0) {
      batches.push(currentBatch)
      currentBatch = []
      currentTokens = 0
    }

    currentBatch.push(project)
    currentTokens += project.estimatedTokens
  }

  if (currentBatch.length > 0) batches.push(currentBatch)

  return batches
}

// ── Step 3: Synthesize a batch via single LLM call ──

async function synthesizeBatch(batch: ProjectSlackData[]): Promise<Map<string, SynthResult>> {
  const results = new Map<string, SynthResult>()

  // Single-project batch: use simpler single-project format for reliability
  if (batch.length === 1) {
    const data = batch[0]
    const systemPrompt = loadPromptCached('instructions-for-llm/agent-vault-synthesizer.md')
    const userPrompt = `${data.formattedPrompt}\n\nОтветь ТОЛЬКО JSON, без markdown и пояснений.`

    try {
      const response = await callClaude(userPrompt, { system: systemPrompt, timeoutMs: 180_000 })
      const parsed = parseSingleResult(response.text)
      if (parsed) results.set(data.name, parsed)
    } catch (error) {
      logger.warn({ project: data.name, error }, 'Vault synth: Claude call failed for single-project batch')
    }
    return results
  }

  // Multi-project batch
  const systemPrompt = loadPromptCached('instructions-for-llm/agent-vault-synthesizer.md')
  const projectNames = batch.map(p => p.name)
  const combinedPrompt = [
    ...batch.map(p => p.formattedPrompt),
    '',
    `Обработай ВСЕ проекты выше. Ответь ТОЛЬКО JSON (без markdown), формат:`,
    `{"projects": {"${projectNames.join('": {...}, "')}": {...}}}`,
    '',
    `Каждый проект содержит: updates, current_focus, alerts, team_changes, significance.`,
  ].join('\n')

  try {
    const response = await callClaude(combinedPrompt, { system: systemPrompt, timeoutMs: 300_000 })
    const parsed = parseBatchResult(response.text, projectNames)

    for (const [name, result] of Object.entries(parsed)) {
      results.set(name, result)
    }
  } catch (error) {
    logger.warn({ projects: projectNames, error }, 'Vault synth: Claude call failed for batch')
  }

  return results
}

// ── Parsing ──

function parseSingleResult(text: string): SynthResult | null {
  try {
    const parsed = JSON.parse(text)
    if (!parsed.significance) return null
    return normalizeSynthResult(parsed)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      try { return parseSingleResult(match[0]) } catch { /* give up */ }
    }
    logger.warn({ text: text.slice(0, 200) }, 'Vault synth: failed to parse single-project response')
    return null
  }
}

function parseBatchResult(text: string, expectedProjects: string[]): Record<string, SynthResult> {
  const results: Record<string, SynthResult> = {}

  try {
    const parsed = JSON.parse(text) as { projects?: Record<string, Record<string, unknown>> }
    if (parsed.projects) {
      for (const name of expectedProjects) {
        const projectResult = parsed.projects[name]
        if (projectResult) {
          const normalized = normalizeSynthResult(projectResult)
          if (normalized) results[name] = normalized
        }
      }
      return results
    }
  } catch {
    // Try to extract JSON from text
    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      try { return parseBatchResult(match[0], expectedProjects) } catch { /* give up */ }
    }
  }

  logger.warn(
    { text: text.slice(0, 300), expected: expectedProjects },
    'Vault synth: failed to parse batch response',
  )
  return results
}

function normalizeSynthResult(parsed: Record<string, unknown>): SynthResult | null {
  const significance = parsed.significance as string | undefined
  if (!significance) return null

  return {
    updates: Array.isArray(parsed.updates)
      ? (parsed.updates as UpdateEntry[]).filter((u) => u.date && u.text)
      : [],
    current_focus: (parsed.current_focus as string) ?? '',
    alerts: Array.isArray(parsed.alerts) ? parsed.alerts as string[] : [],
    team_changes: Array.isArray(parsed.team_changes) ? parsed.team_changes as string[] : [],
    significance: ['none', 'low', 'high'].includes(significance)
      ? significance as SynthResult['significance']
      : 'none',
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
    return { projectsProcessed: 0, projectsUpdated: 0, projectsSkipped: 0, errors: 0, highSignificance: 0, durationMs: 0, llmCalls: 0 }
  }

  isRunning = true
  const startTime = Date.now()
  const stats: SynthesizerStats = {
    projectsProcessed: 0, projectsUpdated: 0, projectsSkipped: 0,
    errors: 0, highSignificance: 0, durationMs: 0, llmCalls: 0,
  }
  const significantResults = new Map<string, SynthResult>()

  try {
    const effectiveLookback = calculateLookback(lookbackHours)
    if (effectiveLookback !== lookbackHours) {
      const state = loadSynthState()
      logger.info(
        { defaultHours: lookbackHours, effectiveHours: effectiveLookback, lastRun: state.lastSuccessfulRun },
        'Vault synth: catching up after missed runs',
      )
    }

    const projects = getAllProjects().filter(p => p.status === 'active')
    logger.info({ total: projects.length, lookbackHours: effectiveLookback }, 'Vault synthesizer starting')

    // Step 0: Load project cards, filter those with channels
    const projectsWithChannels: Array<{ name: string; card: ProjectCard }> = []
    for (const project of projects) {
      const card = loadProjectCard(project.name)
      if (!card || extractChannelNames(card).length === 0) { stats.projectsSkipped++; continue }
      projectsWithChannels.push({ name: project.name, card })
    }

    // Step 1: Collect all Slack data (no LLM)
    logger.info({ count: projectsWithChannels.length }, 'Vault synth: collecting Slack data')
    const projectData = await collectSlackData(projectsWithChannels, effectiveLookback)
    const skippedNoMessages = projectsWithChannels.length - projectData.length
    stats.projectsSkipped += skippedNoMessages
    stats.projectsProcessed = projectData.length

    logger.info(
      { withMessages: projectData.length, skippedNoMessages },
      'Vault synth: Slack data collected',
    )

    // Step 2: Create token-bounded batches
    const batches = createBatches(projectData)
    stats.llmCalls = batches.length

    logger.info(
      {
        batches: batches.length,
        batchSizes: batches.map(b => b.length),
        batchTokens: batches.map(b => b.reduce((sum, p) => sum + p.estimatedTokens, 0)),
      },
      'Vault synth: batches created',
    )

    // Step 3: Execute batches sequentially (parallel Claude CLI calls crash)
    const batchResults: PromiseSettledResult<Map<string, SynthResult>>[] = []
    for (const batch of batches) {
      const result = await synthesizeBatch(batch).then(
        value => ({ status: 'fulfilled' as const, value }),
        reason => ({ status: 'rejected' as const, reason }),
      )
      batchResults.push(result)
    }

    // Step 4: Apply results
    for (const batchResult of batchResults) {
      if (batchResult.status === 'rejected') {
        stats.errors++
        continue
      }

      for (const [name, result] of batchResult.value) {
        if (result.significance === 'none') continue

        const { updated } = applyUpdates(name, result)
        if (updated) stats.projectsUpdated++

        if (result.significance === 'high') {
          stats.highSignificance++
          significantResults.set(name, result)
        }

        logger.debug({ project: name, significance: result.significance, updated }, 'Vault synth: project processed')
      }
    }

    if (stats.projectsUpdated > 0) refreshKnowledgeMap()

    if (significantResults.size > 0) {
      logger.info({ count: significantResults.size, projects: [...significantResults.keys()] }, 'Vault synth: high-significance updates detected')
    }

    // Mark successful run — next run won't need catch-up lookback
    saveSynthState({ lastSuccessfulRun: new Date().toISOString() })
  } finally {
    isRunning = false
    stats.durationMs = Date.now() - startTime
    logger.info(stats, 'Vault synthesizer complete')
  }

  return stats
}
