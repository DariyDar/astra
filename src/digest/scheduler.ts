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
import { Bot } from 'grammy'
import { logger } from '../logging/logger.js'
import { compileDigest } from './compiler.js'

const MAX_TELEGRAM_MESSAGE_LENGTH = 4096

/** Lazy-initialized Bot singleton for Telegram delivery. */
let botInstance: InstanceType<typeof Bot> | null = null

function getBot(): InstanceType<typeof Bot> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured')
  if (!botInstance) botInstance = new Bot(token)
  return botInstance
}

/** Telegram-supported HTML tags. Anything else gets stripped. */
const ALLOWED_TAGS = new Set(['b', 'i', 'u', 's', 'a', 'code', 'pre'])

/**
 * Sanitize LLM output to valid Telegram HTML.
 * - Strips unsupported tags (keeps content)
 * - Escapes bare < > & that aren't part of valid tags
 * - Closes any unclosed tags
 */
function sanitizeTelegramHtml(html: string): string {
  // Remove markdown artifacts the LLM might sneak in
  let result = html.replace(/```[a-z]*/g, '').replace(/```/g, '')

  // Replace all < with a placeholder, then restore valid allowed tags
  // This prevents bare < in text (e.g., "retention < 35%") from breaking Telegram
  const PLACEHOLDER = '\x00LT\x00'
  result = result.replace(/</g, PLACEHOLDER)

  // Restore allowed opening tags: <b>, <i>, <a href="...">, etc.
  for (const tag of ALLOWED_TAGS) {
    // Opening tag with attributes (e.g., <a href="...">)
    const openRegex = new RegExp(`${PLACEHOLDER}(${tag})(\\s[^>]*)?>`, 'gi')
    result = result.replace(openRegex, '<$1$2>')
    // Opening tag without attributes
    const openSimple = new RegExp(`${PLACEHOLDER}(${tag})>`, 'gi')
    result = result.replace(openSimple, '<$1>')
    // Closing tag
    const closeRegex = new RegExp(`${PLACEHOLDER}/(${tag})>`, 'gi')
    result = result.replace(closeRegex, '</$1>')
  }

  // Escape any remaining < placeholders as &lt;
  result = result.replace(new RegExp(PLACEHOLDER, 'g'), '&lt;')

  // Fix broken <a> tags: remove <a> without valid href, and their matching </a>
  // Replace broken <a> with a marker, then clean up
  result = result.replace(/<a\s*>/gi, '')  // <a> with no attributes
  result = result.replace(/<a\s+href\s*=\s*""?\s*>/gi, '')  // <a href="">
  result = result.replace(/<a\s+href\s*=\s*''?\s*>/gi, '')  // <a href=''>
  result = result.replace(/<a\s+>/gi, '')  // <a > (just whitespace)

  // Balance unclosed tags
  result = balanceHtmlTags(result)

  return result
}

/** Send a message via Telegram Bot API. */
async function sendTelegramMessage(text: string): Promise<void> {
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID
  if (!chatId) {
    logger.warn('TELEGRAM_ADMIN_CHAT_ID not configured')
    return
  }

  const sanitized = sanitizeTelegramHtml(text)
  const bot = getBot()
  const chunks = splitMessage(sanitized, MAX_TELEGRAM_MESSAGE_LENGTH)
  for (const chunk of chunks) {
    try {
      await bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' })
    } catch (htmlError) {
      // If HTML parsing fails, strip all tags and send as plain text
      const errMsg = htmlError instanceof Error ? htmlError.message : String(htmlError)
      logger.warn({ error: errMsg, chunkLen: chunk.length }, 'Telegram HTML parse failed, sending as plain text')
      const plainText = chunk.replace(/<[^>]+>/g, '')
      await bot.api.sendMessage(chatId, plainText)
    }
  }
}

/** Split a message into chunks that fit Telegram's limit, preserving line boundaries. */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }

    // Find last newline before maxLen
    let splitAt = remaining.lastIndexOf('\n', maxLen)
    if (splitAt === -1 || splitAt < maxLen / 2) {
      splitAt = maxLen
    }

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n/, '')
  }

  // Balance unclosed HTML tags in each chunk
  return chunks.map(balanceHtmlTags)
}

/** Balance HTML tags: close unclosed tags and remove orphaned closing tags. */
function balanceHtmlTags(chunk: string): string {
  const openTags: string[] = []
  const orphanedClosePositions: Array<{ start: number; end: number }> = []
  const tagRegex = /<\/?([a-z]+)[^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = tagRegex.exec(chunk)) !== null) {
    const isClosing = match[0].startsWith('</')
    const tagName = match[1].toLowerCase()
    if (isClosing) {
      const idx = openTags.lastIndexOf(tagName)
      if (idx !== -1) {
        openTags.splice(idx, 1)
      } else {
        // Orphaned closing tag — mark for removal
        orphanedClosePositions.push({ start: match.index, end: match.index + match[0].length })
      }
    } else if (!match[0].endsWith('/>')) {
      openTags.push(tagName)
    }
  }

  // Remove orphaned closing tags (iterate in reverse to preserve positions)
  let result = chunk
  for (let i = orphanedClosePositions.length - 1; i >= 0; i--) {
    const { start, end } = orphanedClosePositions[i]
    result = result.slice(0, start) + result.slice(end)
  }

  // Close unclosed tags
  if (openTags.length > 0) {
    result += openTags.reverse().map((t) => `</${t}>`).join('')
  }
  return result
}

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
        // Add jitter (0-30s) to prevent thundering herd when both companies retry simultaneously
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

  // Compile both companies in parallel (each has its own retry chain)
  const [acResult, hgResult] = await Promise.allSettled([
    compileWithRetry('astrocat'),
    compileWithRetry('highground'),
  ])

  const acText = acResult.status === 'fulfilled' ? acResult.value : null
  const hgText = hgResult.status === 'fulfilled' ? hgResult.value : null

  // Send AstroCat digest
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

  // Send Highground digest
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
