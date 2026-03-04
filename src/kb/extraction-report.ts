import { eq, sql, and } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  kbEntities,
  kbEntityAliases,
  kbEntityRelations,
  kbChunks,
} from '../db/schema.js'
import type * as schema from '../db/schema.js'

type DB = NodePgDatabase<typeof schema>

interface EntityRow {
  id: number
  type: string
  name: string
  company: string | null
}

interface AliasRow {
  entityId: number
  alias: string
}

interface RelationRow {
  fromId: number
  toId: number
  relation: string
  role: string | null
}

interface ChunkSourceCount {
  source: string
  count: number
}

interface CrossSourceEntity {
  id: number
  name: string
  type: string
  sources: Array<{ source: string; count: number }>
  sampleTexts: Array<{ source: string; text: string }>
}

/**
 * Simple character-based distance for detecting near-duplicate entity names.
 * Returns the minimum number of single-character edits (insert, delete, substitute).
 * Capped at maxDist+1 for performance — returns early if distance exceeds threshold.
 */
function levenshteinDistance(a: string, b: string, maxDist: number = 3): number {
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > maxDist) return maxDist + 1

  const prev = Array.from({ length: lb + 1 }, (_, i) => i)
  const curr = new Array<number>(lb + 1)

  for (let i = 1; i <= la; i++) {
    curr[0] = i
    let minInRow = curr[0]
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      if (curr[j] < minInRow) minInRow = curr[j]
    }
    if (minInRow > maxDist) return maxDist + 1
    for (let j = 0; j <= lb; j++) prev[j] = curr[j]
  }
  return prev[lb]
}

/**
 * Generate a structured quality report for entity extraction results.
 * Covers: entity summary, samples, cross-source mapping, issues, coverage stats.
 */
