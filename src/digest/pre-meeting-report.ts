/**
 * Pre-meeting report compiler for AstroCat projects.
 * Generates a comprehensive project status report 1 hour before the weekly sync.
 *
 * Data sources: Slack (AC workspace), Gmail, Calendar, ClickUp, KB context, registry statuses.
 * Period: last 2 days (today + yesterday) to catch fresh activity.
 * Output: Telegram HTML message focused on current state + milestone ETAs.
 *
 * Can be triggered:
 * - Automatically via cron (1 hour before sync)
 * - Manually via Telegram skill ("отчёт перед синком")
 * - CLI: npx tsx src/digest/pre-meeting-report.ts --now
 */

import { callClaude } from '../llm/client.js'
import { logger } from '../logging/logger.js'
import { resolveGoogleTokens } from '../mcp/briefing/google-auth.js'
import { fetchGmail } from '../mcp/briefing/gmail.js'
import { fetchCalendar } from '../mcp/briefing/calendar.js'
import { fetchClickUp } from '../mcp/briefing/clickup.js'
import { findEntitiesByType, getAliasesForEntityIds, loadProjectCard } from '../kb/vault-reader.js'
import { fetchDigestSlack } from './sources/slack.js'
import { fetchMyTasks } from './my-tasks.js'
import { PRE_MEETING_SYSTEM_PROMPT, buildPreMeetingUserPrompt } from './pre-meeting-prompt.js'
import { buildNameMap, resolveDisplayName } from './name-resolver.js'
import { sendTelegramMessage } from '../telegram/sender.js'
import type { BriefingItem, BriefingRequest } from '../mcp/briefing/types.js'
import type { DigestSlackChannel } from './sources/slack.js'
import { getAllStatuses, type ProjectStatus } from '../kb/vault-reader.js'

/** Max projects to include KB context for. */
const MAX_KB_PROJECTS = 15
const MAX_FACTS_PER_PROJECT = 5

/** Retry config for source fetching. */
const RETRY_MAX_ATTEMPTS = 3
const RETRY_INITIAL_DELAY_MS = 3_000
const RETRY_MAX_DELAY_MS = 30_000

