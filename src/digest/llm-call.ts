/**
 * Single Sonnet call that turns the raw collected data into a structured
 * DigestResult JSON. No subagents, no orchestrator phase.
 */

import { logger } from '../logging/logger.js'
import { callClaude } from '../llm/client.js'
import type { CollectedDigestData } from './collect.js'
import type { DigestResult } from './schema.js'
import type { BriefingItem } from '../mcp/briefing/types.js'
import type { ClickUpTask } from './my-tasks.js'

const SYSTEM_PROMPT = `Ты — дневной дайджест-компилятор для CPO двух игровых студий: AstroCat (AC) и Highground (HG).

Твоя единственная задача: получить ВСЕ сырые данные за вчера и вернуть один JSON по схеме ниже. Никаких комментариев, объяснений, markdown — только валидный JSON.

ПРАВИЛА:
1. Каждый item = ОДИН факт. Не объединяй несвязанное в один item.
2. Тип item: slack | email | clickup | calendar | build | milestone | other.
3. Importance 1-5: 1 = тривиально, 3 = обычная новость, 4 = требует внимания, 5 = блокер/срочное/требует решения.
4. one_line: ≤ 120 символов, по-русски, без эмодзи. Должен быть понятен без контекста.
5. detail: 1-3 предложения, ТОЛЬКО для importance ≥ 4 или когда без контекста смысл теряется. По-русски.
6. Привяжи каждый item к проекту по упоминанию названий/алиасов в данных. Если не привязывается — clientы general_updates.
7. Тихие проекты (без апдейтов) — в silent_projects по name, не в projects.
8. Status проекта: ok = всё штатно, attention = есть нерешённые вопросы/риски, blocked = блокеры/просрочки.
9. Группируй Slack-треды: один тред = один item (даже если 20 сообщений).
10. RSVP-ответы Calendar (Accepted:/Declined:) ИГНОРИРУЙ — они уже отфильтрованы.
11. Дублирование между источниками (та же новость в Slack и Email): один item, выбери лучший источник для link.
12. Не пиши items с importance 1, кроме случаев когда это часть series ("ДР Маши, Пети и Васи").
13. item_id формат: "<date>-<company>-<projectId>-<seq>" или "<date>-<company>-general-<seq>". date в формате YYYYMMDD, без дефисов. seq — 3-значный порядковый номер с 001.

ВЫХОДНОЙ ФОРМАТ (строгая JSON схема):

{
  "digest_date": "YYYY-MM-DD",
  "companies": {
    "astrocat": {
      "projects": [
        {
          "project_id": "spongebob-kco",
          "project_name": "SpongeBob KCO",
          "status": "ok" | "attention" | "blocked",
          "items": [
            {
              "item_id": "20260428-ac-spongebob-kco-001",
              "type": "slack",
              "importance": 4,
              "one_line": "Indium QA: Feature TP на LiveOps 5.11.0 (92.5%)",
              "detail": "Команда Manila продолжает регрессию. Ожидаемое завершение завтра.",
              "link": "https://...",
              "source_meta": {"channel": "#spongebob"}
            }
          ]
        }
      ],
      "silent_projects": ["Vector", "Idle Axe"],
      "general_updates": [
        {
          "item_id": "20260428-ac-general-001",
          "type": "absence",
          "importance": 2,
          "one_line": "Дима в отпуске 28 апр - 5 мая"
        }
      ]
    },
    "highground": { ... }
  },
  "meta": {
    "items_total": <число>,
    "sources": {"slack": 12, "email": 5, "clickup": 8, "calendar": 2, "build": 3}
  }
}

Возвращай ТОЛЬКО JSON, никакого текста до или после.`

function fmtSlack(channels: CollectedDigestData['slack']): string {
  if (channels.length === 0) return 'Нет сообщений.'
  const lines: string[] = []
  for (const ch of channels) {
    if (ch.messages.length === 0) continue
    const wsTag = ch.workspace ? ` [${ch.workspace.toUpperCase()}]` : ''
    lines.push(`\n#${ch.channelName}${wsTag} (${ch.messages.length} msgs):`)
    for (const m of ch.messages) {
      const thread = m.threadInfo ? ` [${m.threadInfo}]` : ''
      const link = m.link ? ` ${m.link}` : ''
      lines.push(`  ${m.author}: ${m.text}${thread}${link}`)
    }
  }
  return lines.join('\n')
}

function fmtGmail(items: BriefingItem[]): string {
  if (items.length === 0) return 'Нет писем.'
  const lines: string[] = []
  for (const e of items) {
    const from = e.author as string ?? ''
    const subj = e.subject as string ?? ''
    const prev = e.text_preview as string ?? ''
    const acct = e.account as string ?? ''
    const link = e.link as string ?? ''
    lines.push(`От: ${from} (${acct})`)
    lines.push(`Тема: ${subj}`)
    if (prev) lines.push(`Превью: ${prev}`)
    if (link) lines.push(`URL: ${link}`)
    lines.push('')
  }
  return lines.join('\n')
}

function fmtCalendar(items: BriefingItem[]): string {
  if (items.length === 0) return 'Нет событий.'
  const lines: string[] = []
  for (const ev of items) {
    const date = ev.date as string ?? ''
    const subj = ev.subject as string ?? ''
    const status = ev.status as string ?? ''
    const tag = status === 'cancelled' ? ' [CANCELLED]' : ''
    lines.push(`  ${date} — ${subj}${tag}`)
  }
  return lines.join('\n')
}

