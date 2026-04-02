/**
 * Subagent-based digest compiler.
 *
 * Architecture:
 *   Phase 1 (parallel): 3 Claude calls each digesting one slice of raw data:
 *     - SlackAgent    → summarises all Slack channels into project bullets
 *     - EmailCalAgent → summarises Gmail + Calendar into project bullets
 *     - ClickUpAgent  → summarises ClickUp tasks + KB context into project bullets
 *   Phase 2 (sequential): OrchestratorAgent receives the 3 section summaries
 *     + project statuses + my tasks and assembles the final Telegram HTML digest.
 *
 * Why this beats one big Claude call:
 *   - Each subagent prompt is ~3× smaller → fits comfortably within 3-min timeout.
 *   - All three run in parallel → total wall-clock ≈ longest single agent, not sum.
 *   - Orchestrator only does formatting + merging, not heavy extraction → very fast.
 */

import { callClaude } from '../llm/client.js'
import { logger } from '../logging/logger.js'
import type { DigestSlackChannel } from './sources/slack.js'
import type { BriefingItem } from '../mcp/briefing/types.js'
import type { ClickUpTask } from './my-tasks.js'
import type { ProjectStatus } from '../kb/vault-reader.js'
import { loadPrompt } from '../kb/vault-loader.js'
import { fetchProductionMilestones, formatMilestonesForDigest } from './sources/production-updates.js'

// ─── Sub-agent system prompts (moved to vault/instructions-for-llm/) ────────

// Moved to vault/instructions-for-llm/agent-digest-slack.md
const getSlackAgentSystem = (): string => loadPrompt('instructions-for-llm/agent-digest-slack.md')

// Moved to vault/instructions-for-llm/agent-digest-email-cal.md
const getEmailCalAgentSystem = (): string => loadPrompt('instructions-for-llm/agent-digest-email-cal.md')

// Moved to vault/instructions-for-llm/agent-digest-clickup-kb.md
const getClickupKbAgentSystem = (): string => loadPrompt('instructions-for-llm/agent-digest-clickup-kb.md')

// Moved to vault/instructions-for-llm/agent-digest-compiler.md
const getOrchestratorSystem = (): string => loadPrompt('instructions-for-llm/agent-digest-compiler.md')

// ─── Prompt builders ─────────────────────────────────────────────────────────

function buildSlackAgentPrompt(
  company: string,
  date: string,
  allProjects: string[],
  channels: DigestSlackChannel[],
): string {
  const lines: string[] = [
    `Компания: ${company} | Дата: ${date}`,
    `Все проекты: ${allProjects.join(', ')}`,
    '',
    '--- SLACK-СООБЩЕНИЯ ЗА ВЧЕРА ---',
  ]

  if (channels.length === 0) {
    lines.push('Нет сообщений')
  } else {
    for (const ch of channels) {
      lines.push(`\n#${ch.channelName} (${ch.messages.length} сообщений):`)
      for (const msg of ch.messages) {
        const thread = msg.threadInfo ? ` [${msg.threadInfo}]` : ''
        const link = msg.link ? ` ${msg.link}` : ''
        lines.push(`  ${msg.author}: ${msg.text}${thread}${link}`)
      }
    }
  }

  return lines.join('\n')
}

