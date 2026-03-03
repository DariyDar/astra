import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../db/schema.js'
import { callClaude } from '../llm/client.js'
import { logger } from '../logging/logger.js'
import {
  findUnprocessedChunks,
  updateChunkEntityIds,
  createEntity,
  addAlias,
  addRelation,
  findEntityByName,
} from './repository.js'
import type { EntityType, RelationType } from './types.js'

type DB = NodePgDatabase<typeof schema>

const BATCH_SIZE = 50
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

const EXTRACTION_PROMPT = `You are an entity extraction system for a project management knowledge base.
Analyze the provided text chunks and extract:

1. **Entities** — people, projects, channels, clients, companies, processes
   - For each entity: name (canonical), type, aliases (alternate names/spellings), company (hg/ac/null)
   - Normalize names: "Семён" and "Semyon" are the same person
   - Channel names: preserve with prefix (e.g. "ac/general", "hg/dev-chat")

2. **Relations** — connections between entities
   - works_on: person → project
   - manages: person → project/team
   - owns: person → project/process
   - member_of: person → company/channel
   - client_of: company/person → project

Return ONLY valid JSON (no markdown, no explanation):
{
  "entities": [
    { "name": "Семён", "type": "person", "aliases": ["Semyon", "Semen"], "company": "hg" }
  ],
  "relations": [
    { "from": "Семён", "to": "Oregon Trail", "relation": "works_on", "role": "developer" }
  ]
}

Rules:
- Only extract entities clearly mentioned in the text
- Do not invent relations not supported by the text
- Prefer Russian names as canonical when available
- Skip generic terms (e.g. "project", "team" without specific names)
- Entity types: person, project, channel, client, company, process
- Relation types: works_on, manages, owns, member_of, client_of`

/**
 * Extract entities from unprocessed KB chunks using a single LLM call.
 * Designed to run as a nightly batch job.
 */
export async function extractEntities(db: DB): Promise<{ entitiesCreated: number; relationsCreated: number; chunksProcessed: number }> {
  const stats = { entitiesCreated: 0, relationsCreated: 0, chunksProcessed: 0 }

  const chunks = await findUnprocessedChunks(db, BATCH_SIZE)
  if (chunks.length === 0) {
    logger.info('Entity extraction: no unprocessed chunks')
    return stats
  }

  logger.info({ chunkCount: chunks.length }, 'Entity extraction: starting batch')

  // Build context from chunks
  const chunkTexts = chunks.map((c, i) =>
    `--- Chunk ${i + 1} [source=${c.source}, id=${c.sourceId}] ---\n${c.text.slice(0, 800)}`,
  ).join('\n\n')

  const prompt = `${EXTRACTION_PROMPT}\n\n--- TEXT CHUNKS ---\n${chunkTexts}`

  try {
    const response = await callClaude(prompt, {
      system: 'You are a JSON-only entity extraction tool. Output valid JSON only, no markdown.',
    })

    const extraction = parseExtraction(response.text)
    if (!extraction) {
      logger.warn('Entity extraction: failed to parse LLM response')
      return stats
    }

    // Merge entities into graph
    const entityIdMap = new Map<string, number>()

    for (const entity of extraction.entities) {
      if (!VALID_ENTITY_TYPES.has(entity.type)) continue

      // Check if entity already exists
      const existing = await findEntityByName(db, entity.name)
      if (existing) {
        entityIdMap.set(entity.name.toLowerCase(), existing.id)
        // Add new aliases
        for (const alias of entity.aliases ?? []) {
          await addAlias(db, existing.id, alias).catch(() => { /* alias may already exist */ })
        }
        continue
      }

      // Create new entity (returns id, handles conflict internally)
      const entityId = await createEntity(db, {
        type: entity.type,
        name: entity.name,
        company: entity.company,
        metadata: { source: 'extraction' },
      })

      entityIdMap.set(entity.name.toLowerCase(), entityId)
      stats.entitiesCreated++

      // Add aliases
      for (const alias of entity.aliases ?? []) {
        await addAlias(db, entityId, alias).catch(() => { /* alias may already exist */ })
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

    // Mark chunks as processed (set entity_ids to empty array — not null)
    for (const chunk of chunks) {
      // Collect entity IDs mentioned in this chunk's text
      const mentionedIds: number[] = []
      for (const [name, id] of entityIdMap) {
        if (chunk.text.toLowerCase().includes(name)) {
          mentionedIds.push(id)
        }
      }
      await updateChunkEntityIds(db, chunk.id, mentionedIds)
    }

    stats.chunksProcessed = chunks.length
    logger.info(stats, 'Entity extraction: batch complete')
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    logger.error({ error: errMsg }, 'Entity extraction: LLM call failed')
  }

  return stats
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
