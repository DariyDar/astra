import { logger } from '../logging/logger.js'
import { env } from '../config/env.js'

const GEMINI_MODEL = 'gemini-2.5-flash'
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_RETRIES = 3

// Rate limiter: 15 RPM for free tier
const RPM_LIMIT = 15
const RPM_WINDOW_MS = 60_000
const requestTimestamps: number[] = []

export interface GeminiOptions {
  /** System instruction for the model. */
  systemInstruction?: string
  /** Request JSON response format. */
  jsonMode?: boolean
  /** Timeout in ms. Default 120s. */
  timeoutMs?: number
  /** Max output tokens. Default: let model decide. */
  maxOutputTokens?: number
}

export interface GeminiResponse {
  text: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

/** Wait until we can make a request within the RPM limit. */
async function waitForRateLimit(): Promise<void> {
  while (true) {
    const now = Date.now()
    while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RPM_WINDOW_MS) {
      requestTimestamps.shift()
    }
    if (requestTimestamps.length < RPM_LIMIT) {
      requestTimestamps.push(Date.now())
      return
    }
    const waitMs = requestTimestamps[0] + RPM_WINDOW_MS - now + 100
    logger.debug({ waitMs }, 'Gemini rate limit: waiting')
    await new Promise((r) => setTimeout(r, waitMs))
  }
}

/** Strip API key from error messages to prevent leaking secrets. */
function sanitizeError(error: Error, apiKey: string): Error {
  if (error.message.includes(apiKey)) {
    error.message = error.message.replaceAll(apiKey, '[REDACTED]')
  }
  return error
}

/**
 * Call Gemini API via REST.
 * Uses raw fetch() — no SDK dependency.
 */
export async function callGemini(
  prompt: string,
  options?: GeminiOptions,
): Promise<GeminiResponse> {
  const apiKey = env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not configured')
  }

  await waitForRateLimit()

  const url = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      ...(options?.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
      ...(options?.jsonMode ? { responseMimeType: 'application/json' } : {}),
    },
  }

  if (options?.systemInstruction) {
    body.systemInstruction = {
      parts: [{ text: options.systemInstruction }],
    }
  }

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (response.status === 429) {
        const backoff = Math.min(2 ** attempt * 2000, 30_000)
        logger.warn({ attempt, backoffMs: backoff }, 'Gemini 429: rate limited, retrying')
        await new Promise((r) => setTimeout(r, backoff))
        continue
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown')
        throw new Error(`Gemini API error ${response.status}: ${errorText.slice(0, 500)}`)
      }

      const data = await response.json() as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> }
        }>
        usageMetadata?: {
          promptTokenCount?: number
          candidatesTokenCount?: number
          totalTokenCount?: number
        }
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''

      return {
        text,
        usage: data.usageMetadata ? {
          promptTokens: data.usageMetadata.promptTokenCount ?? 0,
          completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: data.usageMetadata.totalTokenCount ?? 0,
        } : undefined,
      }
    } catch (error) {
      lastError = sanitizeError(
        error instanceof Error ? error : new Error(String(error)),
        apiKey,
      )

      if (lastError.name === 'TimeoutError' || lastError.message.includes('timed out')) {
        logger.warn({ attempt, timeoutMs }, 'Gemini request timed out')
        if (attempt < MAX_RETRIES) continue
      }

      // Don't retry non-retryable errors
      if (!lastError.message.includes('429') && !lastError.message.includes('timed out')) {
        throw lastError
      }
    }
  }

  throw lastError ?? new Error('Gemini call failed after retries')
}

/** Reset rate limiter (for testing). */
export function resetRateLimiter(): void {
  requestTimestamps.length = 0
}
