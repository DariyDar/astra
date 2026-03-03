#!/usr/bin/env node
/**
 * Inspect the KB entity graph. Run: npx tsx src/kb/inspect.ts
 */
import 'dotenv/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema.js'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const db = drizzle(pool, { schema })

// Entity counts
const types = await db.execute<{ type: string; count: number }>(
  sql`SELECT type, count(*)::int as count FROM kb_entities GROUP BY type ORDER BY count DESC`,
)
console.log('=== Entities by type ===')
for (const r of types.rows) console.log(`  ${r.type}: ${r.count}`)

// People
const people = await db.execute<{ name: string; company: string | null }>(
  sql`SELECT name, company FROM kb_entities WHERE type='person' ORDER BY name`,
)
console.log('\n=== People ===')
for (const r of people.rows) console.log(`  ${r.name} (${r.company || 'cross'})`)

// Projects
const projects = await db.execute<{ name: string; company: string | null }>(
  sql`SELECT name, company FROM kb_entities WHERE type='project' ORDER BY name`,
)
console.log('\n=== Projects ===')
for (const r of projects.rows) console.log(`  ${r.name} (${r.company || 'cross'})`)

// Companies
const companies = await db.execute<{ name: string }>(
  sql`SELECT name FROM kb_entities WHERE type='company' ORDER BY name`,
)
console.log('\n=== Companies ===')
for (const r of companies.rows) console.log(`  ${r.name}`)

// Aliases sample
const aliases = await db.execute<{ alias: string; entity_name: string }>(
  sql`SELECT a.alias, e.name as entity_name FROM kb_entity_aliases a JOIN kb_entities e ON a.entity_id = e.id ORDER BY e.name, a.alias`,
)
console.log(`\n=== Aliases (${aliases.rows.length} total) ===`)
for (const r of aliases.rows) console.log(`  ${r.alias} → ${r.entity_name}`)

// Relations
const rels = await db.execute<{ from_name: string; relation: string; role: string | null; to_name: string }>(
  sql`SELECT e1.name as from_name, r.relation, r.role, e2.name as to_name
      FROM kb_entity_relations r
      JOIN kb_entities e1 ON r.from_id = e1.id
      JOIN kb_entities e2 ON r.to_id = e2.id
      ORDER BY e2.name, e1.name`,
)
console.log(`\n=== Relations (${rels.rows.length} total) ===`)
for (const r of rels.rows) {
  const role = r.role ? ` (${r.role})` : ''
  console.log(`  ${r.from_name} --[${r.relation}${role}]--> ${r.to_name}`)
}

await pool.end()
