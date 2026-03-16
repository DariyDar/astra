/**
 * Per-Project Status Generator — generates daily status summaries
 * for each project using data from Slack, ClickUp, Gmail, Calendar, and KB.
 *
 * Writes to _current-status.yaml in-place.
 * Called after KB ingestion in the nightly cron job.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { callClaude } from '../../llm/client.js'
import { logger } from '../../logging/logger.js'
import { fetchDigestSlack } from '../../digest/sources/slack.js'
import { fetchClickUp } from '../../mcp/briefing/clickup.js'
import { parsePeriod } from '../../mcp/briefing/period.js'
import type { BriefingRequest } from '../../mcp/briefing/types.js'
import { refresh } from './reader.js'

const REGISTRY_DIR = join(fileURLToPath(import.meta.url), '..')
const STATUS_FILE = join(REGISTRY_DIR, 'projects', '_current-status.yaml')

interface ProjectStatusEntry {
  project: string
  status: string
  current_focus: string
  monitoring: {
    slack: string[]
    clickup: string | false
    jira?: string
  }
  updated_at: string
  open_tasks?: number
  overdue_tasks?: number
  last_slack_activity?: string
}

interface StatusFileData {
  last_updated: string
  astrocat: ProjectStatusEntry[]
  highground: ProjectStatusEntry[]
}

/**
 * Generate daily project statuses for all active projects.
 * Fetches data from Slack + ClickUp per project and uses Claude to summarize.
 */
export async function generateProjectStatuses(): Promise<void> {
  logger.info('Starting project status generation')

  const statusData = loadStatusFile()
  if (!statusData) {
    logger.error('Cannot load _current-status.yaml')
    return
  }

  const todayStr = new Date().toISOString().slice(0, 10)
  const yesterdayPeriod = parsePeriod('yesterday')

  // Process all projects in both companies
  const allProjects = [
    ...statusData.astrocat.map((p) => ({ ...p, company: 'ac' as const })),
    ...statusData.highground.map((p) => ({ ...p, company: 'hg' as const })),
  ]

  const activeProjects = allProjects.filter((p) => p.status === 'active')
  logger.info({ total: activeProjects.length }, 'Processing active projects')

  for (const project of activeProjects) {
    try {
      const updated = await generateSingleProjectStatus(project, yesterdayPeriod)
      if (updated) {
        // Find and update in the status data
        const companyList = project.company === 'ac' ? statusData.astrocat : statusData.highground
        const idx = companyList.findIndex((p) => p.project === project.project)
        if (idx >= 0) {
          companyList[idx] = { ...companyList[idx], ...updated, updated_at: todayStr }
        }
      }
    } catch (error) {
      logger.warn({ project: project.project, error: error instanceof Error ? error.message : String(error) }, 'Failed to generate status for project')
    }
  }

  // Write updated statuses
  statusData.last_updated = todayStr
  writeStatusFile(statusData)

  // Invalidate reader cache so knowledge map picks up fresh data
  refresh()

  logger.info({ projectsUpdated: activeProjects.length }, 'Project status generation complete')
}

async function generateSingleProjectStatus(
  project: ProjectStatusEntry & { company: 'ac' | 'hg' },
  period: ReturnType<typeof parsePeriod>,
): Promise<Partial<ProjectStatusEntry> | null> {
  const slackChannels = project.monitoring?.slack ?? []
  const clickupList = project.monitoring?.clickup

  // Fetch Slack messages for project channels
  let slackSummary = ''
  if (slackChannels.length > 0) {
    try {
      const allSlackData = await fetchDigestSlack(project.company, period)
      // Filter to only this project's monitored channels
      const slackData = allSlackData.filter((ch) =>
        slackChannels.some((sc) => ch.channelName.toLowerCase().includes(sc.toLowerCase())),
      )
      const totalMsgs = slackData.reduce((sum, ch) => sum + ch.messages.length, 0)
      if (totalMsgs > 0) {
        slackSummary = slackData
          .filter((ch) => ch.messages.length > 0)
          .map((ch) => `#${ch.channelName}: ${ch.messages.length} msgs`)
          .join(', ')
      }
    } catch {
      // Non-critical, continue without Slack data
    }
  }

  // Fetch ClickUp tasks
  let taskSummary = ''
  let openTasks = 0
  let overdueTasks = 0
  if (clickupList && typeof clickupList === 'string') {
    try {
      const req: BriefingRequest = {
        sources: ['clickup'],
        query_type: 'recent',
        period: 'last_week',
        clickup_list_names: [clickupList],
        include_closed: false,
        limit_per_source: 50,
      }
      const tasks = await fetchClickUp(req, period)
      openTasks = tasks.length
      overdueTasks = tasks.filter((t) => {
        const due = t.due_date as string | undefined
        if (!due) return false
        return new Date(due) < new Date()
      }).length
      taskSummary = `${openTasks} open tasks, ${overdueTasks} overdue`
    } catch {
      // Non-critical
    }
  }

  // Build a minimal context for Claude to summarize
  const contextParts: string[] = [`Project: ${project.project}`]
  if (slackSummary) contextParts.push(`Slack activity: ${slackSummary}`)
  if (taskSummary) contextParts.push(`ClickUp: ${taskSummary}`)
  if (!slackSummary && !taskSummary) {
    // No data to summarize
    return {
      current_focus: project.current_focus === 'TBD' ? 'Нет данных за последние сутки' : project.current_focus,
      open_tasks: openTasks,
      overdue_tasks: overdueTasks,
      last_slack_activity: slackSummary ? new Date().toISOString().slice(0, 10) : project.last_slack_activity,
    }
  }

  // Ask Claude for a brief summary
  try {
    const response = await callClaude(
      `Сгенерируй краткий статус проекта (2-3 предложения на русском). Данные:\n${contextParts.join('\n')}`,
      {
        system: 'Ты генерируешь краткие статусы проектов для внутреннего дашборда. Только факты, без вводных слов. Формат: 2-3 предложения.',
        timeoutMs: 30_000,
      },
    )
    return {
      current_focus: response.text.trim(),
      open_tasks: openTasks,
      overdue_tasks: overdueTasks,
      last_slack_activity: slackSummary ? new Date().toISOString().slice(0, 10) : project.last_slack_activity,
    }
  } catch {
    return {
      open_tasks: openTasks,
      overdue_tasks: overdueTasks,
      last_slack_activity: slackSummary ? new Date().toISOString().slice(0, 10) : project.last_slack_activity,
    }
  }
}

function loadStatusFile(): StatusFileData | null {
  try {
    if (!existsSync(STATUS_FILE)) return null
    const content = readFileSync(STATUS_FILE, 'utf-8')
    return yaml.load(content) as StatusFileData
  } catch {
    return null
  }
}

function writeStatusFile(data: StatusFileData): void {
  const header = [
    '# Актуальные статусы проектов',
    '# Обновляется ежедневно (процесс: daily-project-status-update)',
    '# last_updated заполняется автоматически',
    '# Если updated_at > 3 дней назад — статус stale',
    '',
  ].join('\n')

  const yamlContent = yaml.dump(data, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
  })

  // Atomic write: write to temp file then rename to avoid corruption on crash
  const tmpFile = STATUS_FILE + '.tmp'
  writeFileSync(tmpFile, header + '\n' + yamlContent, 'utf-8')
  renameSync(tmpFile, STATUS_FILE)
  logger.info({ file: STATUS_FILE }, 'Project statuses written (atomic)')
}
