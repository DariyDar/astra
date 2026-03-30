/**
 * Core digest compiler — "Краткое содержание предыдущих серий".
 * Fetches YESTERDAY's data from all sources + KB context + project statuses,
 * sends to Claude LLM to produce a formatted Telegram HTML digest.
 *
 * Data separation happens IN CODE: each company gets ONLY its own data.
 * Gmail/Calendar/ClickUp are filtered by project name/alias matching.
 * Slack is naturally separated by workspace.
 */

import { logger } from '../logging/logger.js'
import { compileDigestWithSubagents } from './sub-compiler.js'
import { resolveGoogleTokens } from '../mcp/briefing/google-auth.js'
import { fetchGmail } from '../mcp/briefing/gmail.js'
import { fetchCalendar } from '../mcp/briefing/calendar.js'
import { fetchClickUp } from '../mcp/briefing/clickup.js'
import { parsePeriod } from '../mcp/briefing/period.js'
import { findEntitiesByType, getAliasesForEntityIds, loadProjectCard } from '../kb/vault-reader.js'
import { fetchDigestSlack, type DigestSlackChannel } from './sources/slack.js'
import { fetchMyTasks, type ClickUpTask } from './my-tasks.js'
import { buildNameMap, resolveDisplayName, type NameMap } from './name-resolver.js'
import type { BriefingRequest, BriefingItem } from '../mcp/briefing/types.js'
import { getAllStatuses, type ProjectStatus } from '../kb/vault-reader.js'
// Discovery report removed — YAML registry replaced by Obsidian vault

type Company = 'astrocat' | 'highground'

const COMPANY_LABELS: Record<Company, string> = {
  astrocat: 'AstroCat',
  highground: 'Highground',
}

const SLACK_WORKSPACE_MAP: Record<Company, 'ac' | 'hg'> = {
  astrocat: 'ac',
  highground: 'hg',
}

/** Retry config for source fetching. */
const RETRY_MAX_ATTEMPTS = 5
const RETRY_INITIAL_DELAY_MS = 5_000
const RETRY_MAX_DELAY_MS = 60_000

/** Max projects to include KB context for (limits LLM prompt size). */
const MAX_KB_PROJECTS = 20

/** Max facts per project in KB context. */
const MAX_FACTS_PER_PROJECT = 8

