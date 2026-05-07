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
6. Привязка item к проекту:
   - Если канал Slack ОТНОСИТСЯ К ОДНОМУ ПРОЕКТУ (например #spongebob, #stt-dev, #puppet-master-vibe-edition) — все его сообщения принадлежат этому проекту.
   - Если канал ОБЩИЙ (например #lisbon-talks, #leads, #ac-team, #standups, #ac-production-updates, #cofounders-speakeasy, #announcements, #ac-user-acquisition) — НЕ привязывай по каналу. Привязывай по УПОМИНАНИЮ названия проекта/алиаса В ТЕКСТЕ сообщения. Если в тексте упомянут "Idle Axe" — это item проекта "Idle Axe Thrower", даже если разговор был в #lisbon-talks.
   - Email/ClickUp/Calendar — привязывай по контексту (sender, project name в subject/title, упоминания в теле).
   - Если ни канал, ни текст явно не указывают на проект — кладёшь в general_updates.
7. Тихие проекты (без апдейтов) — в silent_projects по name, не в projects.
8. Status проекта: ok = всё штатно, attention = есть нерешённые вопросы/риски, blocked = блокеры/просрочки.
9. Группируй Slack-треды: один тред = один item (даже если 20 сообщений).
10. RSVP-ответы Calendar (Accepted:/Declined:) ИГНОРИРУЙ — они уже отфильтрованы.
11. Дублирование между источниками (та же новость в Slack и Email): один item, выбери лучший источник для link.
12. Не пиши items с importance 1, кроме случаев когда это часть series ("ДР Маши, Пети и Васи").
13. item_id формат: "<date>-<companyCode>-<projectId>-<seq>" или "<date>-<companyCode>-general-<seq>". date в формате YYYYMMDD без дефисов. seq — 3-значный с 001. companyCode = "ac" или "hg".
14. ВАЖНО ПРО JSON STRINGS: внутри значений one_line / detail / source_meta:
    - НЕ ставь буквальные переносы строк — используй пробел
    - Все двойные кавычки внутри текста экранируй как \\" (например \\"In A Jam\\")
    - НЕ используй кавычки-ёлочки « » — заменяй на обычные ' или экранированные \\"
    - НЕ используй markdown (** _ # *) — в Telegram дайджесте мы рендерим plain text
    - Не оставляй trailing comma после последнего элемента массива/объекта

ПРОЕКТ-СПЕЦИФИЧНЫЕ ПРАВИЛА:

STT (Star Trek Timelines) — в #stt-live-ops идут регулярные операционные процедуры:

  1. ШЕДУЛИНГ CM/OE — каждый ПОНЕДЕЛЬНИК.
     Маркеры (английский): "Scheduling next CM, does it look good?", "Scheduling next OE, does it look good?", "Scheduling next campaign, looks good?", "Scheduling N week long OE", "Scheduling month-long OE".
     - Если за понедельник недели хотя бы по одному из CM/OE/campaign выполнены — это РУТИНА. ОДИН item: "Шедулинг CM и OE на неделю выполнен", importance=2, type=slack. НЕ перечисляй конкретные ивенты.
     - Если понедельник прошёл без сообщений шедулинга — ОДИН item: "⚠️ Шедулинг CM/OE не выполнен в понедельник", importance=4.

  2. КАТАЛОЖНАЯ ПРОЦЕДУРА — вторник + среда.
     Стандартный поток: Вт "out of both" + "entering both" + "Entering prod" + "Deploying update_*" + список ивентов; Ср "Out of prod Buddy-checked and uncohorted: ..." + "Scheduling next Event '...'".
     - Если в Вт-Ср недели поток выполнен (есть entering prod + out of prod buddy-checked) — ОДИН item: "Каталог за неделю обработан и развёрнут", importance=2, type=slack. НЕ перечисляй ивенты.
     - Если процедура не завершена — ОДИН item: "⚠️ Каталожная процедура не завершена", importance=4.

  3. БИЛДЫ И ПАТЧИ — нерегулярные. Сообщения "Version X.Y.Z is live on ..." или "Deploying update_*" — обычные items с importance=3.

  4. ОБРАЩЕНИЯ от TP managers / Customer Service — players issues, missing events, error reports — высокая важность (4-5).

  5. SLACKBOT REMINDERS ("Reminder: The next week's server branch needs to be created.") — ИГНОРИРУЙ.

ИТОГ для STT: вместо длинного списка из 5-7 items по разным ивентам — ожидается 2-4 коротких item: статус шедулинга, статус каталожной процедуры, плюс билды/обращения если есть.

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

/**
 * Dump a raw LLM response that failed to parse to /tmp for debugging,
 * then attempt a series of progressively-lenient cleanup steps.
 */
function dumpFailedResponse(company: string, raw: string): void {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = `/tmp/digest-llm-fail-${company}-${Date.now()}.txt`
    fs.writeFileSync(path, raw, 'utf-8')
    logger.warn({ path, company, len: raw.length }, 'Digest LLM: raw response dumped for inspection')
  } catch { /* best effort */ }
}

/**
 * Lenient cleanup pass for common LLM JSON breakage:
 *   - replace smart quotes (« » “ ” „ ‚) with safe alternatives
 *   - kill literal newlines inside string values (between an opening and the
 *     unescaped closing ")
 * Returns null if cleanup itself failed.
 */
function cleanupJson(text: string): string {
  let t = text
  // Smart quotes around words → straight single quotes (safer than double).
  t = t.replace(/[«»“”„‚]/g, "'")
  // Replace literal newlines inside JSON string values with spaces.
  // Heuristic: scan char-by-char tracking string state.
  let out = ''
  let inStr = false
  let escaped = false
  for (const ch of t) {
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      out += ch
      escaped = true
      continue
    }
    if (ch === '"') {
      out += ch
      inStr = !inStr
      continue
    }
    if (inStr && (ch === '\n' || ch === '\r' || ch === '\t')) {
      out += ' '
      continue
    }
    out += ch
  }
  return out
}

function parseJsonResponse(raw: string, company: string): DigestCompany | null {
  let text = raw.trim()
  if (text.startsWith('```')) {
    const end = text.lastIndexOf('```')
    text = text.slice(text.indexOf('\n') + 1, end).trim()
  }
  const firstBrace = text.indexOf('{')
  if (firstBrace > 0) text = text.slice(firstBrace)

  // Try strict parse first
  try {
    return JSON.parse(text) as DigestCompany
  } catch { /* fall through to lenient */ }

  // Try lenient cleanup
  try {
    const cleaned = cleanupJson(text)
    return JSON.parse(cleaned) as DigestCompany
  } catch (error) {
    logger.error(
      { error: (error as Error).message, head: text.slice(0, 200), tail: text.slice(-200), len: text.length },
      'Digest LLM: JSON parse failed even after cleanup',
    )
    dumpFailedResponse(company, raw)
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

  const parsed = parseJsonResponse(response.text, companyCode)
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