export async function generateExtractionReport(db: DB): Promise<string> {
  const lines: string[] = []
  const hr = '='.repeat(60)
  const subHr = '-'.repeat(40)

  lines.push(hr)
  lines.push('  ENTITY EXTRACTION QUALITY REPORT')
  lines.push(`  Generated: ${new Date().toISOString()}`)
  lines.push(hr)
  lines.push('')

  // ── 1. Entity summary by type ──
  const allEntities = await db.select({
    id: kbEntities.id,
    type: kbEntities.type,
    name: kbEntities.name,
    company: kbEntities.company,
  }).from(kbEntities).orderBy(kbEntities.type, kbEntities.name)

  const entityByType = new Map<string, EntityRow[]>()
  for (const e of allEntities) {
    const list = entityByType.get(e.type) ?? []
    list.push(e)
    entityByType.set(e.type, list)
  }

  lines.push('1. ENTITY SUMMARY')
  lines.push(subHr)
  lines.push(`Total entities: ${allEntities.length}`)
  lines.push('')
  for (const [type, entities] of entityByType) {
    lines.push(`  ${type}: ${entities.length}`)
  }
  lines.push('')

  // ── 2. Entity samples per type ──
  // Fetch all aliases
  const allAliases = await db.select({
    entityId: kbEntityAliases.entityId,
    alias: kbEntityAliases.alias,
  }).from(kbEntityAliases)

  const aliasesByEntity = new Map<number, string[]>()
  for (const a of allAliases) {
    const list = aliasesByEntity.get(a.entityId) ?? []
    list.push(a.alias)
    aliasesByEntity.set(a.entityId, list)
  }

  // Fetch all relations
  const allRelations = await db.select({
    fromId: kbEntityRelations.fromId,
    toId: kbEntityRelations.toId,
    relation: kbEntityRelations.relation,
    role: kbEntityRelations.role,
  }).from(kbEntityRelations)

  const entityNameMap = new Map<number, string>(allEntities.map((e) => [e.id, e.name]))

  // Build relation index by entity
  const relsByEntity = new Map<number, Array<{ relation: string; targetName: string; role: string | null }>>()
  for (const r of allRelations) {
    // from side
    const fromList = relsByEntity.get(r.fromId) ?? []
    fromList.push({ relation: r.relation, targetName: entityNameMap.get(r.toId) ?? '?', role: r.role })
    relsByEntity.set(r.fromId, fromList)
    // to side
    const toList = relsByEntity.get(r.toId) ?? []
    toList.push({ relation: `<-${r.relation}`, targetName: entityNameMap.get(r.fromId) ?? '?', role: r.role })
    relsByEntity.set(r.toId, toList)
  }

  // Chunk counts per entity per source — use raw SQL for efficiency
  const chunkEntityCounts = await db.execute<{
    entity_id: number
    source: string
    cnt: number
  }>(sql`
    SELECT unnest(entity_ids) as entity_id, source, count(*)::int as cnt
    FROM kb_chunks
    WHERE entity_ids IS NOT NULL AND array_length(entity_ids, 1) > 0
    GROUP BY unnest(entity_ids), source
    ORDER BY entity_id, source
  `)

  const chunkCountsByEntity = new Map<number, Map<string, number>>()
  for (const row of chunkEntityCounts.rows) {
    const entityMap = chunkCountsByEntity.get(row.entity_id) ?? new Map<string, number>()
    entityMap.set(row.source, row.cnt)
    chunkCountsByEntity.set(row.entity_id, entityMap)
  }

  lines.push('2. ENTITY SAMPLES PER TYPE (up to 10 each)')
  lines.push(subHr)

  for (const [type, entities] of entityByType) {
    lines.push(`\n  [${type.toUpperCase()}] (${entities.length} total)`)
    const sample = entities.slice(0, 10)
    for (const e of sample) {
      const aliases = aliasesByEntity.get(e.id)
      const rels = relsByEntity.get(e.id) ?? []
      const chunkSources = chunkCountsByEntity.get(e.id)

      lines.push(`    * ${e.name}${e.company ? ` (${e.company})` : ''}`)
      if (aliases && aliases.length > 0) {
        lines.push(`      Aliases: ${aliases.join(', ')}`)
      }
      if (rels.length > 0) {
        const relStrs = rels.slice(0, 5).map((r) =>
          `${r.relation} -> ${r.targetName}${r.role ? ` (${r.role})` : ''}`,
        )
        lines.push(`      Relations: ${relStrs.join('; ')}`)
        if (rels.length > 5) lines.push(`        ... and ${rels.length - 5} more`)
      }
      if (chunkSources && chunkSources.size > 0) {
        const srcStrs = [...chunkSources.entries()].map(([s, c]) => `${c} ${s}`)
        lines.push(`      Chunks: ${srcStrs.join(', ')}`)
      } else {
        lines.push('      Chunks: none')
      }
    }
    if (entities.length > 10) {
      lines.push(`    ... and ${entities.length - 10} more ${type} entities`)
    }
  }
  lines.push('')

  // ── 3. Cross-source mapping examples ──
  lines.push('3. CROSS-SOURCE MAPPING (entities in 3+ sources)')
  lines.push(subHr)

  const crossSourceEntities: CrossSourceEntity[] = []
  for (const e of allEntities) {
    const sourceMap = chunkCountsByEntity.get(e.id)
    if (!sourceMap || sourceMap.size < 3) continue
    crossSourceEntities.push({
      id: e.id,
      name: e.name,
      type: e.type,
      sources: [...sourceMap.entries()].map(([source, count]) => ({ source, count })),
      sampleTexts: [],
    })
  }

  // Sort by number of sources descending, then by total chunk count
  crossSourceEntities.sort((a, b) => {
    const srcDiff = b.sources.length - a.sources.length
    if (srcDiff !== 0) return srcDiff
    const totalA = a.sources.reduce((sum, s) => sum + s.count, 0)
    const totalB = b.sources.reduce((sum, s) => sum + s.count, 0)
    return totalB - totalA
  })

  const topCross = crossSourceEntities.slice(0, 10)

  // Fetch sample chunk texts for cross-source entities
  if (topCross.length > 0) {
    for (const entity of topCross) {
      for (const src of entity.sources) {
        const [sampleChunk] = await db.select({ text: kbChunks.text, source: kbChunks.source })
          .from(kbChunks)
          .where(and(
            eq(kbChunks.source, src.source),
            sql`${entity.id} = ANY(${kbChunks.entityIds})`,
          ))
          .limit(1)
        if (sampleChunk) {
          entity.sampleTexts.push({
            source: sampleChunk.source,
            text: sampleChunk.text.slice(0, 100).replace(/\n/g, ' '),
          })
        }
      }
    }
  }

  if (topCross.length === 0) {
    lines.push('  No entities found in 3+ sources yet.')
  } else {
    for (const entity of topCross) {
      const srcBreakdown = entity.sources.map((s) => `${s.count} ${s.source}`).join(', ')
      lines.push(`\n  * ${entity.name} (${entity.type}) -- ${entity.sources.length} sources`)
      lines.push(`    Sources: ${srcBreakdown}`)
      for (const st of entity.sampleTexts) {
        lines.push(`    [${st.source}] "${st.text}..."`)
      }
    }
  }
  lines.push('')

  // ── 4. Potential issues ──
  lines.push('4. POTENTIAL ISSUES')
  lines.push(subHr)

  // 4a. Person entities with raw Slack ID pattern
  const slackIdPattern = /^U[A-Z0-9]{8,}$/
  const slackIdEntities = allEntities.filter((e) => e.type === 'person' && slackIdPattern.test(e.name))

  lines.push(`\n  a) Person entities with raw Slack IDs: ${slackIdEntities.length}`)
  if (slackIdEntities.length > 0) {
    for (const e of slackIdEntities.slice(0, 20)) {
      lines.push(`     - ${e.name}`)
    }
    if (slackIdEntities.length > 20) {
      lines.push(`     ... and ${slackIdEntities.length - 20} more`)
    }
  }

  // 4b. Entity names longer than 100 characters
  const longNameEntities = allEntities.filter((e) => e.name.length > 100)
  lines.push(`\n  b) Entity names > 100 chars: ${longNameEntities.length}`)
  if (longNameEntities.length > 0) {
    for (const e of longNameEntities.slice(0, 10)) {
      lines.push(`     - [${e.type}] "${e.name.slice(0, 80)}..." (${e.name.length} chars)`)
    }
  }

  // 4c. Entities with zero chunk references (orphaned)
  const orphanedEntities = allEntities.filter((e) => !chunkCountsByEntity.has(e.id))
  lines.push(`\n  c) Orphaned entities (no chunk references): ${orphanedEntities.length}`)
  if (orphanedEntities.length > 0) {
    for (const e of orphanedEntities.slice(0, 15)) {
      lines.push(`     - [${e.type}] ${e.name}`)
    }
    if (orphanedEntities.length > 15) {
      lines.push(`     ... and ${orphanedEntities.length - 15} more`)
    }
  }

  // 4d. Duplicate-looking entity pairs (same type, Levenshtein <= 3)
  lines.push(`\n  d) Potential duplicates (same type, similar names):`)
  const duplicatePairs: Array<{ a: string; b: string; type: string; dist: number }> = []
  for (const [type, entities] of entityByType) {
    // Compare all pairs within the same type (limit to avoid O(n^2) explosion)
    const capped = entities.slice(0, 200) // cap at 200 per type for performance
    for (let i = 0; i < capped.length; i++) {
      for (let j = i + 1; j < capped.length; j++) {
        const nameA = capped[i].name.toLowerCase()
        const nameB = capped[j].name.toLowerCase()
        // Skip if names are identical (already deduped by DB constraint)
        if (nameA === nameB) continue
        const dist = levenshteinDistance(nameA, nameB, 3)
        if (dist <= 3) {
          duplicatePairs.push({
            a: capped[i].name,
            b: capped[j].name,
            type,
            dist,
          })
        }
      }
    }
  }

  if (duplicatePairs.length === 0) {
    lines.push('     None detected')
  } else {
    for (const pair of duplicatePairs.slice(0, 20)) {
      lines.push(`     - [${pair.type}] "${pair.a}" ~ "${pair.b}" (dist=${pair.dist})`)
    }
    if (duplicatePairs.length > 20) {
      lines.push(`     ... and ${duplicatePairs.length - 20} more pairs`)
    }
  }
  lines.push('')

  // ── 5. Coverage stats per source ──
  lines.push('5. COVERAGE STATS PER SOURCE')
  lines.push(subHr)

  const sources = ['slack', 'gmail', 'calendar', 'clickup', 'notion', 'drive']
  for (const source of sources) {
    // Total extractable (not stubs, min text 100, entity_ids IS NULL excluded from "extractable" — we want total eligible)
    const [totalRow] = await db.select({
      count: sql<number>`count(*)::int`,
    }).from(kbChunks).where(and(
      eq(kbChunks.source, source),
      sql`length(${kbChunks.text}) > 100`,
      sql`${kbChunks.text} NOT LIKE '%[metadata-only stub]%'`,
      sql`${kbChunks.text} NOT LIKE '%[system email -- metadata only]%'`,
    ))

    // Processed (entity_ids is NOT NULL)
    const [processedRow] = await db.select({
      count: sql<number>`count(*)::int`,
    }).from(kbChunks).where(and(
      eq(kbChunks.source, source),
      sql`length(${kbChunks.text}) > 100`,
      sql`${kbChunks.text} NOT LIKE '%[metadata-only stub]%'`,
      sql`${kbChunks.text} NOT LIKE '%[system email -- metadata only]%'`,
      sql`${kbChunks.entityIds} IS NOT NULL`,
    ))

    const total = totalRow?.count ?? 0
    const processed = processedRow?.count ?? 0
    const unprocessed = total - processed
    const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : '0.0'

    lines.push(`\n  ${source}:`)
    lines.push(`    Total extractable: ${total}`)
    lines.push(`    Processed:         ${processed}`)
    lines.push(`    Unprocessed:       ${unprocessed}`)
    lines.push(`    Coverage:          ${pct}%`)
  }

  // Overall coverage
  const [overallTotal] = await db.select({
    count: sql<number>`count(*)::int`,
  }).from(kbChunks).where(and(
    sql`length(${kbChunks.text}) > 100`,
    sql`${kbChunks.text} NOT LIKE '%[metadata-only stub]%'`,
    sql`${kbChunks.text} NOT LIKE '%[system email -- metadata only]%'`,
    sql`${kbChunks.source} != 'drive'`,
  ))

  const [overallProcessed] = await db.select({
    count: sql<number>`count(*)::int`,
  }).from(kbChunks).where(and(
    sql`length(${kbChunks.text}) > 100`,
    sql`${kbChunks.text} NOT LIKE '%[metadata-only stub]%'`,
    sql`${kbChunks.text} NOT LIKE '%[system email -- metadata only]%'`,
    sql`${kbChunks.source} != 'drive'`,
    sql`${kbChunks.entityIds} IS NOT NULL`,
  ))

  const ot = overallTotal?.count ?? 0
  const op = overallProcessed?.count ?? 0
  const overallPct = ot > 0 ? ((op / ot) * 100).toFixed(1) : '0.0'

  lines.push(`\n  OVERALL (excl. drive):`)
  lines.push(`    Total extractable: ${ot}`)
  lines.push(`    Processed:         ${op}`)
  lines.push(`    Unprocessed:       ${ot - op}`)
  lines.push(`    Coverage:          ${overallPct}%`)
  lines.push('')

  // Total relations
  lines.push('SUMMARY')
  lines.push(subHr)
  lines.push(`Total entities:     ${allEntities.length}`)
  lines.push(`Total aliases:      ${allAliases.length}`)
  lines.push(`Total relations:    ${allRelations.length}`)
  lines.push(`Cross-source (3+):  ${crossSourceEntities.length}`)
  lines.push(`Slack ID issues:    ${slackIdEntities.length}`)
  lines.push(`Potential dupes:    ${duplicatePairs.length}`)
  lines.push(`Overall coverage:   ${overallPct}%`)
  lines.push('')
  lines.push(hr)

  return lines.join('\n')
}
