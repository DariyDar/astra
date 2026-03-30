/**
 * Vault Synthesizer — periodically updates vault project statuses
 * from fresh Slack data via Gemini LLM synthesis.
 *
 * Flow: getAllProjects → for each active project with Slack channels:
 *   fetchRecentMessages → callGemini (synthesize) → updateProjectStatus
 *   → notify via Telegram if significant changes detected
 */

import { logger } from '../logging/logger.js'
import { callGemini } from '../llm/gemini.js'
import { loadPromptCached } from './vault-loader.js'
import { fetchRecentMessages, type ChannelMessages } from './vault-slack-fetcher.js'
import {
  getAllProjects, loadProjectCard, updateProjectStatus,
  refreshKnowledgeMap, type ProjectCard,
} from './vault-reader.js'
import { sendTelegramMessage } from '../telegram/sender.js'

// ── Types ──

interface SynthResult {
  current_focus: string
  milestones: string[]
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

// ── Guard ──

let isRunning = false

// ── Per-project synthesis ──

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

async function synthesizeProject(
  card: ProjectCard,
  lookbackHours: number,
): Promise<SynthResult | null> {
  const channelNames = extractChannelNames(card)
  if (channelNames.length === 0) return null

  const channelData = await fetchRecentMessages(channelNames, lookbackHours)
  if (channelData.length === 0) return null

  const totalMessages = channelData.reduce((sum, ch) => sum + ch.messages.length, 0)
  if (totalMessages === 0) return null

  const currentStatus = card.current_status
  const currentFocus = currentStatus?.current_focus ?? 'нет данных'

  const systemPrompt = loadPromptCached('prompts/vault-synthesizer.md')
  const userPrompt = [
    `Проект: ${card.name} (${card.company.toUpperCase()})`,
    `Текущий статус: ${card.status}`,
    `Текущий фокус: ${currentFocus}`,
    '',
    `Свежие сообщения из Slack (${totalMessages} шт, за последние ${lookbackHours}ч):`,
    '',
    formatMessagesForLLM(channelData),
  ].join('\n')

  try {
    const response = await callGemini(userPrompt, {
      systemInstruction: systemPrompt,
      jsonMode: true,
      thinkingBudget: 0,
      timeoutMs: 30_000,
      maxOutputTokens: 1024,
    })

    return parseSynthResult(response.text)
  } catch (error) {
    logger.warn({ project: card.name, error }, 'Vault synth: Gemini call failed')
    return null
  }
}

function parseSynthResult(text: string): SynthResult | null {
  try {
    const parsed = JSON.parse(text) as SynthResult
    if (!parsed.significance) return null
    return {
      current_focus: parsed.current_focus ?? '',
      milestones: Array.isArray(parsed.milestones) ? parsed.milestones : [],
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
      team_changes: Array.isArray(parsed.team_changes) ? parsed.team_changes : [],
      significance: ['none', 'low', 'high'].includes(parsed.significance) ? parsed.significance : 'none',
    }
  } catch {
    // Try extracting JSON from text
    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        return parseSynthResult(match[0])
      } catch { /* give up */ }
    }
    logger.warn({ text: text.slice(0, 200) }, 'Vault synth: failed to parse Gemini response')
    return null
  }
}

// ── Vault writing ──

function applyUpdates(projectName: string, result: SynthResult): { updated: boolean; changes: string[] } {
  if (result.significance === 'none') return { updated: false, changes: [] }
  if (!result.current_focus && result.milestones.length === 0) return { updated: false, changes: [] }

  const updateResult = updateProjectStatus(projectName, result.current_focus, result.milestones)
  return { updated: updateResult.success, changes: updateResult.changes }
}

// ── Notification ──

function buildNotification(results: Map<string, SynthResult>): string | null {
  const highItems: string[] = []

  for (const [project, result] of results) {
    if (result.significance !== 'high') continue

    const parts: string[] = [`<b>${project}</b>`]
    if (result.alerts.length > 0) {
      parts.push(...result.alerts.map(a => `⚠️ ${a}`))
    }
    if (result.team_changes.length > 0) {
      parts.push(...result.team_changes.map(t => `👤 ${t}`))
    }
    if (result.current_focus) {
      parts.push(result.current_focus)
    }
    highItems.push(parts.join('\n'))
  }

  if (highItems.length === 0) return null

  return `<b>🔔 KB Alert</b>\n\n${highItems.join('\n\n')}`
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
    projectsProcessed: 0,
    projectsUpdated: 0,
    projectsSkipped: 0,
    errors: 0,
    highSignificance: 0,
    durationMs: 0,
  }

  const significantResults = new Map<string, SynthResult>()

  try {
    const projects = getAllProjects().filter(p => p.status === 'active')
    logger.info({ total: projects.length, lookbackHours }, 'Vault synthesizer starting')

    for (const project of projects) {
      try {
        const card = loadProjectCard(project.name)
        if (!card) { stats.projectsSkipped++; continue }

        const channelNames = extractChannelNames(card)
        if (channelNames.length === 0) { stats.projectsSkipped++; continue }

        stats.projectsProcessed++
        const result = await synthesizeProject(card, lookbackHours)

        if (!result || result.significance === 'none') continue

        const { updated } = applyUpdates(project.name, result)
        if (updated) stats.projectsUpdated++

        if (result.significance === 'high') {
          stats.highSignificance++
          significantResults.set(project.name, result)
        }

        logger.debug({
          project: project.name,
          significance: result.significance,
          updated,
          focus: result.current_focus?.slice(0, 50),
        }, 'Vault synth: project processed')
      } catch (error) {
        stats.errors++
        logger.warn({ project: project.name, error }, 'Vault synth: project failed')
      }
    }

    // Refresh knowledge map after all updates
    if (stats.projectsUpdated > 0) {
      refreshKnowledgeMap()
    }

    // Send Telegram notification for significant changes
    const notification = buildNotification(significantResults)
    if (notification) {
      try {
        await sendTelegramMessage(notification)
      } catch (error) {
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
