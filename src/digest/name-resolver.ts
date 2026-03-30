/**
 * Resolves Slack display names to short Russian display names from KB entities.
 * Built once per digest run, maps all known aliases → display_name.
 */

import { findEntitiesByType, getAliasesForEntityIds } from '../kb/vault-reader.js'
import { logger } from '../logging/logger.js'

export type NameMap = Map<string, string>

/**
 * Build a name normalization map from KB person entities.
 * Maps every known alias (lowercase) → display_name from metadata.
 * Returns a Map for O(1) lookups.
 */
export async function buildNameMap(): Promise<NameMap> {
  const people = await findEntitiesByType('person')
  const personIds = people.map((p) => p.id)

  const aliases = await getAliasesForEntityIds(personIds)

  const aliasMap = new Map<string, string[]>()
  for (const a of aliases) {
    const eid = a.entityId
    const list = aliasMap.get(eid) ?? []
    list.push(a.alias)
    aliasMap.set(eid, list)
  }

  const nameMap: NameMap = new Map()

  for (const person of people) {
    const metadata = person.metadata as Record<string, unknown> | null
    const displayName = (metadata?.display_name as string) ?? ''
    if (!displayName) continue

    // Map the entity name itself
    setWithCollisionCheck(nameMap, person.name.toLowerCase(), displayName)

    // Map all aliases
    const personAliases = aliasMap.get(person.id) ?? []
    for (const alias of personAliases) {
      setWithCollisionCheck(nameMap, alias.toLowerCase(), displayName)
    }
  }

  return nameMap
}

function setWithCollisionCheck(map: NameMap, key: string, value: string): void {
  const existing = map.get(key)
  if (existing && existing !== value) {
    logger.warn({ alias: key, existing, new: value }, 'NameMap: alias collision, overwriting')
  }
  map.set(key, value)
}

/**
 * Resolve a Slack author name to its short Russian display name.
 * Tries: full name → first name only → original.
 * This handles cases like "Danil Koryakin" when aliases have "Danil" but not the full English name.
 */
export function resolveDisplayName(name: string, nameMap: NameMap): string {
  const lower = name.toLowerCase()
  // Try full name first
  const full = nameMap.get(lower)
  if (full) return full
  // Try first name only (handles "Danil Koryakin" → match "danil" → "Данил")
  const firstName = lower.split(/\s+/)[0]
  if (firstName && firstName !== lower) {
    const first = nameMap.get(firstName)
    if (first) return first
  }
  return name
}
