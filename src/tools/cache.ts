/**
 * Simple in-memory cache for tool results.
 * Avoids re-fetching Slack/KB/ClickUp data if it was recently collected.
 * TTL-based expiry, no persistence (cleared on restart).
 */

import { createHash } from 'node:crypto'

interface CacheEntry {
  data: unknown
  expiresAt: number
}

const store = new Map<string, CacheEntry>()

/** Default TTLs per tool type */
export const TTL = {
  slack: 30 * 60_000,       // 30 min — Slack data changes slowly
  kb: 60 * 60_000,          // 1 hour — vault data updates once/day
  clickup: 5 * 60_000,      // 5 min — tasks change frequently
  drive: 15 * 60_000,       // 15 min — docs change occasionally
} as const

function makeKey(tool: string, opts: unknown): string {
  const hash = createHash('md5').update(JSON.stringify({ tool, opts })).digest('hex').slice(0, 12)
  return `${tool}:${hash}`
}

export function getCached<T>(tool: string, opts: unknown): T | null {
  const key = makeKey(tool, opts)
  const entry = store.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    store.delete(key)
    return null
  }
  return entry.data as T
}

export function setCache(tool: string, opts: unknown, data: unknown, ttlMs: number): void {
  const key = makeKey(tool, opts)
  store.set(key, { data, expiresAt: Date.now() + ttlMs })
}

/** Clear all cache (useful after write operations) */
export function clearCache(): void {
  store.clear()
}
