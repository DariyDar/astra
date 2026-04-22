import type { Skill, SkillContext, SkillResult } from './types.js'
import { loadPromptCached } from '../kb/vault-loader.js'
import { searchSlack, formatSlackResults } from '../tools/slack-search.js'
import { lookupKB, formatKBResult } from '../tools/kb-lookup.js'
import { readDriveDoc, formatDriveResult, extractDriveUrls } from '../tools/drive-read.js'
import { queryClickUp, formatClickUpResult } from '../tools/clickup-query.js'
import { getAllProjects, loadProjectCard } from '../kb/vault-reader.js'
import { logger } from '../logging/logger.js'

/**
 * Detect if a query requires deep investigation (parallel subagents)
 * vs a simple data lookup (single Claude call with prefetched data).
 */
function isInvestigationQuery(text: string): boolean {
  const lower = text.toLowerCase()

  const investigationPhrases = [
    'вся доступная информация', 'вся информация',
    'разберись', 'расследуй', 'исследуй', 'проанализируй',
    'deep dive', 'investigate', 'подробный анализ', 'подробности',
    'что не так с', 'почему не работает', 'в чём проблема',
    'и в интернете', 'и что пишут', 'и в каналах',
    'шаги воспроизведения', 'все подробности',
    'максимум информации', 'максимум инфы',
    'собери всё', 'найди всё',
  ]
  if (investigationPhrases.some((p) => lower.includes(p))) return true
  if (text.length > 120 && /(?:найди|поиск|search|bug|баг|проблем|ошибк)/i.test(lower)) return true
  return false
}

/** Detect which project the query is about (if any) */
function detectProject(text: string): string | null {
  const lower = text.toLowerCase()
  const projects = getAllProjects()
  for (const p of projects) {
    const names = [p.name.toLowerCase(), ...(p.aliases || []).map((a: string) => a.toLowerCase())]
    for (const name of names) {
      if (name.length > 2 && lower.includes(name)) return p.name
    }
  }
  return null
}

/** Detect data sources needed based on query keywords */
function detectNeededSources(text: string): { slack: boolean; kb: boolean; clickup: boolean; drive: boolean } {
  const lower = text.toLowerCase()
  return {
    slack: /слак|slack|канал|channel|обсужда|писал|тред|thread|чат/.test(lower),
    kb: /проект|project|команд|team|кто работает|статус|status|знаешь|расскажи|инфо/.test(lower),
    clickup: /задач|task|кликап|clickup|тикет|сделано|выполнен|дедлайн|deadline/.test(lower),
    drive: /документ|doc|таблиц|sheet|файл|file|открой|посмотри в/.test(lower),
  }
}

/** Detect time period from query text */
function detectPeriod(text: string): 'day' | 'week' | 'month' | '3months' | '6months' | 'year' {
  const lower = text.toLowerCase()
  if (/сегодня|today|за день/.test(lower)) return 'day'
  if (/неделю|week|за неделю|на этой неделе/.test(lower)) return 'week'
  if (/месяц|month|за месяц/.test(lower)) return 'month'
  if (/давно|полгода|пол года/.test(lower)) return '6months'
  if (/год|year/.test(lower)) return 'year'
  return 'week' // default
}

/**
 * Pre-fetch data based on query analysis.
 * Returns formatted text to append to system prompt as context.
 * Returns null if no prefetch is possible (fall through to MCP).
 */
