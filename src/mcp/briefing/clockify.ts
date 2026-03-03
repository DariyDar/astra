import { log } from './utils.js'
import { parsePeriod } from './period.js'

// ── Clockify API ──

const CLOCKIFY_API = 'https://api.clockify.me/api/v1'
const CLOCKIFY_REPORTS_API = 'https://reports.api.clockify.me/v1'

interface ClockifyUser { id: string; name: string; email: string; status: string }
let clockifyUserCache: ClockifyUser[] = []
let clockifyUserCacheTs = 0
const CLOCKIFY_USER_CACHE_TTL_MS = 10 * 60_000

async function resolveClockifyUsers(): Promise<ClockifyUser[]> {
  const apiKey = process.env.CLOCKIFY_API_KEY
  const wsId = process.env.CLOCKIFY_WORKSPACE_ID
  if (!apiKey || !wsId) throw new Error('CLOCKIFY_API_KEY or CLOCKIFY_WORKSPACE_ID not set')

  if (clockifyUserCache.length > 0 && Date.now() - clockifyUserCacheTs < CLOCKIFY_USER_CACHE_TTL_MS) {
    return clockifyUserCache
  }

  // page-size=200 covers current team (~40). Paginate if workspace grows beyond 200.
  const res = await fetch(`${CLOCKIFY_API}/workspaces/${wsId}/users?status=ACTIVE&page-size=200`, {
    headers: { 'X-Api-Key': apiKey },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Clockify users API: ${res.status} ${res.statusText}`)
  const data = (await res.json()) as Array<{ id: string; name: string; email: string; status: string }>
  clockifyUserCache = data.map(u => ({ id: u.id, name: u.name, email: u.email, status: u.status }))
  clockifyUserCacheTs = Date.now()
  log(`Clockify user cache refreshed: ${clockifyUserCache.length} active users`)
  return clockifyUserCache
}

// ── Report types ──

export type ClockifyReportType = 'summary' | 'who_tracked' | 'who_missing'

interface ClockifyReportRequest {
  report_type: ClockifyReportType
  period: string
  group_by?: 'user' | 'project'
  project_name?: string
  user_name?: string
}

interface ClockifyReportResult {
  report_type: ClockifyReportType
  period: { start: string; end: string }
  data: unknown[]
  meta: { query_time_ms: number }
}

function secondsToHM(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

// ── Report execution ──

export async function executeClockifyReport(req: ClockifyReportRequest): Promise<ClockifyReportResult> {
  const startTime = Date.now()
  const apiKey = process.env.CLOCKIFY_API_KEY
  const wsId = process.env.CLOCKIFY_WORKSPACE_ID
  if (!apiKey || !wsId) throw new Error('CLOCKIFY_API_KEY or CLOCKIFY_WORKSPACE_ID not set')

  const period = parsePeriod(req.period)
  const periodStart = period.after.toISOString()
  const periodEnd = period.before.toISOString()

  const groupBy = req.group_by ?? 'user'
  const groups = groupBy === 'user' ? ['USER', 'PROJECT'] : ['PROJECT', 'USER']

  // Fetch summary report
  const reportRes = await fetch(`${CLOCKIFY_REPORTS_API}/workspaces/${wsId}/reports/summary`, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      dateRangeStart: periodStart,
      dateRangeEnd: periodEnd,
      summaryFilter: { groups },
    }),
  })
  if (!reportRes.ok) throw new Error(`Clockify reports API: ${reportRes.status} ${reportRes.statusText}`)
  const report = (await reportRes.json()) as {
    groupOne?: Array<{
      _id: string
      name: string
      duration: number
      children?: Array<{ _id: string; name: string; duration: number }>
    }>
  }

  const rawGroups = report.groupOne ?? []

  // Apply name filters
  let filtered = rawGroups
  if (req.user_name && groupBy === 'user') {
    const lower = req.user_name.toLowerCase()
    filtered = filtered.filter(g => g.name.toLowerCase().includes(lower))
  }
  if (req.project_name && groupBy === 'project') {
    const lower = req.project_name.toLowerCase()
    filtered = filtered.filter(g => g.name.toLowerCase().includes(lower))
  }
  // Cross-filter: user_name when grouped by project, project_name when grouped by user
  if (req.project_name && groupBy === 'user') {
    const lower = req.project_name.toLowerCase()
    filtered = filtered.map(g => ({
      ...g,
      children: (g.children ?? []).filter(c => c.name.toLowerCase().includes(lower)),
    })).filter(g => (g.children?.length ?? 0) > 0)
  }
  if (req.user_name && groupBy === 'project') {
    const lower = req.user_name.toLowerCase()
    filtered = filtered.map(g => ({
      ...g,
      children: (g.children ?? []).filter(c => c.name.toLowerCase().includes(lower)),
    })).filter(g => (g.children?.length ?? 0) > 0)
  }

  if (req.report_type === 'summary') {
    const data = filtered.map(g => ({
      [groupBy === 'user' ? 'user' : 'project']: g.name,
      total_hours: secondsToHM(g.duration),
      ...(groupBy === 'user'
        ? { projects: (g.children ?? []).map(c => ({ name: c.name, hours: secondsToHM(c.duration) })) }
        : { users: (g.children ?? []).map(c => ({ name: c.name, hours: secondsToHM(c.duration) })) }
      ),
    }))
    return { report_type: 'summary', period: { start: periodStart, end: periodEnd }, data, meta: { query_time_ms: Date.now() - startTime } }
  }

  // who_tracked / who_missing — need user list, match by user _id (not display name)
  const users = await resolveClockifyUsers()
  const userHoursMap = new Map<string, number>()
  // Always group by USER for identity matching (use rawGroups with USER as primary group)
  const userGroups = groupBy === 'user' ? rawGroups : []
  if (groupBy === 'user') {
    for (const g of userGroups) {
      userHoursMap.set(g._id, g.duration)
    }
  } else {
    // Grouped by project — aggregate children (users) across projects by _id
    for (const g of rawGroups) {
      for (const c of g.children ?? []) {
        userHoursMap.set(c._id, (userHoursMap.get(c._id) ?? 0) + c.duration)
      }
    }
  }

  if (req.report_type === 'who_tracked') {
    const data = users
      .map(u => ({ user: u.name, hours: secondsToHM(userHoursMap.get(u.id) ?? 0), hours_raw: userHoursMap.get(u.id) ?? 0 }))
      .sort((a, b) => b.hours_raw - a.hours_raw)
      .map(({ hours_raw: _, ...rest }) => rest)
    return { report_type: 'who_tracked', period: { start: periodStart, end: periodEnd }, data, meta: { query_time_ms: Date.now() - startTime } }
  }

  if (req.report_type === 'who_missing') {
    const data = users
      .filter(u => !userHoursMap.has(u.id) || userHoursMap.get(u.id) === 0)
      .map(u => ({ user: u.name, email: u.email }))
    return { report_type: 'who_missing', period: { start: periodStart, end: periodEnd }, data, meta: { query_time_ms: Date.now() - startTime } }
  }

  throw new Error(`Unknown report_type: ${req.report_type}`)
}

// ── Tool definition ──

export const clockifyReportTool = {
  name: 'clockify_report',
  description: `Time tracking report from Clockify. Returns aggregated hours data for the team.

report_type options:
- "summary" — per-person or per-project breakdown with hours
- "who_tracked" — all active users with their tracked hours (sorted by hours)
- "who_missing" — active users who logged zero hours in the period

period options: "today", "this_week", "last_week", "this_month", "last_month", or ISO range "2026-01-01/2026-01-31"`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      report_type: {
        type: 'string' as const,
        enum: ['summary', 'who_tracked', 'who_missing'],
        description: 'Type of report',
      },
      period: {
        type: 'string' as const,
        description: 'Time period for the report',
        default: 'this_month',
      },
      group_by: {
        type: 'string' as const,
        enum: ['user', 'project'],
        description: 'Group results by user or project (default: user)',
        default: 'user',
      },
      project_name: {
        type: 'string' as const,
        description: 'Filter to a specific project (fuzzy match)',
      },
      user_name: {
        type: 'string' as const,
        description: 'Filter to a specific person (fuzzy match)',
      },
    },
    required: ['report_type'],
  },
}
