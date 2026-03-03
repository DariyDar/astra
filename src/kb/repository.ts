import { eq, and, ilike, sql, inArray } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  kbEntities,
  kbEntityAliases,
  kbEntityRelations,
  kbChunks,
  kbIngestionState,
} from '../db/schema.js'
import type * as schema from '../db/schema.js'
import type { EntityType, RelationType, ChunkSource, IngestionStatus } from './types.js'

type DB = NodePgDatabase<typeof schema>

// ── Entity operations ──

export async function createEntity(
  db: DB,
  entity: { type: EntityType; name: string; company?: string; metadata?: Record<string, unknown> },
): Promise<number> {
  const [row] = await db.insert(kbEntities).values({
    type: entity.type,
    name: entity.name,
    company: entity.company ?? null,
    metadata: entity.metadata ?? null,
  }).onConflictDoNothing().returning({ id: kbEntities.id })

  if (row) return row.id

  // Already exists — fetch the ID
  const [existing] = await db.select({ id: kbEntities.id })
    .from(kbEntities)
    .where(and(eq(kbEntities.type, entity.type), eq(kbEntities.name, entity.name)))

  return existing.id
}

export async function findEntityByName(
  db: DB,
  name: string,
): Promise<{ id: number; type: EntityType; name: string; company: string | null } | null> {
  // Try exact match on entities
  const [direct] = await db.select({
    id: kbEntities.id,
    type: kbEntities.type,
    name: kbEntities.name,
    company: kbEntities.company,
  }).from(kbEntities).where(ilike(kbEntities.name, name)).limit(1)

  if (direct) return { ...direct, type: direct.type as EntityType }

  // Try alias match
  const [alias] = await db.select({
    id: kbEntities.id,
    type: kbEntities.type,
    name: kbEntities.name,
    company: kbEntities.company,
  })
    .from(kbEntityAliases)
    .innerJoin(kbEntities, eq(kbEntityAliases.entityId, kbEntities.id))
    .where(ilike(kbEntityAliases.alias, name))
    .limit(1)

  if (alias) return { ...alias, type: alias.type as EntityType }

  return null
}

export async function findEntitiesByType(
  db: DB,
  type: EntityType,
): Promise<Array<{ id: number; name: string; company: string | null; metadata: unknown }>> {
  return db.select({
    id: kbEntities.id,
    name: kbEntities.name,
    company: kbEntities.company,
    metadata: kbEntities.metadata,
  }).from(kbEntities).where(eq(kbEntities.type, type))
}

// ── Alias operations ──

export async function addAlias(
  db: DB,
  entityId: number,
  alias: string,
  language?: string,
): Promise<void> {
  await db.insert(kbEntityAliases).values({
    entityId,
    alias,
    language: language ?? null,
  }).onConflictDoNothing()
}

export async function resolveAlias(
  db: DB,
  name: string,
): Promise<number | null> {
  const entity = await findEntityByName(db, name)
  return entity?.id ?? null
}

// ── Relation operations ──

export async function addRelation(
  db: DB,
  rel: {
    fromId: number
    toId: number
    relation: RelationType
    role?: string
    status?: string
    period?: string
    metadata?: Record<string, unknown>
  },
): Promise<void> {
  // Check if this exact relation already exists
  const [existing] = await db.select({ id: kbEntityRelations.id })
    .from(kbEntityRelations)
    .where(and(
      eq(kbEntityRelations.fromId, rel.fromId),
      eq(kbEntityRelations.toId, rel.toId),
      eq(kbEntityRelations.relation, rel.relation),
    ))
    .limit(1)

  if (existing) return

  await db.insert(kbEntityRelations).values({
    fromId: rel.fromId,
    toId: rel.toId,
    relation: rel.relation,
    role: rel.role ?? null,
    status: rel.status ?? 'active',
    period: rel.period ?? null,
    metadata: rel.metadata ?? null,
  })
}

