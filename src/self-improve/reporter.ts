/**
 * Telegram report builder for self-improvement agent.
 * Generates and sends a Russian-language HTML report.
 */

import { sendTelegramMessage } from '../telegram/sender.js'
import { logger } from '../logging/logger.js'
import type { SelfImproveReport, ProblematicCase, AnalysisResult } from './types.js'

const PROBLEM_LABELS: Record<string, string> = {
  error: 'ошибка',
  timeout: 'таймаут',
  negative_feedback: 'негативный фидбек',
  short_response: 'короткий ответ',
  slow_response: 'медленный ответ',
  max_turns_exceeded: 'превышен лимит шагов',
}

const CATEGORY_LABELS: Record<string, string> = {
  registry_fix: 'реестр (YAML)',
  prompt_fix: 'промпт/навигация',
  code_fix: 'код',
  infra_fix: 'инфраструктура',
}

/**
 * Build the HTML report from self-improvement data.
 */
export function buildReport(report: SelfImproveReport): string {
  const lines: string[] = []

  lines.push(`<b>Astra Self-Improve Report</b>`)
  lines.push(`<b>Дата:</b> ${report.date}`)
  lines.push('')

  // Stats section
  lines.push(`<b>Статистика за день:</b>`)
  lines.push(`- Всего взаимодействий: ${report.totalInteractions}`)
  if (report.errorCount > 0) lines.push(`- Ошибок: ${report.errorCount}`)
  if (report.timeoutCount > 0) lines.push(`- Таймаутов: ${report.timeoutCount}`)
  lines.push(`- Среднее время ответа: ${formatMs(report.avgResponseTimeMs)}`)
  lines.push(`- Макс. время ответа: ${formatMs(report.maxResponseTimeMs)}`)
  if (report.totalCostUsd > 0) {
    lines.push(`- Стоимость за день: $${report.totalCostUsd.toFixed(3)}`)
  }
  lines.push('')

  // Problems section
  if (report.problematicCases.length > 0) {
    lines.push(`<b>Проблемы (${report.problematicCases.length}):</b>`)
    for (const c of report.problematicCases.slice(0, 15)) {
      const tags = c.problems.map((p) => PROBLEM_LABELS[p] ?? p).join(', ')
      const question = truncate(c.interaction.userText, 80)
      lines.push(`- [${tags}] ${escapeHtml(question)}`)
    }
    if (report.problematicCases.length > 15) {
      lines.push(`  ... и ещё ${report.problematicCases.length - 15}`)
    }
    lines.push('')
  }

  // Analysis results
  if (report.analysisResults.length > 0) {
    lines.push(`<b>Анализ (${report.analysisResults.length}):</b>`)
    for (const r of report.analysisResults) {
      const cat = CATEGORY_LABELS[r.category] ?? r.category
      lines.push(`- [${cat}] ${escapeHtml(r.summary)}`)
    }
    lines.push('')
  }

  // Applied fixes
  if (report.appliedFixes.length > 0) {
    lines.push(`<b>Применённые исправления (${report.appliedFixes.length}):</b>`)
    for (const f of report.appliedFixes) {
      const file = f.fix?.filePath ?? 'unknown'
      lines.push(`  ✅ ${escapeHtml(file)}: ${escapeHtml(f.fix?.description ?? f.summary)}`)
    }
    lines.push('')
  }

  // Failed fixes
  if (report.failedFixes.length > 0) {
    lines.push(`<b>Неудачные исправления (${report.failedFixes.length}):</b>`)
    for (const f of report.failedFixes) {
      lines.push(`  ❌ ${escapeHtml(f.result.fix?.filePath ?? '')}: ${escapeHtml(f.error)}`)
    }
    lines.push('')
  }

  // Proposed fixes (need human review)
  if (report.proposedFixes.length > 0) {
    lines.push(`<b>Предложенные исправления (требуют ревью) (${report.proposedFixes.length}):</b>`)
    for (const p of report.proposedFixes) {
      const cat = CATEGORY_LABELS[p.category] ?? p.category
      lines.push(`  ⚠️ [${cat}] ${escapeHtml(p.summary)}`)
    }
    lines.push('')
  }

  // No problems
  if (report.problematicCases.length === 0) {
    lines.push('Проблем не обнаружено. Все взаимодействия в норме.')
  }

  return lines.join('\n')
}

/**
 * Build and send the self-improvement report.
 */
export async function sendReport(report: SelfImproveReport): Promise<void> {
  const html = buildReport(report)

  try {
    await sendTelegramMessage(html)
    logger.info({ reportLength: html.length }, 'Self-improve: report sent to Telegram')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error({ error: msg }, 'Self-improve: failed to send report')
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}мс`
  return `${(ms / 1000).toFixed(1)}с`
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '...'
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
