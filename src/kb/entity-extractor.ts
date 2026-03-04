import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { QdrantClient } from '@qdrant/js-client-rest'
import type * as schema from '../db/schema.js'
import { callClaude } from '../llm/client.js'
import { logger } from '../logging/logger.js'
import {
  findUnprocessedChunks,
  countUnprocessedChunks,
  getAllEntityNames,
  markChunksProcessed,
  updateChunkEntityIds,
  createEntity,
  addAlias,
  addRelation,
  findEntityByName,
} from './repository.js'
import type { EntityType, RelationType } from './types.js'

type DB = NodePgDatabase<typeof schema>

const COLLECTION_NAME = 'astra_knowledge'
const DEFAULT_BATCH_SIZE = 50
const EXTRACTION_TIMEOUT_MS = 300_000  // 5 min — extraction prompts are large
const MAX_ENTITY_NAME_LENGTH = 200
const ENTITY_CONTEXT_REFRESH_INTERVAL = 10
const VALID_ENTITY_TYPES = new Set<string>(['person', 'project', 'channel', 'client', 'company', 'process'])
const VALID_RELATION_TYPES = new Set<string>(['works_on', 'manages', 'owns', 'member_of', 'client_of'])

interface ExtractedEntity {
  name: string
  type: EntityType
  aliases?: string[]
  company?: string
}

interface ExtractedRelation {
  from: string
  to: string
  relation: RelationType
  role?: string
}

interface ExtractionResult {
  entities: ExtractedEntity[]
  relations: ExtractedRelation[]
}

export interface ExtractionBatchResult {
  entitiesCreated: number
  relationsCreated: number
  chunksProcessed: number
  costUsd: number
}

export interface BatchBudget {
  maxBatches: number
  maxTimeMinutes: number
  maxCostUsd: number
  chunkBatchSize: number
  pauseBetweenMs: number
}

export interface BatchStats {
  totalChunks: number
  totalEntities: number
  totalRelations: number
  totalBatches: number
  totalCostUsd: number
  remainingUnprocessed: number
  stoppedReason: 'complete' | 'budget_time' | 'budget_cost' | 'budget_batches'
}

const EXTRACTION_PROMPT = `You are an entity extraction system for a project management knowledge base.
Analyze the provided text chunks and extract:

1. **Entities** — people, projects, channels, clients, companies, processes
   - For each entity: name (canonical), type, aliases (alternate names/spellings), company (hg/ac/null)
   - Normalize names: "\u0421\u0435\u043c\u0451\u043d" and "Semyon" are the same person
   - Channel names: preserve with prefix (e.g. "ac/general", "hg/dev-chat")

2. **Relations** — connections between entities
   - works_on: person \u2192 project
   - manages: person \u2192 project/team
   - owns: person \u2192 project/process
   - member_of: person \u2192 company/channel
   - client_of: company/person \u2192 project

Return ONLY valid JSON (no markdown, no explanation):
{
  "entities": [
    { "name": "\u0421\u0435\u043c\u0451\u043d", "type": "person", "aliases": ["Semyon", "Semen"], "company": "hg" }
  ],
  "relations": [
    { "from": "\u0421\u0435\u043c\u0451\u043d", "to": "Oregon Trail", "relation": "works_on", "role": "developer" }
  ]
}

Rules:
- Only extract entities clearly mentioned in the text
- Do not invent relations not supported by the text
- Prefer Russian names as canonical when available
- Skip generic terms (e.g. "project", "team" without specific names)
- Entity types: person, project, channel, client, company, process
- Relation types: works_on, manages, owns, member_of, client_of`

/** Build entity context string, truncating at comma boundary. */
function buildEntityContext(entities: Array<{ name: string; type: string }>, maxChars: number = 3000): string {
  let ctx = entities.map((e) => `${e.name} (${e.type})`).join(', ')
  if (ctx.length > maxChars) {
    const cutoff = ctx.lastIndexOf(',', maxChars)
    ctx = cutoff > 0 ? ctx.slice(0, cutoff) + ', ...' : ctx.slice(0, maxChars) + '...'
  }
  return ctx
}

/**
 * Extract entities from unprocessed KB chunks using a single LLM call.
 */
