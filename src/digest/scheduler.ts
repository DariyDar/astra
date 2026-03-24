#!/usr/bin/env node
/**
 * Daily digest scheduler and delivery.
 * Compiles two digest messages (AstroCat + Highground) and sends via Telegram.
 *
 * "Краткое содержание предыдущих серий" — recap of yesterday only.
 * Cron runs at 01:00 UTC = 09:00 WITA (Bali time).
 * Each data source has 5 retries with exponential backoff (5s→60s).
 * If full compilation fails, retries up to 3 times with ~5-min intervals.
 * Worst-case delivery by ~09:30 Bali time.
 *
 * Can also be run manually: npx tsx src/digest/scheduler.ts --now
 */

import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { QdrantClient } from '@qdrant/js-client-rest'
import { logger } from '../logging/logger.js'
import { compileDigest } from './compiler.js'
import { sendTelegramMessage } from '../telegram/sender.js'
import { embed } from '../memory/embedder.js'
import { env } from '../config/env.js'

/** Full-compilation retry: if all per-source retries fail, retry entire compilation. */
const COMPILATION_MAX_RETRIES = 3
const COMPILATION_RETRY_DELAY_MS = 5 * 60_000 // 5 minutes between full retries

/**
 * Compile a single company digest with full-compilation retry.
 * Returns the compiled text or null if all attempts exhausted.
 */
async function compileWithRetry(company: 'astrocat' | 'highground'): Promise<{ text: string | null; lastError: string | null }> {
  let lastError: string | null = null
  for (let attempt = 1; attempt <= COMPILATION_MAX_RETRIES; attempt++) {
    try {
      const text = await compileDigest(company)
      return { text, lastError: null }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      logger.error(
        { company, attempt, maxAttempts: COMPILATION_MAX_RETRIES, error: lastError },
        'Digest compilation failed',
      )

      if (attempt < COMPILATION_MAX_RETRIES) {
        const jitter = Math.random() * 30_000
        const delay = COMPILATION_RETRY_DELAY_MS + jitter
        logger.info(
          { company, nextRetryInSec: Math.round(delay / 1000) },
          'Retrying full digest compilation',
        )
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }
  return { text: null, lastError }
}

/** Compile and deliver digests for both companies. */
export async function deliverDailyDigest(): Promise<void> {
  const startTime = Date.now()

  logger.info('Starting daily digest compilation (with retry)')

  const [acResult, hgResult] = await Promise.allSettled([
    compileWithRetry('astrocat'),
    compileWithRetry('highground'),
  ])

  const { text: acText, lastError: acError } = acResult.status === 'fulfilled' ? acResult.value : { text: null, lastError: String(acResult.reason) }
  const { text: hgText, lastError: hgError } = hgResult.status === 'fulfilled' ? hgResult.value : { text: null, lastError: String(hgResult.reason) }

  if (acText) {
    await sendTelegramMessage(acText)
    await saveDigestToKB('AstroCat', acText)
    logger.info({ len: acText.length }, 'AstroCat digest sent + saved to KB')
  } else {
    logger.error('AstroCat digest: all compilation attempts exhausted')
    try {
      const errorHint = acError ? `\n\nПричина: <code>${acError.slice(0, 200)}</code>` : ''
      await sendTelegramMessage(
        `⚠️ Не удалось собрать дайджест AstroCat после всех попыток. Смотри логи.${errorHint}`,
      )
    } catch (notifyErr) {
      logger.error({ error: notifyErr }, 'Failed to send AstroCat error notification')
    }
  }

  if (hgText) {
    await sendTelegramMessage(hgText)
    await saveDigestToKB('Highground', hgText)
    logger.info({ len: hgText.length }, 'Highground digest sent + saved to KB')
  } else {
    logger.error('Highground digest: all compilation attempts exhausted')
    try {
      const errorHint = hgError ? `\n\nПричина: <code>${hgError.slice(0, 200)}</code>` : ''
      await sendTelegramMessage(
        `⚠️ Не удалось собрать дайджест Highground после всех попыток. Смотри логи.${errorHint}`,
      )
    } catch (notifyErr) {
      logger.error({ error: notifyErr }, 'Failed to send Highground error notification')
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000)
  logger.info({ elapsedSec: elapsed }, 'Daily digest delivery complete')
}

/**
 * Save compiled digest to KB (Qdrant astra_knowledge) for future queries.
 * Stored as source="digest", chunk_type="daily_digest".
 * This enables kb_search to find recent project statuses from digests.
 */
async function saveDigestToKB(company: string, digestText: string): Promise<void> {
  try {
    const qdrant = new QdrantClient({ url: env.QDRANT_URL })
    const now = new Date()
    const dateStr = now.toISOString().slice(0, 10)
    const sourceId = `digest-${company.toLowerCase()}-${dateStr}`

    // Delete previous digest for same company+date (idempotent re-runs)
    await qdrant.delete('astra_knowledge', {
      wait: true,
      filter: { must: [{ key: 'source_id', match: { value: sourceId } }] },
    })

    // Embed the digest text
    const vector = await embed(`${company} daily digest ${dateStr}: ${digestText.slice(0, 500)}`)

    await qdrant.upsert('astra_knowledge', {
      wait: true,
      points: [{
        id: randomUUID(),
        vector,
        payload: {
          source: 'digest',
          source_id: sourceId,
          chunk_type: 'daily_digest',
          text: digestText,
          company: company.toLowerCase(),
          entity_ids: [],
          source_date: now.getTime(),
        },
      }],
    })

    logger.info({ company, sourceId, textLen: digestText.length }, 'Digest saved to KB')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.warn({ company, error: msg }, 'Failed to save digest to KB (non-critical)')
  }
}

// --- CLI entry point: npx tsx src/digest/scheduler.ts --now ---
if (process.argv.includes('--now')) {
  deliverDailyDigest()
    .then(() => {
      logger.info('Manual digest run complete')
      process.exit(0)
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ error: msg }, 'Manual digest run failed')
      process.exit(1)
    })
}
