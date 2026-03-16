/**
 * System prompt for daily digest LLM compilation.
 * "Краткое содержание предыдущих серий" — recap of yesterday only.
 * The LLM receives COMPANY-FILTERED data and produces
 * a formatted Telegram HTML message grouped by project.
 */

import type { DigestSlackChannel } from './sources/slack.js'
import type { BriefingItem } from '../mcp/briefing/types.js'
import type { ClickUpTask } from './my-tasks.js'
import type { ProjectStatus } from '../kb/registry/reader.js'

export const DIGEST_SYSTEM_PROMPT = `Ты компилируешь ежедневный дайджест ("Краткое содержание предыдущих серий") для Дария (CPO / VP Production).
Дайджест покрывает ТОЛЬКО вчерашний день. Никаких планов на сегодня или будущее.

ФОРМАТ: Telegram HTML. Используй ТОЛЬКО теги <b>, <i>, <a href="...">.
НЕ используй другие HTML-теги (<p>, <br>, <h1>, <ul>, <li>). Переносы строк — обычные \\n, буллеты — •.
НЕ используй markdown-синтаксис (**, ##, и т.д.).

СТРУКТУРА:
1. Заголовок: <b>{CompanyName} — {дата}</b>
2. По КАЖДОМУ проекту компании (даже если нет активности):
   <b>{Название проекта}</b>
   • буллеты с ключевыми событиями вчера
   • Если по проекту НЕТ данных ни в одном источнике — напиши "без апдейтов"
3. ClickUp-задачи включай ВНУТРЬ секции проекта (не отдельным блоком в конце). Задачи, не привязанные к проекту — в "Прочее".
4. Секция <b>Прочее</b> для непроектной активности (общие встречи, HR, админ, задачи без проекта)
5. Финальная секция <b>Мои задачи</b> с задачами Дария (просроченные + на сегодня)

ПРАВИЛА КОНТЕНТА:
• Группируй ВСЮ активность по проектам. Используй KB-контекст и статусы проектов чтобы знать к какому проекту что относится.
• НЕ используй префиксы типа "Production:", "QA:", "Dev:" перед буллетами. Просто пиши суть.
• Суммируй информацию PER PROJECT через ВСЕ источники одновременно. Один лаконичный тезис вместо перечисления отдельно Slack, отдельно Email.
  Пример хорошего буллета: "Fish AI в работе (Алехандро), QA отчёт — 5 P1 багов, софт-лонч ETA 15/04"
• Если одно событие есть в нескольких источниках (calendar + email + Slack) — упомяни ОДИН раз.
• Стендапы, дейли — если на стендапе обсуждались конкретные решения, статусы, блокеры — упомяни РЕЗУЛЬТАТЫ обсуждения, а не факт стендапа.
• QA-отчёты (из email) — обязательно связывай с проектом: кол-во багов, приоритеты, критичные проблемы.
• Системные письма (ClickUp нотификации, CI, отчёты App Store) — суммировать "N системных писем", если нет критичного.
• Человеческие письма — отправитель + тема + 1 строка сути.
• Slack — суммировать КЛЮЧЕВЫЕ обсуждения: решения, блокеры, запросы, статусы. НЕ пересказывать каждое сообщение.
• ИМЕНА: всегда используй короткие русские имена. "Dariy Shatskikh" → "Дарий", "Anastasia Voronova" → "Настя", "Sergey" → "Сергей". Если в данных имя уже на русском — используй как есть.
• Calendar — события со временем и УЧАСТНИКАМИ. Пиши "Дарий и Иван провели митинг по X", а не "Dariy Shatskikh провел митинг по X". Подсветить если отменено.
• ClickUp — смена статусов, новые задачи, завершения.
• Проблемы, блокеры, эскалации — подсветить ⚠️.
• В "Мои задачи": данные уже сгруппированы на "Просроченные" и "На этой неделе". ОБЯЗАТЕЛЬНО указывай проект [list] у каждой задачи. НЕ пиши "ПРОСРОЧЕНА" на каждой строке — достаточно заголовка группы.
• Ссылки: в конце каждого буллета добавляй кликабельную ссылку на источник, если URL доступен.
  Формат: <a href="url">(Слак)</a>, <a href="url">(Почта)</a>, <a href="url">(ClickUp)</a>, <a href="url">(Календарь)</a>.
  Ссылка должна быть ПОСЛЕДНИМ элементом буллета.
• Статусы проектов (если предоставлены) используй как КОНТЕКСТ для обогащения буллетов — приближающиеся дедлайны, текущий фокус команды.

КАЧЕСТВО ТЕКСТА:
• ТОЛЬКО ФАКТЫ. Без оценок, без "отличная работа", без рекомендаций, без "стоит обратить внимание".
• КОНКРЕТИКА: имена людей, числа, даты, версии, проценты. "Обсуждались вопросы" — ЗАПРЕЩЕНО.
• Пиши кратко. 2-5 буллетов на проект максимум.
• Используй KB-контекст для добавления релевантного контекста (ETA майлстоуна, текущий статус, приближающиеся дедлайны).
• НЕ перечисляй все KB-факты — только когда они добавляют контекст к вчерашней активности.
• Если источник вернул ошибку или пуст — пропусти молча.
• НЕ добавляй приветствие или подпись. Начинай сразу с заголовка.

КРИТИЧЕСКИ ВАЖНО:
• Тебе приходят данные ТОЛЬКО для одной компании. ВСЕ данные релевантны — используй их.
• Ты ОБЯЗАН покрыть ВСЕ проекты, по которым есть активность в данных. Не останавливайся после первого проекта.
• Если в Slack есть 10 каналов с сообщениями — в дайджесте должны быть упомянуты все 10 проектов.
• Пройдись по каждому Slack-каналу, каждому письму, каждому событию и каждой задаче.
• Ответ должен покрывать ВСЕ данные. Краткость — это 2-5 буллетов НА ПРОЕКТ, а не 1 проект на весь дайджест.

Если НЕТ активности: "<b>{CompanyName} — {дата}</b>\\n\\nЗа вчера активности не было."
`

