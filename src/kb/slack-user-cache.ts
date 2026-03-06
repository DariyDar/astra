import { SLACK_WORKSPACES } from '../mcp/briefing/slack.js'
import { logger } from '../logging/logger.js'

const USERS_PER_PAGE = 200
const CACHE_TTL_MS = 10 * 60 * 1000  // 10 minutes

/** Module-level cache to avoid re-fetching users from Slack API on every call. */
let cachedResult: Map<string, string> | null = null
let cacheTimestamp = 0

interface SlackUser {
  id: string
  deleted?: boolean
  real_name?: string
  profile?: {
    display_name?: string
    real_name?: string
  }
}

interface UsersListResponse {
  ok: boolean
  members?: SlackUser[]
  response_metadata?: { next_cursor?: string }
}

/**
 * Build a Map of Slack user ID → display name from both AC and HG workspaces.
 * Includes deactivated users (they appear in historical messages).
 */
export async function buildSlackUserCache(): Promise<Map<string, string>> {
  if (cachedResult && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedResult
  }

  const cache = new Map<string, string>()

  for (const ws of SLACK_WORKSPACES) {
    const headers = { Authorization: `Bearer ${ws.token}` }
    let cursor = ''
    let wsCount = 0

    do {
      const params = new URLSearchParams({
        limit: String(USERS_PER_PAGE),
        include_locale: 'false',
      })
      if (cursor) params.set('cursor', cursor)

      const resp = await fetch(
        `https://slack.com/api/users.list?${params}`,
        { headers, signal: AbortSignal.timeout(15_000) },
      )

      if (!resp.ok) {
        logger.warn({ workspace: ws.label, status: resp.status }, 'Slack users.list failed')
        break
      }

      const data = await resp.json() as UsersListResponse
      if (!data.ok) {
        logger.warn({ workspace: ws.label }, 'Slack users.list returned ok=false')
        break
      }

      for (const user of data.members ?? []) {
        const displayName =
          user.profile?.display_name?.trim() ||
          user.profile?.real_name?.trim() ||
          user.real_name?.trim() ||
          user.id

        cache.set(user.id, displayName)
        wsCount++
      }

      cursor = data.response_metadata?.next_cursor || ''
    } while (cursor)

    logger.info({ workspace: ws.label, users: wsCount }, 'Slack user cache built')
  }

  logger.info({ totalUsers: cache.size }, 'Slack user cache complete')
  cachedResult = cache
  cacheTimestamp = Date.now()
  return cache
}

/**
 * Resolve a single user ID to display name via users.info API.
 * Used as fallback for Slack Connect guests not returned by users.list.
 * Result is cached in the module-level cache for subsequent calls.
 */
export async function resolveUserId(userId: string, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(userId)
  if (cached) return cached

  for (const ws of SLACK_WORKSPACES) {
    try {
      const resp = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
        headers: { Authorization: `Bearer ${ws.token}` },
        signal: AbortSignal.timeout(5_000),
      })
      if (!resp.ok) continue
      const data = await resp.json() as { ok: boolean; user?: SlackUser }
      if (!data.ok || !data.user) continue

      const u = data.user
      const name =
        u.profile?.display_name?.trim() ||
        u.profile?.real_name?.trim() ||
        u.real_name?.trim() ||
        userId
      cache.set(userId, name)
      return name
    } catch {
      continue
    }
  }

  return userId
}

/**
 * Replace <@U123> and <@U123|display_name> patterns with resolved display names.
 * If user ID not found in cache, falls back to pipe display name or keeps raw ID.
 */
export function resolveSlackMentions(text: string, cache: Map<string, string>): string {
  return text.replace(/<@(U[A-Z0-9]+)(?:\|([^>]*))?>/g, (_match, userId: string, pipeName?: string) => {
    const cached = cache.get(userId)
    if (cached) return cached

    // Fall back to pipe display name if present and non-empty
    if (pipeName?.trim()) return pipeName.trim()

    // No resolution available — keep original
    return _match
  })
}

/**
 * Async version of resolveSlackMentions — resolves unknown user IDs via users.info API.
 * Use for digest where we want all names resolved.
 */
export async function resolveSlackMentionsAsync(text: string, cache: Map<string, string>): Promise<string> {
  const mentionPattern = /<@(U[A-Z0-9]+)(?:\|([^>]*))?>/g
  const matches = [...text.matchAll(mentionPattern)]
  if (matches.length === 0) return text

  // Resolve unknown IDs in parallel
  const unknownIds = new Set<string>()
  for (const m of matches) {
    if (!cache.has(m[1])) unknownIds.add(m[1])
  }
  if (unknownIds.size > 0) {
    await Promise.all([...unknownIds].map((id) => resolveUserId(id, cache)))
  }

  // Now replace synchronously — all IDs should be cached
  return resolveSlackMentions(text, cache)
}