async function prefetchData(ctx: SkillContext): Promise<{ data: string; skipMcp: boolean } | null> {
  const text = ctx.message.text
  const project = detectProject(text)
  const sources = detectNeededSources(text)
  const period = detectPeriod(text)
  const anySources = sources.slack || sources.kb || sources.clickup || sources.drive

  // If we can't determine what to prefetch, let MCP handle it
  if (!project && !anySources) return null

  const sections: string[] = []
  let fetchedSomething = false

  try {
    // KB lookup — always do if we know the project
    if (project || sources.kb) {
      const kb = await lookupKB({ project: project ?? undefined, section: 'all' })
      if (kb.found) {
        sections.push(formatKBResult(kb))
        fetchedSomething = true
      }
    }

    // Slack — if project is known, search its channels
    if (sources.slack || project) {
      let channels: string[] = []
      if (project) {
        const card = loadProjectCard(project)
        if (card?.slack_channels) {
          channels = Object.keys(card.slack_channels).map(ch => ch.replace(/^#/, ''))
        }
      }
      if (channels.length > 0) {
        const slackResult = await searchSlack({
          channels,
          period,
          includeThreads: true,
          maxMessages: 50,
        })
        if (slackResult.messages.length > 0) {
          sections.push(formatSlackResults(slackResult))
          fetchedSomething = true
        }
      }
    }

    // ClickUp — if project is known
    if (sources.clickup && project) {
      const ckResult = await queryClickUp({ project })
      if (ckResult.tasks.length > 0) {
        sections.push(formatClickUpResult(ckResult))
        fetchedSomething = true
      }
    }

    // Drive — if there are doc URLs in the text
    if (sources.drive) {
      const urls = extractDriveUrls(text)
      for (const url of urls.slice(0, 3)) {
        const doc = await readDriveDoc({ url })
        if (doc.found) {
          sections.push(formatDriveResult(doc))
          fetchedSomething = true
        }
      }
    }
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'Briefing prefetch error (non-fatal)')
  }

  if (!fetchedSomething) return null

  return {
    data: `\n\n--- ПРЕДВАРИТЕЛЬНО СОБРАННЫЕ ДАННЫЕ (скриптом, без LLM) ---\n\n${sections.join('\n\n')}\n\n--- КОНЕЦ ДАННЫХ ---\n\nИспользуй эти данные для ответа. Если данных достаточно — отвечай на основе них. Если нет — можешь использовать MCP tools для дополнительного поиска.`,
    skipMcp: true, // enough data prefetched, no need for MCP
  }
}

const briefingSkill: Skill = {
  name: 'briefing',
  description: 'Universal data skill: live sources (Slack, Gmail, Calendar, ClickUp) + Knowledge Base (historical facts, entities, milestones)',

  triggers: [
    // Live data
    'что нового', 'что сегодня', 'что у меня', 'что по расписанию',
    'непрочитанные', 'дайджест', 'обзор', 'briefing',
    'по всем фронтам', 'что было', 'что обсуждали',
    'есть письма', 'есть письмо', 'unread',
    'найди', 'search', 'поиск', 'найти',
    'обнови контекст', 'обнови мой контекст',
    'дедлайн', 'deadline', 'горят',
    'кто писал', 'кто последний',
    'канал', 'channel',
    'задачи', 'задач', 'tasks', 'проект', 'project',
    'выполнены', 'сделано', 'статус', 'status',
    'кликап', 'clickup',
    'знаешь', 'расскажи', 'инфо', 'info',
    // KB / historical data
    'найди в базе', 'поищи в базе', 'база знаний', 'knowledge base',
    'что знаешь о', 'что ты знаешь', 'who works on', 'кто работает над',
    'кто работает на', 'кто в команде', 'кто на проекте',
    'граф сущностей', 'entity graph', 'entities',
    'кто такой', 'кто такая', 'info about',
    'kb_search', 'kb_entities',
    'что говорил', 'что писал', 'что обсуждали раньше',
    'история', 'архив', 'прошлое', 'ранее',
    'в каких проектах', 'какие проекты',
    // Milestones, wiki, verification
    'майлстоун', 'milestone', 'вики', 'wiki',
    'проверь', 'правильно ли', 'корректно ли', 'по правилам',
    // Financial, HR, documents
    'зарплата', 'salary', 'заработал', 'бюджет', 'budget', 'P&L',
    'документ', 'document', 'таблица', 'spreadsheet', 'планнинг', 'planning',
    'отпуск', 'vacation', 'больничн', 'sick',
    'посмотри в', 'открой', 'посчитай', 'сколько стоит', 'сколько денег',
  ],

  async preProcess(ctx) {
    const investigation = isInvestigationQuery(ctx.message.text)

    // Investigation goes to two-phase pipeline (already optimized)
    if (investigation) {
      return {
        prompt: ctx.message.text,
        investigation: true,
        systemPromptExtra: loadPromptCached('instructions-for-llm/skill-briefing.md'),
      }
    }

    // Non-investigation: try to prefetch data
    const prefetch = await prefetchData(ctx)

    if (prefetch) {
      logger.info({ skipMcp: prefetch.skipMcp }, 'Briefing: prefetch successful')
      return {
        prompt: ctx.message.text,
        systemPromptExtra: loadPromptCached('instructions-for-llm/skill-briefing.md') + prefetch.data,
        skipMcp: prefetch.skipMcp,
      }
    }

    // Fallback: no prefetch possible, use MCP as before (but with maxTurns=15 from router)
    return {
      prompt: ctx.message.text,
      systemPromptExtra: loadPromptCached('instructions-for-llm/skill-briefing.md'),
    }
  },
}

export default briefingSkill
