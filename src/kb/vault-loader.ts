/**
 * Utility for loading prompt files from the vault directory.
 * Supports optional caching with configurable TTL.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const VAULT_DIR = join(process.cwd(), 'vault')

/** Load a prompt file from the vault directory (no caching). */
export function loadPrompt(relativePath: string): string {
  const fullPath = join(VAULT_DIR, relativePath)
  if (!existsSync(fullPath)) throw new Error(`Prompt file not found: ${fullPath}`)
  return readFileSync(fullPath, 'utf-8')
}

/** Cached prompt entry. */
interface CacheEntry {
  content: string
  cachedAt: number
}

const promptCache = new Map<string, CacheEntry>()

/** Load a prompt file with TTL-based caching. Default TTL: 1 hour. */
export function loadPromptCached(relativePath: string, ttlMs = 60 * 60 * 1000): string {
  const entry = promptCache.get(relativePath)
  if (entry && Date.now() - entry.cachedAt < ttlMs) {
    return entry.content
  }
  const content = loadPrompt(relativePath)
  promptCache.set(relativePath, { content, cachedAt: Date.now() })
  return content
}