function buildEmailCalAgentPrompt(
  company: string,
  date: string,
  allProjects: string[],
  gmail: BriefingItem[],
  calendar: BriefingItem[],
): string {
  const lines: string[] = [
    `Компания: ${company} | Дата: ${date}`,
    `Все проекты: ${allProjects.join(', ')}`,
    '',
    '--- ПОЧТА (вчера) ---',
  ]

  if (gmail.length === 0) {
    lines.push('Нет писем')
  } else {
    for (const email of gmail) {
      const from = (email.author as string) ?? ''
      const subject = (email.subject as string) ?? ''
      const preview = (email.text_preview as string) ?? ''
      const emailLink = (email.link as string) ?? ''
      lines.push(`  От: ${from}`)
      lines.push(`  Тема: ${subject}`)
      if (preview) lines.push(`  Превью: ${preview}`)
      if (emailLink) lines.push(`  URL: ${emailLink}`)
      lines.push('')
    }
  }

  lines.push('\n--- КАЛЕНДАРЬ (вчера) ---')
  if (calendar.length === 0) {
    lines.push('Нет событий')
  } else {
    for (const event of calendar) {
      const subject = (event.subject as string) ?? ''
      const date_ = (event.date as string) ?? ''
      const attendees = (event.attendees as string) ?? ''
      const status = (event.status as string) ?? ''
      const cancelled = status === 'cancelled' ? ' [ОТМЕНЕНО]' : ''
      const calLinks = (event.links as string[]) ?? []
      const calUrl = calLinks[0] ?? ''
      lines.push(`  ${date_} — ${subject}${cancelled}${calUrl ? ` ${calUrl}` : ''}`)
      if (attendees) lines.push(`    Участники: ${attendees}`)
    }
  }

  return lines.join('\n')
}

function buildClickUpKBAgentPrompt(
  company: string,
  date: string,
  allProjects: string[],
  clickup: BriefingItem[],
  kbContext: Array<{ project: string; facts: string[] }>,
): string {
  const lines: string[] = [
    `Компания: ${company} | Дата: ${date}`,
    `Все проекты: ${allProjects.join(', ')}`,
    '',
    '--- CLICKUP (активность вчера) ---',
  ]

  if (clickup.length === 0) {
    lines.push('Нет активности')
  } else {
    for (const task of clickup) {
      const subject = (task.subject as string) ?? ''
      const status = (task.status as string) ?? ''
      const list = (task.list as string) ?? ''
      const assignee = (task.assignee as string) ?? ''
      const url = (task.link as string) ?? ''
      lines.push(`  [${list}] ${subject} — ${status}${assignee ? ` (${assignee})` : ''}${url ? ` ${url}` : ''}`)
    }
  }

  if (kbContext.length > 0) {
    lines.push('\n--- KB КОНТЕКСТ (факты по проектам) ---')
    for (const entry of kbContext) {
      lines.push(`\n[${entry.project}]`)
      for (const fact of entry.facts) {
        lines.push(`  - ${fact}`)
      }
    }
  }

  return lines.join('\n')
}

function buildOrchestratorPrompt(params: {
  company: string
  date: string
  allProjects: string[]
  generalSection: string
  slackSection: string
  emailCalSection: string
  clickupKbSection: string
  milestonesSection: string
  myTasks: ClickUpTask[]
  projectStatuses: ProjectStatus[]
  registryGaps?: { staleProjects: number; unknownUsers: number; unknownChannels: number }
}): string {
  const lines: string[] = [
    `Компания: ${params.company} | Дата: ${params.date}`,
    `Все проекты: ${params.allProjects.join(', ')}`,
  ]

  // General/team news section — goes FIRST in digest
  if (params.generalSection) {
    lines.push('')
    lines.push('=== ОБЩИЕ НОВОСТИ (из каналов announcements, leads, ac-team, absence и т.д.) ===')
    lines.push(params.generalSection)
  }

  lines.push(
    '',
    '=== СЕКЦИЯ ОТ SLACK-АГЕНТА (проектные каналы) ===',
    params.slackSection || 'Нет данных',
    '',
    '=== СЕКЦИЯ ОТ EMAIL+CALENDAR-АГЕНТА ===',
    params.emailCalSection || 'Нет данных',
    '',
    '=== СЕКЦИЯ ОТ CLICKUP+KB-АГЕНТА ===',
    params.clickupKbSection || 'Нет данных',
  )

  // Production milestones
  if (params.milestonesSection) {
    lines.push('')
    lines.push(params.milestonesSection)
  }

  // My tasks (upcoming only, no overdue)
  const upcoming = params.myTasks.filter((t) => !t.is_overdue)
  if (upcoming.length > 0) {
    lines.push('\n--- МОИ ЗАДАЧИ (назначены Дарию, на этой неделе) ---')
    for (const t of upcoming) {
      const due = t.due_date ? ` (до ${t.due_date})` : ''
      lines.push(`  [${t.list}] ${t.subject} — ${t.status}${due} ${t.url}`)
    }
  }

  // Project statuses
  const activeStatuses = params.projectStatuses.filter((s) => s.status === 'active' && s.current_focus !== 'TBD')
  if (activeStatuses.length > 0) {
    lines.push('\n--- СТАТУСЫ ПРОЕКТОВ (контекст из KB registry) ---')
    for (const s of activeStatuses) {
      const tasks = s.open_tasks !== undefined ? ` | ${s.open_tasks} задач` : ''
      lines.push(`[${s.project}] ${s.status}${tasks} | Фокус: ${s.current_focus}`)
    }
  }

  // Registry gaps
  if (params.registryGaps) {
    const { staleProjects, unknownUsers, unknownChannels } = params.registryGaps
    const warnings: string[] = []
    if (staleProjects > 0) warnings.push(`${staleProjects} проектов с устаревшими статусами`)
    if (unknownUsers > 0) warnings.push(`${unknownUsers} новых людей в Slack не в реестре`)
    if (unknownChannels > 0) warnings.push(`${unknownChannels} каналов Slack не каталогизированы`)
    if (warnings.length > 0) {
      lines.push('\n--- ПРЕДУПРЕЖДЕНИЯ О ДАННЫХ ---')
      lines.push('Добавь в конец секцию <b>⚠️ Актуальность данных</b>:')
      for (const w of warnings) lines.push(`• ${w}`)
    }
  }

  return lines.join('\n')
}

