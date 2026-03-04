---
phase: 04-knowledge-base
plan: entity-review
type: execute
wave: 5
depends_on:
  - bulk-extraction
files_modified:
  - src/kb/entity-merge.ts
  - src/kb/entity-review.ts
autonomous: false
requirements:
  - KB-04

must_haves:
  truths:
    - "ONE canonical entity per real-world object, ALL variations are aliases"
    - "Known duplicates merged: Motor World: The Car Factory = Ohbibi MWCF"
    - "All entity merges confirmed by user before execution — NO automatic merges"
    - "After merge, Qdrant entity_ids updated to reflect canonical IDs"
    - "Entity graph has no orphaned aliases or broken relations after merge"
  artifacts:
    - path: "src/kb/entity-merge.ts"
      provides: "SQL-based entity merge utility"
      exports: ["mergeEntities"]
    - path: "src/kb/entity-review.ts"
      provides: "Interactive CLI for entity dedup review"
  key_links:
    - from: "src/kb/entity-merge.ts"
      to: "src/db/schema.ts"
      via: "moves aliases, relations, chunk entity_ids from duplicate to canonical"
      pattern: "kbEntityAliases|kbEntityRelations|array_replace"
    - from: "src/kb/entity-merge.ts"
      to: "Qdrant astra_knowledge"
      via: "updates entity_ids payload after merge"
      pattern: "qdrant.*setPayload|entity_ids"
    - from: "src/kb/entity-review.ts"
      to: "src/kb/entity-merge.ts"
      via: "calls mergeEntities after user confirms each merge"
      pattern: "mergeEntities"
---

<objective>
Build entity merge utility and interactive review CLI. Show all entities grouped by type, surface suspicious duplicates via name similarity, present to user for confirmation, and merge only explicitly approved pairs. Known merges include Motor World: The Car Factory = Ohbibi MWCF.

Purpose: CONTEXT.md mandates "ONE canonical entity per real-world object, ALL variations are aliases. Discovered dups/aliases MUST be presented to user for confirmation -- NO automatic merges." After bulk extraction, duplicate entities inevitably exist. This plan provides the tooling and interactive workflow to clean them up with user oversight.

Output: Entity merge utility, interactive review CLI, clean entity graph with user-approved merges.
</objective>

<execution_context>
@C:/Users/dimsh/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/dimsh/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/04-knowledge-base/04-CONTEXT.md
@.planning/phases/04-knowledge-base/04-RESEARCH.md
@.planning/phases/04-knowledge-base/bulk-extraction-SUMMARY.md
@src/kb/repository.ts
@src/db/schema.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Build entity merge utility and review report generator</name>
  <files>src/kb/entity-merge.ts, src/kb/entity-review.ts</files>
  <action>
**Create `src/kb/entity-merge.ts`** with exported function `mergeEntities(db: DB, qdrantClient: QdrantClient, canonicalId: number, duplicateId: number): Promise<{ aliasesMoved: number; relationsMoved: number; chunksUpdated: number }>`:

1. Move aliases: `UPDATE kb_entity_aliases SET entity_id = canonicalId WHERE entity_id = duplicateId`
2. Add the duplicate's name as a new alias of the canonical entity (use `onConflictDoNothing` in case it already exists)
3. Re-point relations: Update `kb_entity_relations` where `from_id = duplicateId` to `from_id = canonicalId`. Same for `to_id`. Handle self-referential relations (skip if both from and to would be the canonical). Delete exact duplicate relations that would result from the merge (same from_id, to_id, relation_type).
4. Update chunk entity_ids arrays in PostgreSQL: `UPDATE kb_chunks SET entity_ids = array_replace(entity_ids, duplicateId, canonicalId) WHERE duplicateId = ANY(entity_ids)`
5. Update Qdrant entity_ids: Fetch all chunk UUIDs from `kb_chunks` where `canonicalId = ANY(entity_ids)`, then batch-update Qdrant payload `entity_ids` to match the PostgreSQL arrays. Use `qdrantClient.setPayload` with the `astra_knowledge` collection.
6. Delete the duplicate entity from `kb_entities` (CASCADE handles remaining aliases/relations)
7. Log what was merged via pino logger
8. Return counts of moved aliases, re-pointed relations, and updated chunks

**Create `src/kb/entity-review.ts`** — a CLI script (runnable via `npx tsx`) that generates an entity review report:

1. **Entity inventory by type:** Query all entities grouped by type. For each type, list all entities sorted alphabetically with: name, alias count, relation count, chunk reference count.

