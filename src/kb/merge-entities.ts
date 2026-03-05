#!/usr/bin/env node
/**
 * Entity merge CLI tool.
 * Merges duplicate entities: moves all facts, relations, aliases, documents, chunk refs
 * from source entity to target entity, then deletes the source.
 *
 * Usage: npx tsx src/kb/merge-entities.ts
 * (runs predefined merge list — edit MERGES array below)
 */
import 'dotenv/config'
import { db } from '../db/index.js'
import { sql } from 'drizzle-orm'
import { logger } from '../logging/logger.js'

type DB = typeof db

interface MergeOp {
  /** Entity ID to keep */
  targetId: number
  /** Entity IDs to merge into target (will be deleted) */
  sourceIds: number[]
  /** Optional: extra aliases to add to target */
  extraAliases?: string[]
}

/**
 * Merge one source entity into target.
 * Moves facts, relations, aliases, documents, chunk entity_ids.
 */
async function mergeEntity(database: DB, targetId: number, sourceId: number): Promise<void> {
  // 1. Add source entity name as alias of target (ignore conflict)
  await database.execute(sql`
    INSERT INTO kb_entity_aliases (entity_id, alias)
    SELECT ${targetId}, name FROM kb_entities WHERE id = ${sourceId}
    ON CONFLICT (alias) DO NOTHING
  `)

  // 2. Move aliases
  await database.execute(sql`
    UPDATE kb_entity_aliases SET entity_id = ${targetId}
    WHERE entity_id = ${sourceId}
    AND alias NOT IN (SELECT alias FROM kb_entity_aliases WHERE entity_id = ${targetId})
  `)
  // Delete remaining conflicting aliases (already exist on target)
  await database.execute(sql`
    DELETE FROM kb_entity_aliases WHERE entity_id = ${sourceId}
  `)

  // 3. Move facts (skip exact duplicates by text+type)
  await database.execute(sql`
    UPDATE kb_facts SET entity_id = ${targetId}
    WHERE entity_id = ${sourceId}
    AND NOT EXISTS (
      SELECT 1 FROM kb_facts f2
      WHERE f2.entity_id = ${targetId} AND f2.text = kb_facts.text AND f2.fact_type = kb_facts.fact_type
    )
  `)
  await database.execute(sql`DELETE FROM kb_facts WHERE entity_id = ${sourceId}`)

  // 4. Move relations (from_id)
  await database.execute(sql`
    UPDATE kb_entity_relations SET from_id = ${targetId}
    WHERE from_id = ${sourceId}
    AND NOT EXISTS (
      SELECT 1 FROM kb_entity_relations r2
      WHERE r2.from_id = ${targetId} AND r2.to_id = kb_entity_relations.to_id
        AND r2.relation = kb_entity_relations.relation
    )
  `)
  await database.execute(sql`DELETE FROM kb_entity_relations WHERE from_id = ${sourceId}`)

  // 5. Move relations (to_id)
  await database.execute(sql`
    UPDATE kb_entity_relations SET to_id = ${targetId}
    WHERE to_id = ${sourceId}
    AND NOT EXISTS (
      SELECT 1 FROM kb_entity_relations r2
      WHERE r2.from_id = kb_entity_relations.from_id AND r2.to_id = ${targetId}
        AND r2.relation = kb_entity_relations.relation
    )
  `)
  await database.execute(sql`DELETE FROM kb_entity_relations WHERE to_id = ${sourceId}`)

  // 6. Move documents (skip URL conflicts)
  await database.execute(sql`
    UPDATE kb_documents SET entity_id = ${targetId}
    WHERE entity_id = ${sourceId}
    AND NOT EXISTS (
      SELECT 1 FROM kb_documents d2
      WHERE d2.entity_id = ${targetId} AND d2.url = kb_documents.url
    )
  `)
  await database.execute(sql`DELETE FROM kb_documents WHERE entity_id = ${sourceId}`)

  // 7. Replace in chunk entity_ids arrays
  await database.execute(sql`
    UPDATE kb_chunks
    SET entity_ids = array_replace(entity_ids, ${sourceId}, ${targetId})
    WHERE ${sourceId} = ANY(entity_ids)
  `)

  // 8. Delete source entity (cascade handles any remaining orphans)
  await database.execute(sql`DELETE FROM kb_entities WHERE id = ${sourceId}`)
}

