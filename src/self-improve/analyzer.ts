/**
 * Claude analyzer for self-improvement agent.
 * Sends problematic interaction cases to Claude for classification
 * and fix generation.
 */

import { callClaude } from '../llm/client.js'
import { logger } from '../logging/logger.js'
import { loadPromptCached } from '../kb/vault-loader.js'
import type { ProblematicCase, AnalysisResult, FixCategory, ProblemType } from './types.js'

/** Max cases to analyze per night (cost control). */
const MAX_CASES_TO_ANALYZE = 20

/** Max cases per batch (keep context manageable). */
const BATCH_SIZE = 10

// Moved to vault/instructions-for-llm/agent-self-improve.md
const getAnalysisSystemPrompt = (): string => loadPromptCached('instructions-for-llm/agent-self-improve.md')

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
    system: getAnalysisSystemPrompt(),
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