function fmtClickUp(items: BriefingItem[]): string {
  if (items.length === 0) return 'Нет активности.'
  const lines: string[] = []
  for (const t of items) {
    const list = t.list as string ?? ''
    const subj = t.subject as string ?? ''
    const status = t.status as string ?? ''
    const assignee = t.assignee as string ?? ''
    const link = t.link as string ?? ''
    lines.push(`  [${list}] ${subj} — ${status}${assignee ? ` (${assignee})` : ''}${link ? ` ${link}` : ''}`)
  }
  return lines.join('\n')
}

function fmtMyTasks(tasks: ClickUpTask[]): string {
  const upcoming = tasks.filter(t => !t.is_overdue)
  if (upcoming.length === 0) return ''
  const lines = ['МОИ ЗАДАЧИ (на этой неделе):']
  for (const t of upcoming) {
    const due = t.due_date ? ` (до ${t.due_date})` : ''
    lines.push(`  [${t.list}] ${t.subject} — ${t.status}${due} ${t.url}`)
  }
  return lines.join('\n')
}

function fmtMilestones(milestones: CollectedDigestData['milestones']): string {
  if (milestones.length === 0) return ''
  const lines = ['MILESTONES (Production Updates Tracker):']
  for (const m of milestones) {
    const dueIso = m.deadline.toISOString().slice(0, 10)
    const flag = m.isOverdue ? ' [ПРОСРОЧЕНО]' : m.daysUntil <= 7 ? ` [через ${m.daysUntil}д]` : ''
    lines.push(`  [${m.project}] ${m.name} — дедлайн ${dueIso}${flag}`)
  }
  return lines.join('\n')
}

function fmtProjectList(data: CollectedDigestData): string {
  const lines: string[] = ['ИЗВЕСТНЫЕ ПРОЕКТЫ (используй именно эти project_name):']
  lines.push(`AstroCat:`)
  for (const s of data.projectStatuses.astrocat) {
    lines.push(`  - ${s.project} (статус: ${s.status})`)
  }
  lines.push(`Highground:`)
  for (const s of data.projectStatuses.highground) {
    lines.push(`  - ${s.project} (статус: ${s.status})`)
  }
  return lines.join('\n')
}

function buildUserPrompt(data: CollectedDigestData): string {
  const sections: string[] = []
  sections.push(`Дата дайджеста: ${data.date} (период: ${data.periodLabel})`)
  sections.push('')
  sections.push(fmtProjectList(data))
  sections.push('')
  sections.push('=== SLACK ===')
  sections.push(fmtSlack(data.slack))
  sections.push('')
  sections.push('=== ПОЧТА ===')
  sections.push(fmtGmail(data.gmail))
  sections.push('')
  sections.push('=== КАЛЕНДАРЬ ===')
  sections.push(fmtCalendar(data.calendar))
  sections.push('')
  sections.push('=== CLICKUP ===')
  sections.push(fmtClickUp(data.clickup))
  const my = fmtMyTasks(data.myTasks)
  if (my) { sections.push(''); sections.push(my) }
  const ms = fmtMilestones(data.milestones)
  if (ms) { sections.push(''); sections.push(ms) }
  sections.push('')
  sections.push('Верни строго JSON по описанной выше схеме.')
  return sections.join('\n')
}

/**
 * Strip optional ```json fences and parse. Returns null on failure.
 * We try to be lenient because Claude CLI sometimes wraps JSON in code fences
 * despite the system prompt asking otherwise.
 */
function parseJsonResponse(raw: string): DigestResult | null {
  let text = raw.trim()
  // Strip code fences
  if (text.startsWith('```')) {
    const end = text.lastIndexOf('```')
    text = text.slice(text.indexOf('\n') + 1, end).trim()
  }
  // Trim everything before the first '{'
  const firstBrace = text.indexOf('{')
  if (firstBrace > 0) text = text.slice(firstBrace)
  try {
    return JSON.parse(text) as DigestResult
  } catch (error) {
    logger.error({ error: (error as Error).message, head: text.slice(0, 200) }, 'Digest LLM: JSON parse failed')
    return null
  }
}

/**
 * One Sonnet call. Returns parsed JSON or throws.
 * No fallback — if it fails, it fails. Caller handles retry at the scheduler level.
 */
export async function compileDigestJson(data: CollectedDigestData): Promise<DigestResult> {
  const userPrompt = buildUserPrompt(data)
  logger.info({ promptLen: userPrompt.length }, 'Digest LLM: sending single call')

  const response = await callClaude(userPrompt, {
    system: SYSTEM_PROMPT,
    timeoutMs: 240_000,
  })

  logger.info(
    {
      responseLen: response.text.length,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
      costUsd: response.usage?.costUsd,
    },
    'Digest LLM: response received',
  )

  const parsed = parseJsonResponse(response.text)
  if (!parsed) {
    throw new Error('Digest LLM returned non-parseable response')
  }

  // Sanity check
  if (!parsed.companies?.astrocat || !parsed.companies?.highground) {
    throw new Error('Digest LLM JSON missing required companies')
  }
  return parsed
}
