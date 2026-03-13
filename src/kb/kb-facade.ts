/**
 * KB Facade — unified API for all Knowledge Base consumers.
 *
 * Switches between legacy (PG+Qdrant) and Graphiti based on KB_BACKEND env var.
 * Consumers import from here instead of repository.ts / search.ts directly.
 */

import { db } from '../db/index.js'
import { inArray } from 'drizzle-orm'
import { kbEntityAliases } from '../db/schema.js'
import { logger } from '../logging/logger.js'
import type { EntityType, KBSearchResult, ChunkSource, FactType } from './types.js'

const rawBackend = process.env.KB_BACKEND ?? 'legacy'
if (rawBackend !== 'legacy' && rawBackend !== 'graphiti') {
  throw new Error(`Invalid KB_BACKEND: "${rawBackend}". Must be "legacy" or "graphiti"`)
}
const KB_BACKEND = rawBackend

// ── Types shared across backends ──

export interface FacadeEntity {
  id: number | string
  type: EntityType
  name: string
  company: string | null
  metadata?: Record<string, unknown> | null
}

export interface FacadeRelation {
  relation: string
  role: string | null
  status: string | null
  fromName: string
  toName: string
  fromType: string
  toType: string
}

export interface FacadeFact {
  id: number | string
  factDate: Date | null
  factType: string
  text: string
  source: string
  confidence: number
  createdAt: Date
}

export interface FacadeAlias {
  entityId: number | string
  alias: string
}

// ── Cached legacy imports + singletons ──

let _repository: typeof import('./repository.js') | null = null
async function getRepository() {
  if (!_repository) _repository = await import('./repository.js')
  return _repository
}

let _vectorStore: InstanceType<typeof import('./vector-store.js').KBVectorStore> | null = null
async function getVectorStore() {
  if (_vectorStore) return _vectorStore
  const { QdrantClient } = await import('@qdrant/js-client-rest')
  const { KBVectorStore } = await import('./vector-store.js')
  const client = new QdrantClient({ url: process.env.QDRANT_URL ?? 'http://localhost:6333' })
  _vectorStore = new KBVectorStore(client)
  await _vectorStore.ensureCollection()
  return _vectorStore
}

let _graphitiClient: typeof import('./graphiti-client.js') | null = null
async function getGraphitiClient() {
  if (!_graphitiClient) _graphitiClient = await import('./graphiti-client.js')
  return _graphitiClient
}

// ── Entity operations ──

export async function findEntitiesByType(
  type: EntityType,
): Promise<FacadeEntity[]> {
  if (KB_BACKEND === 'graphiti') {
    return findEntitiesByTypeGraphiti(type)
  }
  return findEntitiesByTypeLegacy(type)
}

export async function findEntityByName(
  name: string,
): Promise<FacadeEntity | null> {
  if (KB_BACKEND === 'graphiti') {
    return findEntityByNameGraphiti(name)
  }
  return findEntityByNameLegacy(name)
}

// ── Relation operations ──

export async function getRelationsFor(
  entityId: number | string,
): Promise<FacadeRelation[]> {
  if (KB_BACKEND === 'graphiti') {
    return getRelationsForGraphiti(entityId)
  }
  return getRelationsForLegacy(entityId as number)
}

// ── Fact operations ──

export async function getFactsForEntity(
  entityId: number | string,
  options?: { limit?: number; factType?: FactType; after?: Date; before?: Date },
): Promise<FacadeFact[]> {
  if (KB_BACKEND === 'graphiti') {
    return getFactsForEntityGraphiti(entityId, options)
  }
  return getFactsForEntityLegacy(entityId as number, options)
}

// ── Search ──

export async function hybridSearch(
  query: string,
  options: {
    source?: ChunkSource
    person?: string
    project?: string
    after?: Date
    before?: Date
    limit?: number
  } = {},
): Promise<KBSearchResult[]> {
  if (KB_BACKEND === 'graphiti') {
    return hybridSearchGraphiti(query, options)
  }
  return hybridSearchLegacy(query, options)
}

// ── Alias operations (used by compiler + name-resolver) ──

export async function getAliasesForEntityIds(
  entityIds: number[],
): Promise<FacadeAlias[]> {
  if (KB_BACKEND === 'graphiti') {
    // TODO(phase-2): Graphiti auto-deduplicates aliases into entity nodes.
    // Once we have seeded entities with proper group_ids, we can query
    // entity nodes directly to get their alternative names.
    logger.warn('getAliasesForEntityIds: not yet implemented for Graphiti backend, returning empty')
    return []
  }

  if (entityIds.length === 0) return []

  const rows = await db.select({
    entityId: kbEntityAliases.entityId,
    alias: kbEntityAliases.alias,
  }).from(kbEntityAliases).where(inArray(kbEntityAliases.entityId, entityIds))

  return rows
}

// ══════════════════════════════════════════════
// Legacy backend implementations
// ══════════════════════════════════════════════

async function findEntitiesByTypeLegacy(type: EntityType): Promise<FacadeEntity[]> {
  const repo = await getRepository()
  const entities = await repo.findEntitiesByType(db, type)
  return entities.map((e) => ({
    id: e.id,
    type,
    name: e.name,
    company: e.company,
    metadata: e.metadata as Record<string, unknown> | null,
  }))
}

