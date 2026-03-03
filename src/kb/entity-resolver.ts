import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../db/schema.js'
import { findEntityByName } from './repository.js'

type DB = NodePgDatabase<typeof schema>

/**
 * Resolve a person/project/entity name to an entity ID.
 * Tries exact match on kb_entities.name, then alias lookup.
 * Case-insensitive, works cross-language (Семён → Semyon).
 *
 * Returns entity ID or null if not found.
 */
export async function resolveEntity(
  db: DB,
  name: string,
): Promise<number | null> {
  const entity = await findEntityByName(db, name)
  return entity?.id ?? null
}

/**
 * Resolve multiple names to entity IDs.
 * Skips names that don't resolve. Returns unique IDs.
 */
export async function resolveEntities(
  db: DB,
  names: string[],
): Promise<number[]> {
  const ids: Set<number> = new Set()
  for (const name of names) {
    const id = await resolveEntity(db, name)
    if (id !== null) ids.add(id)
  }
  return [...ids]
}
