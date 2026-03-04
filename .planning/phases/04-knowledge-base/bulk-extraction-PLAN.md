---
phase: 04-knowledge-base
plan: bulk-extraction
type: execute
wave: 4
depends_on:
  - slack-user-cache
files_modified:
  - src/kb/extraction-report.ts
autonomous: false
requirements:
  - KB-01
  - KB-02
  - KB-03
  - KB-04

must_haves:
  truths:
    - "Entity extraction covers all 6 sources (Slack, Notion, Gmail, Calendar, ClickUp, Drive) not just Slack"
    - "User has reviewed and approved quality at each escalation stage (small, medium, full)"
    - "Cross-source entity mapping works — same entity linked across Slack, Notion, Gmail, Calendar, ClickUp chunks"
    - "Entity count grows from ~130 seed+extracted to 200-400 after full extraction"
    - "Entity extraction uses Slack chunks with resolved names (not raw IDs)"
  artifacts:
    - path: "src/kb/extraction-report.ts"
      provides: "Quality report generator for entity extraction results"
      exports: ["generateExtractionReport"]
  key_links:
    - from: "src/kb/extraction-report.ts"
      to: "src/kb/repository.ts"
      via: "queries entity graph for report data"
      pattern: "kbEntities|kbEntityRelations|kbChunks"
    - from: "src/kb/extract-entities-manual.ts"
      to: "src/kb/entity-extractor.ts"
      via: "CLI invokes extractEntitiesBatch with budget params"
      pattern: "extractEntitiesBatch"
---

<objective>
Run entity extraction in escalating stages with user quality verification at each gate: (1) small test 2-3 batches, (2) medium test ~10 batches per source, (3) full bulk run. Generate quality reports for user review at each stage. No bulk operation proceeds without explicit user approval.

Purpose: CONTEXT.md mandates incremental quality verification. ~8,331 extractable chunks remain across 6 sources. The user must review content quality (not just "it ran") at each stage before escalating. This ensures the entity graph is accurate and cross-source mapping works correctly.

Output: Complete entity extraction across all sources with user-verified quality at each gate.
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
@.planning/phases/04-knowledge-base/slack-user-cache-SUMMARY.md
@src/kb/entity-extractor.ts
@src/kb/repository.ts
@src/kb/extract-entities-manual.ts
@src/db/schema.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create extraction quality report generator</name>
  <files>src/kb/extraction-report.ts</files>
  <action>
Create `src/kb/extraction-report.ts` with exported function `generateExtractionReport(db: DB): Promise<string>`:

The function generates a structured text report containing:

1. **Entity summary:** Total entity count, broken down by type (person, project, channel, process, tool, company, team, etc.). Show new entities since last report if possible (compare with a count snapshot).

