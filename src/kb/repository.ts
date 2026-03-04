import { eq, and, ilike, sql, inArray } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  kbEntities,
  kbEntityAliases,
  kbEntityRelations,
  kbChunks,
  kbIngestionState,
  kbFacts,
  kbDocuments,
} from '../db/schema.js'
import type * as schema from '../db/schema.js'
import type { EntityType, RelationType, ChunkSource, IngestionStatus, FactType, DocType } from './types.js'

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

/** Shared quality filter conditions for extractable chunks. */
function extractableChunkConditions(minTextLength: number = 100) {
  return and(
    sql`${kbChunks.entityIds} IS NULL`,
    sql`length(${kbChunks.text}) > ${minTextLength}`,
    sql`${kbChunks.text} NOT LIKE '%[metadata-only stub]%'`,
    sql`${kbChunks.text} NOT LIKE '%[system email -- metadata only]%'`,
    sql`${kbChunks.source} != 'drive'`,
  )
}

export async function findUnprocessedChunks(
  db: DB,
  limit: number = 50,
  options?: { minTextLength?: number },
): Promise<Array<{ id: string; source: string; sourceId: string; text: string; qdrantId: string | null; metadata: unknown; sourceDate: Date | null }>> {
  const rows = await db.select({
    id: kbChunks.id,
    source: kbChunks.source,
    sourceId: kbChunks.sourceId,
    text: kbChunks.text,
    qdrantId: kbChunks.qdrantId,
    metadata: kbChunks.metadata,
    sourceDate: kbChunks.sourceDate,
  }).from(kbChunks)
    .where(extractableChunkConditions(options?.minTextLength))
    .orderBy(
      sql`CASE ${kbChunks.source}
        WHEN 'slack' THEN 1
        WHEN 'clickup' THEN 2
        WHEN 'notion' THEN 3
        WHEN 'gmail' THEN 4
        WHEN 'calendar' THEN 5
        ELSE 6
      END`,
      sql`${kbChunks.sourceDate} DESC NULLS LAST`,
    )
    .limit(limit)

  return rows.map((r) => ({ ...r, id: r.id.toString(), qdrantId: r.qdrantId ?? null, sourceDate: r.sourceDate ?? null }))
}

export async function countUnprocessedChunks(db: DB): Promise<number> {
  const [row] = await db.select({
    count: sql<number>`count(*)::int`,
  }).from(kbChunks)
    .where(extractableChunkConditions())
  return row?.count ?? 0
}

export async function getAllEntityNames(
  db: DB,
): Promise<Array<{ name: string; type: string }>> {
  return db.select({
    name: kbEntities.name,
    type: kbEntities.type,
  }).from(kbEntities).orderBy(kbEntities.name)
}

