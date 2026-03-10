#!/usr/bin/env node
/**
 * Knowledge Map — structured KB dump for manual quality review.
 * Run: npx tsx src/kb/knowledge-map.ts [--section people|projects|processes|companies|clients|channels|orphans|stats]
 * Output: stdout (pipe to file for review)
 */
import 'dotenv/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema.js'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const db = drizzle(pool, { schema })

// Parse section filter from CLI args
const sectionArg = process.argv.find((a) => a.startsWith('--section'))
const sectionFilter = sectionArg ? process.argv[process.argv.indexOf(sectionArg) + 1] : null

interface Entity {
  id: number
  type: string
  name: string
  company: string | null
  metadata: Record<string, unknown> | null
}

interface Alias {
  entity_id: number
  alias: string
}

interface Relation {
  from_id: number
  to_id: number
  from_name: string
  from_type: string
  to_name: string
  to_type: string
  relation: string
  role: string | null
  status: string
  period: string | null
}

interface Fact {
  id: number
  entity_id: number
  fact_type: string
  text: string
  source: string
  fact_date: string | null
  confidence: number
}

interface Doc {
  id: number
  entity_id: number
  title: string
  url: string
  source: string
  doc_type: string
}

interface ChunkCount {
  source: string
  count: number
}

// ─── Load all data ───

const allEntities = (await db.execute<Entity>(
  sql`SELECT id, type, name, company, metadata FROM kb_entities ORDER BY type, name`,
)).rows

const allAliases = (await db.execute<Alias>(
  sql`SELECT entity_id, alias FROM kb_entity_aliases ORDER BY entity_id, alias`,
)).rows

const allRelations = (await db.execute<Relation>(
  sql`SELECT r.from_id, r.to_id, e1.name as from_name, e1.type as from_type,
      e2.name as to_name, e2.type as to_type, r.relation, r.role, r.status, r.period
      FROM kb_entity_relations r
      JOIN kb_entities e1 ON r.from_id = e1.id
      JOIN kb_entities e2 ON r.to_id = e2.id
      ORDER BY r.relation, e1.name`,
)).rows

const allFacts = (await db.execute<Fact>(
  sql`SELECT id, entity_id, fact_type, text, source, fact_date::text, confidence
      FROM kb_facts ORDER BY entity_id, fact_date DESC NULLS LAST`,
)).rows

const allDocs = (await db.execute<Doc>(
  sql`SELECT id, entity_id, title, url, source, doc_type
      FROM kb_documents ORDER BY entity_id, title`,
)).rows

const chunkCounts = (await db.execute<ChunkCount>(
  sql`SELECT source, count(*)::int as count FROM kb_chunks GROUP BY source ORDER BY count DESC`,
)).rows

const totalChunks = chunkCounts.reduce((sum, c) => sum + c.count, 0)

// ─── Index data ───

const entityById = new Map<number, Entity>()
for (const e of allEntities) entityById.set(e.id, e)

const aliasesByEntity = new Map<number, string[]>()
for (const a of allAliases) {
  const list = aliasesByEntity.get(a.entity_id) ?? []
  list.push(a.alias)
  aliasesByEntity.set(a.entity_id, list)
}

const relsByEntity = new Map<number, Relation[]>()
for (const r of allRelations) {
  const fromList = relsByEntity.get(r.from_id) ?? []
  fromList.push(r)
  relsByEntity.set(r.from_id, fromList)
  const toList = relsByEntity.get(r.to_id) ?? []
  toList.push(r)
  relsByEntity.set(r.to_id, toList)
}

const factsByEntity = new Map<number, Fact[]>()
for (const f of allFacts) {
  const list = factsByEntity.get(f.entity_id) ?? []
  list.push(f)
  factsByEntity.set(f.entity_id, list)
}

const docsByEntity = new Map<number, Doc[]>()
for (const d of allDocs) {
  const list = docsByEntity.get(d.entity_id) ?? []
  list.push(d)
  docsByEntity.set(d.entity_id, list)
}

// ─── Helpers ───

function line(text: string) { process.stdout.write(text + '\n') }
function header(text: string) { line(`\n${'═'.repeat(80)}\n${text}\n${'═'.repeat(80)}`) }
function subheader(text: string) { line(`\n${'─'.repeat(60)}\n${text}\n${'─'.repeat(60)}`) }

function formatAliases(entityId: number): string {
  const aliases = aliasesByEntity.get(entityId)
  if (!aliases || aliases.length === 0) return ''
  return `  Aliases: ${aliases.join(', ')}`
}

function formatMetadata(meta: Record<string, unknown> | null): string {
  if (!meta || Object.keys(meta).length === 0) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(meta)) {
    if (v !== null && v !== undefined && v !== '') {
      parts.push(`${k}: ${v}`)
    }
  }
  return parts.length > 0 ? `  Metadata: ${parts.join(' | ')}` : ''
}

function formatRelationsFor(entityId: number): string[] {
  const rels = relsByEntity.get(entityId) ?? []
  if (rels.length === 0) return []
  const lines: string[] = []
  for (const r of rels) {
    const role = r.role ? ` (${r.role})` : ''
    const status = r.status !== 'active' ? ` [${r.status}]` : ''
    const period = r.period ? ` [${r.period}]` : ''
    if (r.from_id === entityId) {
      lines.push(`    → ${r.relation}${role}${status}${period} → ${r.to_name} [${r.to_type}]`)
    } else {
      lines.push(`    ← ${r.relation}${role}${status}${period} ← ${r.from_name} [${r.from_type}]`)
    }
  }
  return lines
}

