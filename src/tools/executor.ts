/**
 * Tool executor — runs a plan of tool calls in parallel, returns formatted text.
 * Claude produces a plan (JSON), executor runs tools, returns results for analysis.
 */

import { searchSlack, formatSlackResults, type SlackSearchOpts } from './slack-search.js'
import { lookupKB, formatKBResult, type KBLookupOpts } from './kb-lookup.js'
import { readDriveDoc, formatDriveResult, type DriveReadOpts } from './drive-read.js'
import { queryClickUp, formatClickUpResult, type ClickUpQueryOpts } from './clickup-query.js'
import { logger } from '../logging/logger.js'

export interface ToolCall {
  tool: 'searchSlack' | 'lookupKB' | 'readDriveDoc' | 'queryClickUp'
  opts: SlackSearchOpts | KBLookupOpts | DriveReadOpts | ClickUpQueryOpts
}

export interface ToolPlan {
  plan: ToolCall[]
}

export interface ExecutionResult {
  results: string   // formatted text for LLM
  toolsRun: number
  errors: number
}

/** Execute a plan of tool calls in parallel, return formatted results as text */
export async function executeToolPlan(plan: ToolPlan): Promise<ExecutionResult> {
  const startTime = Date.now()
  let errors = 0

  const results = await Promise.allSettled(
    plan.plan.map(async (call) => {
      switch (call.tool) {
        case 'searchSlack':
          return formatSlackResults(await searchSlack(call.opts as SlackSearchOpts))
        case 'lookupKB':
          return formatKBResult(await lookupKB(call.opts as KBLookupOpts))
        case 'readDriveDoc':
          return formatDriveResult(await readDriveDoc(call.opts as DriveReadOpts))
        case 'queryClickUp':
          return formatClickUpResult(await queryClickUp(call.opts as ClickUpQueryOpts))
        default:
          return `--- Unknown tool: ${(call as ToolCall).tool} ---`
      }
    }),
  )

  const textParts: string[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') {
      textParts.push(r.value)
    } else {
      errors++
      textParts.push(`--- Tool error: ${(r.reason as Error).message} ---`)
    }
  }

  const durationMs = Date.now() - startTime
  logger.info(
    { toolsRun: plan.plan.length, errors, durationMs },
    'Tool plan executed',
  )

  return {
    results: textParts.join('\n\n'),
    toolsRun: plan.plan.length,
    errors,
  }
}

/** Tool catalog description for Claude's planning turn */
export const TOOL_CATALOG = `Доступные инструменты сбора данных (вызываются скриптом, не тобой):

1. **searchSlack** — поиск сообщений в Slack каналах
   Параметры:
   - channels: string[] — имена каналов (без #)
   - keywords?: string[] — ключевые слова для фильтрации (если пусто — все сообщения)
   - period: "day" | "week" | "month" | "3months" | "6months" | "year"
   - includeThreads?: boolean — загружать ответы в тредах

2. **lookupKB** — поиск в базе знаний (проекты, люди, каналы, статусы)
   Параметры:
   - project?: string — имя проекта
   - person?: string — имя человека
   - section?: "team" | "channels" | "docs" | "status" | "all"

3. **readDriveDoc** — прочитать содержимое Google Doc/Sheet
   Параметры:
   - url?: string — ссылка на Google Doc/Sheet
   - fileId?: string — ID файла (альтернатива URL)

4. **queryClickUp** — получить задачи из ClickUp
   Параметры:
   - project?: string — имя проекта (резолвится в list через vault)
   - listId?: string — ID списка (альтернатива)
   - status?: string[] — фильтр по статусам
   - includeCompleted?: boolean — включать закрытые

Ответь JSON в формате:
{"plan": [{"tool": "searchSlack", "opts": {...}}, {"tool": "lookupKB", "opts": {...}}]}

Правила:
- Используй project Quick Reference из Knowledge Map для определения каналов
- Если пользователь говорит "давно" → period="6months", "недавно" → period="week"
- Для конкретного проекта: всегда lookupKB(project=X) + searchSlack(channels=каналы_из_vault)
- Максимум 5 вызовов в одном плане
`
