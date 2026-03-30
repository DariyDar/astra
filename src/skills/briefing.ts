import type { Skill } from './types.js'
import { loadPromptCached } from '../kb/vault-loader.js'

/**
 * Detect if a query requires deep investigation (parallel subagents)
 * vs a simple data lookup (single Claude call).
 *
 * Investigation signals: long questions, explicit research intent,
 * bug investigation, multi-source requests ("и в слаке и в интернете").
 */
function isInvestigationQuery(text: string): boolean {
  const lower = text.toLowerCase()

  // Explicit investigation phrases
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

  // Long query (>120 chars) with search intent = likely investigation
  if (text.length > 120 && /(?:найди|поиск|search|bug|баг|проблем|ошибк)/i.test(lower)) return true

  return false
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
    // Moved to vault/instructions-for-llm/skill-briefing.md
    return {
      prompt: ctx.message.text,
      investigation,
      systemPromptExtra: loadPromptCached('instructions-for-llm/skill-briefing.md'),
    }
  },
}

export default briefingSkill