async function runMerges(database: DB, merges: MergeOp[]): Promise<void> {
  let merged = 0
  let deleted = 0

  for (const op of merges) {
    for (const sourceId of op.sourceIds) {
      // Verify both exist
      const [target] = (await database.execute(sql`
        SELECT id, name FROM kb_entities WHERE id = ${op.targetId}
      `)).rows
      const [source] = (await database.execute(sql`
        SELECT id, name FROM kb_entities WHERE id = ${sourceId}
      `)).rows

      if (!target) {
        logger.warn({ targetId: op.targetId }, 'Target entity not found, skipping')
        continue
      }
      if (!source) {
        logger.warn({ sourceId }, 'Source entity not found (already merged?), skipping')
        continue
      }

      await mergeEntity(database, op.targetId, sourceId)
      merged++
      logger.info({ target: `${target.name} [${op.targetId}]`, source: `${source.name} [${sourceId}]` }, 'Merged')
    }

    // Add extra aliases
    for (const alias of op.extraAliases ?? []) {
      await database.execute(sql`
        INSERT INTO kb_entity_aliases (entity_id, alias)
        VALUES (${op.targetId}, ${alias})
        ON CONFLICT (alias) DO NOTHING
      `)
    }

    deleted += op.sourceIds.length
  }

  logger.info({ merged, deleted }, 'All merges complete')
}

async function deleteEntities(database: DB, ids: number[], reason: string): Promise<void> {
  for (const id of ids) {
    const [entity] = (await database.execute(sql`
      SELECT id, name FROM kb_entities WHERE id = ${id}
    `)).rows
    if (!entity) continue

    // Remove from chunk arrays first (no FK)
    await database.execute(sql`
      UPDATE kb_chunks
      SET entity_ids = array_remove(entity_ids, ${id})
      WHERE ${id} = ANY(entity_ids)
    `)

    await database.execute(sql`DELETE FROM kb_entities WHERE id = ${id}`)
    logger.info({ id, name: entity.name, reason }, 'Deleted entity')
  }
}

// ============================================================
// MERGE DEFINITIONS
// ============================================================

