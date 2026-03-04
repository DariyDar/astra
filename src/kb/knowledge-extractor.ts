import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { QdrantClient } from '@qdrant/js-client-rest'
import type * as schema from '../db/schema.js'
import { callGemini } from '../llm/gemini.js'
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
  addFact,
  addDocument,
  findEntityByName,
} from './repository.js'
import type { EntityType, RelationType, FactType, DocType, ChunkSource, KnowledgeExtractionResult } from './types.js'

type DB = NodePgDatabase<typeof schema>

const COLLECTION_NAME = 'astra_knowledge'
const DEFAULT_BATCH_SIZE = 100
const MAX_ENTITY_NAME_LENGTH = 200
const ENTITY_CONTEXT_REFRESH_INTERVAL = 10
const VALID_ENTITY_TYPES = new Set<string>(['person', 'project', 'channel', 'client', 'company', 'process'])
const VALID_RELATION_TYPES = new Set<string>(['works_on', 'manages', 'owns', 'member_of', 'client_of'])
const VALID_FACT_TYPES = new Set<string>(['event', 'decision', 'status', 'milestone', 'release', 'deadline'])
const VALID_DOC_SOURCES = new Set<string>(['notion', 'drive'])
const VALID_DOC_TYPES = new Set<string>(['spec', 'wiki', 'report', 'meeting_notes', 'design', 'other'])
const MAX_CHUNK_TEXT_LENGTH = 1200

function isValidUrl(s: string): boolean {
  try { new URL(s); return true } catch { return false }
}

export interface ExtractionBatchResult {
  entitiesCreated: number
  relationsCreated: number
  factsCreated: number
  documentsCreated: number
  chunksProcessed: number
  errorCount?: number
}

export interface BatchBudget {
  maxBatches: number
  maxTimeMinutes: number
  chunkBatchSize: number
}

export interface BatchStats {
  totalChunks: number
  totalEntities: number
  totalRelations: number
  totalFacts: number
  totalDocuments: number
  totalBatches: number
  remainingUnprocessed: number
  stoppedReason: 'complete' | 'budget_time' | 'budget_batches' | 'error'
}

const EXTRACTION_PROMPT = `You are a knowledge extraction system for a project management knowledge base.
Analyze the provided text chunks and extract 4 types of information:

1. **Entities** — people, projects, channels, clients, companies, processes
   - name (canonical), type, aliases (alternate names/spellings), company (hg/ac/null)
   - Normalize names: "Семён" and "Semyon" are the same person
   - Channel names: preserve with prefix (e.g. "ac/general", "hg/dev-chat")

2. **Relations** — connections between entities
   - works_on, manages, owns, member_of, client_of
   - Include role when mentioned (e.g. "developer", "QA lead")

3. **Facts** — time-stamped events, decisions, statuses, milestones
   - Tied to an entity by name
   - Include date when mentioned (ISO format YYYY-MM-DD)
   - Types: event, decision, status, milestone, release, deadline

4. **Documents** — Notion/Drive documents linked to entities
   - Only when a URL is explicitly mentioned
   - Include title, url, source (notion/drive), type (spec/wiki/report/meeting_notes/design/other)

Return JSON:
{
  "entities": [{ "name": "Семён", "type": "person", "aliases": ["Semyon"], "company": "hg" }],
  "relations": [{ "from": "Семён", "to": "Oregon Trail", "relation": "works_on", "role": "developer" }],
  "facts": [{ "entity": "Oregon Trail", "date": "2026-02-28", "type": "milestone", "text": "Released v2.0" }],
  "documents": [{ "entity": "Oregon Trail", "title": "OT Spec", "url": "https://notion.so/ot-spec", "source": "notion", "type": "spec" }]
}

Rules:
- Only extract what is clearly mentioned in the text
- Do not invent relations or facts not supported by the text
- Prefer Russian names as canonical when available
- Skip generic terms (e.g. "project", "team" without specific names)
- Dates: use ISO format. If only month mentioned, use first day (e.g. "2026-03-01")
- Facts: be specific and concise. "завершил интеграцию Galaxy Event v3" is better than "работал над проектом"
- If no facts/documents found, return empty arrays`

/** Build metadata header for a chunk to help the LLM contextualize it. */
export function buildChunkHeader(chunk: {
  source: string
  sourceId: string
  metadata?: Record<string, unknown> | null
  sourceDate?: Date | null
}): string {
  const parts: string[] = [`[source=${chunk.source}, id=${chunk.sourceId}`]
  const meta = chunk.metadata as Record<string, string> | null | undefined
  if (meta?.channel) parts.push(`channel=${meta.channel}`)
  if (meta?.user || meta?.userName) parts.push(`user=${meta.userName ?? meta.user}`)
  if (meta?.subject) parts.push(`subject=${meta.subject}`)
  if (meta?.fileName) parts.push(`file=${meta.fileName}`)
  if (chunk.sourceDate) parts.push(`date=${chunk.sourceDate.toISOString().split('T')[0]}`)
  return parts.join(', ') + ']'
}

