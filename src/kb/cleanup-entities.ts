#!/usr/bin/env node
/**
 * KB Entity Cleanup — bulk removal of junk entities.
 * Run: npx tsx src/kb/cleanup-entities.ts [--dry-run]
 *
 * Deletes: STT game characters, unresolved Slack IDs, role titles,
 * junk processes/projects/companies/clients/channels, duplicates.
 * Merges: company duplicates, channel duplicates, person duplicates, project duplicates.
 */
import 'dotenv/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema.js'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const db = drizzle(pool, { schema })
const dryRun = process.argv.includes('--dry-run')

interface Row { id: number; name: string }

// ─── Helpers ───

async function query(sqlStr: ReturnType<typeof sql>): Promise<Row[]> {
  const result = await db.execute(sqlStr)
  return result.rows as unknown as Row[]
}

async function deleteEntities(ids: number[], reason: string): Promise<number> {
  let deleted = 0
  for (const id of ids) {
    const [entity] = await query(sql`SELECT id, name FROM kb_entities WHERE id = ${id}`)
    if (!entity) continue
    if (dryRun) {
      console.log(`  [DRY-RUN] Would delete: ${entity.name} (id:${id}) — ${reason}`)
    } else {
      await db.execute(sql`UPDATE kb_chunks SET entity_ids = array_remove(entity_ids, ${id}) WHERE ${id} = ANY(entity_ids)`)
      await db.execute(sql`DELETE FROM kb_entities WHERE id = ${id}`)
      console.log(`  Deleted: ${entity.name} (id:${id}) — ${reason}`)
    }
    deleted++
  }
  return deleted
}

async function mergeEntity(targetId: number, sourceId: number): Promise<boolean> {
  const [target] = await query(sql`SELECT id, name FROM kb_entities WHERE id = ${targetId}`)
  const [source] = await query(sql`SELECT id, name FROM kb_entities WHERE id = ${sourceId}`)
  if (!target || !source) return false

  if (dryRun) {
    console.log(`  [DRY-RUN] Would merge: ${source.name} (id:${sourceId}) → ${target.name} (id:${targetId})`)
    return true
  }

  // Add source name as alias
  await db.execute(sql`INSERT INTO kb_entity_aliases (entity_id, alias) SELECT ${targetId}, name FROM kb_entities WHERE id = ${sourceId} ON CONFLICT (alias) DO NOTHING`)
  // Move aliases
  await db.execute(sql`UPDATE kb_entity_aliases SET entity_id = ${targetId} WHERE entity_id = ${sourceId} AND alias NOT IN (SELECT alias FROM kb_entity_aliases WHERE entity_id = ${targetId})`)
  await db.execute(sql`DELETE FROM kb_entity_aliases WHERE entity_id = ${sourceId}`)
  // Move facts
  await db.execute(sql`UPDATE kb_facts SET entity_id = ${targetId} WHERE entity_id = ${sourceId} AND NOT EXISTS (SELECT 1 FROM kb_facts f2 WHERE f2.entity_id = ${targetId} AND f2.text = kb_facts.text AND f2.fact_type = kb_facts.fact_type)`)
  await db.execute(sql`DELETE FROM kb_facts WHERE entity_id = ${sourceId}`)
  // Move relations (from)
  await db.execute(sql`UPDATE kb_entity_relations SET from_id = ${targetId} WHERE from_id = ${sourceId} AND NOT EXISTS (SELECT 1 FROM kb_entity_relations r2 WHERE r2.from_id = ${targetId} AND r2.to_id = kb_entity_relations.to_id AND r2.relation = kb_entity_relations.relation)`)
  await db.execute(sql`DELETE FROM kb_entity_relations WHERE from_id = ${sourceId}`)
  // Move relations (to)
  await db.execute(sql`UPDATE kb_entity_relations SET to_id = ${targetId} WHERE to_id = ${sourceId} AND NOT EXISTS (SELECT 1 FROM kb_entity_relations r2 WHERE r2.from_id = kb_entity_relations.from_id AND r2.to_id = ${targetId} AND r2.relation = kb_entity_relations.relation)`)
  await db.execute(sql`DELETE FROM kb_entity_relations WHERE to_id = ${sourceId}`)
  // Move documents
  await db.execute(sql`UPDATE kb_documents SET entity_id = ${targetId} WHERE entity_id = ${sourceId} AND NOT EXISTS (SELECT 1 FROM kb_documents d2 WHERE d2.entity_id = ${targetId} AND d2.url = kb_documents.url)`)
  await db.execute(sql`DELETE FROM kb_documents WHERE entity_id = ${sourceId}`)
  // Update chunk arrays
  await db.execute(sql`UPDATE kb_chunks SET entity_ids = array_replace(entity_ids, ${sourceId}, ${targetId}) WHERE ${sourceId} = ANY(entity_ids)`)
  // Delete source
  await db.execute(sql`DELETE FROM kb_entities WHERE id = ${sourceId}`)

  console.log(`  Merged: ${source.name} (id:${sourceId}) → ${target.name} (id:${targetId})`)
  return true
}