const PERSON_MERGES: MergeOp[] = [
  // Дарий — keep [21]
  { targetId: 21, sourceIds: [303, 1908] },
  // sgumeniuk / Sergey Gumeniuk — keep [192]
  { targetId: 192, sourceIds: [329] },
  // Александра Федюшина — keep [28]
  { targetId: 28, sourceIds: [285] },
  // Алехандро / Alex Gudkov — keep [36]
  { targetId: 36, sourceIds: [369] },
  // Амгалан Токуренов — keep [37]
  { targetId: 37, sourceIds: [306] },
  // Алмазхан Баймышев — keep [40]
  { targetId: 40, sourceIds: [1006] },
  // Аля Сивец — keep [282]
  { targetId: 282, sourceIds: [803] },
  // Амир Лотан — keep [191]
  { targetId: 191, sourceIds: [312] },
  // Данил Корякин — keep [53] (has most facts)
  { targetId: 53, sourceIds: [193] },
  // Дмитрий Денисов — keep [33]
  { targetId: 33, sourceIds: [308] },
  // Иван Щелоков — keep [269] (Ivan Shchelokov, ac, 9f 9r)
  { targetId: 269, sourceIds: [39, 344, 3060, 3207], extraAliases: ['Иван Щелоков', 'Ivan Schelokov'] },
  // Богдан Хашиев — keep [57]
  { targetId: 57, sourceIds: [781] },
  // Денис Арцюховский — keep [277]
  { targetId: 277, sourceIds: [50, 2996] },
  // Богородский / Валерий — keep [211] (most facts)
  { targetId: 211, sourceIds: [304, 31] },
  // Julia Duflot — keep [272] (separate from Julia Chatalian)
  { targetId: 272, sourceIds: [1580, 338] },
  // Julia Chatalian — keep [259]
  { targetId: 259, sourceIds: [3216] },
  // Фарид Хайбуллин — keep [271]
  { targetId: 271, sourceIds: [339, 43] },
  // Ян Рымарчик — keep [273] (most facts)
  { targetId: 273, sourceIds: [3056, 346, 46, 489] },
  // Алексей Мащенко — keep [274]
  { targetId: 274, sourceIds: [342] },
  // Ангелина Заика — keep [276]
  { targetId: 276, sourceIds: [341, 3648] },
  // Александр Крылов — keep [278]
  { targetId: 278, sourceIds: [343] },
  // Мария Поллиектова — keep [275]
  { targetId: 275, sourceIds: [340] },
  // Юлия Гречаная — keep [280]
  { targetId: 280, sourceIds: [1010] },
  // Анель Бектассова — keep [279]
  { targetId: 279, sourceIds: [3071] },
  // Анна Самусенко — keep [268]
  { targetId: 268, sourceIds: [3082] },
  // Дияр Тайкенов — keep [281]
  { targetId: 281, sourceIds: [1206, 3424, 34] },
  // Слава / Вячеслав Куряков — keep [261]
  { targetId: 261, sourceIds: [24, 3425] },
  // Алёна Субботина — keep [942]
  { targetId: 942, sourceIds: [55] },
  // Челси — keep [262]
  { targetId: 262, sourceIds: [870, 58] },
  // Брент Видмер — keep [283]
  { targetId: 283, sourceIds: [26, 345] },
  // Тим Мельников — keep [266]
  { targetId: 266, sourceIds: [247] },
  // Йенг / Yang Wen — keep [25]
  { targetId: 25, sourceIds: [3057, 1007] },
  // Ирина Бородина — keep [2156]
  { targetId: 2156, sourceIds: [3217] },
  // Гоар Алавердян — keep [2344]
  { targetId: 2344, sourceIds: [2370], extraAliases: ['Гоар Алавердян'] },
  // Руслан Гадельшин — keep [32]
  { targetId: 32, sourceIds: [307] },
  // Илья Бочаров — merge Slack UID
  { targetId: 44, sourceIds: [2490] },
  // Юлия [56] = ambiguous "Юлия" with no last name → merge into Duflot since ac + alias Julia
  // Actually user said 3 Julias. [56] has alias "Julia" and company "ac" — Duflot is ac analyst
  { targetId: 272, sourceIds: [56] },
  // Маргарита Гидоновна — keep [258], merge empty [260]
  { targetId: 258, sourceIds: [260] },
  // Катя Дочкина [47] = Катя — already correct, no merge needed
  // Сергей [54] = sgumeniuk (QA Lead on Level Two, QA on Pivot Pumps/Aquarium/IAT/MWCF/Tough Guy)
  { targetId: 192, sourceIds: [54] },
  // Kaitlynn [769] = Кейтлин [735] (Tilting Point)
  { targetId: 735, sourceIds: [769], extraAliases: ['Kaitlynn'] },
  // Jijo [861] + JIJO M MATHEWS [3525] — Indium Soft QA on Oregon Trail
  { targetId: 861, sourceIds: [3525], extraAliases: ['Jijo M Mathews'] },
  // HTML5-разработчик [377] = Всеволод [41]
  { targetId: 41, sourceIds: [377], extraAliases: ['HTML5-разработчик', 'HTML5 developer'] },
  // Sam [688] = owner of Relevate Health — keep as is, add alias
  // Джо [248] = Joe Russo (Tilting Point) — keep as is, add alias
]

// Slack User IDs as person entities — junk (no real name resolved)
const SLACK_UID_JUNK: number[] = [
  2705, 1534, 1388, 2714, 2732, 1535, 2702, 2731, 2692, 1538, 2730, 2551, 2734,
  2950, 2711, 2646, 2064, 1377, 1532, 1861, 1531, 1391, 1398, 1344, 1533, 1862,
  1536, 1360, 1722, 687, 683, 686, 685, 2063, 1537, 2698, 1539, 2662, 2694,
  1002, 2710, 2704, 2371, 2628, 2372, 2373, 2652, 2829, 2627, 2640, 2828, 2374, 2733,
]

