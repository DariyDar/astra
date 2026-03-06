import type { Source, BriefingRequest, BriefingItem } from './types.js'
import { log, truncate, jsonOrThrow } from './utils.js'

// ── ClickUp list resolution ──

interface ClickUpList {
  id: string
  name: string
  folderName?: string
  spaceName?: string
}

/** Cached ClickUp lists. Refreshed at most once per 10 minutes. */
let clickUpListCache: ClickUpList[] = []
let clickUpListCacheTs = 0
const CLICKUP_CACHE_TTL_MS = 10 * 60_000

async function resolveClickUpLists(headers: Record<string, string>, teamId: string): Promise<ClickUpList[]> {
  if (Date.now() - clickUpListCacheTs < CLICKUP_CACHE_TTL_MS && clickUpListCache.length > 0) {
    return clickUpListCache
  }

  const lists: ClickUpList[] = []

  // Get all spaces
  const spacesResp = await fetch(
    `https://api.clickup.com/api/v2/team/${teamId}/space?archived=false`,
    { headers, signal: AbortSignal.timeout(15_000) },
  )
  const spacesData = await jsonOrThrow<{ spaces?: Array<{ id: string; name: string }> }>(spacesResp, 'ClickUp spaces')

  // For each space, get folders and folderless lists in parallel
  const spaceResults = await Promise.allSettled(
    (spacesData.spaces ?? []).map(async (space) => {
      const [foldersResp, listsResp] = await Promise.all([
        fetch(`https://api.clickup.com/api/v2/space/${space.id}/folder?archived=false`, { headers, signal: AbortSignal.timeout(15_000) }),
        fetch(`https://api.clickup.com/api/v2/space/${space.id}/list?archived=false`, { headers, signal: AbortSignal.timeout(15_000) }),
      ])

      const foldersData = await jsonOrThrow<{ folders?: Array<{ id: string; name: string; lists?: Array<{ id: string; name: string }> }> }>(foldersResp, `ClickUp folders (${space.name})`)
      const listsData = await jsonOrThrow<{ lists?: Array<{ id: string; name: string }> }>(listsResp, `ClickUp lists (${space.name})`)

      const spaceLists: ClickUpList[] = []

      // Folderless lists
      for (const list of listsData.lists ?? []) {
        spaceLists.push({ id: list.id, name: list.name, spaceName: space.name })
      }

      // Lists inside folders
      for (const folder of foldersData.folders ?? []) {
        for (const list of folder.lists ?? []) {
          spaceLists.push({ id: list.id, name: list.name, folderName: folder.name, spaceName: space.name })
        }
      }

      return spaceLists
    }),
  )

  for (const r of spaceResults) {
    if (r.status === 'fulfilled') lists.push(...r.value)
  }

  clickUpListCache = lists
  clickUpListCacheTs = Date.now()
  log(`ClickUp list cache refreshed: ${lists.length} lists`)
  return lists
}

/** Fuzzy-match list names: case-insensitive substring match against list name, folder name, or space name. */
function matchClickUpLists(allLists: ClickUpList[], names: string[]): ClickUpList[] {
  const matched: ClickUpList[] = []
  for (const name of names) {
    const term = name.toLowerCase()
    for (const list of allLists) {
      if (matched.some(m => m.id === list.id)) continue
      if (
        list.name.toLowerCase().includes(term) ||
        (list.folderName?.toLowerCase().includes(term) ?? false) ||
        (list.spaceName?.toLowerCase().includes(term) ?? false)
      ) {
        matched.push(list)
      }
    }
  }
  return matched
}

// ── Briefing fetcher ──