export async function getRelationsFor(
  db: DB,
  entityId: number,
): Promise<Array<{
  id: number
  fromId: number
  toId: number
  relation: string
  role: string | null
  status: string | null
  fromName: string
  toName: string
  fromType: string
  toType: string
}>> {
  const fromEntity = db.$with('from_entity').as(
    db.select({ id: kbEntities.id, name: kbEntities.name, type: kbEntities.type }).from(kbEntities),
  )
  const toEntity = db.$with('to_entity').as(
    db.select({ id: kbEntities.id, name: kbEntities.name, type: kbEntities.type }).from(kbEntities),
  )

  // Simple approach: two separate queries for from/to
  const asFrom = await db.select({
    id: kbEntityRelations.id,
    fromId: kbEntityRelations.fromId,
    toId: kbEntityRelations.toId,
    relation: kbEntityRelations.relation,
    role: kbEntityRelations.role,
    status: kbEntityRelations.status,
  }).from(kbEntityRelations).where(eq(kbEntityRelations.fromId, entityId))

  const asTo = await db.select({
    id: kbEntityRelations.id,
    fromId: kbEntityRelations.fromId,
    toId: kbEntityRelations.toId,
    relation: kbEntityRelations.relation,
    role: kbEntityRelations.role,
    status: kbEntityRelations.status,
  }).from(kbEntityRelations).where(eq(kbEntityRelations.toId, entityId))

  const allRels = [...asFrom, ...asTo]
  if (allRels.length === 0) return []

  // Fetch entity names for all referenced IDs
  const entityIdSet = new Set<number>()
  for (const r of allRels) {
    entityIdSet.add(r.fromId)
    entityIdSet.add(r.toId)
  }

  const entities = await db.select({
    id: kbEntities.id,
    name: kbEntities.name,
    type: kbEntities.type,
  }).from(kbEntities).where(inArray(kbEntities.id, [...entityIdSet]))

  const nameMap = new Map(entities.map((e) => [e.id, e]))

  return allRels.map((r) => ({
    ...r,
    fromName: nameMap.get(r.fromId)?.name ?? 'unknown',
    toName: nameMap.get(r.toId)?.name ?? 'unknown',
    fromType: nameMap.get(r.fromId)?.type ?? 'unknown',
    toType: nameMap.get(r.toId)?.type ?? 'unknown',
  }))
}

// ── Chunk operations ──

export async function upsertChunk(
  db: DB,
  chunk: {
    source: ChunkSource
    sourceId: string
    chunkIndex: number
    contentHash: string
    text: string
    qdrantId?: string
    entityIds?: number[]
    metadata?: Record<string, unknown>
    sourceDate?: Date
  },
): Promise<{ id: string; isNew: boolean }> {
  const [existing] = await db.select({ id: kbChunks.id, contentHash: kbChunks.contentHash })
    .from(kbChunks)
    .where(and(
      eq(kbChunks.source, chunk.source),
      eq(kbChunks.sourceId, chunk.sourceId),
      eq(kbChunks.chunkIndex, chunk.chunkIndex),
    ))
    .limit(1)

  if (existing) {
    // Already exists — skip if same hash (no update needed)
    if (existing.contentHash === chunk.contentHash) {
      return { id: existing.id.toString(), isNew: false }
    }
    // Content changed — update
    await db.update(kbChunks)
      .set({
        contentHash: chunk.contentHash,
        text: chunk.text,
        qdrantId: chunk.qdrantId ?? null,
        entityIds: chunk.entityIds ?? null,
        metadata: chunk.metadata ?? null,
        sourceDate: chunk.sourceDate ?? null,
      })
      .where(eq(kbChunks.id, existing.id))
    return { id: existing.id.toString(), isNew: false }
  }

  const [row] = await db.insert(kbChunks).values({
    source: chunk.source,
    sourceId: chunk.sourceId,
    chunkIndex: chunk.chunkIndex,
    contentHash: chunk.contentHash,
    text: chunk.text,
    qdrantId: chunk.qdrantId ?? null,
    entityIds: chunk.entityIds ?? null,
    metadata: chunk.metadata ?? null,
    sourceDate: chunk.sourceDate ?? null,
  }).returning({ id: kbChunks.id })

  return { id: row.id.toString(), isNew: true }
}