// Star Trek game characters (not real people)
const STT_CHARACTERS: number[] = [
  2435, 2439, 2440, 2441, 2442, 2443, 2444, 2445, // Audrid, Cellist, Emony, Gray, etc.
  2433, 2434, 2436, 2437, 2438, 2477, 2475, 2562, // Joran, Torias, Lela, Tobin, Verad, Drone, Joseph, Symbiont
  1524, 1504, 1503, 1502, 1671, // Uncertain Times Garak, Riker, Rogers, Romaine, Q (STT chars)
]

// Other junk person entities
const OTHER_JUNK: number[] = [
  2661, // Slackbot
  382,  // "Grace Decklan" — 0f 1r, STT character?
  383,  // "Mayor Q" — STT character
]

// ============================================================
// PROJECT MERGES
// ============================================================

const PROJECT_MERGES: MergeOp[] = [
  // Aquarium — keep [16]
  { targetId: 16, sourceIds: [802, 162, 700, 586, 3058] },
  // Idle Axe Thrower — keep [17] (Magic Archery [1473] is a DIFFERENT project, not IAT)
  { targetId: 17, sourceIds: [852, 919, 2157] },
  // Star Trek Timelines — keep [13] (StS [906] is 0f/0r, unclear if STT — removed)
  { targetId: 13, sourceIds: [2518, 732, 2946] },
  // SpongeBob KCO (F2P/LiveOps, Tilting Point) — keep [1199] "SpongeBob: Krusty Cook-Off"
  // [14] has 189 mixed facts (~148 KCO + ~41 Netflix) — merge into KCO as majority
  { targetId: 1199, sourceIds: [14, 863, 1074, 1238, 1260, 1581, 2325], extraAliases: ['SpongeBob', 'SBKCO', 'Губка Боб', 'SB', 'SpongeBob LiveOps', 'SBKCO F2P', 'Krusty Cook-Off', 'KCO'] },
  // SpongeBob Netflix (Get Cookin', Netflix Games) — keep [1646] "SpongeBob KCO Netflix"
  { targetId: 1646, sourceIds: [1909, 1241, 1582, 2052, 1889], extraAliases: ['SpongeBob Get Cookin', 'SB Netflix', 'SpongeBob Netflix', 'SpongeBob PE'] },
  // Oregon Trail — keep [15]
  { targetId: 15, sourceIds: [] }, // already clean
  // Ohbibi MWCF — keep [18]
  { targetId: 18, sourceIds: [214, 1176, 1174, 1179, 2065, 3135] },
  // Block Puzzle — keep [923] (Clash of Gods is a DIFFERENT project)
  { targetId: 923, sourceIds: [2268] },
  // Clash of Gods / Bow — keep [2276]
  { targetId: 2276, sourceIds: [2232, 1133], extraAliases: ['Bow', 'Clash of God'] },
  // Level Two — keep [9]
  { targetId: 9, sourceIds: [800] },
  // Level One (Gluc) — keep [894]
  { targetId: 894, sourceIds: [8, 1220, 2672] },
  // Pivot Pumps — keep [10]
  { targetId: 10, sourceIds: [163, 521, 578, 643] },
  // Tough Guy — keep [20]
  { targetId: 20, sourceIds: [298, 442, 441, 546] },
  // Dracula — keep [2699]
  { targetId: 2699, sourceIds: [2658, 2228, 2737, 2673] },
  // Motor World / MMs — keep [18] already merged above
  // MMs / M&M's — keep [2025]
  { targetId: 2025, sourceIds: [2197, 2198, 897] },
  // Vector Wuxia — keep [907]
  { targetId: 907, sourceIds: [233, 570, 1073, 804] },
  // Puppet Master (ex-Summoner) — keep [299], merge Summoner as earlier name
  { targetId: 299, sourceIds: [708, 2223, 1143, 2229], extraAliases: ['Summoner'] },
  // LifeQuest — keep [250]
  { targetId: 250, sourceIds: [244] },
  // Bakalyau / Bacalhau — keep [1181]
  { targetId: 1181, sourceIds: [1940, 1026, 2183] },
  // Pong Breaker — keep [1000]
  { targetId: 1000, sourceIds: [876, 1193] },
  // Insulin Pump / Pivot — keep [10] (already above)
  // Medical Projects — keep [323]
  { targetId: 323, sourceIds: [3237] },
  // Dosage Dropper / Dose Dropper — keep [1971]
  { targetId: 1971, sourceIds: [2287] },
  // Bitter Bites / Bitter Bytes — keep [2788]
  { targetId: 2788, sourceIds: [2838] },
  // Looted Boxes — keep [2840]
  { targetId: 2840, sourceIds: [2930] },
  // Match Masters — keep [1001] (Toon Blast [2281] and Match Mansion [2282] are DIFFERENT games)
  { targetId: 1001, sourceIds: [2237, 1952] },
  // Summoner merged into Puppet Master above
  // Playable Ads — keep [12]
  { targetId: 12, sourceIds: [376] },
  // diabetes app — keep [894] (Level One/Gluc already)
  // Coral Carnival — keep [721]
  { targetId: 721, sourceIds: [846] },
  // Wedding Planning Trelane — keep [1890]
  { targetId: 1890, sourceIds: [1859] },
  // Nick [296] = Nickelodeon [305] (client entity, short name)
  { targetId: 305, sourceIds: [296], extraAliases: ['Nick'] },
]

