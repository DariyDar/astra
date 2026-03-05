import { logger } from '../logging/logger.js'
import { env } from '../config/env.js'

const GEMINI_MODEL = 'gemini-2.5-flash'
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_RETRIES = 5

/** Collect all available Gemini API keys for round-robin rotation. */
function getApiKeys(): string[] {
  const keys: string[] = []
  if (env.GEMINI_API_KEY_PERSONAL) keys.push(env.GEMINI_API_KEY_PERSONAL)
  if (env.GEMINI_API_KEY_HG) keys.push(env.GEMINI_API_KEY_HG)
  if (env.GEMINI_API_KEY_AC) keys.push(env.GEMINI_API_KEY_AC)
  if (keys.length === 0 && env.GEMINI_API_KEY) keys.push(env.GEMINI_API_KEY)
  return keys
}

let keyIndex = 0

/** Get next API key via round-robin. */
function nextApiKey(): string {
  const keys = getApiKeys()
  if (keys.length === 0) throw new Error('No GEMINI_API_KEY configured')
  const key = keys[keyIndex % keys.length]
  keyIndex++
  return key
}

// Per-key rate limiter: track timestamps per key
const perKeyTimestamps = new Map<string, number[]>()
const RPM_LIMIT = 10 // Conservative: Gemini free tier is 20 RPM but 429s happen earlier
const RPM_WINDOW_MS = 60_000
const MAX_RATE_LIMIT_WAIT_MS = 120_000 // Never wait longer than 2 minutes

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

/** Wait until we can make a request within the per-key RPM limit. Throws if wait exceeds MAX_RATE_LIMIT_WAIT_MS. */
async function waitForRateLimit(apiKey: string): Promise<void> {
  if (!perKeyTimestamps.has(apiKey)) perKeyTimestamps.set(apiKey, [])
  const timestamps = perKeyTimestamps.get(apiKey)!
  const waitStart = Date.now()

  while (true) {
    const now = Date.now()
    // Safety: never wait longer than MAX_RATE_LIMIT_WAIT_MS
    if (now - waitStart > MAX_RATE_LIMIT_WAIT_MS) {
      logger.warn({ apiKeyTail: apiKey.slice(-6), waitedMs: now - waitStart }, 'Gemini rate limit: max wait exceeded, proceeding anyway')
      timestamps.push(Date.now())
      return
    }
    while (timestamps.length > 0 && timestamps[0] < now - RPM_WINDOW_MS) {
      timestamps.shift()
    }
    if (timestamps.length < RPM_LIMIT) {
      timestamps.push(Date.now())
      return
    }
    const waitMs = Math.min(timestamps[0] + RPM_WINDOW_MS - now + 100, 30_000)
    logger.debug({ waitMs, keyTail: apiKey.slice(-6) }, 'Gemini rate limit: waiting')
    await new Promise((r) => setTimeout(r, waitMs))
  }
}

/** Strip API keys from error messages to prevent leaking secrets. */
function sanitizeError(error: Error): Error {
  for (const key of getApiKeys()) {
    if (error.message.includes(key)) {
      error.message = error.message.replaceAll(key, '[REDACTED]')
    }
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
  let apiKey = nextApiKey()

  await waitForRateLimit(apiKey)

  let url = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`
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
        // Always wait before retrying — Gemini needs time to reset its RPM window
        const backoff = Math.min(2 ** attempt * 5000, 60_000)
        const keys = getApiKeys()
        if (keys.length > 1) {
          const nextKey = nextApiKey()
          logger.warn({ attempt, keysAvailable: keys.length, backoffMs: backoff }, 'Gemini 429: backing off then rotating key')
          await new Promise((r) => setTimeout(r, backoff))
          await waitForRateLimit(nextKey)
          url = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${nextKey}`
          apiKey = nextKey
        } else {
          logger.warn({ attempt, backoffMs: backoff }, 'Gemini 429: rate limited, retrying')
          await new Promise((r) => setTimeout(r, backoff))
        }
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
  perKeyTimestamps.clear()
  keyIndex = 0
}