// ─── Main entry point ────────────────────────────────────────────────────────

export interface SubCompilerParams {
  company: string
  date: string
  slackChannels: DigestSlackChannel[]
  gmailData: BriefingItem[]
  calendarData: BriefingItem[]
  clickupData: BriefingItem[]
  myTasks: ClickUpTask[]
  kbContext: Array<{ project: string; facts: string[] }>
  allProjects: string[]
  projectStatuses: ProjectStatus[]
  registryGaps?: { staleProjects: number; unknownUsers: number; unknownChannels: number }
}

/** Split channels into batches and run one Slack subagent per batch in parallel. */
async function compileSlackSection(
  company: string,
  date: string,
  allProjects: string[],
  channels: DigestSlackChannel[],
): Promise<string> {
  if (channels.length === 0) return ''

  const BATCH_SIZE = 10
  const batches: DigestSlackChannel[][] = []
  for (let i = 0; i < channels.length; i += BATCH_SIZE) {
    batches.push(channels.slice(i, i + BATCH_SIZE))
  }

  if (batches.length === 1) {
    // Single batch — one call
    const result = await callClaude(
      buildSlackAgentPrompt(company, date, allProjects, batches[0]),
      { system: getSlackAgentSystem(), timeoutMs: 120_000 },
    )
    return result.text
  }

  // Multiple batches — run in parallel, concatenate results
  logger.info({ company, batches: batches.length, channels: channels.length }, 'Digest: splitting Slack into batches')
  const slackSystem = getSlackAgentSystem()
  const results = await Promise.allSettled(
    batches.map((batch, i) =>
      callClaude(
        buildSlackAgentPrompt(company, date, allProjects, batch),
        { system: slackSystem, timeoutMs: 120_000 },
      ).then((r) => ({ batch: i, text: r.text })),
    ),
  )

  // Join batch summaries — each is already compressed bullets, total stays manageable
  return results
    .filter((r): r is PromiseFulfilledResult<{ batch: number; text: string }> => r.status === 'fulfilled')
    .sort((a, b) => a.value.batch - b.value.batch)
    .map((r) => r.value.text)
    .join('\n\n')
    .slice(0, 6_000)  // Cap at 6K chars — ~3K tokens, sufficient for orchestrator
}