// ============================================================

async function main() {
  logger.info('Starting entity merge/cleanup')

  // 1. Merge person duplicates
  logger.info({ count: PERSON_MERGES.length }, 'Merging person duplicates')
  await runMerges(db, PERSON_MERGES)

  // 2. Merge project duplicates
  logger.info({ count: PROJECT_MERGES.length }, 'Merging project duplicates')
  await runMerges(db, PROJECT_MERGES)

  // 3. Enrich standalone entities with aliases
  const aliasUpdates = [
    { entityId: 688, aliases: ['Sam Relevate', 'Sam (Relevate Health)'] }, // Sam — owner of Relevate Health
    { entityId: 248, aliases: ['Joe Russo', 'Джо Руссо'] }, // Джо — Joe Russo from Tilting Point
  ]
  for (const u of aliasUpdates) {
    for (const alias of u.aliases) {
      await db.execute(sql`
        INSERT INTO kb_entity_aliases (entity_id, alias)
        VALUES (${u.entityId}, ${alias})
        ON CONFLICT (alias) DO NOTHING
      `)
    }
    logger.info({ entityId: u.entityId, aliases: u.aliases }, 'Added aliases')
  }

  // 4. Delete junk entities
  const allJunk = [...SLACK_UID_JUNK, ...STT_CHARACTERS, ...OTHER_JUNK]
  logger.info({ count: allJunk.length }, 'Deleting junk entities')
  await deleteEntities(db, allJunk, 'junk')

  // 5. Delete empty process entities (0 facts AND 0 relations)
  const emptyProcs = await db.execute(sql`
    SELECT e.id FROM kb_entities e
    WHERE e.type = 'process'
      AND NOT EXISTS (SELECT 1 FROM kb_facts WHERE entity_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM kb_entity_relations WHERE from_id = e.id OR to_id = e.id)
  `)
  const emptyProcIds = emptyProcs.rows.map((r) => (r as { id: number }).id)
  logger.info({ count: emptyProcIds.length }, 'Deleting empty process entities (0f 0r)')
  await deleteEntities(db, emptyProcIds, 'empty process')

  // 6. Final stats
  const stats = await db.execute(sql`
    SELECT type, count(*) as cnt FROM kb_entities GROUP BY type ORDER BY cnt DESC
  `)
  logger.info('Final entity counts:')
  for (const row of stats.rows) {
    logger.info({ type: row.type, count: row.cnt })
  }

  process.exit(0)
}

main().catch((err) => {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Merge failed')
  process.exit(1)
})
