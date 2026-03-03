export type EntityType = 'person' | 'project' | 'channel' | 'client' | 'company' | 'process'
export type RelationType = 'works_on' | 'manages' | 'owns' | 'member_of' | 'client_of'
export type ChunkSource = 'slack' | 'gmail' | 'calendar' | 'clickup' | 'drive' | 'notion' | 'clockify'
export type ChunkType = 'message' | 'email' | 'document' | 'task' | 'event'
export type IngestionStatus = 'idle' | 'running' | 'failed'

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

/** Filters for KB search. */
export interface KBSearchFilters {
  source?: ChunkSource
  entityIds?: number[]
  chunkType?: ChunkType
  after?: Date
  before?: Date
}
