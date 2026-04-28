/**
 * Single-pass data collector for the new digest pipeline.
 *
 * Pulls every source we feed into Sonnet (Slack from both workspaces, Gmail,
 * Calendar, ClickUp, my tasks, production milestones, vault project cards) and
 * returns one big object the LLM caller can stringify into a single prompt.
 */

import { logger } from '../logging/logger.js'
import type { BriefingItem } from '../mcp/briefing/types.js'
import type { ProjectStatus } from '../kb/vault-reader.js'
import { getAllStatuses } from '../kb/vault-reader.js'
import { resolveGoogleTokens } from '../mcp/briefing/google-auth.js'
import { fetchGmail } from '../mcp/briefing/gmail.js'
import { fetchCalendar } from '../mcp/briefing/calendar.js'
import { fetchClickUp } from '../mcp/briefing/clickup.js'
import { parsePeriod } from '../mcp/briefing/period.js'
import { fetchMyTasks, type ClickUpTask } from './my-tasks.js'
import { fetchDigestSlack, type DigestSlackChannel } from './sources/slack.js'
import {
  fetchProductionMilestones,
  type ProductionMilestone,
} from './sources/production-updates.js'
import { buildProjectMap, type ProjectInfo } from './compiler.js'
import { buildNameMap, type NameMap } from './name-resolver.js'

export interface CollectedDigestData {
  /** ISO date this digest covers (yesterday, or Fri+Sat+Sun on Mondays). */
  date: string
  /** Russian-formatted period label for prompts. */
  periodLabel: string
  /** Slack messages per channel for AC + HG combined. Channel objects carry workspace label. */
  slack: DigestSlackChannel[]
  gmail: BriefingItem[]
  calendar: BriefingItem[]
  clickup: BriefingItem[]
  myTasks: ClickUpTask[]
  milestones: ProductionMilestone[]
  /** Active projects per company, with status snapshot from `_current-status.yaml`. */
  projectStatuses: { astrocat: ProjectStatus[]; highground: ProjectStatus[] }
  /** Used for company filtering and name normalization. */
  projectMap: Map<string, ProjectInfo[]>
  nameMap: NameMap
}

const RU_MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

function ruDate(d: Date): string {
  return `${d.getDate()} ${RU_MONTHS[d.getMonth()]}`
}

/**
 * Single retry helper. Most sources already have inner retry logic; this
 * wrapper catches programmatic exceptions one level above.
 */
async function tryOrLog<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.warn({ source: name, error: msg }, 'Digest collect: source failed, using fallback')
    return fallback
  }
}

export async function collectDigestData(): Promise<CollectedDigestData> {
  const now = new Date()
  const dayOfWeek = now.getDay() // 0=Sun, 1=Mon
  const periodStr = dayOfWeek === 1 ? 'last_3_days' : 'yesterday'
  const period = parsePeriod(periodStr)
  const date = now.toISOString().slice(0, 10)
  const periodLabel = dayOfWeek === 1
    ? `${ruDate(period.after)} – ${ruDate(period.before)}`
    : ruDate(period.after)

  logger.info({ periodStr, date }, 'Digest collect: starting')

  const [projectMap, nameMap] = await Promise.all([
    tryOrLog('projectMap', buildProjectMap, new Map<string, ProjectInfo[]>()),
    tryOrLog('nameMap', buildNameMap, new Map() as NameMap),
  ])

  const googleTokens = await resolveGoogleTokens()

  const briefingReq: import('../mcp/briefing/types.js').BriefingRequest = {
    sources: ['gmail', 'calendar', 'clickup'],
    query_type: 'digest-unread',
    period: periodStr,
    limit_per_source: 100,
  }

  const [
    acSlack,
    hgSlack,
    gmail,
    calendar,
    clickup,
    myTasks,
    milestones,
  ] = await Promise.all([
    tryOrLog('slack-ac', () => fetchDigestSlack('ac', period), [] as DigestSlackChannel[]),
    tryOrLog('slack-hg', () => fetchDigestSlack('hg', period), [] as DigestSlackChannel[]),
    tryOrLog('gmail', () => fetchGmail(briefingReq, period, googleTokens), [] as BriefingItem[]),
    tryOrLog('calendar', () => fetchCalendar(briefingReq, period, googleTokens), [] as BriefingItem[]),
    tryOrLog('clickup', () => fetchClickUp(briefingReq, period), [] as BriefingItem[]),
    tryOrLog('my-tasks', fetchMyTasks, [] as ClickUpTask[]),
    tryOrLog('milestones', fetchProductionMilestones, [] as ProductionMilestone[]),
  ])

  const projectStatuses = getAllStatuses()

  logger.info(
    {
      slack: acSlack.length + hgSlack.length,
      slackMsgs: [...acSlack, ...hgSlack].reduce((s, ch) => s + ch.messages.length, 0),
      gmail: gmail.length,
      calendar: calendar.length,
      clickup: clickup.length,
      myTasks: myTasks.length,
      milestones: milestones.length,
      projectsAC: projectStatuses.astrocat.length,
      projectsHG: projectStatuses.highground.length,
    },
    'Digest collect: complete',
  )

  return {
    date,
    periodLabel,
    slack: [...acSlack, ...hgSlack],
    gmail,
    calendar,
    clickup,
    myTasks,
    milestones,
    projectStatuses,
    projectMap,
    nameMap,
  }
}