/** Format date in Russian for the digest header. */
function formatDateRu(date: Date): string {
  const months = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ]
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`
}

/** Sources that MUST succeed for a complete digest. */
const CRITICAL_SOURCES = ['slack', 'gmail', 'calendar', 'clickup'] as const

interface SourceResult<T> {
  name: string
  data: T | null
  error: string | null
}

/** Project info from KB for matching and context. */
interface ProjectInfo {
  id: string
  name: string
  company: string
  aliases: string[]
  searchTerms: string[]  // lowercase name + aliases for matching
}

/**
 * Build a map of company → project search terms for filtering
 * Gmail/Calendar/ClickUp data per company.
 */
async function buildProjectMap(): Promise<Map<string, ProjectInfo[]>> {
  const projects = await findEntitiesByType('project')
  const projectIds = projects.map((p) => p.id)

  // Fetch all aliases for all projects via facade
  const aliases = await getAliasesForEntityIds(projectIds)

  const aliasMap = new Map<string, string[]>()
  for (const a of aliases) {
    const eid = a.entityId
    const list = aliasMap.get(eid) ?? []
    list.push(a.alias)
    aliasMap.set(eid, list)
  }

  const byCompany = new Map<string, ProjectInfo[]>()

  for (const p of projects) {
    if (!p.company) continue
    const company = p.company.toLowerCase()
    const projectAliases = aliasMap.get(p.id) ?? []
    const searchTerms = [p.name, ...projectAliases].map((t) => t.toLowerCase())

    const info: ProjectInfo = {
      id: p.id,
      name: p.name,
      company,
      aliases: projectAliases,
      searchTerms,
    }

    const list = byCompany.get(company) ?? []
    list.push(info)
    byCompany.set(company, list)
  }

  return byCompany
}

/** Escape special regex characters. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Check if a text string mentions any project from the given list.
 * Short terms (<=3 chars) use word boundary matching to avoid false positives
 * (e.g., "ot" in "notification", "sb" in "usb").
 */
function textMatchesCompany(text: string, companyProjects: ProjectInfo[]): boolean {
  const lower = text.toLowerCase()
  return companyProjects.some((p) =>
    p.searchTerms.some((term) => {
      if (term.length <= 3) {
        const regex = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i')
        return regex.test(lower)
      }
      return lower.includes(term)
    }),
  )
}

/**
 * Filter BriefingItems to those relevant to a specific company.
 * Checks subject, text_preview, list, and account fields.
 * Items that don't match any company go into "shared" bucket.
 */
function filterItemsForCompany(
  items: BriefingItem[],
  companyProjects: ProjectInfo[],
  otherProjects: ProjectInfo[],
): { matched: BriefingItem[]; shared: BriefingItem[] } {
  const matched: BriefingItem[] = []
  const shared: BriefingItem[] = []

  for (const item of items) {
    const searchableFields = [
      item.subject as string ?? '',
      item.text_preview as string ?? '',
      item.list as string ?? '',
      item.attendees as string ?? '',
    ].join(' ')

    if (textMatchesCompany(searchableFields, companyProjects)) {
      matched.push(item)
    } else if (textMatchesCompany(searchableFields, otherProjects)) {
      // Belongs to the other company — skip
    } else {
      // Not project-specific — shared (general meetings, HR, admin)
      shared.push(item)
    }
  }

  return { matched, shared }
}

/** Filter Gmail items by account: dariy@astrocat.co → ac, dshatskikh@highground.games → hg. */
function filterGmailByAccount(
  items: BriefingItem[],
  wsLabel: string,
  companyProjects: ProjectInfo[],
  otherProjects: ProjectInfo[],
): BriefingItem[] {
  const result: BriefingItem[] = []

  for (const item of items) {
    const account = (item.account as string ?? '').toLowerCase()
    const searchable = [
      item.subject as string ?? '',
      item.text_preview as string ?? '',
      item.author as string ?? '',
    ].join(' ')

    // If email matches a project, use project-based filtering
    if (textMatchesCompany(searchable, companyProjects)) {
      result.push(item)
      continue
    }
    if (textMatchesCompany(searchable, otherProjects)) {
      continue  // belongs to other company
    }

    // Non-project email: assign by account
    if (wsLabel === 'ac' && account.includes('astrocat')) {
      result.push(item)
    } else if (wsLabel === 'hg' && account.includes('highground')) {
      result.push(item)
    } else if (wsLabel === 'ac') {
      // Default non-project emails to AC (Dariy's primary)
      result.push(item)
    }
  }

  return result
}

/** Pre-fetched shared data that can be reused across multiple compileDigest calls. */
export interface SharedDigestData {
  projectMap: Map<string, ProjectInfo[]>
  nameMap: NameMap
  gmail: BriefingItem[]
  calendar: BriefingItem[]
  clickup: BriefingItem[]
  myTasks: ClickUpTask[]
}

/**
 * Fetch shared data (Gmail, Calendar, ClickUp, KB maps) ONCE for both companies.
 * Returns pre-fetched data to pass into compileDigest.
 */
export async function fetchSharedDigestData(): Promise<SharedDigestData> {
  const yesterdayPeriod = parsePeriod('yesterday')

  // Build project map + name map
  const [projectMapResult, nameMapResult] = await Promise.allSettled([
    buildProjectMap(),
    buildNameMap(),
  ])
  if (projectMapResult.status === 'rejected') {
    logger.warn({ error: projectMapResult.reason instanceof Error ? projectMapResult.reason.message : String(projectMapResult.reason) }, 'Digest: buildProjectMap failed, using empty project map (KB unavailable)')
  }
  if (nameMapResult.status === 'rejected') {
    logger.warn({ error: nameMapResult.reason instanceof Error ? nameMapResult.reason.message : String(nameMapResult.reason) }, 'Digest: buildNameMap failed, using empty name map')
  }
  const projectMap = projectMapResult.status === 'fulfilled' ? projectMapResult.value : new Map<string, ProjectInfo[]>()
  const nameMap: NameMap = nameMapResult.status === 'fulfilled' ? nameMapResult.value : new Map()

  // Pre-resolve Google tokens (needed by gmail + calendar)
  const googleTokens = await fetchWithRetry('google-auth', () => resolveGoogleTokens())

  // Fetch shared sources in parallel
  const [gmailResult, calResult, clickupResult, myTasksResult] = await Promise.allSettled([
    fetchWithRetry('gmail', () => fetchGmail(buildBriefingReq('yesterday', 100), yesterdayPeriod, googleTokens)),
    fetchWithRetry('calendar', () => fetchCalendar(buildBriefingReq('yesterday', 100), yesterdayPeriod, googleTokens)),
    fetchWithRetry('clickup', () => fetchClickUp(buildBriefingReq('yesterday', 100), yesterdayPeriod)),
    fetchWithRetry('my-tasks', () => fetchMyTasks()),
  ])

  // Validate critical shared sources
  const sharedResults: SourceResult<unknown>[] = [
    { name: 'gmail', ...settledToResult(gmailResult) },
    { name: 'calendar', ...settledToResult(calResult) },
    { name: 'clickup', ...settledToResult(clickupResult) },
  ]
  const failedCritical = sharedResults.filter(
    (r) => r.error !== null && (CRITICAL_SOURCES as readonly string[]).includes(r.name),
  )
  if (failedCritical.length > 0) {
    const names = failedCritical.map((r) => `${r.name}: ${r.error}`).join('; ')
    throw new Error(`Critical shared sources failed: ${names}`)
  }

  return {
    projectMap,
    nameMap,
    gmail: (gmailResult.status === 'fulfilled' ? gmailResult.value : []) as BriefingItem[],
    calendar: (calResult.status === 'fulfilled' ? calResult.value : []) as BriefingItem[],
    clickup: (clickupResult.status === 'fulfilled' ? clickupResult.value : []) as BriefingItem[],
    myTasks: (myTasksResult.status === 'fulfilled' ? myTasksResult.value : []) as ClickUpTask[],
  }
}

/**
 * Compile a daily digest for a specific company.
 * Fetches YESTERDAY's data with retry, validates completeness, sends to LLM.
 * Data is filtered PER COMPANY in code before sending to Claude.
 *
 * If `shared` is provided, uses pre-fetched Gmail/Calendar/ClickUp/maps instead of fetching again.
 */
export async function compileDigest(company: Company, shared?: SharedDigestData): Promise<string> {
  const now = new Date()
  const dateStr = formatDateRu(now)
  const companyLabel = COMPANY_LABELS[company]
  const wsLabel = SLACK_WORKSPACE_MAP[company]

  const yesterdayPeriod = parsePeriod('yesterday')

  // Use shared data if provided, otherwise fetch independently (backward compat)
  let projectMap: Map<string, ProjectInfo[]>
  let nameMap: NameMap
  let allGmail: BriefingItem[]
  let allCalendar: BriefingItem[]
  let allClickup: BriefingItem[]
  let myTasks: ClickUpTask[]

  if (shared) {
    projectMap = shared.projectMap
    nameMap = shared.nameMap
    allGmail = shared.gmail
    allCalendar = shared.calendar
    allClickup = shared.clickup
    myTasks = shared.myTasks
  } else {
    // Legacy path: fetch everything independently
    const [projectMapResult, nameMapResult] = await Promise.allSettled([
      buildProjectMap(),
      buildNameMap(),
    ])
    if (projectMapResult.status === 'rejected') {
      logger.warn({ error: projectMapResult.reason instanceof Error ? projectMapResult.reason.message : String(projectMapResult.reason) }, 'Digest: buildProjectMap failed, using empty project map (KB unavailable)')
    }
    if (nameMapResult.status === 'rejected') {
      logger.warn({ error: nameMapResult.reason instanceof Error ? nameMapResult.reason.message : String(nameMapResult.reason) }, 'Digest: buildNameMap failed, using empty name map')
    }
    projectMap = projectMapResult.status === 'fulfilled' ? projectMapResult.value : new Map<string, ProjectInfo[]>()
    nameMap = nameMapResult.status === 'fulfilled' ? nameMapResult.value : new Map()

    const googleTokens = await fetchWithRetry('google-auth', () => resolveGoogleTokens())
    const [gmailResult, calResult, clickupResult, myTasksResult] = await Promise.allSettled([
      fetchWithRetry('gmail', () => fetchGmail(buildBriefingReq('yesterday', 100), yesterdayPeriod, googleTokens)),
      fetchWithRetry('calendar', () => fetchCalendar(buildBriefingReq('yesterday', 100), yesterdayPeriod, googleTokens)),
      fetchWithRetry('clickup', () => fetchClickUp(buildBriefingReq('yesterday', 100), yesterdayPeriod)),
      fetchWithRetry('my-tasks', () => fetchMyTasks()),
    ])
    allGmail = (gmailResult.status === 'fulfilled' ? gmailResult.value : []) as BriefingItem[]
    allCalendar = (calResult.status === 'fulfilled' ? calResult.value : []) as BriefingItem[]
    allClickup = (clickupResult.status === 'fulfilled' ? clickupResult.value : []) as BriefingItem[]
    myTasks = (myTasksResult.status === 'fulfilled' ? myTasksResult.value : []) as ClickUpTask[]
  }

  const companyProjects = projectMap.get(wsLabel) ?? []
  const otherWs = wsLabel === 'ac' ? 'hg' : 'ac'
  const otherProjects = projectMap.get(otherWs) ?? []

  // Fetch Slack per-company (always separate — workspace-specific)
  const [slackResult, kbResult] =
    await Promise.allSettled([
      fetchWithRetry('slack', () => fetchDigestSlack(wsLabel, yesterdayPeriod)),
      fetchWithRetry('kb', () => fetchKBContext(wsLabel)),
    ])

  // Collect results and check for critical failures (Slack + KB are per-company)
  const results: SourceResult<unknown>[] = [
    { name: 'slack', ...settledToResult(slackResult) },
    { name: 'kb', ...settledToResult(kbResult) },
  ]

  // Validate Slack (the only per-company critical source)
  const failedCritical = results.filter(
    (r) => r.error !== null && (CRITICAL_SOURCES as readonly string[]).includes(r.name),
  )
  if (failedCritical.length > 0) {
    const names = failedCritical.map((r) => `${r.name}: ${r.error}`).join('; ')
    throw new Error(`Critical sources failed for ${company} digest: ${names}`)
  }

  // Slack — already filtered by workspace
  const slackChannels = (slackResult.status === 'fulfilled' ? slackResult.value : []) as DigestSlackChannel[]

  // Gmail — filter by account + project matching
  const companyGmail = filterGmailByAccount(allGmail, wsLabel, companyProjects, otherProjects)

  // Calendar — filter by project matching, shared goes to both
  const { matched: projectCalendar, shared: sharedCalendar } = filterItemsForCompany(
    allCalendar, companyProjects, otherProjects,
  )
  const companyCalendar = [...projectCalendar, ...sharedCalendar]

  // ClickUp — filter by list name matching projects (NO shared — unmatched tasks are noise)
  const { matched: companyClickup } = filterItemsForCompany(
    allClickup, companyProjects, otherProjects,
  )

  const kbContext = (kbResult.status === 'fulfilled' ? kbResult.value : []) as Array<{ project: string; facts: string[] }>

  // Resolve display names: Slack author → short Russian name
  resolveSlackDisplayNames(slackChannels, nameMap)

  // Log non-critical failures as warnings
  const failedNonCritical = results.filter(
    (r) => r.error !== null && !(CRITICAL_SOURCES as readonly string[]).includes(r.name),
  )
  for (const f of failedNonCritical) {
    logger.warn({ source: f.name, error: f.error }, 'Digest: non-critical source failed, using empty fallback')
  }

  const slackMsgCount = slackChannels.reduce((sum, ch) => sum + ch.messages.length, 0)
  logger.info({
    company,
    slackChannels: slackChannels.length,
    slackMessages: slackMsgCount,
    gmail: companyGmail.length,
    gmailTotal: allGmail.length,
    calendar: companyCalendar.length,
    calendarTotal: allCalendar.length,
    clickup: companyClickup.length,
    clickupTotal: allClickup.length,
    myTasks: myTasks.length,
    kbProjects: kbContext.length,
  }, 'Digest: data fetched and filtered for company')

  // Load project statuses from registry
  const projectStatuses = getProjectStatusesForCompany(wsLabel)

  // Discovery report disabled — vault replaces YAML registry, gaps tracking moved to Phase 7
  const registryGaps = undefined

  // Compile via parallel subagents + orchestrator
  const digestText = await compileDigestWithSubagents({
    company: companyLabel,
    date: dateStr,
    slackChannels,
    gmailData: companyGmail,
    calendarData: companyCalendar,
    clickupData: companyClickup,
    myTasks,
    kbContext,
    allProjects: companyProjects.map((p) => p.name),
    projectStatuses,
    registryGaps,
  })

  if (!digestText || digestText.trim().length === 0) {
    throw new Error(`Subagent compilation returned empty result for ${company} digest`)
  }

  return digestText
}

/** Get project statuses from the YAML registry for a company. */
function getProjectStatusesForCompany(companyCode: string): ProjectStatus[] {
  try {
    const statuses = getAllStatuses()
    return companyCode === 'ac' ? statuses.astrocat : statuses.highground
  } catch {
    return []
  }
}

/** Fetch KB context for projects belonging to a company (from vault statuses). */
async function fetchKBContext(companyCode: string): Promise<Array<{ project: string; facts: string[] }>> {
  const projects = findEntitiesByType('project')
  const companyProjects = projects.filter((p) => {
    if (!p.company) return false
    return p.company.toLowerCase() === companyCode.toLowerCase()
  })

  const results: Array<{ project: string; facts: string[] }> = []
  for (const project of companyProjects.slice(0, MAX_KB_PROJECTS)) {
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

/** Build a minimal BriefingRequest for the fetchers. */
function buildBriefingReq(period: string, limit: number): BriefingRequest {
  return {
    sources: ['slack', 'gmail', 'calendar', 'clickup'],
    query_type: 'digest',
    period,
    limit_per_source: limit,
  }
}

/**
 * Fetch with retry and exponential backoff.
 * Retries up to RETRY_MAX_ATTEMPTS times with increasing delays.
 */
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
          'Digest: source fetch failed, retrying',
        )
        await sleep(delay)
      }
    }
  }

  logger.error(
    { source: name, attempts: RETRY_MAX_ATTEMPTS, error: lastError?.message },
    'Digest: source fetch failed after all retries',
  )
  throw lastError!
}

/** Convert PromiseSettledResult to data/error pair. */
function settledToResult<T>(result: PromiseSettledResult<T>): { data: T | null; error: string | null } {
  if (result.status === 'fulfilled') {
    return { data: result.value, error: null }
  }
  const msg = result.reason instanceof Error ? result.reason.message : String(result.reason)
  return { data: null, error: msg }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Replace Slack author names with short Russian display names from KB. Mutates in place. */
function resolveSlackDisplayNames(channels: DigestSlackChannel[], nameMap: NameMap): void {
  for (const ch of channels) {
    for (const msg of ch.messages) {
      msg.author = resolveDisplayName(msg.author, nameMap)
    }
  }
}
