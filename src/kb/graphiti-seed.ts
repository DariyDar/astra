#!/usr/bin/env node
/**
 * Seed the Graphiti knowledge graph with clean entities from seed.ts.
 *
 * Strategy: feed structured text episodes to Graphiti, letting its LLM
 * extract entities + edges naturally. This produces a richer graph than
 * manually creating bare entity nodes.
 *
 * Group IDs map to entity types: "companies", "projects", "people", "processes".
 * Relations are seeded as separate episodes in a "relations" group.
 *
 * Run: GRAPHITI_URL=http://localhost:3200 npx tsx src/kb/graphiti-seed.ts
 */
import { allEntities, relations, type SeedEntity, type SeedRelation } from './seed.js'
import type { GraphitiMessage } from './graphiti-client.js'

const GRAPHITI_URL = process.env.GRAPHITI_URL ?? 'http://localhost:3200'
const INTER_REQUEST_DELAY_MS = 4_500 // ~13 RPM, under Gemini 15 RPM limit
const REQUEST_TIMEOUT_MS = 60_000

// ── HTTP helpers ──

async function graphitiFetch<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(`${GRAPHITI_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`${res.status}: ${text}`)
    }

    return await res.json() as T
  } finally {
    clearTimeout(timeoutId)
  }
}

async function healthcheck(): Promise<boolean> {
  try {
    const res = await fetch(`${GRAPHITI_URL}/healthcheck`, { signal: AbortSignal.timeout(5_000) })
    return res.ok
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Episode builders ──

function buildEntityEpisode(entity: SeedEntity): GraphitiMessage {
  const parts: string[] = []

  parts.push(`${entity.name} is a ${entity.type}.`)

  if (entity.company) {
    const companyLabel = entity.company === 'ac' ? 'AstroCat' : entity.company === 'hg' ? 'Highground' : entity.company
    parts.push(`${entity.name} belongs to ${companyLabel}.`)
  }

  if (entity.aliases && entity.aliases.length > 0) {
    parts.push(`Also known as: ${entity.aliases.join(', ')}.`)
  }

  if (entity.metadata) {
    if (entity.metadata.role) parts.push(`Role: ${entity.metadata.role}.`)
    if (entity.metadata.client) parts.push(`Client: ${entity.metadata.client}.`)
    if (entity.metadata.description) parts.push(`${entity.metadata.description}`)
    if (entity.metadata.display_name) parts.push(`Display name: ${entity.metadata.display_name}.`)
    if (entity.metadata.platform) parts.push(`Platform: ${entity.metadata.platform}.`)
    if (entity.metadata.project) parts.push(`Related project: ${entity.metadata.project}.`)
  }

  return {
    content: parts.join(' '),
    name: `seed-entity-${entity.type}-${entity.name}`,
    role_type: 'system',
    source_description: `seed:${entity.type}`,
  }
}

function buildRelationEpisode(rel: SeedRelation): GraphitiMessage {
  const parts: string[] = []

  switch (rel.relation) {
    case 'works_on':
      parts.push(`${rel.from} works on ${rel.to}${rel.role ? ` as ${rel.role}` : ''}.`)
      break
    case 'manages':
      parts.push(`${rel.from} manages ${rel.to}${rel.role ? ` as ${rel.role}` : ''}.`)
      break
    case 'owns':
      parts.push(`${rel.from} owns/co-founded ${rel.to}${rel.role ? ` (${rel.role})` : ''}.`)
      break
    case 'member_of':
      parts.push(`${rel.from} is a member of ${rel.to}${rel.role ? ` (${rel.role})` : ''}.`)
      break
    case 'client_of':
      parts.push(`${rel.from} is a client of ${rel.to}. ${rel.from} commissions work on ${rel.to}.`)
      break
  }

  return {
    content: parts.join(' '),
    name: `seed-relation-${rel.from}-${rel.relation}-${rel.to}`,
    role_type: 'system',
    source_description: 'seed:relation',
  }
}

// ── Main ──

async function main() {
  console.log('Graphiti Seed — loading entities from seed.ts')
  console.log(`Target: ${GRAPHITI_URL}`)
  console.log(`Entities: ${allEntities.length}, Relations: ${relations.length}`)
  console.log(`Rate limit delay: ${INTER_REQUEST_DELAY_MS}ms between requests\n`)

  // Health check
  const ok = await healthcheck()
  if (!ok) {
    console.error('ERROR: Graphiti server is not reachable at', GRAPHITI_URL)
    process.exit(1)
  }
  console.log('Graphiti server is healthy.\n')

  let succeeded = 0
  let failed = 0
  const errors: string[] = []

  // Phase 1: Seed entities as episodes (grouped by type)
  console.log('── Phase 1: Seeding entities ──')

  for (let i = 0; i < allEntities.length; i++) {
    const entity = allEntities[i]
    const groupId = `seed-${entity.type}`
    const message = buildEntityEpisode(entity)

    try {
      await graphitiFetch('/messages', { group_id: groupId, messages: [message] })
      succeeded++
      console.log(`  [${i + 1}/${allEntities.length}] OK: ${entity.type}/${entity.name}`)
    } catch (error) {
      failed++
      const msg = `${entity.type}/${entity.name}: ${error instanceof Error ? error.message : error}`
      errors.push(msg)
      console.error(`  [${i + 1}/${allEntities.length}] FAIL: ${msg}`)
    }

    if (i < allEntities.length - 1) await delay(INTER_REQUEST_DELAY_MS)
  }

  console.log(`\nEntities: ${succeeded} OK, ${failed} failed\n`)

  // Phase 2: Seed relations as episodes
  console.log('── Phase 2: Seeding relations ──')

  let relSucceeded = 0
  let relFailed = 0

  for (let i = 0; i < relations.length; i++) {
    const rel = relations[i]
    const message = buildRelationEpisode(rel)

    try {
      await graphitiFetch('/messages', { group_id: 'seed-relations', messages: [message] })
      relSucceeded++
      console.log(`  [${i + 1}/${relations.length}] OK: ${rel.from} → ${rel.relation} → ${rel.to}`)
    } catch (error) {
      relFailed++
      const msg = `${rel.from} → ${rel.to}: ${error instanceof Error ? error.message : error}`
      errors.push(msg)
      console.error(`  [${i + 1}/${relations.length}] FAIL: ${msg}`)
    }

    if (i < relations.length - 1) await delay(INTER_REQUEST_DELAY_MS)
  }

  console.log(`\nRelations: ${relSucceeded} OK, ${relFailed} failed`)

  // Summary
  console.log('\n── Summary ──')
  console.log(`Total: ${succeeded + relSucceeded} OK, ${failed + relFailed} failed`)

  if (errors.length > 0) {
    console.log('\nErrors:')
    for (const e of errors) console.log(`  - ${e}`)
  }

  const totalRequests = allEntities.length + relations.length
  const estimatedMinutes = Math.ceil((totalRequests * INTER_REQUEST_DELAY_MS) / 60_000)
  console.log(`\nActual time: ~${estimatedMinutes} minutes for ${totalRequests} requests`)
}

main().catch((error) => {
  console.error('Seed failed:', error)
  process.exit(1)
})