export async function extractEntities(
  db: DB,
  entityContext?: string,
  qdrantClient?: QdrantClient,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<ExtractionBatchResult> {
  const stats: ExtractionBatchResult = { entitiesCreated: 0, relationsCreated: 0, chunksProcessed: 0, costUsd: 0 }

  const chunks = await findUnprocessedChunks(db, batchSize)
  if (chunks.length === 0) {
    logger.info('Entity extraction: no unprocessed chunks')
    return stats
  }

  logger.info({ chunkCount: chunks.length }, 'Entity extraction: starting batch')

  // Build context from chunks
  const chunkTexts = chunks.map((c, i) =>
    `--- Chunk ${i + 1} [source=${c.source}, id=${c.sourceId}] ---\n${c.text.slice(0, 800)}`,
  ).join('\n\n')

  let prompt = EXTRACTION_PROMPT
  if (entityContext) {
    prompt += `\n\nEXISTING ENTITIES (use these canonical names when referencing known entities):\n${entityContext}`
  }
  prompt += `\n\n--- TEXT CHUNKS ---\n${chunkTexts}`

  try {
    const response = await callClaude(prompt, {
      system: 'You are a JSON-only entity extraction tool. Output valid JSON only, no markdown.',
      timeoutMs: EXTRACTION_TIMEOUT_MS,
    })

    stats.costUsd = response.usage?.costUsd ?? 0

    const extraction = parseExtraction(response.text)
    if (!extraction) {
      logger.warn('Entity extraction: failed to parse LLM response')
      // Mark chunks as processed with empty entity_ids to avoid re-processing
      for (const chunk of chunks) {
        await updateChunkEntityIds(db, chunk.id, [])
      }
      stats.chunksProcessed = chunks.length
      return stats
    }

    // Merge entities into graph
    const entityIdMap = new Map<string, number>()

    for (const entity of extraction.entities) {
      if (!VALID_ENTITY_TYPES.has(entity.type)) continue
      if (!entity.name || entity.name.trim().length === 0 || entity.name.length > MAX_ENTITY_NAME_LENGTH) continue

      const existing = await findEntityByName(db, entity.name)
      if (existing) {
        entityIdMap.set(entity.name.toLowerCase(), existing.id)
        for (const alias of entity.aliases ?? []) {
          if (alias && alias.length <= MAX_ENTITY_NAME_LENGTH) {
            await addAlias(db, existing.id, alias).catch(() => { /* alias may already exist */ })
          }
        }
        continue
      }

      const entityId = await createEntity(db, {
        type: entity.type,
        name: entity.name,
        company: entity.company,
        metadata: { source: 'extraction' },
      })

      entityIdMap.set(entity.name.toLowerCase(), entityId)
      stats.entitiesCreated++

      for (const alias of entity.aliases ?? []) {
        if (alias && alias.length <= MAX_ENTITY_NAME_LENGTH) {
          await addAlias(db, entityId, alias).catch(() => { /* alias may already exist */ })
        }
      }
    }

    // Create relations
    for (const rel of extraction.relations) {
      if (!VALID_RELATION_TYPES.has(rel.relation)) continue

      const fromEntity = await findEntityByName(db, rel.from)
      const toEntity = await findEntityByName(db, rel.to)
      if (!fromEntity || !toEntity) continue

      await addRelation(db, {
        fromId: fromEntity.id,
        toId: toEntity.id,
        relation: rel.relation,
        role: rel.role,
        status: 'active',
        metadata: { source: 'extraction' },
      })
      stats.relationsCreated++
    }

    // Mark chunks as processed and update Qdrant
    for (const chunk of chunks) {
      const mentionedIds: number[] = []
      for (const [name, id] of entityIdMap) {
        if (chunk.text.toLowerCase().includes(name)) {
          mentionedIds.push(id)
        }
      }
      await updateChunkEntityIds(db, chunk.id, mentionedIds)

      // Update Qdrant entity_ids payload
      if (qdrantClient && chunk.qdrantId) {
        try {
          await qdrantClient.setPayload(COLLECTION_NAME, {
            payload: { entity_ids: mentionedIds },
            points: [chunk.qdrantId],
          })
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          logger.warn({ qdrantId: chunk.qdrantId, error: errMsg }, 'Qdrant entity_ids update failed')
        }
      }
    }

    stats.chunksProcessed = chunks.length
    logger.info(stats, 'Entity extraction: batch complete')
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    logger.error({ error: errMsg }, 'Entity extraction: LLM call failed')
  }

  return stats
}

const DEFAULT_BUDGET: BatchBudget = {
  maxBatches: 100,
  maxTimeMinutes: 120,
  maxCostUsd: 5.0,
  chunkBatchSize: DEFAULT_BATCH_SIZE,
  pauseBetweenMs: 2000,
}

/**
 * Run entity extraction in a multi-batch loop with budget controls.
 * Stops when: no more chunks, time exceeded, cost exceeded, or batch limit reached.
 */
export async function extractEntitiesBatch(
  db: DB,
  budget?: Partial<BatchBudget>,
  qdrantClient?: QdrantClient,
): Promise<BatchStats> {
  const b: BatchBudget = { ...DEFAULT_BUDGET, ...budget }
  const startTime = Date.now()

  const stats: BatchStats = {
    totalChunks: 0,
    totalEntities: 0,
    totalRelations: 0,
    totalBatches: 0,
    totalCostUsd: 0,
    remainingUnprocessed: 0,
    stoppedReason: 'complete',
  }

  // Build entity context (refreshed every N batches)
  let entityContext = buildEntityContext(await getAllEntityNames(db))

  for (let batch = 0; batch < b.maxBatches; batch++) {
    // Check time budget
    const elapsedMin = (Date.now() - startTime) / 60_000
    if (elapsedMin > b.maxTimeMinutes) {
      stats.stoppedReason = 'budget_time'
      break
    }

    // Check cost budget
    if (stats.totalCostUsd >= b.maxCostUsd) {
      stats.stoppedReason = 'budget_cost'
      break
    }

    // Refresh entity context periodically to include newly created entities
    if (batch > 0 && batch % ENTITY_CONTEXT_REFRESH_INTERVAL === 0) {
      entityContext = buildEntityContext(await getAllEntityNames(db))
    }

    const result = await extractEntities(db, entityContext, qdrantClient, b.chunkBatchSize)
    if (result.chunksProcessed === 0) break

    stats.totalChunks += result.chunksProcessed
    stats.totalEntities += result.entitiesCreated
    stats.totalRelations += result.relationsCreated
    stats.totalCostUsd += result.costUsd
    stats.totalBatches++

    logger.info({
      batch: stats.totalBatches,
      chunksTotal: stats.totalChunks,
      entitiesTotal: stats.totalEntities,
      costUsd: stats.totalCostUsd.toFixed(2),
      elapsedMin: ((Date.now() - startTime) / 60_000).toFixed(1),
    }, 'Entity extraction: batch progress')

    // Pause between batches to avoid rate limiting
    if (batch < b.maxBatches - 1) {
      await new Promise((r) => setTimeout(r, b.pauseBetweenMs))
    }
  }

  // Check if stopped due to batch limit
  if (stats.stoppedReason === 'complete' && stats.totalBatches >= b.maxBatches) {
    stats.stoppedReason = 'budget_batches'
  }

  stats.remainingUnprocessed = await countUnprocessedChunks(db)

  logger.info({
    ...stats,
    totalCostUsd: stats.totalCostUsd.toFixed(2),
  }, 'Entity extraction: bulk run complete')

  return stats
}

/**
 * Mark low-value chunks as processed (entity_ids = []) without LLM calls.
 * Targets: stubs, metadata-only, short text, drive chunks.
 */
export async function markLowValueChunks(db: DB): Promise<number> {
  const count = await markChunksProcessed(db, 'low-value')
  if (count > 0) {
    logger.info({ count }, 'Entity extraction: marked low-value chunks as processed')
  }
  return count
}

/** Try to parse JSON from LLM response, handling markdown fences. */
function parseExtraction(text: string): ExtractionResult | null {
  // Strip markdown code fences if present
  let clean = text.trim()
  if (clean.startsWith('```')) {
    clean = clean.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }

  try {
    const parsed = JSON.parse(clean) as ExtractionResult
    if (!Array.isArray(parsed.entities)) parsed.entities = []
    if (!Array.isArray(parsed.relations)) parsed.relations = []
    return parsed
  } catch {
    // Try to find JSON in the response
    const jsonMatch = clean.match(/\{[\s\S]*"entities"[\s\S]*\}/)
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as ExtractionResult
      } catch { /* ignore */ }
    }
    return null
  }
}