export async function findChunksBySource(
  db: DB,
  source: ChunkSource,
  limit: number = 100,
): Promise<Array<{ id: string; sourceId: string; text: string; metadata: unknown }>> {
  const rows = await db.select({
    id: kbChunks.id,
    sourceId: kbChunks.sourceId,
    text: kbChunks.text,
    metadata: kbChunks.metadata,
  }).from(kbChunks).where(eq(kbChunks.source, source)).limit(limit)

  return rows.map((r) => ({ ...r, id: r.id.toString() }))
}

export async function findUnprocessedChunks(
  db: DB,
  limit: number = 50,
): Promise<Array<{ id: string; source: string; sourceId: string; text: string; metadata: unknown }>> {
  const rows = await db.select({
    id: kbChunks.id,
    source: kbChunks.source,
    sourceId: kbChunks.sourceId,
    text: kbChunks.text,
    metadata: kbChunks.metadata,
  }).from(kbChunks)
    .where(sql`${kbChunks.entityIds} IS NULL`)
    .limit(limit)

  return rows.map((r) => ({ ...r, id: r.id.toString() }))
}

export async function updateChunkEntityIds(
  db: DB,
  chunkId: string,
  entityIds: number[],
): Promise<void> {
  await db.update(kbChunks)
    .set({ entityIds })
    .where(eq(kbChunks.id, BigInt(chunkId)))
}

export async function searchChunksByKeyword(
  db: DB,
  keyword: string,
  filters: { source?: ChunkSource; after?: Date; before?: Date },
  limit: number = 20,
): Promise<Array<{ id: string; source: string; sourceId: string; text: string; sourceDate: Date | null; metadata: unknown }>> {
  const conditions = [ilike(kbChunks.text, `%${keyword}%`)]

  if (filters.source) conditions.push(eq(kbChunks.source, filters.source))
  if (filters.after) conditions.push(sql`${kbChunks.sourceDate} >= ${filters.after}`)
  if (filters.before) conditions.push(sql`${kbChunks.sourceDate} <= ${filters.before}`)

  const rows = await db.select({
    id: kbChunks.id,
    source: kbChunks.source,
    sourceId: kbChunks.sourceId,
    text: kbChunks.text,
    sourceDate: kbChunks.sourceDate,
    metadata: kbChunks.metadata,
  }).from(kbChunks).where(and(...conditions)).limit(limit)

  return rows.map((r) => ({ ...r, id: r.id.toString() }))
}

// ── Ingestion state operations ──

export async function getIngestionState(
  db: DB,
  source: string,
): Promise<KBIngestionStateRow | null> {
  const [row] = await db.select().from(kbIngestionState).where(eq(kbIngestionState.source, source)).limit(1)
  return row ?? null
}

export async function setIngestionState(
  db: DB,
  source: string,
  state: {
    watermark: string
    status?: IngestionStatus
    itemsTotal?: number
    error?: string | null
  },
): Promise<void> {
  const values = {
    source,
    watermark: state.watermark,
    status: state.status ?? 'idle',
    itemsTotal: state.itemsTotal ?? 0,
    error: state.error ?? null,
    lastRun: new Date(),
    updatedAt: new Date(),
  }

  await db.insert(kbIngestionState).values(values).onConflictDoUpdate({
    target: kbIngestionState.source,
    set: {
      watermark: values.watermark,
      status: values.status,
      itemsTotal: values.itemsTotal,
      error: values.error,
      lastRun: values.lastRun,
      updatedAt: values.updatedAt,
    },
  })
}

interface KBIngestionStateRow {
  id: number
  source: string
  watermark: string
  lastRun: Date | null
  itemsTotal: number | null
  status: string | null
  error: string | null
  updatedAt: Date | null
}
