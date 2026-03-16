/**
 * Claude analyzer for self-improvement agent.
 * Sends problematic interaction cases to Claude for classification
 * and fix generation.
 */

import { callClaude } from '../llm/client.js'
import { logger } from '../logging/logger.js'
import type { ProblematicCase, AnalysisResult, FixCategory, ProblemType } from './types.js'

/** Max cases to analyze per night (cost control). */
const MAX_CASES_TO_ANALYZE = 20

/** Max cases per batch (keep context manageable). */
const BATCH_SIZE = 10

const ANALYSIS_SYSTEM_PROMPT = `Ты — агент самоулучшения бота Astra (Telegram-ассистент на базе Claude).
Твоя задача: анализировать проблемные взаимодействия и предлагать исправления.

## Контекст
Astra отвечает на вопросы пользователя, используя MCP tools (kb_search, kb_registry, briefing, audit_tasks и др.).
Данные о проектах, людях, компаниях хранятся в YAML-файлах реестра: src/kb/registry/ (projects/, people/, companies/, channels/, processes/).
Навыки бота (skills) определяют системные промпты для разных типов запросов.

## Классификация проблем
Для каждого проблемного кейса определи категорию исправления:

1. **registry_fix** — проблема в YAML-реестре (отсутствующий алиас, неправильные данные, недостающая связь).
   ТОЛЬКО для файлов в src/kb/registry/**/*.yaml.
   Можно исправить автоматически. Сгенерируй точный патч (filePath, oldContent, newContent).

2. **prompt_fix** — проблема в навигации/промпте (skill guidance неточный, бот не знает как искать).
   Требует изменения TypeScript кода — ТОЛЬКО описание, без патча.

3. **code_fix** — баг в коде (неправильная логика, ошибка парсинга, крэш).
   Требует изменения TypeScript кода — ТОЛЬКО описание.

4. **infra_fix** — проблема инфраструктуры (таймаут, деплой, rate limit, перегрузка).
   ТОЛЬКО описание.

## Формат ответа
Ответь СТРОГО в формате JSON array:
[
  {
    "correlationId": "uuid-строка",
    "problems": ["error", "negative_feedback"],
    "category": "registry_fix",
    "summary": "Краткое описание проблемы и решения на русском",
    "fix": {
      "filePath": "src/kb/registry/companies/example.yaml",
      "description": "Добавить алиас 'EX' для быстрого поиска",
      "oldContent": "name: Example Company\\ncode: ex",
      "newContent": "name: Example Company\\ncode: ex\\naliases: [EX]"
    }
  },
  {
    "correlationId": "uuid-строка",
    "problems": ["slow_response"],
    "category": "infra_fix",
    "summary": "Медленный ответ из-за большого количества MCP tool calls"
  }
]

Правила:
- "fix" поле ТОЛЬКО для category="registry_fix"
- Для остальных категорий — только "summary" с описанием
- "summary" всегда на русском языке
- Если проблема неясна или тривиальна — можно пропустить (не включать в массив)
- Не предлагай фиксы если проблема вызвана внешними факторами (Claude перегружен, интернет и т.д.)
- filePath должен быть относительный от корня проекта
- oldContent и newContent — точные подстроки YAML файла`

/**
 * Analyze problematic cases with Claude.
 * Batches cases and returns classified results with fix suggestions.
 */
export async function analyzeCases(cases: ProblematicCase[]): Promise<AnalysisResult[]> {
  const toAnalyze = cases.slice(0, MAX_CASES_TO_ANALYZE)
  if (toAnalyze.length === 0) return []

  const allResults: AnalysisResult[] = []

  // Process in batches
  for (let i = 0; i < toAnalyze.length; i += BATCH_SIZE) {
    const batch = toAnalyze.slice(i, i + BATCH_SIZE)
    try {
      const results = await analyzeBatch(batch)
      allResults.push(...results)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error({ error: msg, batchStart: i, batchSize: batch.length }, 'Self-improve: batch analysis failed')
    }
  }

  logger.info(
    { analyzed: toAnalyze.length, results: allResults.length },
    'Self-improve: analysis complete',
  )

  return allResults
}

async function analyzeBatch(cases: ProblematicCase[]): Promise<AnalysisResult[]> {
  const prompt = buildBatchPrompt(cases)

  const response = await callClaude(prompt, {
    system: ANALYSIS_SYSTEM_PROMPT,
    timeoutMs: 120_000,
  })

  return parseAnalysisResponse(response.text, cases)
}

function buildBatchPrompt(cases: ProblematicCase[]): string {
  const lines: string[] = ['Проанализируй следующие проблемные взаимодействия:\n']

  for (const c of cases) {
    const { interaction, problems, feedbackText } = c
    lines.push(`--- Кейс ${interaction.correlationId} ---`)
    lines.push(`Проблемы: ${problems.join(', ')}`)
    lines.push(`Статус: ${interaction.status}`)
    if (interaction.errorMessage) {
      lines.push(`Ошибка: ${interaction.errorMessage}`)
    }
    lines.push(`Время ответа: ${Math.round(interaction.responseTimeMs / 1000)}с`)
    if (interaction.skill) {
      lines.push(`Skill: ${interaction.skill}`)
    }
    lines.push(`\nВопрос пользователя:\n${interaction.userText.slice(0, 500)}`)
    if (interaction.assistantText) {
      lines.push(`\nОтвет Астры:\n${interaction.assistantText.slice(0, 800)}`)
    }
    if (feedbackText) {
      lines.push(`\nФидбек пользователя:\n${feedbackText.slice(0, 300)}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

function parseAnalysisResponse(text: string, cases: ProblematicCase[]): AnalysisResult[] {
  // Extract JSON array using bracket matching (not greedy regex)
  const startIdx = text.indexOf('[')
  if (startIdx === -1) {
    logger.warn({ responseLength: text.length }, 'Self-improve: no JSON array in analysis response')
    return []
  }
  let depth = 0
  let endIdx = -1
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === '[') depth++
    if (text[i] === ']') depth--
    if (depth === 0) { endIdx = i; break }
  }
  if (endIdx === -1) {
    logger.warn('Self-improve: unbalanced brackets in analysis response')
    return []
  }

  try {
    const parsed = JSON.parse(text.slice(startIdx, endIdx + 1)) as Array<Record<string, unknown>>
    const validCorrelations = new Set(cases.map((c) => c.interaction.correlationId))

    return parsed
      .filter((item) => {
        if (!item.correlationId || !item.category || !item.summary) return false
        if (!validCorrelations.has(item.correlationId as string)) return false
        const validCategories: FixCategory[] = ['registry_fix', 'prompt_fix', 'code_fix', 'infra_fix']
        return validCategories.includes(item.category as FixCategory)
      })
      .map((item) => ({
        correlationId: item.correlationId as string,
        problems: ((item.problems as string[]) ?? []) as ProblemType[],
        category: item.category as FixCategory,
        summary: item.summary as string,
        fix: item.fix && (item.category as string) === 'registry_fix'
          ? {
              filePath: (item.fix as Record<string, string>).filePath,
              description: (item.fix as Record<string, string>).description,
              oldContent: (item.fix as Record<string, string>).oldContent,
              newContent: (item.fix as Record<string, string>).newContent,
            }
          : undefined,
      }))
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error({ error: msg }, 'Self-improve: failed to parse analysis JSON')
    return []
  }
}
