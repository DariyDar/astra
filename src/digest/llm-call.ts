/**
 * Per-company Sonnet calls. Two parallel LLM invocations (AC and HG), each
 * receiving only its own data, returning a per-company JSON. Results are
 * merged into a single DigestResult by the caller.
 *
 * Why two calls instead of one: a single 28K-token prompt asking for the
 * full bilateral JSON consistently times out at 240–600s. Splitting per
 * company keeps each prompt at ~10–15K tokens which finishes in ~3 min.
 */

import { logger } from '../logging/logger.js'
import { callClaude } from '../llm/client.js'
import type { CollectedDigestData } from './collect.js'
import type { DigestResult, DigestCompany } from './schema.js'
import type { BriefingItem } from '../mcp/briefing/types.js'
import type { ClickUpTask } from './my-tasks.js'
import { filterItemsForCompany, filterGmailByAccount } from './compiler.js'
import type { DigestSlackChannel } from './sources/slack.js'

const SYSTEM_PROMPT = `Ты — дневной дайджест-компилятор для CPO одной игровой студии.

Твоя единственная задача: получить ВСЕ сырые данные за вчера и вернуть один JSON по схеме ниже. Никаких комментариев, объяснений, markdown — только валидный JSON.

ПРАВИЛА:
1. Каждый item = ОДИН факт. Не объединяй несвязанное в один item.
2. Тип item: slack | email | clickup | calendar | build | milestone | other.
3. Importance 1-5: 1 = тривиально, 3 = обычная новость, 4 = требует внимания, 5 = блокер/срочное/требует решения.
4. one_line: ≤ 120 символов, по-русски, без эмодзи. Должен быть понятен без контекста.
5. detail: 1-3 предложения, ТОЛЬКО для importance ≥ 4 или когда без контекста смысл теряется. По-русски.
6. Привяжи каждый item к проекту по упоминанию названий/алиасов в данных. Если не привязывается — в general_updates.
7. Тихие проекты (без апдейтов) — в silent_projects по name, не в projects.
8. Status проекта: ok = всё штатно, attention = есть нерешённые вопросы/риски, blocked = блокеры/просрочки.
9. Группируй Slack-треды: один тред = один item (даже если 20 сообщений).
10. RSVP-ответы Calendar (Accepted:/Declined:) ИГНОРИРУЙ — они уже отфильтрованы.
11. Дублирование между источниками (та же новость в Slack и Email): один item, выбери лучший источник для link.
12. Не пиши items с importance 1, кроме случаев когда это часть series ("ДР Маши, Пети и Васи").
13. item_id формат: "<date>-<companyCode>-<projectId>-<seq>" или "<date>-<companyCode>-general-<seq>". date в формате YYYYMMDD без дефисов. seq — 3-значный с 001. companyCode = "ac" или "hg".

ВЫХОДНОЙ ФОРМАТ (строгая JSON схема для ОДНОЙ компании):

{
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
}

Возвращай ТОЛЬКО JSON, никакого текста до или после.`

