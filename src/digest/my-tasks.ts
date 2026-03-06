/**
 * Fetch tasks assigned to the current user from ClickUp.
 * Used by the daily digest to show "My Tasks" section.
 */

import { logger } from '../logging/logger.js'

export interface ClickUpTask {
  subject: string
  status: string
  due_date: string
  list: string
  url: string
  is_overdue: boolean
}

/** Format date as "6 мар 2026". */
function formatDateShort(d: Date): string {
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`
}

/** Cached ClickUp user ID, keyed by API key to handle key rotation. */
let cachedUser: { apiKey: string; userId: string } | null = null

async function resolveMyUserId(headers: Record<string, string>, apiKey: string): Promise<string> {
  if (cachedUser && cachedUser.apiKey === apiKey) return cachedUser.userId

  const resp = await fetch('https://api.clickup.com/api/v2/user', {
    headers,
    signal: AbortSignal.timeout(10_000),
  })
  if (!resp.ok) throw new Error(`ClickUp user API HTTP ${resp.status}`)
  const data = await resp.json() as { user?: { id: number } }
  if (!data.user?.id) throw new Error('ClickUp: cannot resolve current user')

  const userId = String(data.user.id)
  cachedUser = { apiKey, userId }
  return userId
}

/** Get "today start" in Bali time (UTC+8), expressed as a UTC Date. */
function getBaliTodayStart(): Date {
  const BALI_OFFSET_MS = 8 * 60 * 60 * 1000
  const now = new Date()
  const baliNow = new Date(now.getTime() + BALI_OFFSET_MS)
  const baliMidnight = new Date(
    Date.UTC(baliNow.getUTCFullYear(), baliNow.getUTCMonth(), baliNow.getUTCDate()),
  )
  return new Date(baliMidnight.getTime() - BALI_OFFSET_MS)
}

/**
 * Fetch tasks assigned to Dariy: overdue + due today + due this week.
 * Returns tasks sorted: overdue first, then by due date ascending.
 */
export async function fetchMyTasks(): Promise<ClickUpTask[]> {
  const apiKey = process.env.CLICKUP_API_KEY
  const teamId = process.env.CLICKUP_TEAM_ID
  if (!apiKey || !teamId) {
    logger.warn('ClickUp not configured, skipping my-tasks')
    return []
  }

  const headers: Record<string, string> = { Authorization: apiKey }
  const userId = await resolveMyUserId(headers, apiKey)

  const todayStart = getBaliTodayStart()
  const weekEnd = new Date(todayStart.getTime() + 7 * 86400_000)

  // Fetch tasks assigned to me with due dates up to 7 days out (includes overdue)
  // ClickUp API v2 uses assignees[]=id format (array-style query param)
  const params = new URLSearchParams({
    'assignees[]': userId,
    include_closed: 'false',
    subtasks: 'true',
    due_date_lt: String(weekEnd.getTime()),
    order_by: 'due_date',
    page: '0',
  })

  const resp = await fetch(
    `https://api.clickup.com/api/v2/team/${teamId}/task?${params}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  )
  if (!resp.ok) throw new Error(`ClickUp tasks HTTP ${resp.status}`)
  const data = await resp.json() as { tasks?: Array<Record<string, unknown>> }

  const tasks: ClickUpTask[] = (data.tasks ?? []).map((t) => {
    const dueMs = t.due_date ? parseInt(t.due_date as string) : 0
    const dueDate = dueMs ? new Date(dueMs) : null
    const listInfo = t.list as { name?: string } | undefined

    return {
      subject: (t.name as string) ?? '',
      status: (t.status as { status?: string })?.status ?? '',
      due_date: dueDate ? formatDateShort(dueDate) : '',
      list: listInfo?.name ?? '',
      url: (t.url as string) ?? '',
      is_overdue: dueDate ? dueDate < todayStart : false,
    }
  })

  // Sort: overdue first, then by due_date ascending
  tasks.sort((a, b) => {
    if (a.is_overdue && !b.is_overdue) return -1
    if (!a.is_overdue && b.is_overdue) return 1
    return a.due_date.localeCompare(b.due_date)
  })

  return tasks
}