// ─── CLEANUP RULES ───

async function main() {
  console.log(`\n=== KB ENTITY CLEANUP ${dryRun ? '(DRY RUN)' : '(LIVE)'} ===\n`)
  let totalDeleted = 0
  let totalMerged = 0

  // ────────────────────────────────────────────
  // 1. PERSONS
  // ────────────────────────────────────────────
  console.log('\n--- PERSON CLEANUP ---')

  // 1a. Merge duplicates FIRST (before deletion picks them up as orphans)
  const personMerges: [number, number[]][] = [
    [2344, [2346]], // Goar — Гоар Алавердян duplicate
    [281, [3987]],  // Diyar Taikenov — Дияр Тайкенов duplicate
    [261, [3986]],  // Vyacheslav Kuryakov — Вячеслав duplicate
    [273, [3985]],  // Yan Rymarchyk — Ян duplicate
    [57, [3399]],   // Bogdan Khashiev — Bogdan Kashiev duplicate
    [300, [3933]],  // Romain Blanchais — Romain duplicate
  ]
  console.log(`\n1a. Person duplicate merges: ${personMerges.length}`)
  for (const [target, sources] of personMerges) {
    for (const source of sources) {
      if (await mergeEntity(target, source)) totalMerged++
    }
  }

  // Protect real external contacts that happen to be orphans
  const protectedPersonIds = new Set([
    300,  // Romain Blanchais — Ohbibi employee
    1228, // Yakovkina — Tilting Point
    1229, // Rakocevic — Tilting Point
    2552, // Meaghan — HG (Manila QA oversight)
    1679, // Nadezhda Riabova — HG
    2038, // Viacheslav Nekatunin — HG
    4005, // Simon — AC (Simon Friedrich, Transperfect)
  ])

  // 1b. Orphan extracted persons (STT chars, interview candidates, etc.)
  const orphanPersons = await query(sql`
    SELECT e.id, e.name FROM kb_entities e
    WHERE e.type = 'person'
      AND e.metadata->>'source' = 'extraction'
      AND NOT EXISTS (SELECT 1 FROM kb_entity_aliases WHERE entity_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM kb_entity_relations r WHERE r.from_id = e.id OR r.to_id = e.id)
  `)
  const orphanPersonFiltered = orphanPersons.filter(r => !protectedPersonIds.has(r.id))
  console.log(`\n1b. Orphan extracted persons (${orphanPersons.length} found, ${orphanPersonFiltered.length} after protecting ${protectedPersonIds.size} known contacts):`)
  totalDeleted += await deleteEntities(orphanPersonFiltered.map(r => r.id), 'orphan extracted person')

  // 1c. Unresolved Slack IDs
  const slackIdPersons = await query(sql`
    SELECT id, name FROM kb_entities WHERE type = 'person' AND name ~ '^U[0-9A-Z]{8,}$'
  `)
  console.log(`\n1c. Unresolved Slack ID persons: ${slackIdPersons.length}`)
  totalDeleted += await deleteEntities(slackIdPersons.map(r => r.id), 'unresolved Slack ID')

  // 1d. Role titles stored as persons
  const roleTitles = await query(sql`
    SELECT id, name FROM kb_entities WHERE type = 'person'
      AND name IN ('Feature Owner', 'GD', 'GD (ГД)', 'PM', 'PM (ПМ)', 'Product Owner', 'Team Lead', 'Team Lead (Тимлид)')
  `)
  console.log(`\n1d. Role titles as persons: ${roleTitles.length}`)
  totalDeleted += await deleteEntities(roleTitles.map(r => r.id), 'role title, not person')

  // ────────────────────────────────────────────
  // 2. PROJECTS
  // ────────────────────────────────────────────
  console.log('\n--- PROJECT CLEANUP ---')

  // 2a. Orphan extracted projects (no aliases, no relations, <=2 facts) — STT events, external refs
  const orphanProjects = await query(sql`
    SELECT e.id, e.name FROM kb_entities e
    WHERE e.type = 'project'
      AND e.metadata->>'source' = 'extraction'
      AND NOT EXISTS (SELECT 1 FROM kb_entity_aliases WHERE entity_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM kb_entity_relations r WHERE r.from_id = e.id OR r.to_id = e.id)
      AND (SELECT count(*) FROM kb_facts WHERE entity_id = e.id) <= 2
  `)
  console.log(`\n2a. Orphan extracted projects (no aliases, no rels, <=2 facts): ${orphanProjects.length}`)
  totalDeleted += await deleteEntities(orphanProjects.map(r => r.id), 'orphan extracted project')

  // 2b. Known project duplicates
  const projectMerges: [number, number[]][] = [
    [16, [3747]],     // Aquarium ← Aquarium Project
    [1199, [3880]],   // SpongeBob KCO ← Sponge Bob (Mobile)
    [1646, [3881, 3859]], // SpongeBob Netflix ← Sponge Bob (Netflix), Sponge Bob-Netflix
    [13, [3882]],     // Star Trek Timelines ← Star Track
    [16, [3878, 3879]], // Aquarium ← Zen Aquarium (Mobile), Zen Aquarium (PC)
    [2699, [2674]],   // Dracula City Master ← DCM
    [17, [3874]],     // Idle Axe Thrower — referenced as idle-axe-project (if exists)
  ]
  console.log(`\n2b. Project duplicate merges: ${projectMerges.length}`)
  for (const [target, sources] of projectMerges) {
    for (const source of sources) {
      if (await mergeEntity(target, source)) totalMerged++
    }
  }

  // 2c. Sub-features / world levels (not standalone projects)
  const subFeatures = await query(sql`
    SELECT id, name FROM kb_entities WHERE type = 'project'
      AND (name IN ('World 1','World 2','World 3','World 4','Magic tree for Worlds 3-4',
                    'diabetes-UI','vikingssimulator','ohbibi.motorworld.bikefactory',
                    'ZombieMasters','diabetes app','StinkyBurgers','Wild West',
                    'Theme 1: Wild Wild West','Puzzle','Product Demo','Script-2',
                    'Jijo 5.10.4','IDLE ARMY','Ivan Shchelokov''s new game'))
  `)
  console.log(`\n2c. Sub-features / non-projects: ${subFeatures.length}`)
  totalDeleted += await deleteEntities(subFeatures.map(r => r.id), 'sub-feature, not standalone project')

  // 2d. External game references (mentioned in discussions, not company projects)
  const extGames = await query(sql`
    SELECT id, name FROM kb_entities WHERE type = 'project'
      AND name IN ('ABZU','Backpack Battles','Ballionaire','Bowmaster','Brawlhalla',
                   'Dungeon Rampage','Escape From Tarkov','Foxhole','Gold & Goblins: Idle Merger',
                   'Hill Climb Racing 2','INDIKA','Journey','LUDUS - Merge Arena PvP',
                   'Magic Sort','Match Mansion','Match Masters','Reigns','STALKRAFT',
                   'Slimes.TD','Spiritfall','Sword of the Sea','The Walking Dead',
                   'Toon Blast','Water Sort Puzzle','openfront.io','osu! gameplay',
                   'Badmirals and Dadmirals','Lower Decks','Voyager',
                   'Voyager''s Unimatrix Zero','Army of Heroes')
  `)
  console.log(`\n2d. External game references: ${extGames.length}`)
  totalDeleted += await deleteEntities(extGames.map(r => r.id), 'external game reference')

  // 2e. STT bug tickets as projects
  const sttBugs = await query(sql`
    SELECT id, name FROM kb_entities WHERE type = 'project' AND name ~ '^ST-[0-9]+$'
  `)
  console.log(`\n2e. STT bug tickets as projects: ${sttBugs.length}`)
  totalDeleted += await deleteEntities(sttBugs.map(r => r.id), 'bug ticket, not project')

  // ────────────────────────────────────────────
  // 3. PROCESSES
  // ────────────────────────────────────────────
  console.log('\n--- PROCESS CLEANUP ---')

  // 3a. Bare Jira tickets
  const jiraProcs = await query(sql`
    SELECT id, name FROM kb_entities WHERE type = 'process' AND name ~ '^ST-[0-9]+$'
  `)
  console.log(`\n3a. Jira ticket processes: ${jiraProcs.length}`)
  totalDeleted += await deleteEntities(jiraProcs.map(r => r.id), 'bare Jira ticket')

  // 3b. Raw ClickUp IDs
  const cuProcs = await query(sql`
    SELECT id, name FROM kb_entities WHERE type = 'process' AND name ~ '^86c[a-z0-9]+$'
  `)
  console.log(`\n3b. ClickUp ID processes: ${cuProcs.length}`)
  totalDeleted += await deleteEntities(cuProcs.map(r => r.id), 'raw ClickUp ID')

  // 3c. Version numbers
  const verProcs = await query(sql`
    SELECT id, name FROM kb_entities WHERE type = 'process' AND name ~ '^[0-9]+\.[0-9]+(\.[0-9]+)?$'
  `)
  console.log(`\n3c. Version number processes: ${verProcs.length}`)
  totalDeleted += await deleteEntities(verProcs.map(r => r.id), 'version number')

  // 3d. Build/server references
  const buildProcs = await query(sql`
    SELECT id, name FROM kb_entities WHERE type = 'process'
      AND (name ~ '^(Android|iOS|Build) #[0-9]+$' OR name ~ '^server_' OR name ~ '^update_' OR name ~ '^[0-9]{2}/[0-9]{2} Server$')
  `)
  console.log(`\n3d. Build/server ref processes: ${buildProcs.length}`)
  totalDeleted += await deleteEntities(buildProcs.map(r => r.id), 'build/server reference')

  // 3e. Empty orphan processes (0 facts AND 0 relations)
  const emptyProcs = await query(sql`
    SELECT e.id, e.name FROM kb_entities e
    WHERE e.type = 'process'
      AND NOT EXISTS (SELECT 1 FROM kb_facts WHERE entity_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM kb_entity_relations WHERE from_id = e.id OR to_id = e.id)
  `)
  console.log(`\n3e. Empty orphan processes (0 facts, 0 rels): ${emptyProcs.length}`)
  totalDeleted += await deleteEntities(emptyProcs.map(r => r.id), 'empty orphan process')

  // 3f. Tiny orphan processes (<=1 fact, 0 rels, short generic name)
  const tinyProcs = await query(sql`
    SELECT e.id, e.name FROM kb_entities e
    WHERE e.type = 'process'
      AND length(e.name) < 15
      AND NOT EXISTS (SELECT 1 FROM kb_entity_relations WHERE from_id = e.id OR to_id = e.id)
      AND (SELECT count(*) FROM kb_facts WHERE entity_id = e.id) <= 1
      AND NOT EXISTS (SELECT 1 FROM kb_entity_aliases WHERE entity_id = e.id)
  `)
  console.log(`\n3f. Tiny orphan processes (<15 chars, <=1 fact, 0 rels): ${tinyProcs.length}`)
  totalDeleted += await deleteEntities(tinyProcs.map(r => r.id), 'tiny generic process')

  // 3g. Full bug descriptions as process names (>80 chars, orphan)
  const longBugProcs = await query(sql`
    SELECT e.id, e.name FROM kb_entities e
    WHERE e.type = 'process'
      AND length(e.name) > 80
      AND NOT EXISTS (SELECT 1 FROM kb_entity_relations WHERE from_id = e.id OR to_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM kb_entity_aliases WHERE entity_id = e.id)
  `)
  console.log(`\n3g. Bug-description processes (>80 chars, orphan): ${longBugProcs.length}`)
  totalDeleted += await deleteEntities(longBugProcs.map(r => r.id), 'bug description as process name')

  // ────────────────────────────────────────────
  // 4. COMPANIES
  // ────────────────────────────────────────────
  console.log('\n--- COMPANY CLEANUP ---')

  // 4a. Company duplicate merges
  // Find canonical IDs first
  const findId = async (name: string): Promise<number | null> => {
    const [r] = await query(sql`SELECT id, name FROM kb_entities WHERE type = 'company' AND name = ${name} LIMIT 1`)
    return r?.id ?? null
  }

  const hgId = await findId('Highground')
  const tpId = await findId('Tilting Point')
  const alId = await findId('APPLOVIN BIDDING')
  const indiumId = await findId('Indium Soft')
  const daedalusId = await findId('Daedalus Lab')
  const relevateId = await findId('Relevate Health')

  const companyMergePairs: [string, string[]][] = [
    ['Highground', ['High Ground Games', 'High Ground Technology LLC', 'Highground Technology', 'Highground games']],
    ['Tilting Point', ['Tiltingpoint', 'TiltinggZ games', 'Tilting Point Media']],
    ['APPLOVIN BIDDING', ['APPLOVIN BIDIING', 'Applovin Max']],
    ['Indium Soft', ['Indium']],
    ['Daedalus Lab', ['Daedalus']],
    ['Relevate Health', ['Relevate']],
    ['AstroCat', ['Астрокет']],
    ['Amazon', ['amazon.com']],
    ['App Center', ['AppCenter']],
    ['Unity Ads', ['UnityAds']],
    ['Messengage.ai', ['Messengage.com']],
  ]

  console.log(`\n4a. Company duplicate merges:`)
  for (const [targetName, sourceNames] of companyMergePairs) {
    const targetRow = await query(sql`SELECT id, name FROM kb_entities WHERE type = 'company' AND name = ${targetName} LIMIT 1`)
    if (!targetRow.length) { console.log(`  Skip: ${targetName} not found`); continue }
    for (const srcName of sourceNames) {
      const srcRow = await query(sql`SELECT id, name FROM kb_entities WHERE type = 'company' AND name = ${srcName} LIMIT 1`)
      if (!srcRow.length) continue
      if (await mergeEntity(targetRow[0].id, srcRow[0].id)) totalMerged++
    }
  }

  // 4b. Fictional/junk companies
  const junkCompanies = await query(sql`
    SELECT id, name FROM kb_entities WHERE type = 'company'
      AND name IN ('Ferengi Alliance', 'Team A', 'Team B', 'Narrative')
  `)
  console.log(`\n4b. Junk companies: ${junkCompanies.length}`)
  totalDeleted += await deleteEntities(junkCompanies.map(r => r.id), 'junk company')

  // 4c. Orphan extracted companies (SaaS tools, no rels, no aliases, <=2 facts)
  const orphanCompanies = await query(sql`
    SELECT e.id, e.name FROM kb_entities e
    WHERE e.type = 'company'
      AND e.metadata->>'source' = 'extraction'
      AND NOT EXISTS (SELECT 1 FROM kb_entity_aliases WHERE entity_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM kb_entity_relations r WHERE r.from_id = e.id OR r.to_id = e.id)
      AND (SELECT count(*) FROM kb_facts WHERE entity_id = e.id) <= 2
  `)
  console.log(`\n4c. Orphan extracted companies (SaaS/noise): ${orphanCompanies.length}`)
  totalDeleted += await deleteEntities(orphanCompanies.map(r => r.id), 'orphan extracted company')

  // ────────────────────────────────────────────
  // 5. CLIENTS
  // ────────────────────────────────────────────
  console.log('\n--- CLIENT CLEANUP ---')

  // 5a. Generic/meaningless clients
  const junkClients = await query(sql`
    SELECT id, name FROM kb_entities WHERE type = 'client'
      AND name IN ('Client','Customer','Customers','mobile','pc','Slack','TP host')
  `)
  console.log(`\n5a. Generic clients: ${junkClients.length}`)
  totalDeleted += await deleteEntities(junkClients.map(r => r.id), 'generic client label')

  // 5b. Countries/regions as clients
  const countryClients = await query(sql`
    SELECT id, name FROM kb_entities WHERE type = 'client'
      AND name IN ('Armenia','Australia','Belarus','Bulgaria','Canada','Dubai','Europe',
                   'Germany','India','Philippines','Russia','US','Serbia')
  `)
  console.log(`\n5b. Countries as clients: ${countryClients.length}`)
  totalDeleted += await deleteEntities(countryClients.map(r => r.id), 'country, not client')

  // 5c. Languages as clients
  const langClients = await query(sql`
    SELECT id, name FROM kb_entities WHERE type = 'client'
      AND name IN ('Chinese','Japanese','Traditional Chinese')
  `)
  console.log(`\n5c. Languages as clients: ${langClients.length}`)
  totalDeleted += await deleteEntities(langClients.map(r => r.id), 'language, not client')

  // 5d. Device models as clients
  const deviceClients = await query(sql`
    SELECT id, name FROM kb_entities WHERE type = 'client'
      AND name IN ('iPhones','iPads','iPhone X','Redmi Note 13')
  `)
  console.log(`\n5d. Devices as clients: ${deviceClients.length}`)
  totalDeleted += await deleteEntities(deviceClients.map(r => r.id), 'device model, not client')

  // 5e. Duplicate store/platform clients
  const dupClientMerges: [string, string[]][] = [
    ['Google Play Store', ['GooglePlay', 'Play Market', 'Google Play Console']],
    ['Apple App Store', ['Appstore', 'iOS store']],
  ]
  console.log(`\n5e. Client duplicate merges:`)
  for (const [targetName, sourceNames] of dupClientMerges) {
    const targetRow = await query(sql`SELECT id, name FROM kb_entities WHERE type = 'client' AND name = ${targetName} LIMIT 1`)
    if (!targetRow.length) { console.log(`  Skip: ${targetName} not found`); continue }
    for (const srcName of sourceNames) {
      const srcRow = await query(sql`SELECT id, name FROM kb_entities WHERE type = 'client' AND name = ${srcName} LIMIT 1`)
      if (!srcRow.length) continue
      if (await mergeEntity(targetRow[0].id, srcRow[0].id)) totalMerged++
    }
  }

  // ────────────────────────────────────────────
  // 6. CHANNELS
  // ────────────────────────────────────────────
  console.log('\n--- CHANNEL CLEANUP ---')

  // 6a. Unresolved Slack channel IDs
  const unresChans = await query(sql`
    SELECT id, name FROM kb_entities WHERE type = 'channel'
      AND (name ~ '^C[0-9A-Z]{8,}$' OR name ~ '^ac/C[0-9A-Z]{8,}$' OR name ~ '^hg/C[0-9A-Z]{8,}$')
  `)
  console.log(`\n6a. Unresolved channel IDs: ${unresChans.length}`)
  totalDeleted += await deleteEntities(unresChans.map(r => r.id), 'unresolved Slack channel ID')

  // 6b. Non-channel entities
  const nonChans = await query(sql`
    SELECT id, name FROM kb_entities WHERE type = 'channel'
      AND name IN ('Google Form','SMM','Sales','Telegram chats','hh',
                   'Level Two - Tasks','Main tasks','QA wiki','absence','absence_bot','TR channel')
  `)
  console.log(`\n6b. Non-channel entities: ${nonChans.length}`)
  totalDeleted += await deleteEntities(nonChans.map(r => r.id), 'not a Slack channel')

  // 6c. Duplicate channels (unprefixed that have prefixed version)
  const dupChans = await query(sql`
    SELECT e1.id, e1.name FROM kb_entities e1
    WHERE e1.type = 'channel'
      AND e1.name NOT LIKE '%/%'
      AND EXISTS (
        SELECT 1 FROM kb_entities e2
        WHERE e2.type = 'channel'
          AND (e2.name = 'ac/' || e1.name OR e2.name = 'hg/' || e1.name)
      )
  `)
  console.log(`\n6c. Duplicate unprefixed channels: ${dupChans.length}`)
  // Merge into prefixed version
  for (const ch of dupChans) {
    const prefixed = await query(sql`
      SELECT id, name FROM kb_entities WHERE type = 'channel'
        AND (name = ${'ac/' + ch.name} OR name = ${'hg/' + ch.name})
      LIMIT 1
    `)
    if (prefixed.length) {
      if (await mergeEntity(prefixed[0].id, ch.id)) totalMerged++
    }
  }

  // ────────────────────────────────────────────
  // 7. DELETE ALL PROCESSES (pure noise)
  // ────────────────────────────────────────────
  console.log('\n--- PROCESS NUKE ---')
  const allProcesses = await query(sql`SELECT id, name FROM kb_entities WHERE type = 'process'`)
  console.log(`\n7. Delete ALL remaining processes: ${allProcesses.length}`)
  totalDeleted += await deleteEntities(allProcesses.map(r => r.id), 'nuke all processes')

  // ────────────────────────────────────────────
  // 8. CLEAN JUNK ALIASES
  // ────────────────────────────────────────────
  console.log('\n--- ALIAS CLEANUP ---')

  const junkAliases = [
    'Саши ПМши',           // garbage on Aleksandr Krylov
    'Yang Brent Wiedmer',  // "Yang" prefix junk
    'Yang Chelsea Marie Dua',
    'Yang Arsen Chatalian',
    'Yang Rymarchyk',
    'Evgeniy Kutepov',     // wrong person as alias of Goar
    'Сильвейна',           // typo on Sylvain
  ]

  // Fix jduflot: it's on Julia Chatalian but should be on Julia Duflot
  const jduflotFix = await query(sql`
    SELECT a.id, a.entity_id, e.name FROM kb_entity_aliases a
    JOIN kb_entities e ON a.entity_id = e.id
    WHERE a.alias = 'jduflot'
  `)
  if (jduflotFix.length && jduflotFix[0].name !== 'Julia Duflot') {
    const duflotEntity = await query(sql`SELECT id FROM kb_entities WHERE name = 'Julia Duflot' LIMIT 1`)
    if (duflotEntity.length) {
      if (dryRun) {
        console.log(`  [DRY-RUN] Would move alias 'jduflot' from ${jduflotFix[0].name} to Julia Duflot`)
      } else {
        await db.execute(sql`DELETE FROM kb_entity_aliases WHERE alias = 'jduflot'`)
        await db.execute(sql`INSERT INTO kb_entity_aliases (entity_id, alias) VALUES (${duflotEntity[0].id}, 'jduflot') ON CONFLICT (alias) DO NOTHING`)
        console.log(`  Moved alias 'jduflot' from ${jduflotFix[0].name} to Julia Duflot`)
      }
    }
  }

  // Delete junk aliases
  let aliasesDeleted = 0
  for (const alias of junkAliases) {
    if (dryRun) {
      console.log(`  [DRY-RUN] Would delete alias: ${alias}`)
    } else {
      await db.execute(sql`DELETE FROM kb_entity_aliases WHERE alias = ${alias}`)
      console.log(`  Deleted alias: ${alias}`)
    }
    aliasesDeleted++
  }

  // Delete Slack ID aliases (U-prefixed)
  const slackIdAliases = await query(sql`
    SELECT a.id, a.alias FROM kb_entity_aliases a WHERE a.alias ~ '^U[0-9A-Z]{6,}$'
  `) as unknown as { id: number; alias: string }[]
  console.log(`\n8. Slack ID aliases to delete: ${slackIdAliases.length}`)
  for (const a of slackIdAliases) {
    if (dryRun) {
      console.log(`  [DRY-RUN] Would delete Slack ID alias: ${a.alias}`)
    } else {
      await db.execute(sql`DELETE FROM kb_entity_aliases WHERE alias = ${a.alias}`)
      console.log(`  Deleted Slack ID alias: ${a.alias}`)
    }
    aliasesDeleted++
  }

  // Delete email aliases (contain @)
  const emailAliases = await query(sql`
    SELECT a.id, a.alias FROM kb_entity_aliases a WHERE a.alias LIKE '%@%'
  `) as unknown as { id: number; alias: string }[]
  console.log(`\nEmail aliases to delete: ${emailAliases.length}`)
  for (const a of emailAliases) {
    if (dryRun) {
      console.log(`  [DRY-RUN] Would delete email alias: ${a.alias}`)
    } else {
      await db.execute(sql`DELETE FROM kb_entity_aliases WHERE alias = ${a.alias}`)
      console.log(`  Deleted email alias: ${a.alias}`)
    }
    aliasesDeleted++
  }

  console.log(`\nTotal aliases cleaned: ${aliasesDeleted}`)

  // ────────────────────────────────────────────
  // SUMMARY
  // ────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`CLEANUP SUMMARY ${dryRun ? '(DRY RUN — nothing was changed)' : '(LIVE)'}`)
  console.log(`${'═'.repeat(60)}`)
  console.log(`  Entities deleted: ${totalDeleted}`)
  console.log(`  Entities merged: ${totalMerged}`)
  console.log(`  Total removed: ${totalDeleted + totalMerged}`)

  // Final counts
  const stats = await db.execute(sql`SELECT type, count(*)::int as cnt FROM kb_entities GROUP BY type ORDER BY cnt DESC`)
  console.log(`\nFinal entity counts:`)
  let total = 0
  for (const row of stats.rows) {
    const r = row as unknown as { type: string; cnt: number }
    console.log(`  ${r.type}: ${r.cnt}`)
    total += r.cnt
  }
  console.log(`  TOTAL: ${total}`)

  await pool.end()
}

main().catch((err) => {
  console.error('Cleanup failed:', err)
  process.exit(1)
})