function fmtSlack(channels: DigestSlackChannel[]): string {
  if (channels.length === 0) return 'Нет сообщений.'
  const lines: string[] = []
  for (const ch of channels) {
    if (ch.messages.length === 0) continue
    lines.push(`\n#${ch.channelName} (${ch.messages.length} msgs):`)
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

function fmtMilestones(milestones: CollectedDigestData['milestones'], companyCode: 'ac' | 'hg'): string {
  if (milestones.length === 0) return ''
  // Production milestones currently come from a single sheet covering all
  // company projects — we pass them all and let the LLM filter by project.
  // (Filtering here would require yet another company-aware mapping.)
  const lines = ['MILESTONES (Production Updates Tracker):']
  for (const m of milestones) {
    const dueIso = m.deadline.toISOString().slice(0, 10)
    const flag = m.isOverdue ? ' [ПРОСРОЧЕНО]' : m.daysUntil <= 7 ? ` [через ${m.daysUntil}д]` : ''
    lines.push(`  [${m.project}] ${m.name} — дедлайн ${dueIso}${flag}`)
  }
  return lines.join('\n')
}

function fmtProjectList(
  projects: CollectedDigestData['projectStatuses']['astrocat'],
  companyName: string,
): string {
  if (projects.length === 0) return ''
  const lines = [`ИЗВЕСТНЫЕ ПРОЕКТЫ ${companyName} (используй именно эти project_name):`]
  for (const s of projects) {
    lines.push(`  - ${s.project} (${s.status})`)
  }
  return lines.join('\n')
}

function buildCompanyPrompt(
  companyCode: 'ac' | 'hg',
  companyName: string,
  data: CollectedDigestData,
): string {
  // Filter Slack to this workspace
  const slack = data.slack.filter(ch => ch.workspace === companyCode)

  // Filter project lists from project map
  const ourProjects = data.projectMap.get(companyCode === 'ac' ? 'astrocat' : 'highground') ?? []
  const otherProjects = data.projectMap.get(companyCode === 'ac' ? 'highground' : 'astrocat') ?? []

  // Filter Gmail by account/project hints
  const gmail = filterGmailByAccount(data.gmail, companyCode, ourProjects, otherProjects)

  // Filter Calendar/ClickUp by project mentions
  const cal = filterItemsForCompany(data.calendar, ourProjects, otherProjects)
  const cu = filterItemsForCompany(data.clickup, ourProjects, otherProjects)

  // Calendar shared events go to AC by default (Дарий primarily AC)
  const calendar = companyCode === 'ac' ? [...cal.matched, ...cal.shared] : cal.matched
  const clickup = cu.matched

  // My tasks: filter by list name if it mentions a project
  const myTasks = data.myTasks.filter(t => {
    const text = `${t.list} ${t.subject}`.toLowerCase()
    return ourProjects.some(p => p.searchTerms.some(term =>
      term.length <= 3 ? new RegExp(`\\b${term}\\b`, 'i').test(text) : text.includes(term),
    ))
  })

  const projects = companyCode === 'ac' ? data.projectStatuses.astrocat : data.projectStatuses.highground

  const sections: string[] = []
  sections.push(`Компания: ${companyName}`)
  sections.push(`Дата дайджеста: ${data.date} (период: ${data.periodLabel})`)
  sections.push('')
  sections.push(fmtProjectList(projects, companyName))
  sections.push('')
  sections.push('=== SLACK ===')
  sections.push(fmtSlack(slack))
  sections.push('')
  sections.push('=== ПОЧТА ===')
  sections.push(fmtGmail(gmail))
  sections.push('')
  sections.push('=== КАЛЕНДАРЬ ===')
  sections.push(fmtCalendar(calendar))
  sections.push('')
  sections.push('=== CLICKUP ===')
  sections.push(fmtClickUp(clickup))
  const my = fmtMyTasks(myTasks)
  if (my) { sections.push(''); sections.push(my) }
  const ms = fmtMilestones(data.milestones, companyCode)
  if (ms) { sections.push(''); sections.push(ms) }
  sections.push('')
  sections.push('Верни строго JSON по описанной выше схеме.')
  return sections.join('\n')
}

function parseJsonResponse(raw: string): DigestCompany | null {
  let text = raw.trim()
  if (text.startsWith('```')) {
    const end = text.lastIndexOf('```')
    text = text.slice(text.indexOf('\n') + 1, end).trim()
  }
  const firstBrace = text.indexOf('{')
  if (firstBrace > 0) text = text.slice(firstBrace)
  try {
    return JSON.parse(text) as DigestCompany
  } catch (error) {
    logger.error({ error: (error as Error).message, head: text.slice(0, 200) }, 'Digest LLM: JSON parse failed')
    return null
  }
}

async function compileCompanyJson(
  companyCode: 'ac' | 'hg',
  companyName: string,
  data: CollectedDigestData,
): Promise<DigestCompany> {
  const userPrompt = buildCompanyPrompt(companyCode, companyName, data)
  logger.info({ company: companyCode, promptLen: userPrompt.length }, 'Digest LLM: sending company call')

  const response = await callClaude(userPrompt, {
    system: SYSTEM_PROMPT,
    timeoutMs: 600_000,
    model: 'opus',
  })

  logger.info(
    {
      company: companyCode,
      responseLen: response.text.length,
      outputTokens: response.usage?.outputTokens,
      costUsd: response.usage?.costUsd,
    },
    'Digest LLM: company response received',
  )

  const parsed = parseJsonResponse(response.text)
  if (!parsed) throw new Error(`Digest LLM (${companyCode}) returned non-parseable response`)
  if (!Array.isArray(parsed.projects) || !Array.isArray(parsed.silent_projects)) {
    throw new Error(`Digest LLM (${companyCode}) JSON missing required fields`)
  }
  return parsed
}

/**
 * Two parallel Sonnet calls (AC + HG), merged into a DigestResult.
 */
export async function compileDigestJson(data: CollectedDigestData): Promise<DigestResult> {
  const [ac, hg] = await Promise.all([
    compileCompanyJson('ac', 'AstroCat', data),
    compileCompanyJson('hg', 'Highground', data),
  ])

  // Build meta from both companies
  const sources: Partial<Record<string, number>> = {}
  let total = 0
  for (const company of [ac, hg]) {
    for (const p of company.projects) {
      for (const it of p.items) {
        sources[it.type] = (sources[it.type] ?? 0) + 1
        total++
      }
    }
    for (const g of company.general_updates) {
      sources[g.type] = (sources[g.type] ?? 0) + 1
      total++
    }
  }

  return {
    digest_date: data.date,
    companies: { astrocat: ac, highground: hg },
    meta: {
      items_total: total,
      sources: sources as DigestResult['meta']['sources'],
    },
  }
}