/** Build entity context string for existing entities. */
function buildEntityContext(entities: Array<{ name: string; type: string }>, maxChars: number = 4000): string {
  let ctx = entities.map((e) => `${e.name} (${e.type})`).join(', ')
  if (ctx.length > maxChars) {
    const cutoff = ctx.lastIndexOf(',', maxChars)
    ctx = cutoff > 0 ? ctx.slice(0, cutoff) + ', ...' : ctx.slice(0, maxChars) + '...'
  }
  return ctx
}

/** Parse and validate LLM JSON response. */
export function parseKnowledgeExtraction(text: string): KnowledgeExtractionResult | null {
  let clean = text.trim()
  if (clean.startsWith('```')) {
    clean = clean.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }

  let parsed: KnowledgeExtractionResult
  try {
    parsed = JSON.parse(clean) as KnowledgeExtractionResult
  } catch {
    const jsonMatch = clean.match(/\{[\s\S]*"entities"[\s\S]*\}/)
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]) as KnowledgeExtractionResult
      } catch {
        return null
      }
    } else {
      return null
    }
  }

  if (!Array.isArray(parsed.entities)) parsed.entities = []
  if (!Array.isArray(parsed.relations)) parsed.relations = []
  if (!Array.isArray(parsed.facts)) parsed.facts = []
  if (!Array.isArray(parsed.documents)) parsed.documents = []

  parsed.entities = parsed.entities.filter((e) =>
    e.name && e.name.trim().length > 0 && e.name.length <= MAX_ENTITY_NAME_LENGTH && VALID_ENTITY_TYPES.has(e.type),
  )
  parsed.relations = parsed.relations.filter((r) =>
    r.from && r.to && VALID_RELATION_TYPES.has(r.relation),
  )
  parsed.facts = parsed.facts.filter((f) =>
    f.entity && f.text && VALID_FACT_TYPES.has(f.type),
  )
  parsed.documents = parsed.documents.filter((d) =>
    d.entity && d.title && d.url && isValidUrl(d.url) &&
    VALID_DOC_SOURCES.has(d.source) && VALID_DOC_TYPES.has(d.type),
  )

  return parsed
}

/**
 * Extract knowledge from one batch of unprocessed chunks using Gemini.
 */
