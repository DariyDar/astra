/**
 * HTTP client for the Graphiti REST API (Python FastAPI server).
 * All knowledge graph operations go through this client.
 */

import { logger } from '../logging/logger.js'

const GRAPHITI_URL = process.env.GRAPHITI_URL ?? 'http://localhost:3200'
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2_000
const REQUEST_TIMEOUT_MS = 180_000

// ── DTOs ──

export interface GraphitiMessage {
  content: string
  uuid?: string
  name?: string
  role_type?: string
  role?: string
  timestamp?: string
  source_description?: string
}

export interface GraphitiFact {
  uuid: string
  name: string
  fact: string
  valid_at: string | null
  invalid_at: string | null
  created_at: string | null
  expired_at: string | null
}

export interface GraphitiEpisode {
  uuid: string
  name: string
  content: string
  created_at: string | null
}

// ── Core HTTP ──

async function graphitiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${GRAPHITI_URL}${path}`

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const err = new Error(`Graphiti ${res.status}: ${body}`)
        // Don't retry client errors (4xx)
        if (res.status >= 400 && res.status < 500) throw err
        throw err
      }

      return await res.json() as T
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const isClientError = msg.includes('Graphiti 4')

      if (isClientError || attempt >= MAX_RETRIES) {
        if (!isClientError) {
          logger.error({ path, attempts: MAX_RETRIES, error: msg }, 'Graphiti request failed after all retries')
        }
        throw error
      }

      logger.warn({ path, attempt, error: msg }, 'Graphiti request failed, retrying')
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt))
    } finally {
      clearTimeout(timeoutId)
    }
  }

  throw new Error('Unreachable')
}

// ── Health ──

export async function healthcheck(): Promise<boolean> {
  try {
    await graphitiFetch<{ status: string }>('/healthcheck')
    return true
  } catch {
    return false
  }
}

// ── Ingest ──

export async function addEpisode(
  groupId: string,
  message: GraphitiMessage,
): Promise<{ uuid: string; status: string }> {
  const result = await graphitiFetch<{ results: Array<{ uuid: string; status: string }> }>(
    '/messages',
    {
      method: 'POST',
      body: JSON.stringify({
        group_id: groupId,
        messages: [message],
      }),
    },
  )

  if (!result.results || result.results.length === 0) {
    throw new Error('Graphiti /messages returned no results')
  }

  return result.results[0]
}

export async function addEpisodes(
  groupId: string,
  messages: GraphitiMessage[],
): Promise<Array<{ uuid: string; status: string }>> {
  const result = await graphitiFetch<{ results: Array<{ uuid: string; status: string }> }>(
    '/messages',
    {
      method: 'POST',
      body: JSON.stringify({
        group_id: groupId,
        messages,
      }),
    },
  )
  return result.results
}

// ── Delete ──

export async function deleteEpisode(episodeUuid: string): Promise<void> {
  await graphitiFetch(`/episode/${episodeUuid}`, { method: 'DELETE' })
}

// ── Search ──

export async function search(
  query: string,
  options: { groupIds?: string[]; maxFacts?: number } = {},
): Promise<GraphitiFact[]> {
  const result = await graphitiFetch<{ facts: GraphitiFact[] }>('/search', {
    method: 'POST',
    body: JSON.stringify({
      group_ids: options.groupIds ?? [],
      query,
      max_facts: options.maxFacts ?? 10,
    }),
  })
  return result.facts
}

// ── Retrieve ──

export async function getEpisodes(
  groupId: string,
  lastN: number = 10,
): Promise<{ group_id: string; episodes: GraphitiEpisode[] }> {
  return graphitiFetch(`/episodes/${groupId}?last_n=${lastN}`)
}
