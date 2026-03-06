/**
 * System prompt for daily digest LLM compilation.
 * "Краткое содержание предыдущих серий" — recap of yesterday only.
 * The LLM receives COMPANY-FILTERED data and produces
 * a formatted Telegram HTML message grouped by project.
 */

import type { DigestSlackChannel } from './sources/slack.js'
import type { BriefingItem } from '../mcp/briefing/types.js'
import type { ClickUpTask } from './my-tasks.js'

export const DIGEST_SYSTEM_PROMPT = `Ты компилируешь ежедневный дайджест ("Краткое содержание предыдущих серий") для Дария (CPO / VP Production).
Дайджест покрывает ТОЛЬКО вчерашний день. Никаких планов на сегодня или будущее.

ФОРМАТ: Telegram HTML. Используй ТОЛЬКО теги <b>, <i>, <a href="...">.
НЕ используй другие HTML-теги (<p>, <br>, <h1>, <ul>, <li>). Переносы строк — обычные \\n, буллеты — •.
НЕ используй markdown-синтаксис (**, ##, и т.д.).

СТРУКТУРА:
1. Заголовок: <b>{CompanyName} — {дата}</b>
2. По каждому проекту с активностью:
   <b>{Название проекта}</b>
   • буллеты с ключевыми событиями вчера
3. Секция <b>Прочее</b> для непроектной активности (общие встречи, HR, админ)
4. Финальная секция <b>Мои задачи</b> с задачами Дария (просроченные + на сегодня)

ПРАВИЛА КОНТЕНТА:
• Группируй ВСЮ активность по проектам. Используй KB-контекст чтобы знать к какому проекту что относится.
• Если в KB-контексте указана внутренняя структура проекта (напр. блоки: production, creatives, UA) — группируй буллеты внутри проекта по этим блокам.
• Если одно событие есть в нескольких источниках (calendar + email + Slack) — упомяни ОДИН раз.
• Стендапы, дейли — ПОЛНОСТЬЮ ПРОПУСТИТЬ. Не упоминать что стендап был проведён, если на нём не было чего-то примечательного.
• Системные письма (ClickUp нотификации, CI, отчёты App Store) — суммировать "N системных писем", если нет критичного.
• Человеческие письма — отправитель + тема + 1 строка сути.
• Slack — суммировать КЛЮЧЕВЫЕ обсуждения: решения, блокеры, запросы, статусы. НЕ пересказывать каждое сообщение.
• Calendar — события со временем и УЧАСТНИКАМИ. Пиши "Дарий и Иван провели митинг по X", а не "Dariy Shatskikh провел митинг по X". Подсветить если отменено.
• ClickUp — смена статусов, новые задачи, завершения.
• Проблемы, блокеры, эскалации — подсветить ⚠️.
• В "Мои задачи": просроченные первые с ⏰, потом на сегодня.
• Ссылки <a href="url">кликабельные</a> где доступны.

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
}): string {
  const sections: string[] = []

  sections.push(`Компания: ${params.company}`)
  sections.push(`Дата: ${params.date}`)

  const totalSlackMsgs = params.slackChannels.reduce((sum, ch) => sum + ch.messages.length, 0)
  sections.push(`\nИТОГО ДАННЫХ: ${params.slackChannels.length} Slack-каналов (${totalSlackMsgs} сообщений), ${params.gmailData.length} писем, ${params.calendarData.length} событий, ${params.clickupData.length} задач, ${params.myTasks.length} моих задач. Покрой ВСЁ.`)

  // Slack — structured per channel with resolved names
  sections.push(`\n--- SLACK (вчерашние сообщения по каналам) ---`)
  if (params.slackChannels.length > 0) {
    for (const ch of params.slackChannels) {
      sections.push(`\n#${ch.channelName} (${ch.messages.length} сообщений):`)
      for (const msg of ch.messages) {
        const thread = msg.threadInfo ? ` [${msg.threadInfo}]` : ''
        sections.push(`  ${msg.author}: ${msg.text}${thread}`)
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
      sections.push(`  От: ${from} (${account})`)
      sections.push(`  Тема: ${subject}`)
      if (preview) sections.push(`  Превью: ${preview}`)
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
      sections.push(`  ${date} — ${subject}${cancelled}`)
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
      const links = (task.links as string[]) ?? []
      const url = links[0] ?? ''
      sections.push(`  [${list}] ${subject} — ${status}${assignee ? ` (${assignee})` : ''}${url ? ` ${url}` : ''}`)
    }
  } else {
    sections.push('Нет активности')
  }

  // My Tasks
  sections.push(`\n--- МОИ ЗАДАЧИ (назначены Дарию) ---`)
  if (params.myTasks.length > 0) {
    for (const task of params.myTasks) {
      const overdue = task.is_overdue ? ' ⏰ ПРОСРОЧЕНА' : ''
      sections.push(`  [${task.list}] ${task.subject} — ${task.status}${overdue}${task.due_date ? ` (до ${task.due_date})` : ''} ${task.url}`)
    }
  } else {
    sections.push('Нет задач')
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