export async function extractKnowledge(
  db: DB,
  entityContext?: string,
  qdrantClient?: QdrantClient,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<ExtractionBatchResult> {
  const stats: ExtractionBatchResult = {
    entitiesCreated: 0,
    relationsCreated: 0,
    factsCreated: 0,
    documentsCreated: 0,
    chunksProcessed: 0,
  }

  const chunks = await findUnprocessedChunks(db, batchSize)
  if (chunks.length === 0) {
    logger.info('Knowledge extraction: no unprocessed chunks')
    return stats
  }

  logger.info({ chunkCount: chunks.length }, 'Knowledge extraction: starting batch')

  const chunkTexts = chunks.map((c, i) => {
    const header = buildChunkHeader(c as { source: string; sourceId: string; metadata?: Record<string, unknown> | null; sourceDate?: Date | null })
    return `--- Chunk ${i + 1} ${header} ---\n${c.text.slice(0, MAX_CHUNK_TEXT_LENGTH)}`
  }).join('\n\n')

  let prompt = EXTRACTION_PROMPT
  if (entityContext) {
    prompt += `\n\nEXISTING ENTITIES (use these canonical names when referencing known entities):\n${entityContext}`
  }
  prompt += `\n\n--- TEXT CHUNKS ---\n${chunkTexts}`

  try {
    const response = await callGemini(prompt, {
      systemInstruction: 'You are a JSON-only knowledge extraction tool. Output valid JSON only.',
      jsonMode: true,
      timeoutMs: 120_000,
    })

    const extraction = parseKnowledgeExtraction(response.text)
    if (!extraction) {
      logger.warn({ responseHead: response.text.slice(0, 200) }, 'Knowledge extraction: failed to parse response')
      for (const chunk of chunks) {
        await updateChunkEntityIds(db, chunk.id, [])
      }
      stats.chunksProcessed = chunks.length
      return stats
    }

    // --- Merge entities ---
    const entityIdMap = new Map<string, number>()

    for (const entity of extraction.entities) {
      const existing = await findEntityByName(db, entity.name)
      if (existing) {
        entityIdMap.set(entity.name.toLowerCase(), existing.id)
        for (const alias of entity.aliases ?? []) {
          if (alias && alias.length <= MAX_ENTITY_NAME_LENGTH) {
            await addAlias(db, existing.id, alias).catch(() => {})
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
          await addAlias(db, entityId, alias).catch(() => {})
        }
      }
    }

    // --- Create relations ---
    for (const rel of extraction.relations) {
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

    // --- Create facts ---
    // Use the most common source in the batch for attribution
    const sourceCounts = new Map<string, number>()
    for (const c of chunks) sourceCounts.set(c.source, (sourceCounts.get(c.source) ?? 0) + 1)
    const dominantSource = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'slack'

    for (const fact of extraction.facts) {
      const entity = await findEntityByName(db, fact.entity)
      if (!entity) continue

      const factDate = fact.date ? new Date(fact.date) : null
      if (factDate && isNaN(factDate.getTime())) continue

      await addFact(db, {
        entityId: entity.id,
        factDate,
        factType: fact.type,
        text: fact.text,
        source: dominantSource as ChunkSource,
      })
      stats.factsCreated++
    }

    // --- Create documents ---
    for (const doc of extraction.documents) {
      const entity = await findEntityByName(db, doc.entity)
      if (!entity) continue

      await addDocument(db, {
        entityId: entity.id,
        title: doc.title,
        url: doc.url,
        source: doc.source,
        docType: doc.type,
      })
      stats.documentsCreated++
    }

    // --- Mark chunks as processed + update Qdrant ---
    for (const chunk of chunks) {
      const mentionedIds: number[] = []
      for (const [name, id] of entityIdMap) {
        if (chunk.text.toLowerCase().includes(name)) {
          mentionedIds.push(id)
        }
      }
      await updateChunkEntityIds(db, chunk.id, mentionedIds)

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
    logger.info(stats, 'Knowledge extraction: batch complete')
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    logger.error({ error: errMsg, chunkCount: chunks.length }, 'Knowledge extraction: Gemini call failed')

    for (const chunk of chunks) {
      await updateChunkEntityIds(db, chunk.id, [])
    }
    stats.chunksProcessed = chunks.length
    stats.errorCount = (stats.errorCount ?? 0) + 1
  }

  return stats
}

const DEFAULT_BUDGET: BatchBudget = {
  maxBatches: 100,
  maxTimeMinutes: 60,
  chunkBatchSize: DEFAULT_BATCH_SIZE,
}

/**
 * Run knowledge extraction in a multi-batch loop with budget controls.
 * No cost budget needed — Gemini free tier.
 */
export async function extractKnowledgeBatch(
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
    totalFacts: 0,
    totalDocuments: 0,
    totalBatches: 0,
    remainingUnprocessed: 0,
    stoppedReason: 'complete',
  }

  let entityContext = buildEntityContext(await getAllEntityNames(db))
  let consecutiveErrors = 0
  const MAX_CONSECUTIVE_ERRORS = 3

  for (let batch = 0; batch < b.maxBatches; batch++) {
    const elapsedMin = (Date.now() - startTime) / 60_000
    if (elapsedMin > b.maxTimeMinutes) {
      stats.stoppedReason = 'budget_time'
      break
    }

    if (batch > 0 && batch % ENTITY_CONTEXT_REFRESH_INTERVAL === 0) {
      entityContext = buildEntityContext(await getAllEntityNames(db))
    }

    const result = await extractKnowledge(db, entityContext, qdrantClient, b.chunkBatchSize)
    if (result.chunksProcessed === 0) break

    if (result.errorCount) {
      consecutiveErrors++
      logger.warn({ consecutiveErrors }, 'Knowledge extraction: batch had errors')
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        stats.stoppedReason = 'error'
        logger.error('Knowledge extraction: too many consecutive errors, stopping')
        break
      }
    } else {
      consecutiveErrors = 0
    }

    stats.totalChunks += result.chunksProcessed
    stats.totalEntities += result.entitiesCreated
    stats.totalRelations += result.relationsCreated
    stats.totalFacts += result.factsCreated
    stats.totalDocuments += result.documentsCreated
    stats.totalBatches++

    logger.info({
      batch: stats.totalBatches,
      chunks: stats.totalChunks,
      entities: stats.totalEntities,
      facts: stats.totalFacts,
      elapsedMin: elapsedMin.toFixed(1),
    }, 'Knowledge extraction: progress')
  }

  if (stats.stoppedReason === 'complete' && stats.totalBatches >= b.maxBatches) {
    stats.stoppedReason = 'budget_batches'
  }

  stats.remainingUnprocessed = await countUnprocessedChunks(db)

  logger.info(stats, 'Knowledge extraction: bulk run complete')
  return stats
}

/**
 * Mark low-value chunks as processed (entity_ids = []) without LLM calls.
 */
export async function markLowValueChunks(db: DB): Promise<number> {
  const count = await markChunksProcessed(db, 'low-value')
  if (count > 0) {
    logger.info({ count }, 'Knowledge extraction: marked low-value chunks as processed')
  }
  return count
}
