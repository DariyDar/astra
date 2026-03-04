export type EntityType = 'person' | 'project' | 'channel' | 'client' | 'company' | 'process'
export type RelationType = 'works_on' | 'manages' | 'owns' | 'member_of' | 'client_of'
export type ChunkSource = 'slack' | 'gmail' | 'calendar' | 'clickup' | 'drive' | 'notion' | 'clockify'
export type ChunkType = 'message' | 'email' | 'document' | 'task' | 'event'
export type IngestionStatus = 'idle' | 'running' | 'failed'
export type FactType = 'event' | 'decision' | 'status' | 'milestone' | 'release' | 'deadline'
export type DocType = 'spec' | 'wiki' | 'report' | 'meeting_notes' | 'design' | 'other'

export interface KBEntity {
  id: number
  type: EntityType
  name: string
  company?: string | null
  metadata?: Record<string, unknown> | null
}

export interface KBEntityAlias {
  id: number
  entityId: number
  alias: string
  language?: string | null
}

export interface KBRelation {
  id: number
  fromId: number
  toId: number
  relation: RelationType
  role?: string | null
  status?: string | null
  period?: string | null
  metadata?: Record<string, unknown> | null
}

export interface KBChunk {
  id: string
  source: ChunkSource
  sourceId: string
  chunkIndex: number
  contentHash: string
  text: string
  qdrantId?: string | null
  entityIds?: number[] | null
  metadata?: Record<string, unknown> | null
  createdAt: Date
  sourceDate?: Date | null
}

/** Input for creating/upserting a chunk (before DB insert). */
export interface KBChunkInput {
  source: ChunkSource
  sourceId: string
  chunkIndex: number
  text: string
  chunkType: ChunkType
  metadata?: Record<string, unknown>
  sourceDate?: Date
}

export interface KBIngestionState {
  source: string
  watermark: string
  lastRun?: Date | null
  itemsTotal: number
  status: IngestionStatus
  error?: string | null
}

/** Result from hybrid search. */
export interface KBSearchResult {
  chunkId: string
  text: string
  source: ChunkSource
  sourceId: string
  sourceDate?: Date | null
  score: number
  entityIds?: number[] | null
  metadata?: Record<string, unknown> | null
}

/** A time-stamped fact tied to an entity. */
export interface KBFact {
  id: number
  entityId: number
  factDate: Date | null
  factType: FactType
  text: string
  source: ChunkSource
  sourceChunkId: string | null
  confidence: number
  metadata?: Record<string, unknown> | null
  createdAt: Date
}

/** A Notion/Drive document linked to an entity. */
export interface KBDocument {
  id: number
  entityId: number
  title: string
  url: string
  source: 'notion' | 'drive'
  docType: DocType
  sourceChunkId: string | null
  metadata?: Record<string, unknown> | null
  createdAt: Date
}

/** Result from unified knowledge extraction (one batch). */
export interface KnowledgeExtractionResult {
  entities: Array<{
    name: string
    type: EntityType
    aliases?: string[]
    company?: string
  }>
  relations: Array<{
    from: string
    to: string
    relation: RelationType
    role?: string
  }>
  facts: Array<{
    entity: string
    date?: string
    type: FactType
    text: string
  }>
  documents: Array<{
    entity: string
    title: string
    url: string
    source: 'notion' | 'drive'
    type: DocType
  }>
}

/** Filters for KB search. */
export interface KBSearchFilters {
  source?: ChunkSource
  entityIds?: number[]
  chunkType?: ChunkType
  after?: Date
  before?: Date
}