export async function markChunksProcessed(
  db: DB,
  filter: 'low-value',
): Promise<number> {
  if (filter !== 'low-value') return 0

  // Mark chunks that DON'T pass the extractable filter (inverse of extractableChunkConditions)
  const updated = await db.update(kbChunks)
    .set({ entityIds: sql`'{}'::int[]` })
    .where(and(
      sql`${kbChunks.entityIds} IS NULL`,
      sql`(
        length(${kbChunks.text}) < 100
        OR ${kbChunks.text} LIKE '%[metadata-only stub]%'
        OR ${kbChunks.text} LIKE '%[system email -- metadata only]%'
        OR ${kbChunks.source} = 'drive'
      )`,
    ))
    .returning({ id: kbChunks.id })

  return updated.length
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

// ── Fact operations ──

export async function addFact(
  db: DB,
  fact: {
    entityId: number
    factDate?: Date | null
    factType: FactType
    text: string
    source: ChunkSource
    sourceChunkId?: string | null
    confidence?: number
    metadata?: Record<string, unknown>
  },
): Promise<number> {
  // Dedup: skip if identical fact already exists for this entity
  const [existing] = await db.select({ id: kbFacts.id })
    .from(kbFacts)
    .where(and(
      eq(kbFacts.entityId, fact.entityId),
      eq(kbFacts.factType, fact.factType),
      eq(kbFacts.text, fact.text),
    ))
    .limit(1)
  if (existing) return existing.id

  const [row] = await db.insert(kbFacts).values({
    entityId: fact.entityId,
    factDate: fact.factDate ?? null,
    factType: fact.factType,
    text: fact.text,
    source: fact.source,
    sourceChunkId: fact.sourceChunkId ? BigInt(fact.sourceChunkId) : undefined,
    confidence: fact.confidence ?? 0.8,
    metadata: fact.metadata ?? null,
  }).returning({ id: kbFacts.id })

  return row.id
}

export async function getFactsForEntity(
  db: DB,
  entityId: number,
  options?: { limit?: number; factType?: FactType; after?: Date; before?: Date },
): Promise<Array<{ id: number; factDate: Date | null; factType: string; text: string; source: string; confidence: number; createdAt: Date }>> {
  const conditions = [eq(kbFacts.entityId, entityId)]
  if (options?.factType) conditions.push(eq(kbFacts.factType, options.factType))
  if (options?.after) conditions.push(sql`${kbFacts.factDate} >= ${options.after}`)
  if (options?.before) conditions.push(sql`${kbFacts.factDate} <= ${options.before}`)

  return db.select({
    id: kbFacts.id,
    factDate: kbFacts.factDate,
    factType: kbFacts.factType,
    text: kbFacts.text,
    source: kbFacts.source,
    confidence: kbFacts.confidence,
    createdAt: kbFacts.createdAt,
  })
    .from(kbFacts)
    .where(and(...conditions))
    .orderBy(sql`${kbFacts.factDate} DESC NULLS LAST`)
    .limit(options?.limit ?? 50)
}

// ── Document operations ──

export async function addDocument(
  db: DB,
  doc: {
    entityId: number
    title: string
    url: string
    source: 'notion' | 'drive'
    docType: DocType
    sourceChunkId?: string | null
    metadata?: Record<string, unknown>
  },
): Promise<number> {
  const [row] = await db.insert(kbDocuments).values({
    entityId: doc.entityId,
    title: doc.title,
    url: doc.url,
    source: doc.source,
    docType: doc.docType,
    sourceChunkId: doc.sourceChunkId ? BigInt(doc.sourceChunkId) : undefined,
    metadata: doc.metadata ?? null,
  }).onConflictDoNothing().returning({ id: kbDocuments.id })

  if (row) return row.id

  // Already exists — fetch ID
  const [existing] = await db.select({ id: kbDocuments.id })
    .from(kbDocuments)
    .where(and(eq(kbDocuments.url, doc.url), eq(kbDocuments.entityId, doc.entityId)))
  return existing.id
}

export async function getDocumentsForEntity(
  db: DB,
  entityId: number,
): Promise<Array<{ id: number; title: string; url: string; source: string; docType: string; createdAt: Date }>> {
  return db.select({
    id: kbDocuments.id,
    title: kbDocuments.title,
    url: kbDocuments.url,
    source: kbDocuments.source,
    docType: kbDocuments.docType,
    createdAt: kbDocuments.createdAt,
  })
    .from(kbDocuments)
    .where(eq(kbDocuments.entityId, entityId))
    .orderBy(sql`${kbDocuments.createdAt} DESC`)
}

// ── Re-extraction support ──

/**
 * Reset entity_ids to NULL for chunks matching filters.
 * This makes them eligible for re-extraction.
 */
export async function resetExtractionFlags(
  db: DB,
  filters?: { source?: ChunkSource; after?: Date; before?: Date },
): Promise<number> {
  const conditions = [sql`${kbChunks.entityIds} IS NOT NULL`]
  if (filters?.source) conditions.push(eq(kbChunks.source, filters.source))
  if (filters?.after) conditions.push(sql`${kbChunks.sourceDate} >= ${filters.after}`)
  if (filters?.before) conditions.push(sql`${kbChunks.sourceDate} <= ${filters.before}`)

  // Count first, then update — avoids loading all IDs into memory (can be 100K+ rows)
  const [countRow] = await db.select({ count: sql<number>`count(*)::int` })
    .from(kbChunks)
    .where(and(...conditions))
  const count = countRow?.count ?? 0

  if (count > 0) {
    await db.update(kbChunks)
      .set({ entityIds: sql`NULL` })
      .where(and(...conditions))
  }

  return count
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
