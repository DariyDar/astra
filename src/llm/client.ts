import Anthropic from '@anthropic-ai/sdk'
import type pino from 'pino'
import { logger } from '../logging/logger.js'
import { writeAuditEntry } from '../logging/audit.js'
import { sendHealthAlert } from '../health/alerter.js'

/**
 * Hardcoded model: single model for ALL tasks per user decision.
 * No tiering, no classification, no fallback chains.
 */
const MODEL = 'claude-sonnet-4-20250514'
const DEFAULT_MAX_TOKENS = 4096

let anthropicClient: Anthropic | null = null

function getClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    })
  }
  return anthropicClient
}

/**
 * Send a message to Claude Sonnet and return the response.
 * Logs token usage, writes audit entry, and alerts user on API errors.
 *
 * Error handling per user decision:
 * - 529/503: Alert user via Telegram ("Claude is temporarily unavailable")
 * - 429: Log warning only (transient rate limit, no user alert)
 * - 401: Log critical + alert user ("API key issue detected")
 * - All errors are re-thrown after handling
 */
export async function callClaude(
  messages: Anthropic.MessageParam[],
  options?: { maxTokens?: number; system?: string },
  requestLogger?: pino.Logger,
): Promise<Anthropic.Message> {
  const log = requestLogger ?? logger
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS

  try {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      messages,
      ...(options?.system ? { system: options.system } : {}),
    })

    log.info(
      {
        event: 'llm_response',
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        stopReason: response.stop_reason,
      },
      'Claude API response received',
    )

    await writeAuditEntry({
      correlationId:
        (log.bindings() as { correlationId?: string }).correlationId ??
        'unknown',
      action: 'llm_request',
      model: response.model,
      metadata: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        stopReason: response.stop_reason,
      },
      status: 'success',
    })

    return response
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      const status = error.status

      if (status === 529 || status === 503) {
        log.error(
          { status, message: error.message },
          'Claude API unavailable',
        )
        await sendHealthAlert(
          "Claude is temporarily unavailable. I'll keep trying and let you know when it's back.",
        )
      } else if (status === 429) {
        log.warn(
          { status, message: error.message },
          'Claude API rate limited (transient)',
        )
      } else if (status === 401) {
        log.fatal(
          { status, message: error.message },
          'Claude API authentication failure',
        )
        await sendHealthAlert(
          'API key issue detected. Please check the ANTHROPIC_API_KEY configuration.',
        )
      } else {
        log.error(
          { status, message: error.message },
          'Claude API error',
        )
      }

      await writeAuditEntry({
        correlationId:
          (log.bindings() as { correlationId?: string }).correlationId ??
          'unknown',
        action: 'llm_request',
        model: MODEL,
        metadata: { status, errorType: error.constructor.name },
        status: 'error',
        errorMessage: error.message,
      })
    }

    throw error
  }
}
