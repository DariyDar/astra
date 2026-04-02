/**
 * Shared Telegram message sender.
 * Extracted from digest/scheduler.ts for reuse across digest, self-improve, and alerts.
 */

import { Bot } from 'grammy'
import { logger } from '../logging/logger.js'

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
const ALLOWED_TAGS = new Set(['b', 'i', 'u', 's', 'a', 'code', 'pre', 'blockquote'])

/**
 * Sanitize LLM output to valid Telegram HTML.
 * - Strips unsupported tags (keeps content)
 * - Escapes bare < > & that aren't part of valid tags
 * - Closes any unclosed tags
 */
export function sanitizeTelegramHtml(html: string): string {
  let result = html.replace(/```[a-z]*/g, '').replace(/```/g, '')

  const PLACEHOLDER = '\x00LT\x00'
  result = result.replace(/</g, PLACEHOLDER)

  for (const tag of ALLOWED_TAGS) {
    const openRegex = new RegExp(`${PLACEHOLDER}(${tag})(\\s[^>]*)?>`, 'gi')
    result = result.replace(openRegex, '<$1$2>')
    const openSimple = new RegExp(`${PLACEHOLDER}(${tag})>`, 'gi')
    result = result.replace(openSimple, '<$1>')
    const closeRegex = new RegExp(`${PLACEHOLDER}/(${tag})>`, 'gi')
    result = result.replace(closeRegex, '</$1>')
  }

  result = result.replace(new RegExp(PLACEHOLDER, 'g'), '&lt;')

  result = result.replace(/<a\s*>/gi, '')
  result = result.replace(/<a\s+href\s*=\s*""?\s*>/gi, '')
  result = result.replace(/<a\s+href\s*=\s*''?\s*>/gi, '')
  result = result.replace(/<a\s+>/gi, '')

  result = balanceHtmlTags(result)

  return result
}

/** Send a message via Telegram Bot API to admin chat. */
export async function sendTelegramMessage(text: string): Promise<void> {
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
      const errMsg = htmlError instanceof Error ? htmlError.message : String(htmlError)
      logger.warn({ error: errMsg, chunkLen: chunk.length }, 'Telegram HTML parse failed, sending as plain text')
      const plainText = chunk.replace(/<[^>]+>/g, '')
      await bot.api.sendMessage(chatId, plainText)
    }
  }
}

/** Split a message into chunks that fit Telegram's limit, preferring blockquote boundaries. */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }

    // Prefer splitting at end of a </blockquote> block (complete project section)
    let splitAt = -1
    const searchRange = remaining.slice(0, maxLen)
    const bqEnd = searchRange.lastIndexOf('</blockquote>')
    if (bqEnd !== -1) {
      splitAt = bqEnd + '</blockquote>'.length
    }

    // Fallback: split at double newline (paragraph boundary)
    if (splitAt === -1 || splitAt < maxLen / 3) {
      const dblNewline = searchRange.lastIndexOf('\n\n')
      if (dblNewline > maxLen / 3) splitAt = dblNewline
    }

    // Fallback: split at single newline
    if (splitAt === -1 || splitAt < maxLen / 3) {
      const newline = searchRange.lastIndexOf('\n')
      if (newline > maxLen / 3) splitAt = newline
    }

    // Last resort: hard cut
    if (splitAt === -1 || splitAt < maxLen / 3) {
      splitAt = maxLen
    }

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n/, '')
  }

  return chunks.map(balanceHtmlTags)
}

/** Balance HTML tags: close unclosed tags and remove orphaned closing tags. */
export function balanceHtmlTags(chunk: string): string {
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
        orphanedClosePositions.push({ start: match.index, end: match.index + match[0].length })
      }
    } else if (!match[0].endsWith('/>')) {
      openTags.push(tagName)
    }
  }

  let result = chunk
  for (let i = orphanedClosePositions.length - 1; i >= 0; i--) {
    const { start, end } = orphanedClosePositions[i]
    result = result.slice(0, start) + result.slice(end)
  }

  if (openTags.length > 0) {
    result += openTags.reverse().map((t) => `</${t}>`).join('')
  }
  return result
}
