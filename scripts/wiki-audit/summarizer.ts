/**
 * Generate 1-2 sentence summary for each audit row using Claude (Haiku).
 *
 * Uses callClaude (Max subscription via CLI) — model: 'haiku'.
 * Concurrency limited to avoid CLI overload. Failures are logged
 * but do not abort the run — failed rows get an empty summary.
 */

import { callClaude } from '../../src/llm/client.js'
import type { AuditRow } from './types.js'

const SUMMARY_SYSTEM_PROMPT =
  'Ты — ассистент. Получаешь содержимое статьи документации и пишешь одно-два предложения по-русски о том, что в этой статье. Без воды, без вступлений типа "Эта статья описывает". Только суть. Если контент слишком короткий или непонятный — ответь "Заглушка" одним словом.'

export async function summarizeRows(
  rows: AuditRow[],
  options: { concurrency?: number } = {},
): Promise<void> {
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 4))
  let completed = 0
  let failures = 0

  console.log(`[summarize] generating summaries for ${rows.length} rows (concurrency=${concurrency})...`)

  // Skip rows with too little content
  const candidates = rows.filter(r => r.textSnapshot.trim().length > 30)
  for (const r of rows) {
    if (r.textSnapshot.trim().length <= 30) r.summary = ''
  }

  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < candidates.length) {
      const idx = cursor++
      const row = candidates[idx]
      try {
        const prompt = `Заголовок: ${row.title}\n\nСодержимое:\n${row.textSnapshot}`
        const resp = await callClaude(prompt, { system: SUMMARY_SYSTEM_PROMPT, model: 'haiku', timeoutMs: 60_000 })
        const text = resp.text.trim().split('\n')[0]?.trim() ?? ''
        row.summary = text === 'Заглушка' ? '' : text
      } catch (e) {
        failures++
        row.summary = ''
        console.log(`\n[summarize] failed: ${row.title.slice(0, 50)} — ${(e as Error).message.slice(0, 100)}`)
      }
      completed++
      if (completed % 10 === 0) {
        process.stdout.write(`\r[summarize] ${completed}/${candidates.length}                `)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))
  process.stdout.write(`\n[summarize] done: ${completed} processed, ${failures} failures\n`)
}