export async function fetchClickUp(
  req: BriefingRequest,
  period: { after: Date; before: Date },
): Promise<BriefingItem[]> {
  const apiKey = process.env.CLICKUP_API_KEY
  const teamId = process.env.CLICKUP_TEAM_ID
  if (!apiKey || !teamId) throw new Error('ClickUp not configured')

  const headers = { Authorization: apiKey }
  const limit = req.limit_per_source ?? 10
  // When querying specific lists, return all tasks (up to API max of 100)
  const listLimit = req.limit_per_source ?? 100
  const includeClosed = req.include_closed ? 'true' : 'false'

  // If specific lists requested, resolve them and query per-list
  if (req.clickup_list_names && req.clickup_list_names.length > 0) {
    const allLists = await resolveClickUpLists(headers, teamId)
    const matched = matchClickUpLists(allLists, req.clickup_list_names)
    if (matched.length === 0) {
      log(`ClickUp: no lists matched for ${JSON.stringify(req.clickup_list_names)}. Available: ${allLists.map(l => l.name).join(', ')}`)
      throw new Error(`No ClickUp lists found matching: ${req.clickup_list_names.join(', ')}. Available lists: ${allLists.slice(0, 20).map(l => l.name).join(', ')}`)
    }

    log(`ClickUp: matched lists: ${matched.map(l => `${l.name} (${l.id})`).join(', ')}`)

    // Fetch tasks from each matched list in parallel
    const listResults = await Promise.allSettled(
      matched.map(async (list) => {
        const params = new URLSearchParams({
          include_closed: includeClosed,
          subtasks: 'true',
        })
        const resp = await fetch(
          `https://api.clickup.com/api/v2/list/${list.id}/task?${params}`,
          { headers, signal: AbortSignal.timeout(15_000) },
        )
        const data = await jsonOrThrow<{ tasks?: Array<Record<string, unknown>> }>(resp, `ClickUp list ${list.name}`)
        return (data.tasks ?? []).map(t => ({ ...mapClickUpTask(t), list: list.name }))
      }),
    )

    let items: BriefingItem[] = []
    for (const r of listResults) {
      if (r.status === 'fulfilled') items.push(...r.value)
    }

    // Apply search_term filter if also provided
    if (req.search_term) {
      const term = req.search_term.toLowerCase()
      items = items.filter(t =>
        ((t.subject as string) ?? '').toLowerCase().includes(term) ||
        ((t.text_preview as string) ?? '').toLowerCase().includes(term),
      )
    }

    const result = items.slice(0, listLimit)
    await resolveParentNames(result, headers)
    return result
  }

  // Search by term across entire workspace
  if (req.search_term) {
    const resp = await fetch(
      `https://api.clickup.com/api/v2/team/${teamId}/task?${new URLSearchParams({
        include_closed: includeClosed,
        subtasks: 'true',
        page: '0',
      })}`,
      { headers, signal: AbortSignal.timeout(15_000) },
    )
    const data = await jsonOrThrow<{ tasks?: Array<Record<string, unknown>> }>(resp, 'ClickUp search')

    const term = req.search_term.toLowerCase()
    const filtered = (data.tasks ?? []).filter(t =>
      ((t.name as string) ?? '').toLowerCase().includes(term) ||
      ((t.description as string) ?? '').toLowerCase().includes(term),
    )

    const searchResult = filtered.slice(0, limit).map(mapClickUpTask)
    await resolveParentNames(searchResult, headers)
    return searchResult
  }

  // For "recent" / "digest" — fetch tasks with due dates in period
  const resp = await fetch(
    `https://api.clickup.com/api/v2/team/${teamId}/task?${new URLSearchParams({
      include_closed: includeClosed,
      subtasks: 'true',
      due_date_gt: String(period.after.getTime()),
      due_date_lt: String(period.before.getTime()),
      page: '0',
    })}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  )
  const data = await jsonOrThrow<{ tasks?: Array<Record<string, unknown>> }>(resp, 'ClickUp tasks')

  const digestResult = (data.tasks ?? []).slice(0, limit).map(mapClickUpTask)
  await resolveParentNames(digestResult, headers)
  return digestResult
}

// ── Parent task name resolution ──

/** Cached parent task names. Avoids re-fetching the same parent across requests. */
const parentNameCache = new Map<string, string>()

/**
 * Resolve parent task IDs to human-readable names via bulk fetch.
 * Mutates items in-place, replacing `parent` ID with parent task name.
 */
async function resolveParentNames(items: BriefingItem[], headers: Record<string, string>): Promise<void> {
  const parentIds = new Set<string>()
  for (const item of items) {
    const pid = item.parent as string
    if (pid && !parentNameCache.has(pid)) parentIds.add(pid)
  }

  if (parentIds.size > 0) {
    const results = await Promise.allSettled(
      [...parentIds].map(async (id) => {
        const resp = await fetch(`https://api.clickup.com/api/v2/task/${id}`, {
          headers,
          signal: AbortSignal.timeout(10_000),
        })
        const data = await jsonOrThrow<{ name?: string }>(resp, `ClickUp task ${id}`)
        return { id, name: data.name ?? '' }
      }),
    )
    for (const r of results) {
      if (r.status === 'fulfilled') parentNameCache.set(r.value.id, r.value.name)
    }
  }

  for (const item of items) {
    const pid = item.parent as string
    if (pid) {
      item.parent = parentNameCache.get(pid) ?? ''
    }
  }
}

// ── Helpers ──

function mapClickUpTask(t: Record<string, unknown>): BriefingItem {
  const listInfo = t.list as { name?: string } | undefined
  const parentId = t.parent as string | null | undefined
  const assignees = ((t.assignees as Array<{ username?: string }>) ?? []).map(a => a.username).filter(Boolean).join(', ')
  const dueDate = t.due_date ? new Date(parseInt(t.due_date as string)).toISOString() : ''
  const desc = truncate((t.description as string) ?? '', 80)

  // Extract custom fields: resolve dropdown orderindex → option name
  const customFields = resolveCustomFields(
    t.custom_fields as Array<{ name: string; type: string; value: unknown; type_config?: { options?: Array<{ name: string; orderindex: number }> } }> | undefined,
  )

  // Only include non-empty fields to keep payload compact
  const item: BriefingItem = {
    source: 'clickup' as Source,
    subject: (t.name as string) ?? '',
    status: (t.status as { status?: string })?.status ?? '',
  }
  if (assignees) item.assignee = assignees
  if (dueDate) item.due_date = dueDate
  if (desc) item.text_preview = desc
  if (listInfo?.name) item.list = listInfo.name
  if (parentId) item.parent = parentId
  for (const [k, v] of Object.entries(customFields)) {
    if (v) item[k] = v
  }
  return item
}

interface RawCustomField {
  name: string
  type: string
  value: unknown
  type_config?: { options?: Array<{ name: string; orderindex: number }> }
}

/** Extract non-empty custom fields, resolving dropdown indices to names. */
function resolveCustomFields(fields: RawCustomField[] | undefined): Record<string, string> {
  if (!fields) return {}
  const result: Record<string, string> = {}

  for (const cf of fields) {
    if (cf.value == null) continue

    const key = `cf_${cf.name.toLowerCase().replace(/\s+/g, '_')}`

    if (cf.type === 'drop_down' && typeof cf.value === 'number') {
      const opts = cf.type_config?.options ?? []
      const match = opts.find(o => o.orderindex === cf.value)
      if (match) result[key] = match.name
    } else if (cf.type === 'date' && typeof cf.value === 'string') {
      result[key] = new Date(parseInt(cf.value)).toISOString()
    } else if (cf.type === 'users') {
      const users = cf.value as Array<{ username?: string }>
      if (Array.isArray(users)) result[key] = users.map(u => u.username ?? '').filter(Boolean).join(', ')
    } else if (typeof cf.value === 'string') {
      result[key] = cf.value
    }
  }

  return result
}