2. **Entity samples per type:** For each entity type, show up to 10 representative entities with their:
   - Name and aliases (from `kb_entity_aliases`)
   - Relations (from `kb_entity_relations` — show relation type + target entity name)
   - Chunk count per source (count of `kb_chunks` referencing this entity's ID in `entity_ids`, grouped by `source`)

3. **Cross-source mapping examples:** Find entities that appear in 3+ different sources (count distinct `source` values in chunks referencing entity). For the top 10 most cross-referenced entities, show:
   - Entity name and type
   - Source breakdown: "15 Slack, 3 Notion, 2 ClickUp, 4 Gmail, 1 Calendar"
   - Sample chunk text snippets (first 100 chars) from each source

4. **Potential issues:** Flag entities that might be problematic:
   - Person entities with names matching raw Slack ID pattern (`/^U[A-Z0-9]{8,}$/`)
   - Entity names longer than 100 characters (likely extraction errors)
   - Entities with zero chunk references (orphaned)
   - Duplicate-looking entity pairs: same type + Levenshtein distance <= 3 on names (use simple character comparison, no external lib needed)

5. **Coverage stats:** For each source, show:
   - Total extractable chunks (not stubs, min text length 100)
   - Chunks with entity_ids assigned (processed)
   - Chunks without entity_ids (unprocessed)
   - Percentage coverage

Format as plain text with clear headers and indentation. The user will read this in a terminal or chat. Keep it readable, not JSON.

Import DB types and schema from `src/db/schema.ts`, use drizzle queries. Import entity tables: `kbEntities`, `kbEntityAliases`, `kbEntityRelations`, `kbChunks`.
  </action>
  <verify>
    <automated>npx tsx -e "import { generateExtractionReport } from './src/kb/extraction-report.js'; console.log(typeof generateExtractionReport === 'function' ? 'PASS' : 'FAIL')"</automated>
    <manual>Run on server: npx tsx -e "import { generateExtractionReport } from './src/kb/extraction-report.js'; import { db } from './src/db/index.js'; const r = await generateExtractionReport(db); console.log(r)" — verify report shows entity breakdown, cross-source mapping, and coverage stats</manual>
  </verify>
  <done>Quality report generator produces structured text report with entity summary, cross-source mapping examples, potential issues, and coverage stats</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 2: Run small test extraction (2-3 batches) and review quality</name>
  <files>src/kb/extract-entities-manual.ts</files>
  <action>
Run small entity extraction test: 2-3 batches of 20 chunks each (~40-60 chunks total, ~$1.30-1.95).

On server: `npx tsx src/kb/extract-entities-manual.ts --skip-mark --batch-size 20 --max-batches 3`

Then generate quality report: `npx tsx -e "import { generateExtractionReport } from './src/kb/extraction-report.js'; import { db } from './src/db/index.js'; console.log(await generateExtractionReport(db))"`

Present the report to the user for review. User must verify:
1. Entity types — are person/project/channel entities correctly identified?
2. Cross-source mapping — do entities link across Slack, Notion, Gmail, etc.?
3. No raw Slack IDs — confirm NO new U[A-Z0-9] person entities created
4. Relation quality — are "works_on", "manages", "member_of" relations accurate?
5. No obvious duplicates — do any entities look like different spellings of the same thing?
6. Specific verification questions about known entities (e.g., "Is Dariy correctly linked to Level One?")
  </action>
  <verify>User reviews quality report and explicitly approves or describes issues</verify>
  <done>User typed "approved" confirming small test extraction quality is acceptable</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3: Run medium test extraction (~50 batches) and review quality</name>
  <files>src/kb/extract-entities-manual.ts</files>
  <action>
Run medium entity extraction: ~10 batches per source (Slack, Notion, Gmail, Calendar, ClickUp = ~50 batches, ~200 chunks/source, ~$32).

On server: `npx tsx src/kb/extract-entities-manual.ts --skip-mark --batch-size 20 --max-batches 50 --max-cost 35`

Then generate quality report: `npx tsx -e "import { generateExtractionReport } from './src/kb/extraction-report.js'; import { db } from './src/db/index.js'; console.log(await generateExtractionReport(db))"`

Present the report to the user for review. User must verify:
1. Entity count should have grown significantly (expect 250-350 total)
2. Cross-source mapping should show entities appearing across 3+ sources
3. Per-source coverage — each source should have meaningful extraction
4. New duplicates that emerged at scale
5. Known entities: project names, team members, processes
6. Dozens of specific questions about entities and their relationships
7. Slack chunks now produce person entities with real names (not IDs)
  </action>
  <verify>User reviews quality report and explicitly approves or describes issues</verify>
  <done>User typed "approved" confirming medium test extraction quality is acceptable</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 4: Run full bulk extraction and final quality review</name>
  <files>src/kb/extract-entities-manual.ts</files>
  <action>
Run full bulk extraction: process all remaining extractable chunks (~8,000 remaining, ~400 batches at size 20, ~$15, ~3-4 hours).

On server: `npx tsx src/kb/extract-entities-manual.ts --skip-mark --batch-size 20 --max-cost 20 --max-time 240`

Then generate final quality report: `npx tsx -e "import { generateExtractionReport } from './src/kb/extraction-report.js'; import { db } from './src/db/index.js'; console.log(await generateExtractionReport(db))"`

Present the report to the user for final review. User must verify:
1. Coverage stats show >80% of extractable chunks processed
2. Entity count is 300-500 total
3. Cross-source mapping is comprehensive — most projects, people, processes linked across sources
4. No raw Slack ID entities
5. Identify any duplicates that need merging (will be handled in entity-review plan)
6. RAG search quality: ask several knowledge questions and check answers include correct source citations
  </action>
  <verify>User reviews final quality report and explicitly approves or describes issues</verify>
  <done>User typed "approved" confirming full extraction quality is acceptable and extraction is complete</done>
</task>

</tasks>

<verification>
1. Entity extraction ran across all 6 sources (not just Slack)
2. User explicitly approved quality at each of the 3 escalation stages
3. No person entities created with raw Slack IDs after re-ingest
4. Cross-source entity mapping verified with user
5. Coverage stats show >80% of extractable chunks processed
6. Entity count grew to 200-400+ from initial 130 seed+extracted
</verification>

<success_criteria>
- Quality report generator works and produces meaningful output
- Small test (2-3 batches) approved by user
- Medium test (~50 batches) approved by user
- Full bulk extraction completed and approved by user
- Entity graph contains entities from all 6 sources with cross-source mapping
- No regression in existing entity graph quality
</success_criteria>

<output>
After completion, create `.planning/phases/04-knowledge-base/bulk-extraction-SUMMARY.md`
</output>
