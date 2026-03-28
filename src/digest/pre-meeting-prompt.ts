/**
 * System prompt for pre-meeting project report.
 * Focuses on CURRENT STATE + milestone ETAs for all AC projects.
 * Delivered 1 hour before the weekly sync.
 */

import type { DigestSlackChannel } from './sources/slack.js'
import type { BriefingItem } from '../mcp/briefing/types.js'
import type { ClickUpTask } from './my-tasks.js'
import type { ProjectStatus } from '../kb/vault-reader.js'
import { loadPrompt } from '../kb/vault-loader.js'

// Moved to vault/prompts/pre-meeting.md
// export const PRE_MEETING_SYSTEM_PROMPT = `Ты готовишь отчёт-подготовку к синку ...`
export const PRE_MEETING_SYSTEM_PROMPT = loadPrompt('prompts/pre-meeting.md')

/** Build user prompt for pre-meeting report with AC-filtered data. */
export function buildPreMeetingUserPrompt(params: {
  date: string
  slackChannels: DigestSlackChannel[]
  gmailData: BriefingItem[]
  calendarData: BriefingItem[]
  clickupData: BriefingItem[]
  myTasks: ClickUpTask[]
  projectStatuses: ProjectStatus[]
  allProjects: string[]
  kbContext: Array<{ project: string; facts: string[] }>
}): string {
  const sections: string[] = []

  sections.push(`Дата: ${params.date}`)
  sections.push(`Компания: AstroCat`)
  sections.push(`\nАктивные проекты: ${params.allProjects.join(', ')}`)

  const totalSlackMsgs = params.slackChannels.reduce((sum, ch) => sum + ch.messages.length, 0)
  sections.push(`\nДАННЫЕ: ${params.slackChannels.length} Slack-каналов (${totalSlackMsgs} сообщений), ${params.gmailData.length} писем, ${params.calendarData.length} событий, ${params.clickupData.length} задач ClickUp, ${params.myTasks.length} моих задач.`)

  // Project statuses from registry — PRIMARY data source
  if (params.projectStatuses.length > 0) {
    sections.push(`\n--- СТАТУСЫ ПРОЕКТОВ (текущее состояние из registry) ---`)
    for (const s of params.projectStatuses) {
      const tasks = s.open_tasks !== undefined ? ` | ${s.open_tasks} задач, ${s.overdue_tasks ?? 0} просрочено` : ''
      const lastActivity = s.last_slack_activity ? ` | последняя активность: ${s.last_slack_activity}` : ''
      sections.push(`[${s.project}] ${s.status}${tasks}${lastActivity}`)
      sections.push(`  Фокус: ${s.current_focus}`)
    }
  }

  // Slack — recent messages by channel
  sections.push(`\n--- SLACK (свежие сообщения) ---`)
  if (params.slackChannels.length > 0) {
    for (const ch of params.slackChannels) {
      sections.push(`\n#${ch.channelName} (${ch.messages.length} сообщений):`)
      for (const msg of ch.messages) {
        const thread = msg.threadInfo ? ` [${msg.threadInfo}]` : ''
        const link = msg.link ? ` ${msg.link}` : ''
        sections.push(`  ${msg.author}: ${msg.text}${thread}${link}`)
      }
    }
  } else {
    sections.push('Нет сообщений')
  }

  // Calendar — today's and upcoming events
  sections.push(`\n--- КАЛЕНДАРЬ ---`)
  if (params.calendarData.length > 0) {
    for (const event of params.calendarData) {
      const subject = (event.subject as string) ?? ''
      const date = (event.date as string) ?? ''
      const attendees = (event.attendees as string) ?? ''
      const status = (event.status as string) ?? ''
      const cancelled = status === 'cancelled' ? ' [ОТМЕНЕНО]' : ''
      const calLinks = (event.links as string[]) ?? []
      const calUrl = calLinks[0] ?? ''
      sections.push(`  ${date} — ${subject}${cancelled}${calUrl ? ` ${calUrl}` : ''}`)
      if (attendees) sections.push(`    Участники: ${attendees}`)
    }
  } else {
    sections.push('Нет событий')
  }

  // ClickUp — task activity
  sections.push(`\n--- CLICKUP (активность) ---`)
  if (params.clickupData.length > 0) {
    for (const task of params.clickupData) {
      const subject = (task.subject as string) ?? ''
      const status = (task.status as string) ?? ''
      const list = (task.list as string) ?? ''
      const assignee = (task.assignee as string) ?? ''
      const url = (task.link as string) ?? ''
      sections.push(`  [${list}] ${subject} — ${status}${assignee ? ` (${assignee})` : ''}${url ? ` ${url}` : ''}`)
    }
  } else {
    sections.push('Нет активности')
  }

  // Gmail
  sections.push(`\n--- ПОЧТА ---`)
  if (params.gmailData.length > 0) {
    for (const email of params.gmailData) {
      const from = (email.author as string) ?? ''
      const subject = (email.subject as string) ?? ''
      const preview = (email.text_preview as string) ?? ''
      const emailLink = (email.link as string) ?? ''
      sections.push(`  От: ${from} | Тема: ${subject}`)
      if (preview) sections.push(`  Превью: ${preview}`)
      if (emailLink) sections.push(`  URL: ${emailLink}`)
      sections.push('')
    }
  } else {
    sections.push('Нет писем')
  }

  // My Tasks
  sections.push(`\n--- МОИ ЗАДАЧИ (Дарий) ---`)
  if (params.myTasks.length > 0) {
    const overdueTasks = params.myTasks.filter((t) => t.is_overdue)
    const upcomingTasks = params.myTasks.filter((t) => !t.is_overdue)

    if (overdueTasks.length > 0) {
      sections.push(`\n⏰ Просроченные (${overdueTasks.length}):`)
      for (const task of overdueTasks) {
        const due = task.due_date ? ` (до ${task.due_date})` : ''
        sections.push(`  [${task.list}] ${task.subject} — ${task.status}${due} ${task.url}`)
      }
    }
    if (upcomingTasks.length > 0) {
      sections.push(`\nНа этой неделе (${upcomingTasks.length}):`)
      for (const task of upcomingTasks) {
        const due = task.due_date ? ` (до ${task.due_date})` : ''
        sections.push(`  [${task.list}] ${task.subject} — ${task.status}${due} ${task.url}`)
      }
    }
  } else {
    sections.push('Нет задач')
  }

  // KB Context
  if (params.kbContext.length > 0) {
    sections.push(`\n--- KB КОНТЕКСТ (факты для обогащения) ---`)
    for (const entry of params.kbContext) {
      sections.push(`\n[${entry.project}]`)
      for (const fact of entry.facts) {
        sections.push(`  - ${fact}`)
      }
    }
  }

  return sections.join('\n')
}
