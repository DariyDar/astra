import { jsonOrThrow } from '../../mcp/briefing/utils.js'
import { formatClickUpTask, splitText } from '../chunker.js'
import type { KBChunkInput } from '../types.js'
import type { SourceAdapter, RawItem } from './types.js'
import { logger } from '../../logging/logger.js'

const CLICKUP_BASE = 'https://api.clickup.com/api/v2'
const INITIAL_LOOKBACK_DAYS = 90
const TASKS_PER_PAGE = 100

interface ClickUpTaskRaw {
  id: string
  name: string
  description?: string
  status?: { status: string }
  assignees?: Array<{ username: string }>
  date_updated?: string
  due_date?: string | null
  list?: { name: string }
  url?: string
}

export function createClickUpAdapter(): SourceAdapter | null {
  const apiKey = process.env.CLICKUP_API_KEY
  const teamId = process.env.CLICKUP_TEAM_ID
  if (!apiKey || !teamId) return null

  return {
    name: 'clickup',
    source: 'clickup' as const,

    async fetchSince(watermark: string): Promise<{ items: RawItem[]; nextWatermark: string }> {
      const headers = { Authorization: apiKey, 'Content-Type': 'application/json' }

      const since = watermark
        ? Number(watermark)
        : Date.now() - INITIAL_LOOKBACK_DAYS * 86400_000

      const items: RawItem[] = []
      let page = 0
      let maxUpdated = String(since)

      // Fetch tasks updated since watermark
      while (true) {
        const params = new URLSearchParams({
          page: String(page),
          order_by: 'updated',
          date_updated_gt: String(since),
          subtasks: 'true',
          include_closed: 'true',
        })

        const resp = await fetch(
          `${CLICKUP_BASE}/team/${teamId}/task?${params}`,
          { headers, signal: AbortSignal.timeout(30_000) },
        )
        const data = await jsonOrThrow<{ tasks: ClickUpTaskRaw[]; last_page?: boolean }>(resp, 'ClickUp tasks')

        for (const task of data.tasks) {
          const updatedAt = task.date_updated ?? String(Date.now())

          items.push({
            id: task.id,
            text: task.description ?? '',
            metadata: {
              name: task.name,
              status: task.status?.status ?? 'unknown',
              assignees: (task.assignees ?? []).map((a) => a.username),
              list: task.list?.name ?? '',
              url: task.url ?? '',
              dueDate: task.due_date ?? null,
            },
            date: new Date(Number(updatedAt)),
          })

          if (updatedAt > maxUpdated) maxUpdated = updatedAt
        }

        if (data.last_page || data.tasks.length < TASKS_PER_PAGE) break
        page++
      }

      logger.info({ tasks: items.length }, 'ClickUp ingestion complete')
      return { items, nextWatermark: maxUpdated }
    },

    toChunks(item: RawItem): KBChunkInput[] {
      const text = formatClickUpTask({
        name: item.metadata.name as string,
        description: item.text || undefined,
        status: item.metadata.status as string,
        assignees: item.metadata.assignees as string[],
        list: item.metadata.list as string,
      })

      if (text.trim().length === 0) return []

      const chunks = splitText(text)
      return chunks.map((chunkText, i) => ({
        source: 'clickup' as const,
        sourceId: item.id,
        chunkIndex: i,
        text: chunkText,
        chunkType: 'task' as const,
        metadata: item.metadata,
        sourceDate: item.date,
      }))
    },
  }
}
