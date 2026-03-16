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
import { logger } from '../logging/logger.js'
import { compileDigest } from './compiler.js'
import { sendTelegramMessage } from '../telegram/sender.js'

/** Full-compilation retry: if all per-source retries fail, retry entire compilation. */
const COMPILATION_MAX_RETRIES = 3
const COMPILATION_RETRY_DELAY_MS = 5 * 60_000 // 5 minutes between full retries

/**
 * Compile a single company digest with full-compilation retry.
 * Returns the compiled text or null if all attempts exhausted.
 */
async function compileWithRetry(company: 'astrocat' | 'highground'): Promise<string | null> {
  for (let attempt = 1; attempt <= COMPILATION_MAX_RETRIES; attempt++) {
    try {
      return await compileDigest(company)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error(
        { company, attempt, maxAttempts: COMPILATION_MAX_RETRIES, error: msg },
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
  return null
}

/** Compile and deliver digests for both companies. */
export async function deliverDailyDigest(): Promise<void> {
  const startTime = Date.now()

  logger.info('Starting daily digest compilation (with retry)')

  const [acResult, hgResult] = await Promise.allSettled([
    compileWithRetry('astrocat'),
    compileWithRetry('highground'),
  ])

  const acText = acResult.status === 'fulfilled' ? acResult.value : null
  const hgText = hgResult.status === 'fulfilled' ? hgResult.value : null

  if (acText) {
    await sendTelegramMessage(acText)
    logger.info({ len: acText.length }, 'AstroCat digest sent')
  } else {
    logger.error('AstroCat digest: all compilation attempts exhausted')
    try {
      await sendTelegramMessage(
        '\u26a0\ufe0f \u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u043e\u0431\u0440\u0430\u0442\u044c \u0434\u0430\u0439\u0434\u0436\u0435\u0441\u0442 AstroCat \u043f\u043e\u0441\u043b\u0435 \u0432\u0441\u0435\u0445 \u043f\u043e\u043f\u044b\u0442\u043e\u043a. \u0421\u043c\u043e\u0442\u0440\u0438 \u043b\u043e\u0433\u0438.',
      )
    } catch (notifyErr) {
      logger.error({ error: notifyErr }, 'Failed to send AstroCat error notification')
    }
  }

  if (hgText) {
    await sendTelegramMessage(hgText)
    logger.info({ len: hgText.length }, 'Highground digest sent')
  } else {
    logger.error('Highground digest: all compilation attempts exhausted')
    try {
      await sendTelegramMessage(
        '\u26a0\ufe0f \u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0441\u043e\u0431\u0440\u0430\u0442\u044c \u0434\u0430\u0439\u0434\u0436\u0435\u0441\u0442 Highground \u043f\u043e\u0441\u043b\u0435 \u0432\u0441\u0435\u0445 \u043f\u043e\u043f\u044b\u0442\u043e\u043a. \u0421\u043c\u043e\u0442\u0440\u0438 \u043b\u043e\u0433\u0438.',
      )
    } catch (notifyErr) {
      logger.error({ error: notifyErr }, 'Failed to send Highground error notification')
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000)
  logger.info({ elapsedSec: elapsed }, 'Daily digest delivery complete')
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