2. **Duplicate candidates:** For each entity type, compare all pairs of entity names using simple Levenshtein-like similarity:
   - Normalize names: lowercase, trim whitespace, remove punctuation
   - Flag pairs where normalized names have edit distance <= 3 OR one name contains the other as a substring
   - Also flag pairs where one entity's name matches another entity's alias
   - Present flagged pairs with both entities' details (aliases, relations, chunk counts)
   - Include a simple distance function inline (no external lib) — iterate chars, count differences

3. **Known merges section:** Always include these known duplicates at the top:
   - "Motor World: The Car Factory" and "Ohbibi MWCF" (same project per CONTEXT.md)
   - Any other pairs where aliases overlap

4. **Output format:** Print the full report to stdout. Format each duplicate candidate as:
   ```
   CANDIDATE MERGE #N:
     Canonical: "Motor World: The Car Factory" (id: 42, type: project)
       Aliases: [mwcf, motor world]
       Relations: 5 (works_on x3, manages x1, client_of x1)
       Chunks: 23 Slack, 4 Notion, 2 Gmail
     Duplicate: "Ohbibi MWCF" (id: 87, type: project)
       Aliases: [ohbibi]
       Relations: 2 (works_on x2)
       Chunks: 8 Slack, 1 ClickUp
     Action: MERGE? (user must confirm)
   ```

5. **Interactive merge mode:** Add `--merge` flag. When set, after printing the report, prompt user for each candidate with: "Merge 'Ohbibi MWCF' into 'Motor World: The Car Factory'? (y/n/skip)". On "y", call `mergeEntities()`. On "n", skip. On "skip", stop processing.

   Since this runs as a CLI script called by Claude executor, the "interactive" part is actually: Claude reads the report output, presents candidates to the user in chat, collects decisions, then runs individual merge commands. So provide also a direct merge command: `npx tsx src/kb/entity-review.ts --merge-pair <canonicalId> <duplicateId>` that executes a single merge.

Import DB from `src/db/index.ts`, Qdrant client from existing KB infrastructure, schema tables from `src/db/schema.ts`.
  </action>
  <verify>
    <automated>npx tsx -e "import { mergeEntities } from './src/kb/entity-merge.js'; console.log(typeof mergeEntities === 'function' ? 'PASS' : 'FAIL')"</automated>
    <manual>Run `npx tsx src/kb/entity-review.ts` on server and verify it produces entity inventory, duplicate candidates, and known merges section</manual>
  </verify>
  <done>Entity merge utility handles all DB + Qdrant updates atomically. Review CLI generates entity inventory with duplicate candidates and supports single-pair merge commands.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 2: Interactive entity dedup review with user</name>
  <files>src/kb/entity-review.ts</files>
  <action>
Run entity review report on server: `npx tsx src/kb/entity-review.ts`

Present the full report to the user showing:
- All entities grouped by type with alias/relation/chunk counts
- Duplicate candidates flagged by name similarity
- Known merges (Motor World / Ohbibi MWCF and others)

For each duplicate candidate, ask the user: "Merge these? Which is canonical?"
For each user-approved merge, execute: `npx tsx src/kb/entity-review.ts --merge-pair <canonicalId> <duplicateId>`

User must review:
1. Entity inventory — are all entity types reasonable (person, project, channel, process, tool, company, team)?
2. Duplicate candidates — for each pair, decide: merge, skip, or discuss
3. Known merges: Motor World: The Car Factory = Ohbibi MWCF (and others from user's domain knowledge)
4. After merges: re-run report to verify no orphaned aliases/relations
5. Spot-check Qdrant entity_ids: pick 2-3 merged entities, verify chunk references are consolidated
  </action>
  <verify>User reviews all duplicate candidates and explicitly approves the entity graph state</verify>
  <done>User typed "approved" after all merges are done and entity graph is clean</done>
</task>

</tasks>

<verification>
1. `mergeEntities` correctly moves aliases, relations, and chunk references
2. No orphaned aliases or broken relations after merge
3. Qdrant entity_ids updated to reflect canonical IDs
4. All user-approved merges executed
5. Known merge (Motor World / Ohbibi MWCF) completed
6. Entity graph has exactly ONE canonical entity per real-world object
</verification>

<success_criteria>
- Entity merge utility works correctly (aliases, relations, chunks, Qdrant all updated)
- Review report surfaces all duplicate candidates
- User reviewed and decided on each candidate
- All approved merges executed without errors
- Entity graph is clean: no duplicates, all aliases point to canonical entities
</success_criteria>

<output>
After completion, create `.planning/phases/04-knowledge-base/entity-review-SUMMARY.md`
</output>