function formatFacts(entityId: number, limit = 10): string[] {
  const facts = factsByEntity.get(entityId) ?? []
  if (facts.length === 0) return []
  const lines: string[] = []
  const shown = facts.slice(0, limit)
  for (const f of shown) {
    const date = f.fact_date ? f.fact_date.substring(0, 10) : '?'
    lines.push(`    [${f.fact_type}] ${date} — ${f.text.substring(0, 200)}${f.text.length > 200 ? '...' : ''} (${f.source})`)
  }
  if (facts.length > limit) {
    lines.push(`    ... and ${facts.length - limit} more facts`)
  }
  return lines
}

function formatDocs(entityId: number): string[] {
  const docs = docsByEntity.get(entityId) ?? []
  if (docs.length === 0) return []
  return docs.map((d) => `    [${d.doc_type}] ${d.title} (${d.source}) ${d.url}`)
}

function printEntity(e: Entity, factsLimit = 10) {
  const company = e.company ? ` [${e.company}]` : ''
  line(`\n  ■ ${e.name}${company} (id:${e.id})`)
  const aliasStr = formatAliases(e.id)
  if (aliasStr) line(aliasStr)
  const metaStr = formatMetadata(e.metadata)
  if (metaStr) line(metaStr)
  const rels = formatRelationsFor(e.id)
  if (rels.length > 0) {
    line('  Relations:')
    rels.forEach((r) => line(r))
  }
  const docs = formatDocs(e.id)
  if (docs.length > 0) {
    line('  Documents:')
    docs.forEach((d) => line(d))
  }
  const facts = formatFacts(e.id, factsLimit)
  if (facts.length > 0) {
    line('  Facts:')
    facts.forEach((f) => line(f))
  }
}

// ─── Sections ───

function printStats() {
  header('KNOWLEDGE BASE OVERVIEW')
  line(`\nGenerated: ${new Date().toISOString().substring(0, 10)}`)
  line(`\nEntity counts:`)
  const byType = new Map<string, number>()
  for (const e of allEntities) byType.set(e.type, (byType.get(e.type) ?? 0) + 1)
  for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    line(`  ${type}: ${count}`)
  }
  line(`  TOTAL entities: ${allEntities.length}`)
  line(`\nAliases: ${allAliases.length}`)
  line(`Relations: ${allRelations.length}`)
  line(`Facts: ${allFacts.length}`)
  line(`Documents: ${allDocs.length}`)
  line(`\nChunks by source:`)
  for (const c of chunkCounts) line(`  ${c.source}: ${c.count.toLocaleString()}`)
  line(`  TOTAL: ${totalChunks.toLocaleString()}`)
}

function printPeople() {
  const people = allEntities.filter((e) => e.type === 'person')
  header(`PEOPLE (${people.length})`)
  for (const p of people) printEntity(p, 5)
}

function printProjects() {
  const projects = allEntities.filter((e) => e.type === 'project')
  header(`PROJECTS (${projects.length})`)
  for (const p of projects) printEntity(p, 15)
}

function printProcesses() {
  const processes = allEntities.filter((e) => e.type === 'process')
  header(`PROCESSES (${processes.length})`)
  for (const p of processes) printEntity(p, 5)
}

function printCompanies() {
  const companies = allEntities.filter((e) => e.type === 'company')
  header(`COMPANIES (${companies.length})`)
  for (const c of companies) printEntity(c)
}

function printClients() {
  const clients = allEntities.filter((e) => e.type === 'client')
  header(`CLIENTS (${clients.length})`)
  for (const c of clients) printEntity(c)
}

function printChannels() {
  const channels = allEntities.filter((e) => e.type === 'channel')
  header(`CHANNELS (${channels.length})`)
  for (const c of channels) printEntity(c, 3)
}

function printOrphans() {
  header('ORPHAN ENTITIES (no relations)')
  const orphans = allEntities.filter((e) => {
    const rels = relsByEntity.get(e.id) ?? []
    return rels.length === 0
  })
  line(`\nTotal orphans: ${orphans.length}`)
  const byType = new Map<string, Entity[]>()
  for (const e of orphans) {
    const list = byType.get(e.type) ?? []
    list.push(e)
    byType.set(e.type, list)
  }
  for (const [type, entities] of [...byType.entries()].sort()) {
    subheader(`${type} orphans (${entities.length})`)
    for (const e of entities) {
      const facts = factsByEntity.get(e.id) ?? []
      const aliases = aliasesByEntity.get(e.id) ?? []
      const company = e.company ? ` [${e.company}]` : ''
      line(`  ${e.name}${company} (id:${e.id}) — ${facts.length} facts, ${aliases.length} aliases`)
    }
  }
}

// ─── Main ───

const sections: Record<string, () => void> = {
  stats: printStats,
  people: printPeople,
  projects: printProjects,
  processes: printProcesses,
  companies: printCompanies,
  clients: printClients,
  channels: printChannels,
  orphans: printOrphans,
}

if (sectionFilter) {
  const fn = sections[sectionFilter]
  if (!fn) {
    console.error(`Unknown section: ${sectionFilter}. Available: ${Object.keys(sections).join(', ')}`)
    process.exit(1)
  }
  fn()
} else {
  // Print all sections
  for (const fn of Object.values(sections)) fn()
}

await pool.end()
