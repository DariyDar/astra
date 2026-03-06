import { log, jsonOrThrow } from './utils.js'

// ── Types ──

interface AuditViolation {
  task: string
  status: string
  issues: string[]
}

interface AuditResult {
  list: string
  total_tasks: number
  tasks_with_issues: number
  issue_summary: Record<string, number>
  violations: AuditViolation[]
}

// ── Required fields from wiki ("Как заводить задачи") ──

const REQUIRED_FIELDS = [
  { key: 'assignee', check: (t: Record<string, unknown>) => !!((t.assignees as unknown[]) ?? []).length },
  { key: 'parent', check: (t: Record<string, unknown>) => !!t.parent },
  { key: 'due_date', check: (t: Record<string, unknown>) => !!t.due_date },
] as const

/** Custom fields that should have a value set. */
const REQUIRED_CUSTOM_FIELDS = ['Project', 'Milestone']

// ── Tool schema ──

export const auditTasksTool = {
  name: 'audit_tasks',
  description: `Audit ClickUp tasks against wiki rules. Checks: assignee, parent (epic/feature), due date, and custom fields (Project, Milestone). Returns only violations — tasks missing required fields. Use for verifying task quality.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      list_name: {
        type: 'string' as const,
        description: 'ClickUp list/project name to audit (fuzzy matched). Required.',
      },
      include_closed: {
        type: 'boolean' as const,
        description: 'Include closed/completed tasks (default: true)',
      },
    },
    required: ['list_name'],
  },
}

// ── List resolution (reuse logic from clickup.ts) ──

interface ClickUpList {
  id: string
  name: string
}

async function findList(headers: Record<string, string>, teamId: string, name: string): Promise<ClickUpList | null> {
  const term = name.toLowerCase()
  const spacesResp = await fetch(
    `https://api.clickup.com/api/v2/team/${teamId}/space?archived=false`,
    { headers, signal: AbortSignal.timeout(15_000) },
  )
  const spacesData = await jsonOrThrow<{ spaces?: Array<{ id: string; name: string }> }>(spacesResp, 'spaces')

  for (const space of spacesData.spaces ?? []) {
    // Folderless lists
    const listsResp = await fetch(
      `https://api.clickup.com/api/v2/space/${space.id}/list?archived=false`,
      { headers, signal: AbortSignal.timeout(15_000) },
    )
    const listsData = await jsonOrThrow<{ lists?: Array<{ id: string; name: string }> }>(listsResp, 'lists')
    for (const list of listsData.lists ?? []) {
      if (list.name.toLowerCase().includes(term)) return list
    }
    // Folder lists
    const foldersResp = await fetch(
      `https://api.clickup.com/api/v2/space/${space.id}/folder?archived=false`,
      { headers, signal: AbortSignal.timeout(15_000) },
    )
    const foldersData = await jsonOrThrow<{ folders?: Array<{ id: string; name: string; lists?: Array<{ id: string; name: string }> }> }>(foldersResp, 'folders')
    for (const folder of foldersData.folders ?? []) {
      for (const list of folder.lists ?? []) {
        if (list.name.toLowerCase().includes(term)) return list
      }
    }
    // Space name match — return first list in space
    if (space.name.toLowerCase().includes(term)) {
      const firstList = listsData.lists?.[0]
      if (firstList) return firstList
    }
  }
  return null
}

// ── Audit execution ──

export async function executeAuditTasks(listName: string, includeClosed: boolean): Promise<AuditResult> {
  const apiKey = process.env.CLICKUP_API_KEY
  const teamId = process.env.CLICKUP_TEAM_ID
  if (!apiKey || !teamId) throw new Error('ClickUp not configured')

  const headers = { Authorization: apiKey }

  const list = await findList(headers, teamId, listName)
  if (!list) throw new Error(`No ClickUp list found matching "${listName}"`)

  log(`audit: found list "${list.name}" (${list.id})`)

  // Fetch all tasks (ClickUp API returns max 100 per page)
  const params = new URLSearchParams({
    include_closed: includeClosed ? 'true' : 'false',
    subtasks: 'true',
  })
  const resp = await fetch(
    `https://api.clickup.com/api/v2/list/${list.id}/task?${params}`,
    { headers, signal: AbortSignal.timeout(30_000) },
  )
  const data = await jsonOrThrow<{ tasks?: Array<Record<string, unknown>> }>(resp, 'tasks')
  const tasks = data.tasks ?? []

  // Audit each task
  const issueCounts: Record<string, number> = {}
  const violations: AuditViolation[] = []

  for (const t of tasks) {
    const issues: string[] = []

    // Check standard fields
    for (const field of REQUIRED_FIELDS) {
      if (!field.check(t)) {
        issues.push(`no_${field.key}`)
      }
    }

    // Check custom fields
    const customFields = (t.custom_fields as Array<{ name: string; value: unknown }>) ?? []
    for (const cfName of REQUIRED_CUSTOM_FIELDS) {
      const cf = customFields.find(c => c.name === cfName)
      if (!cf || cf.value == null) {
        issues.push(`no_cf_${cfName.toLowerCase()}`)
      }
    }

    if (issues.length > 0) {
      for (const issue of issues) {
        issueCounts[issue] = (issueCounts[issue] ?? 0) + 1
      }
      violations.push({
        task: (t.name as string) ?? '?',
        status: (t.status as { status?: string })?.status ?? '?',
        issues,
      })
    }
  }

  log(`audit: ${list.name} — ${tasks.length} tasks, ${violations.length} with issues`)

  return {
    list: list.name,
    total_tasks: tasks.length,
    tasks_with_issues: violations.length,
    issue_summary: issueCounts,
    violations,
  }
}
