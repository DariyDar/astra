/**
 * ClickUp query tool — fetches task data without LLM.
 */

import { env } from '../config/env.js'
import { getAllProjects, loadProjectCard } from '../kb/vault-reader.js'
import { logger } from '../logging/logger.js'
import { getCached, setCache, TTL } from './cache.js'

export interface ClickUpQueryOpts {
  project?: string
  listId?: string
  status?: string[]
  assignee?: string
  includeCompleted?: boolean
}

export interface ClickUpTask {
  id: string
  name: string
  status: string
  assignees: string[]
  dueDate: string | null
  priority: string | null
  url: string
}

export interface ClickUpResult {
  tasks: ClickUpTask[]
  listName: string
  totalFound: number
}

async function ckGet(path: string): Promise<unknown> {
  if (!env.CLICKUP_API_KEY) throw new Error('CLICKUP_API_KEY not configured')
  const r = await fetch(`https://api.clickup.com/api/v2${path}`, {
    headers: { Authorization: env.CLICKUP_API_KEY },
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) throw new Error(`ClickUp ${r.status}`)
  return r.json()
}

/** Resolve project name to ClickUp list IDs via vault */
function resolveListIds(projectName: string): string[] {
  const projects = getAllProjects()
  const match = projects.find(p =>
    p.name.toLowerCase().includes(projectName.toLowerCase()) ||
    (p.aliases || []).some((a: string) => a.toLowerCase().includes(projectName.toLowerCase())),
  )
  if (!match) return []

  const card = loadProjectCard(match.name)
  if (!card?.clickup_lists?.length) return []

  return card.clickup_lists.map(l => l.list)
}

export async function queryClickUp(opts: ClickUpQueryOpts): Promise<ClickUpResult> {
  const cached = getCached<ClickUpResult>('clickup-query', opts)
  if (cached) return cached

  let listIds: string[] = []
  if (opts.listId) {
    listIds = [opts.listId]
  } else if (opts.project) {
    listIds = resolveListIds(opts.project)
  }

  if (listIds.length === 0) {
    return { tasks: [], listName: opts.project || 'unknown', totalFound: 0 }
  }

  const allTasks: ClickUpTask[] = []
  let listName = ''

  for (const listId of listIds) {
    try {
      const params = new URLSearchParams({
        include_closed: opts.includeCompleted ? 'true' : 'false',
        subtasks: 'true',
      })
      if (opts.status?.length) {
        for (const s of opts.status) params.append('statuses[]', s)
      }
      if (opts.assignee) params.set('assignees[]', opts.assignee)

      const data = await ckGet(`/list/${listId}/task?${params}`) as {
        tasks?: Array<{
          id: string; name: string; status?: { status: string }
          assignees?: Array<{ username: string }>
          due_date?: string; priority?: { priority: string }
          url?: string
        }>
      }

      if (!listName) {
        const listData = await ckGet(`/list/${listId}`) as { name: string }
        listName = listData.name
      }

      for (const t of data.tasks || []) {
        allTasks.push({
          id: t.id,
          name: t.name,
          status: t.status?.status || 'unknown',
          assignees: (t.assignees || []).map(a => a.username),
          dueDate: t.due_date ? new Date(parseInt(t.due_date)).toISOString().slice(0, 10) : null,
          priority: t.priority?.priority || null,
          url: t.url || `https://app.clickup.com/t/${t.id}`,
        })
      }
    } catch (error) {
      logger.warn({ listId, error }, 'clickup-query: failed')
    }
  }

  const result: ClickUpResult = {
    tasks: allTasks,
    listName: listName || opts.project || 'unknown',
    totalFound: allTasks.length,
  }

  setCache('clickup-query', opts, result, TTL.clickup)
  return result
}

/** Format as text for LLM */
export function formatClickUpResult(result: ClickUpResult): string {
  if (result.tasks.length === 0) return `--- ClickUp (${result.listName}): 0 задач ---`

  const lines = [`--- ClickUp: ${result.listName} (${result.totalFound} задач) ---`, '']
  for (const t of result.tasks) {
    const assignees = t.assignees.length ? t.assignees.join(', ') : 'no assignee'
    const due = t.dueDate ? ` | due ${t.dueDate}` : ''
    lines.push(`- [${t.status}] ${t.name} (${assignees}${due})`)
  }
  return lines.join('\n')
}