/**
 * Compile digest using parallel subagents + orchestrator.
 * Phase 1a: Slack channels split into batches of 10 (parallel per batch).
 * Phase 1b: Email+Cal and ClickUp+KB run in parallel alongside Slack.
 * Phase 2: Orchestrator merges all sections into final Telegram HTML.
 */
export async function compileDigestWithSubagents(params: SubCompilerParams): Promise<string> {
  const { company, date, allProjects } = params

  logger.info(
    { company, projects: allProjects.length, slackChannels: params.slackChannels.length },
    'Digest subagents: starting phase 1 (parallel extraction)',
  )

  // Split Slack channels: general (team-wide) vs project-specific
  const generalChannels = params.slackChannels.filter((ch) => ch.isGeneral)
  const projectChannels = params.slackChannels.filter((ch) => !ch.isGeneral)

  // Phase 1: all extraction in parallel (Slack internally batched if > 10 channels)
  const [slackResult, generalResult, emailCalResult, clickupKbResult] = await Promise.allSettled([
    compileSlackSection(company, date, allProjects, projectChannels),
    generalChannels.length > 0
      ? compileSlackSection(company, date, allProjects, generalChannels)
      : Promise.resolve(''),
    callClaude(
      buildEmailCalAgentPrompt(company, date, allProjects, params.gmailData, params.calendarData),
      { system: getEmailCalAgentSystem(), timeoutMs: 120_000 },
    ).then((r) => r.text),
    callClaude(
      buildClickUpKBAgentPrompt(company, date, allProjects, params.clickupData, params.kbContext),
      { system: getClickupKbAgentSystem(), timeoutMs: 120_000 },
    ).then((r) => r.text),
  ])

  const slackSection = slackResult.status === 'fulfilled' ? slackResult.value : ''
  const generalSection = generalResult.status === 'fulfilled' ? generalResult.value : ''
  const emailCalSection = emailCalResult.status === 'fulfilled' ? emailCalResult.value : ''
  const clickupKbSection = clickupKbResult.status === 'fulfilled' ? clickupKbResult.value : ''

  // Log which subagents failed (non-fatal — orchestrator works with what it has)
  if (slackResult.status === 'rejected') {
    logger.warn({ company, error: (slackResult.reason as Error)?.message }, 'Digest: Slack subagent failed')
  }
  if (emailCalResult.status === 'rejected') {
    logger.warn({ company, error: (emailCalResult.reason as Error)?.message }, 'Digest: Email+Cal subagent failed')
  }
  if (clickupKbResult.status === 'rejected') {
    logger.warn({ company, error: (clickupKbResult.reason as Error)?.message }, 'Digest: ClickUp+KB subagent failed')
  }

  if (!slackSection && !emailCalSection && !clickupKbSection) {
    throw new Error(`All 3 subagents failed for ${company} digest`)
  }

  logger.info(
    {
      company,
      slackLen: slackSection.length,
      emailCalLen: emailCalSection.length,
      clickupKbLen: clickupKbSection.length,
    },
    'Digest subagents: phase 1 complete, starting orchestrator',
  )

  // Fetch production milestones (non-blocking)
  let milestonesSection = ''
  try {
    const milestones = await fetchProductionMilestones()
    milestonesSection = formatMilestonesForDigest(milestones)
  } catch (err) {
    logger.warn({ error: (err as Error)?.message }, 'Digest: production milestones fetch failed (non-blocking)')
  }

  // Phase 2: orchestrator merges sections into final HTML
  const orchestratorPrompt = buildOrchestratorPrompt({
    company,
    date,
    allProjects,
    generalSection,
    slackSection,
    emailCalSection,
    clickupKbSection,
    milestonesSection,
    myTasks: params.myTasks,
    projectStatuses: params.projectStatuses,
    registryGaps: params.registryGaps,
  })

  const finalResult = await callClaude(orchestratorPrompt, {
    system: getOrchestratorSystem(),
    timeoutMs: 240_000,
  })

  logger.info({ company, outputLen: finalResult.text.length }, 'Digest subagents: orchestrator complete')

  return finalResult.text
}
