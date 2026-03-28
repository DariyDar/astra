/**
 * KB Facade — unified API for all Knowledge Base consumers.
 *
 * Consumers import from here instead of repository.ts / search.ts directly.
 */

import { db } from '../db/index.js'
import type { EntityType, KBSearchResult, ChunkSource, FactType } from './types.js'

// ── Types shared across consumers ──

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

// ── Cached lazy imports ──

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

// ── Entity operations ──

export async function findEntitiesByType(
  type: EntityType,
): Promise<FacadeEntity[]> {
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

export async function findEntityByName(
  name: string,
): Promise<FacadeEntity | null> {
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

// ── Relation operations ──

export async function getRelationsFor(
  entityId: number | string,
): Promise<FacadeRelation[]> {
  const repo = await getRepository()
  const relations = await repo.getRelationsFor(db, entityId as number)
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

// ── Fact operations ──

export async function getFactsForEntity(
  entityId: number | string,
  options?: { limit?: number; factType?: FactType; after?: Date; before?: Date },
): Promise<FacadeFact[]> {
  const repo = await getRepository()
  const facts = await repo.getFactsForEntity(db, entityId as number, options)
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
  const { hybridSearch: legacySearch } = await import('./search.js')
  const vectorStore = await getVectorStore()
  return legacySearch(db, vectorStore, query, options)
}

// ── Alias operations (used by compiler + name-resolver) ──

export async function getAliasesForEntityIds(
  entityIds: number[],
): Promise<FacadeAlias[]> {
  if (entityIds.length === 0) return []

  const { inArray } = await import('drizzle-orm')
  const { kbEntityAliases } = await import('../db/schema.js')

  const rows = await db.select({
    entityId: kbEntityAliases.entityId,
    alias: kbEntityAliases.alias,
  }).from(kbEntityAliases).where(inArray(kbEntityAliases.entityId, entityIds))

  return rows
}