/** Build the user prompt with structured, company-filtered data. */
export function buildDigestUserPrompt(params: {
  company: string
  date: string
  slackChannels: DigestSlackChannel[]
  gmailData: BriefingItem[]
  calendarData: BriefingItem[]
  clickupData: BriefingItem[]
  myTasks: ClickUpTask[]
  kbContext: Array<{ project: string; facts: string[] }>
  allProjects: string[]
  projectStatuses?: ProjectStatus[]
  registryGaps?: { staleProjects: number; unknownUsers: number; unknownChannels: number }
}): string {
  const sections: string[] = []

  sections.push(`Компания: ${params.company}`)
  sections.push(`Дата: ${params.date}`)
  sections.push(`\nПроекты компании: ${params.allProjects.join(', ')}`)
  sections.push(`Покажи секцию для КАЖДОГО проекта. Если данных нет — напиши "без апдейтов".`)

  const totalSlackMsgs = params.slackChannels.reduce((sum, ch) => sum + ch.messages.length, 0)
  sections.push(`\nИТОГО ДАННЫХ: ${params.slackChannels.length} Slack-каналов (${totalSlackMsgs} сообщений), ${params.gmailData.length} писем, ${params.calendarData.length} событий, ${params.clickupData.length} задач, ${params.myTasks.length} моих задач. Покрой ВСЁ.`)

  // Slack — structured per channel with resolved names
  sections.push(`\n--- SLACK (вчерашние сообщения по каналам) ---`)
  if (params.slackChannels.length > 0) {
    for (const ch of params.slackChannels) {
      sections.push(`\n#${ch.channelName} (${ch.messages.length} сообщений):`)
      for (const msg of ch.messages) {
        const thread = msg.threadInfo ? ` [${msg.threadInfo}]` : ''
        const link = msg.link ? ` ${msg.link}` : ''
        sections.push(`  ${msg.author}: ${msg.text}${thread}${link}`)
      }
    }
  } else {
    sections.push('Нет сообщений')
  }

  // Gmail — subject + sender + preview
  sections.push(`\n--- ПОЧТА (вчера) ---`)
  if (params.gmailData.length > 0) {
    for (const email of params.gmailData) {
      const from = (email.author as string) ?? ''
      const subject = (email.subject as string) ?? ''
      const preview = (email.text_preview as string) ?? ''
      const account = (email.account as string) ?? ''
      const emailLink = (email.link as string) ?? ''
      sections.push(`  От: ${from} (${account})`)
      sections.push(`  Тема: ${subject}`)
      if (preview) sections.push(`  Превью: ${preview}`)
      if (emailLink) sections.push(`  URL: ${emailLink}`)
      sections.push('')
    }
  } else {
    sections.push('Нет писем')
  }

  // Calendar — events with time
  sections.push(`\n--- КАЛЕНДАРЬ (вчера) ---`)
  if (params.calendarData.length > 0) {
    for (const event of params.calendarData) {
      const subject = (event.subject as string) ?? ''
      const date = (event.date as string) ?? ''
      const attendees = (event.attendees as string) ?? ''
      const status = (event.status as string) ?? ''
      const cancelled = status === 'cancelled' ? ' [ОТМЕНЕНО]' : ''
      const calLinks = (event.links as string[]) ?? []
      const calUrl = calLinks[0] ?? ''
      sections.push(`  ${date} — ${subject}${cancelled}${calUrl ? ` ${calUrl}` : ''}`)
      if (attendees) sections.push(`    Участники: ${attendees}`)
    }
  } else {
    sections.push('Нет событий')
  }

  // ClickUp — task activity
  sections.push(`\n--- CLICKUP (активность вчера) ---`)
  if (params.clickupData.length > 0) {
    for (const task of params.clickupData) {
      const subject = (task.subject as string) ?? ''
      const status = (task.status as string) ?? ''
      const list = (task.list as string) ?? ''
      const assignee = (task.assignee as string) ?? ''
      const url = (task.link as string) ?? ''
      sections.push(`  [${list}] ${subject} — ${status}${assignee ? ` (${assignee})` : ''}${url ? ` ${url}` : ''}`)
    }
  } else {
    sections.push('Нет активности')
  }

  // My Tasks — grouped by overdue vs upcoming
  sections.push(`\n--- МОИ ЗАДАЧИ (назначены Дарию) ---`)
  if (params.myTasks.length > 0) {
    const overdueTasks = params.myTasks.filter((t) => t.is_overdue)
    const upcomingTasks = params.myTasks.filter((t) => !t.is_overdue)

    if (overdueTasks.length > 0) {
      sections.push(`\n⏰ Просроченные (${overdueTasks.length}):`)
      for (const task of overdueTasks) {
        const due = task.due_date ? ` (до ${task.due_date})` : ''
        sections.push(`  [${task.list}] ${task.subject} — ${task.status}${due} ${task.url}`)
      }
    }
    if (upcomingTasks.length > 0) {
      sections.push(`\nНа этой неделе (${upcomingTasks.length}):`)
      for (const task of upcomingTasks) {
        const due = task.due_date ? ` (до ${task.due_date})` : ''
        sections.push(`  [${task.list}] ${task.subject} — ${task.status}${due} ${task.url}`)
      }
    }
  } else {
    sections.push('Нет задач')
  }

  // Project Statuses from registry
  if (params.projectStatuses && params.projectStatuses.length > 0) {
    const activeStatuses = params.projectStatuses.filter((s) => s.status === 'active' && s.current_focus !== 'TBD')
    if (activeStatuses.length > 0) {
      sections.push(`\n--- СТАТУСЫ ПРОЕКТОВ (текущее состояние из KB registry) ---`)
      for (const s of activeStatuses) {
        const tasks = s.open_tasks !== undefined ? ` | ${s.open_tasks} задач, ${s.overdue_tasks ?? 0} просрочено` : ''
        sections.push(`[${s.project}] ${s.status}${tasks}`)
        sections.push(`  Фокус: ${s.current_focus}`)
      }
    }
  }

  // Registry gaps warning
  if (params.registryGaps) {
    const g = params.registryGaps
    const warnings: string[] = []
    if (g.staleProjects > 0) warnings.push(`${g.staleProjects} проектов с устаревшими статусами (>3 дней)`)
    if (g.unknownUsers > 0) warnings.push(`${g.unknownUsers} новых людей в Slack не внесены в реестр`)
    if (g.unknownChannels > 0) warnings.push(`${g.unknownChannels} каналов Slack не каталогизированы`)
    if (warnings.length > 0) {
      sections.push(`\n--- ПРЕДУПРЕЖДЕНИЯ О ДАННЫХ ---`)
      sections.push(`Добавь в конец дайджеста секцию <b>⚠️ Актуальность данных</b> с этими замечаниями:`)
      for (const w of warnings) {
        sections.push(`• ${w}`)
      }
    }
  }

  // KB Context — project facts for enrichment
  if (params.kbContext.length > 0) {
    sections.push(`\n--- KB КОНТЕКСТ (факты по проектам для добавления контекста) ---`)
    for (const entry of params.kbContext) {
      sections.push(`\n[${entry.project}]`)
      for (const fact of entry.facts) {
        sections.push(`  - ${fact}`)
      }
    }
  }

  return sections.join('\n')
}
