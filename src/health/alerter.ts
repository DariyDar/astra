import { Bot } from 'grammy'
import { logger } from '../logging/logger.js'

/**
 * Rate-limiting state: track last alert time per service/context.
 * Don't send more than 1 alert per service per 5 minutes.
 */
const lastAlertTimes = new Map<string, number>()
const ALERT_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes

let alertBot: InstanceType<typeof Bot> | null = null

function getAlertBot(): InstanceType<typeof Bot> {
  if (!alertBot) {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN not configured for health alerts')
    }
    alertBot = new Bot(token)
  }
  return alertBot
}

/**
 * Send a health alert message to the admin via Telegram.
 * Rate-limited: at most 1 alert per unique message per 5 minutes.
 * Catches send errors to prevent alert failure from cascading.
 */
export async function sendHealthAlert(message: string): Promise<void> {
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID
  if (!chatId) {
    logger.warn('TELEGRAM_ADMIN_CHAT_ID not configured, skipping health alert')
    return
  }

  // Rate-limit by message content (first 50 chars as key)
  const alertKey = message.substring(0, 50)
  const now = Date.now()
  const lastSent = lastAlertTimes.get(alertKey)

  if (lastSent && now - lastSent < ALERT_COOLDOWN_MS) {
    logger.debug(
      { alertKey, cooldownRemaining: ALERT_COOLDOWN_MS - (now - lastSent) },
      'Health alert suppressed (rate limited)',
    )
    return
  }

  try {
    await getAlertBot().api.sendMessage(chatId, `[Astra Health] ${message}`)
    lastAlertTimes.set(alertKey, now)
    logger.info({ message }, 'Health alert sent to Telegram')
  } catch (error) {
    logger.error({ error, message }, 'Failed to send health alert via Telegram')
  }
}