/** Format date in Russian. */
function formatDateRu(date: Date): string {
  const months = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ]
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`
}

/** Escape special regex characters. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface ProjectInfo {
  id: string
  name: string
  aliases: string[]
  searchTerms: string[]
}

/** Build AC project list with aliases for filtering. */
async function buildACProjectList(): Promise<ProjectInfo[]> {
  const projects = await findEntitiesByType('project')
  const acProjects = projects.filter((p) => p.company?.toLowerCase() === 'ac')
  const projectIds = acProjects.map((p) => p.id)

  const aliases = await getAliasesForEntityIds(projectIds)
  const aliasMap = new Map<string, string[]>()
  for (const a of aliases) {
    const eid = a.entityId
    const list = aliasMap.get(eid) ?? []
    list.push(a.alias)
    aliasMap.set(eid, list)
  }

  return acProjects.map((p) => {
    const projectAliases = aliasMap.get(p.id) ?? []
    return {
      id: p.id,
      name: p.name,
      aliases: projectAliases,
      searchTerms: [p.name, ...projectAliases].map((t) => t.toLowerCase()),
    }
  })
}

/** Check if text mentions any AC project. */
function textMatchesAC(text: string, acProjects: ProjectInfo[]): boolean {
  const lower = text.toLowerCase()
  return acProjects.some((p) =>
    p.searchTerms.some((term) => {
      if (term.length <= 3) {
        return new RegExp(`\\b${escapeRegex(term)}\\b`, 'i').test(lower)
      }
      return lower.includes(term)
    }),
  )
}

/** Filter BriefingItems to AC-related ones. */
function filterForAC(items: BriefingItem[], acProjects: ProjectInfo[]): BriefingItem[] {
  return items.filter((item) => {
    const searchable = [
      item.subject as string ?? '',
      item.text_preview as string ?? '',
      item.list as string ?? '',
      item.attendees as string ?? '',
    ].join(' ')
    return textMatchesAC(searchable, acProjects)
  })
}

/** Filter Gmail: AC account + AC project matching. */
function filterGmailForAC(items: BriefingItem[], acProjects: ProjectInfo[]): BriefingItem[] {
  return items.filter((item) => {
    const account = (item.account as string ?? '').toLowerCase()
    const searchable = [
      item.subject as string ?? '',
      item.text_preview as string ?? '',
      item.author as string ?? '',
    ].join(' ')

    if (textMatchesAC(searchable, acProjects)) return true
    if (account.includes('astrocat')) return true
    return false
  })
}

/** Fetch KB context for AC projects (from vault statuses). */
async function fetchACKBContext(acProjects: ProjectInfo[]): Promise<Array<{ project: string; facts: string[] }>> {
  const results: Array<{ project: string; facts: string[] }> = []
  for (const project of acProjects.slice(0, MAX_KB_PROJECTS)) {
    const card = loadProjectCard(project.name)
    if (!card?.current_status) continue
    const facts: string[] = []
    if (card.current_status.current_focus) facts.push(card.current_status.current_focus)
    for (const m of card.current_status.milestones.slice(0, MAX_FACTS_PER_PROJECT)) {
      facts.push(m)
    }
    if (facts.length > 0) results.push({ project: project.name, facts })
  }
  return results
}

/** Build minimal BriefingRequest. */
function buildBriefingReq(period: string, limit: number): BriefingRequest {
  return {
    sources: ['slack', 'gmail', 'calendar', 'clickup'],
    query_type: 'digest',
    period,
    limit_per_source: limit,
  }
}

/** Fetch with retry and exponential backoff. */
async function fetchWithRetry<T>(name: string, fn: () => Promise<T>): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < RETRY_MAX_ATTEMPTS) {
        const delay = Math.min(
          RETRY_INITIAL_DELAY_MS * Math.pow(2, attempt - 1),
          RETRY_MAX_DELAY_MS,
        )
        logger.warn(
          { source: name, attempt, maxAttempts: RETRY_MAX_ATTEMPTS, delay, error: lastError.message },
          'Pre-meeting report: source fetch failed, retrying',
        )
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  logger.error(
    { source: name, attempts: RETRY_MAX_ATTEMPTS, error: lastError?.message },
    'Pre-meeting report: source fetch failed after all retries',
  )
  throw lastError!
}

/**
 * Compile pre-meeting report for AstroCat projects.
 * Fetches last 2 days of data, filters for AC, sends to Claude.
 */
export async function compilePreMeetingReport(): Promise<string> {
  const now = new Date()
  const dateStr = formatDateRu(now)

  // Build AC project list + name map — KB may be unavailable, use empty fallback
  const [acProjectsResult, nameMapResult] = await Promise.allSettled([
    buildACProjectList(),
    buildNameMap(),
  ])
  if (acProjectsResult.status === 'rejected') {
    logger.warn({ error: acProjectsResult.reason instanceof Error ? acProjectsResult.reason.message : String(acProjectsResult.reason) }, 'Pre-meeting report: buildACProjectList failed, using empty list (KB unavailable)')
  }
  const acProjects = acProjectsResult.status === 'fulfilled' ? acProjectsResult.value : []
  const nameMap = nameMapResult.status === 'fulfilled' ? nameMapResult.value : new Map()

  // Build 2-day period: yesterday 00:00 to now
  const twoDaysAgo = new Date(now.getTime() - 2 * 86400_000)
  const period = { after: twoDaysAgo, before: now }

  // Pre-resolve Google tokens
  const googleTokens = await fetchWithRetry('google-auth', () => resolveGoogleTokens())

  // Fetch all sources in parallel
  const [slackResult, gmailResult, calResult, clickupResult, myTasksResult, kbResult] =
    await Promise.allSettled([
      fetchWithRetry('slack', () => fetchDigestSlack('ac', period)),
      fetchWithRetry('gmail', () => fetchGmail(buildBriefingReq('2d', 100), period, googleTokens)),
      fetchWithRetry('calendar', () => fetchCalendar(buildBriefingReq('today', 50), period, googleTokens)),
      fetchWithRetry('clickup', () => fetchClickUp(buildBriefingReq('2d', 100), period)),
      fetchWithRetry('my-tasks', () => fetchMyTasks()),
      fetchWithRetry('kb', () => fetchACKBContext(acProjects)),
    ])

  // Extract results with graceful fallbacks
  const slackChannels = (slackResult.status === 'fulfilled' ? slackResult.value : []) as DigestSlackChannel[]
  const allGmail = (gmailResult.status === 'fulfilled' ? gmailResult.value : []) as BriefingItem[]
  const allCalendar = (calResult.status === 'fulfilled' ? calResult.value : []) as BriefingItem[]
  const allClickup = (clickupResult.status === 'fulfilled' ? clickupResult.value : []) as BriefingItem[]
  const myTasks = (myTasksResult.status === 'fulfilled' ? myTasksResult.value : []) as import('./my-tasks.js').ClickUpTask[]
  const kbContext = (kbResult.status === 'fulfilled' ? kbResult.value : []) as Array<{ project: string; facts: string[] }>

  // Filter for AC
  const companyGmail = filterGmailForAC(allGmail, acProjects)
  const companyCalendar = filterForAC(allCalendar, acProjects)
  const companyClickup = filterForAC(allClickup, acProjects)

  // Resolve display names
  for (const ch of slackChannels) {
    for (const msg of ch.messages) {
      msg.author = resolveDisplayName(msg.author, nameMap)
    }
  }

  // Get project statuses from registry
  const projectStatuses = getACProjectStatuses()

  const slackMsgCount = slackChannels.reduce((sum, ch) => sum + ch.messages.length, 0)
  logger.info({
    slackChannels: slackChannels.length,
    slackMessages: slackMsgCount,
    gmail: companyGmail.length,
    calendar: companyCalendar.length,
    clickup: companyClickup.length,
    myTasks: myTasks.length,
    kbProjects: kbContext.length,
    projectStatuses: projectStatuses.length,
  }, 'Pre-meeting report: data fetched')

  // Build LLM prompt
  const userPrompt = buildPreMeetingUserPrompt({
    date: dateStr,
    slackChannels,
    gmailData: companyGmail,
    calendarData: companyCalendar,
    clickupData: companyClickup,
    myTasks,
    projectStatuses,
    allProjects: acProjects.map((p) => p.name),
    kbContext,
  })

  // Call Claude
  const response = await callClaude(userPrompt, {
    system: PRE_MEETING_SYSTEM_PROMPT,
    timeoutMs: 180_000,
  })

  if (!response.text || response.text.trim().length === 0) {
    throw new Error('Claude returned empty response for pre-meeting report')
  }

  logger.info({
    outputLen: response.text.length,
    promptLen: userPrompt.length,
    usage: response.usage,
  }, 'Pre-meeting report: LLM compilation done')

  return response.text
}

/** Get AC project statuses from registry. */
function getACProjectStatuses(): ProjectStatus[] {
  try {
    const statuses = getAllStatuses()
    return statuses.astrocat
  } catch {
    return []
  }
}

/** Compile and deliver pre-meeting report via Telegram. */
export async function deliverPreMeetingReport(): Promise<void> {
  const startTime = Date.now()
  logger.info('Starting pre-meeting report compilation')

  try {
    const report = await compilePreMeetingReport()
    await sendTelegramMessage(report)

    const elapsed = Math.round((Date.now() - startTime) / 1000)
    logger.info({ elapsedSec: elapsed, len: report.length }, 'Pre-meeting report delivered')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error({ error: msg }, 'Pre-meeting report compilation failed')

    try {
      const errorHint = msg ? `\n\nПричина: <code>${msg.slice(0, 200)}</code>` : ''
      await sendTelegramMessage(
        `⚠️ Не удалось собрать отчёт перед синком. Смотри логи.${errorHint}`,
      )
    } catch (notifyErr) {
      logger.error({ error: notifyErr }, 'Failed to send pre-meeting error notification')
    }
  }
}

// --- CLI entry point: npx tsx src/digest/pre-meeting-report.ts --now ---
if (process.argv.includes('--now')) {
  deliverPreMeetingReport()
    .then(() => {
      logger.info('Manual pre-meeting report complete')
      process.exit(0)
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ error: msg }, 'Manual pre-meeting report failed')
      process.exit(1)
    })
}