async function findEntityByNameLegacy(name: string): Promise<FacadeEntity | null> {
  const repo = await getRepository()
  const entity = await repo.findEntityByName(db, name)
  if (!entity) return null
  return {
    id: entity.id,
    type: entity.type,
    name: entity.name,
    company: entity.company,
  }
}

async function getRelationsForLegacy(entityId: number): Promise<FacadeRelation[]> {
  const repo = await getRepository()
  const relations = await repo.getRelationsFor(db, entityId)
  return relations.map((r) => ({
    relation: r.relation,
    role: r.role,
    status: r.status,
    fromName: r.fromName,
    toName: r.toName,
    fromType: r.fromType,
    toType: r.toType,
  }))
}

async function getFactsForEntityLegacy(
  entityId: number,
  options?: { limit?: number; factType?: FactType; after?: Date; before?: Date },
): Promise<FacadeFact[]> {
  const repo = await getRepository()
  const facts = await repo.getFactsForEntity(db, entityId, options)
  return facts.map((f) => ({
    id: f.id,
    factDate: f.factDate,
    factType: f.factType,
    text: f.text,
    source: f.source,
    confidence: f.confidence,
    createdAt: f.createdAt,
  }))
}

async function hybridSearchLegacy(
  query: string,
  options: {
    source?: ChunkSource
    person?: string
    project?: string
    after?: Date
    before?: Date
    limit?: number
  },
): Promise<KBSearchResult[]> {
  const { hybridSearch: legacySearch } = await import('./search.js')
  const vectorStore = await getVectorStore()
  return legacySearch(db, vectorStore, query, options)
}

// ══════════════════════════════════════════════
// Graphiti backend implementations
// TODO(phase-2): These are approximations using search queries.
// Once entities are seeded with group_ids by type, we can add
// proper endpoints to the Graphiti server for structured queries.
// ══════════════════════════════════════════════

async function findEntitiesByTypeGraphiti(type: EntityType): Promise<FacadeEntity[]> {
  const client = await getGraphitiClient()
  const facts = await client.search(`all ${type} entities`, { maxFacts: 50 })

  const seen = new Set<string>()
  const entities: FacadeEntity[] = []

  for (const fact of facts) {
    if (!seen.has(fact.name)) {
      seen.add(fact.name)
      entities.push({
        id: fact.uuid,
        type,
        name: fact.name,
        company: null,
      })
    }
  }

  return entities
}

async function findEntityByNameGraphiti(name: string): Promise<FacadeEntity | null> {
  const client = await getGraphitiClient()
  const facts = await client.search(name, { maxFacts: 5 })

  if (facts.length === 0) return null

  const best = facts[0]
  return {
    id: best.uuid,
    // TODO(phase-2): Graphiti search doesn't return node type — needs custom endpoint
    type: 'person' as EntityType,
    name: best.name,
    company: null,
  }
}

async function getRelationsForGraphiti(entityId: number | string): Promise<FacadeRelation[]> {
  const client = await getGraphitiClient()
  const facts = await client.search(`relations for entity ${entityId}`, { maxFacts: 20 })

  return facts.map((f) => ({
    relation: 'related_to',
    role: null,
    status: f.invalid_at ? 'inactive' : 'active',
    fromName: f.name,
    toName: '',
    fromType: 'unknown',
    toType: 'unknown',
  }))
}

async function getFactsForEntityGraphiti(
  entityId: number | string,
  options?: { limit?: number; factType?: FactType; after?: Date; before?: Date },
): Promise<FacadeFact[]> {
  const client = await getGraphitiClient()
  const facts = await client.search(`facts about ${entityId}`, {
    maxFacts: options?.limit ?? 50,
  })

  return facts.map((f) => ({
    id: f.uuid,
    factDate: f.valid_at ? new Date(f.valid_at) : null,
    factType: 'status' as string,
    text: f.fact,
    source: 'graphiti' as string,
    confidence: 0.9,
    createdAt: f.created_at ? new Date(f.created_at) : new Date(),
  }))
}

async function hybridSearchGraphiti(
  query: string,
  options: {
    source?: ChunkSource
    person?: string
    project?: string
    after?: Date
    before?: Date
    limit?: number
  },
): Promise<KBSearchResult[]> {
  const client = await getGraphitiClient()

  let enrichedQuery = query
  if (options.person) enrichedQuery += ` involving ${options.person}`
  if (options.project) enrichedQuery += ` about project ${options.project}`

  const facts = await client.search(enrichedQuery, {
    maxFacts: options.limit ?? 10,
  })

  return facts.map((f, i) => ({
    chunkId: f.uuid,
    text: f.fact,
    source: (options.source ?? 'slack') as ChunkSource,
    sourceId: f.uuid,
    sourceDate: f.valid_at ? new Date(f.valid_at) : null,
    score: 1 / (i + 1),
    entityIds: null,
    metadata: {
      name: f.name,
      valid_at: f.valid_at,
      invalid_at: f.invalid_at,
    },
  }))
}
