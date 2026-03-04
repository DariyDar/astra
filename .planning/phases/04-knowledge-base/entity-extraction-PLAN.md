---
phase: 04-knowledge-base
plan: entity-extraction
type: execute
wave: 1
depends_on: []
files_modified:
  - src/kb/entity-extractor.ts
  - src/kb/repository.ts
  - src/kb/extract-entities-manual.ts
  - src/worker/index.ts
autonomous: true
requirements: [KB-ENTITY-EXTRACTION]
must_haves:
  truths:
    - "Low-value chunks (stubs, metadata-only, short text, drive) are marked processed without LLM calls"
    - "Chunks are selected by source priority (slack > clickup > notion > gmail > calendar) and minimum text length"
    - "Extraction runs in a multi-batch loop until budget (time or cost) is exhausted or no chunks remain"
    - "Existing entity names are included in the extraction prompt for better dedup"
    - "CLI script can run bulk initial extraction with --max-batches and --max-cost flags"
    - "Qdrant entity_ids payload is updated after extraction to enable entity-filtered vector search"
    - "Nightly worker uses multi-batch extraction with a 2-hour / $5 budget"
  artifacts:
    - path: "src/kb/entity-extractor.ts"
      provides: "Enhanced extraction with multi-batch loop, budget tracking, entity context, Qdrant sync"
      exports: ["extractEntities", "extractEntitiesBatch", "markLowValueChunks"]
    - path: "src/kb/repository.ts"
      provides: "Enhanced findUnprocessedChunks with source priority, length filter, count query"
      exports: ["findUnprocessedChunks", "countUnprocessedChunks", "getAllEntityNames"]
    - path: "src/kb/extract-entities-manual.ts"
      provides: "CLI for one-time bulk initial extraction"
    - path: "src/worker/index.ts"
      provides: "Updated nightly cron using multi-batch extraction"
  key_links:
    - from: "src/kb/entity-extractor.ts"
      to: "src/kb/repository.ts"
      via: "findUnprocessedChunks with source priority"
      pattern: "findUnprocessedChunks.*limit"
    - from: "src/kb/entity-extractor.ts"
      to: "src/kb/vector-store.ts"
      via: "Qdrant entity_ids payload update after extraction"
      pattern: "updatePayload|setPayload"
    - from: "src/kb/entity-extractor.ts"
      to: "src/llm/client.ts"
      via: "callClaude for each batch"
      pattern: "callClaude"
    - from: "src/worker/index.ts"
      to: "src/kb/entity-extractor.ts"
      via: "nightly cron calls extractEntitiesBatch"
      pattern: "extractEntitiesBatch|markLowValueChunks"
    - from: "src/kb/extract-entities-manual.ts"
      to: "src/kb/entity-extractor.ts"
      via: "CLI calls markLowValueChunks then extractEntitiesBatch"
      pattern: "extractEntitiesBatch|markLowValueChunks"
---

<objective>
Enhance entity extraction to efficiently process ~5-10K useful chunks from 116K total, skipping low-value data, using source-prioritized selection, multi-batch budget-controlled loops, and existing entity context for dedup. Create a CLI for initial bulk extraction and update Qdrant entity_ids for search filtering.

Purpose: The current extraction processes 50 chunks per night with no filtering -- at that rate it would take 6+ years to process the backlog. This enhancement makes extraction practical: skip stubs, prioritize high-value sources, process hundreds of batches per run, and complete initial extraction in 1-3 hours for ~$5-15.

Output: Enhanced entity-extractor.ts, enhanced repository.ts, new CLI script, updated worker.
</objective>

<context>
@.planning/research/entity-extraction-RESEARCH.md
@.planning/phases/04-knowledge-base/gmail-cleanup-SUMMARY.md
@src/kb/entity-extractor.ts
@src/kb/repository.ts
@src/kb/vector-store.ts
@src/kb/types.ts
@src/db/schema.ts
@src/llm/client.ts
@src/worker/index.ts
@src/kb/ingest-manual.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Enhance repository queries and entity extractor with multi-batch budget loop</name>
  <files>
    src/kb/repository.ts
    src/kb/entity-extractor.ts
  </files>
  <action>
**repository.ts changes:**

1. Modify `findUnprocessedChunks()` to accept an options object and use source-prioritized selection with minimum text length filtering. Replace the current naive query:

```typescript
export async function findUnprocessedChunks(
  db: DB,
  limit: number = 50,
  options?: { minTextLength?: number }
): Promise<Array<{ id: string; source: string; sourceId: string; text: string; qdrantId: string | null; metadata: unknown }>> {
```

The query must:
- Filter: `entity_ids IS NULL`
- Filter: `length(text) > {minTextLength ?? 100}` (skip stubs, very short chunks)
- Filter: `text NOT LIKE '%[metadata-only stub]%'` (skip gmail metadata stubs)
- Filter: `text NOT LIKE '%[system email -- metadata only]%'` (skip system email stubs)
- Filter: `source != 'drive'` (drive is metadata-only, no entity value)
- Order by source priority: slack=1, clickup=2, notion=3, gmail=4, calendar=5, else=6
- Then by `source_date DESC NULLS LAST` (recent first within each source tier)
- LIMIT $limit
- Also select `qdrant_id` (needed later for Qdrant entity_ids update)

Use Drizzle `sql` template tag for the raw SQL ORDER BY CASE. Keep the return type compatible but add `qdrantId` field.

2. Add `countUnprocessedChunks()` function:

```typescript
export async function countUnprocessedChunks(db: DB): Promise<number>
```

Count chunks where `entity_ids IS NULL` AND passes the same quality filters (length > 100, not stubs, not drive). Use `sql` template for a COUNT query.

3. Add `getAllEntityNames()` function:

```typescript
export async function getAllEntityNames(
  db: DB
): Promise<Array<{ name: string; type: string }>>
```

Select `name, type` from `kbEntities` ordered by name. This provides context for the extraction prompt.

4. Add `markChunksProcessed()` function for bulk-marking low-value chunks:

```typescript
export async function markChunksProcessed(
  db: DB,
  filter: 'low-value'
): Promise<number>
```

When filter is `'low-value'`, update `entity_ids = '{}'::int[]` (empty array) for all chunks where `entity_ids IS NULL` AND any of:
- `length(text) < 100`
- `text LIKE '%[metadata-only stub]%'`
- `text LIKE '%[system email -- metadata only]%'`
- `source = 'drive'`

Return the count of rows updated. Use `sql` template for the WHERE clause.

**entity-extractor.ts changes:**

1. Add `ExtractionBatchResult` interface extending the existing stats with `costUsd`:

```typescript
interface ExtractionBatchResult {
  entitiesCreated: number
  relationsCreated: number
  chunksProcessed: number
  costUsd: number
}
```

2. Modify the existing `extractEntities()` function to:
- Accept an optional `entityContext?: string` parameter (list of existing entities for the prompt)
- Include entity context in the prompt if provided: append `\n\nEXISTING ENTITIES (use these canonical names when referencing known entities):\n${entityContext}` before the chunks section
- Track cost from `response.usage?.costUsd ?? 0` and return it in the result
- Use the enhanced `findUnprocessedChunks()` (it auto-filters now)
- Collect `qdrantId` from chunks for later Qdrant update

3. After updating PostgreSQL `entity_ids`, also update Qdrant `entity_ids` payload for chunks that have a `qdrantId`. Use the Qdrant client's `setPayload` method:
- Accept an optional `qdrantClient` parameter (type: `QdrantClient` from `@qdrant/js-client-rest`)
- For each processed chunk that has a non-null `qdrantId`, collect {qdrantId, entityIds} pairs
- Batch update Qdrant using `client.setPayload('astra_knowledge', { payload: { entity_ids: mentionedIds }, points: [qdrantId] })` for each chunk
- Wrap in try/catch -- Qdrant failures should log a warning but not fail the batch
- If no `qdrantClient` passed, skip Qdrant updates silently

4. Add the main `extractEntitiesBatch()` function for multi-batch processing:

```typescript
export interface BatchBudget {
  maxBatches: number      // default 100
  maxTimeMinutes: number  // default 120
  maxCostUsd: number      // default 5.0
  chunkBatchSize: number  // default 50
  pauseBetweenMs: number  // default 2000
}

export interface BatchStats {
  totalChunks: number
  totalEntities: number
  totalRelations: number
  totalBatches: number
  totalCostUsd: number
  remainingUnprocessed: number
  stoppedReason: 'complete' | 'budget_time' | 'budget_cost' | 'budget_batches'
}

export async function extractEntitiesBatch(
  db: DB,
  budget?: Partial<BatchBudget>,
  qdrantClient?: QdrantClient
): Promise<BatchStats>
```

Implementation:
- Merge provided budget with defaults: `{ maxBatches: 100, maxTimeMinutes: 120, maxCostUsd: 5.0, chunkBatchSize: 50, pauseBetweenMs: 2000 }`
- Fetch existing entity names once via `getAllEntityNames()`, format as `"Name (type), ..."` string (cap at 3000 chars to avoid prompt bloat)
- Loop: for each batch iteration:
  - Check elapsed time against `maxTimeMinutes` -- break if exceeded
  - Check accumulated cost against `maxCostUsd` -- break if exceeded
  - Check batch count against `maxBatches` -- break if exceeded
  - Call `extractEntities(db, entityContext, qdrantClient)` -- if `chunksProcessed === 0`, break (no more chunks)
  - Accumulate stats
  - Log progress every batch: `{ batch: N, chunksTotal, entitiesTotal, costUsd, elapsed }`
  - Wait `pauseBetweenMs` between batches (avoid rate limiting)
- After loop: count remaining unprocessed chunks via `countUnprocessedChunks()`
- Log final summary and return `BatchStats`

5. Add `markLowValueChunks()` as a convenience export that calls `markChunksProcessed(db, 'low-value')` and logs the result:

```typescript
export async function markLowValueChunks(db: DB): Promise<number>
```

Keep the file under 400 lines. The original file is 204 lines; the additions (BatchBudget interface, extractEntitiesBatch function, markLowValueChunks wrapper, entity context in extractEntities, Qdrant update logic) should add ~150-180 lines.

Do NOT change the EXTRACTION_PROMPT constant, entity types, relation types, or the parseExtraction function. Only extend the existing extraction flow.
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&1 | head -30</automated>
    <manual>Review that findUnprocessedChunks filters stubs and orders by source priority. Review that extractEntitiesBatch has proper budget loop with all 3 stop conditions.</manual>
  </verify>
  <done>
    - `findUnprocessedChunks()` filters by text length > 100, excludes stubs and drive, orders by source priority
    - `countUnprocessedChunks()` returns count of remaining extractable chunks
    - `getAllEntityNames()` returns all entity name/type pairs
    - `markChunksProcessed()` bulk-marks low-value chunks as processed (entity_ids = [])
    - `extractEntities()` includes entity context in prompt and tracks cost
    - `extractEntities()` updates Qdrant entity_ids payload when qdrantClient is provided
    - `extractEntitiesBatch()` loops with time/cost/batch budget, logs progress, returns stats
    - `markLowValueChunks()` convenience wrapper
    - TypeScript compiles with 0 errors
  </done>
</task>

<task type="auto">
  <name>Task 2: Create CLI script and update nightly worker</name>
  <files>
    src/kb/extract-entities-manual.ts
    src/worker/index.ts
  </files>
  <action>
**Create `src/kb/extract-entities-manual.ts`:**

Follow the pattern from `src/kb/ingest-manual.ts` (same DB/Qdrant setup, same CLI argument style, similar console output).

```typescript
#!/usr/bin/env node
/**
 * Manual entity extraction -- run bulk extraction on existing KB chunks.
 * Usage: npx tsx src/kb/extract-entities-manual.ts [options]
 *
 * Options:
 *   --max-batches N   Max number of batches (default: 200)
 *   --max-cost N      Max cost in USD (default: 15)
 *   --max-time N      Max time in minutes (default: 180)
 *   --batch-size N    Chunks per batch (default: 50)
 *   --skip-mark       Skip marking low-value chunks (if already done)
 *   --dry-run         Only count chunks and estimate cost, don't extract
 */
```

Implementation:
1. Parse CLI args from `process.argv` manually (no external arg parser needed -- just iterate argv looking for `--flag value` pairs). Parse: `--max-batches`, `--max-cost`, `--max-time`, `--batch-size`, `--skip-mark`, `--dry-run`.

2. Set up DB and Qdrant connections (same pattern as `ingest-manual.ts`):
   - `import 'dotenv/config'`
   - Create pg Pool from `DATABASE_URL`
   - Create Drizzle db with schema
   - Create QdrantClient from `QDRANT_URL`

3. Step 1 -- Mark low-value chunks (unless `--skip-mark`):
   - Call `markLowValueChunks(db)`
   - Print: `"Marked {N} low-value chunks as processed (stubs, drive, short text)"`

4. Step 2 -- Count remaining:
   - Call `countUnprocessedChunks(db)`
   - Print: `"Remaining extractable chunks: {N}"`
   - Print estimated batches: `Math.ceil(N / batchSize)`
   - Print estimated cost: `(Math.ceil(N / batchSize) * 0.044).toFixed(2)` (from research: ~$0.044/batch)
   - Print estimated time: `Math.ceil(N / batchSize * 0.5)` minutes (~30s per batch)

5. If `--dry-run`, print estimates and exit.

6. Step 3 -- Run extraction:
   - Call `extractEntitiesBatch(db, { maxBatches, maxCostUsd: maxCost, maxTimeMinutes: maxTime, chunkBatchSize: batchSize }, qdrantClient)`
   - Print final stats in a formatted table:
     ```
     === Entity Extraction Results ===
       Batches:    {totalBatches}
       Chunks:     {totalChunks}
       Entities:   {totalEntities} created
       Relations:  {totalRelations} created
       Cost:       ${totalCostUsd.toFixed(2)}
       Remaining:  {remainingUnprocessed}
       Reason:     {stoppedReason}
     ```

7. Close pool: `await pool.end()`

**Update `src/worker/index.ts`:**

1. Import `extractEntitiesBatch` and `markLowValueChunks` from `../kb/entity-extractor.js` instead of `extractEntities`.

2. In the nightly cron handler, replace the current entity extraction block:

Current code (lines 72-79):
```typescript
// Run entity extraction on new chunks (single LLM call)
if (totalCreated > 0) {
  logger.info({ totalCreated }, 'KB ingestion done, starting entity extraction')
  const extractionStats = await extractEntities(db)
  logger.info(extractionStats, 'KB entity extraction complete')
} else {
  logger.info('KB ingestion: no new chunks, skipping entity extraction')
}
```

Replace with:
```typescript
// Mark any new low-value chunks as processed
const marked = await markLowValueChunks(db)
if (marked > 0) {
  logger.info({ marked }, 'KB: marked low-value chunks as processed')
}

// Run multi-batch entity extraction with nightly budget
logger.info('KB: starting nightly entity extraction')
const extractionStats = await extractEntitiesBatch(db, {
  maxBatches: 100,
  maxTimeMinutes: 120,
  maxCostUsd: 5.0,
}, qdrantClient)
logger.info(extractionStats, 'KB nightly entity extraction complete')
```

Note: Remove the `if (totalCreated > 0)` gate. The extraction should always run -- it processes any remaining unprocessed chunks, not just newly created ones. If there are no unprocessed chunks, `extractEntitiesBatch` exits immediately (first batch returns 0 chunks).

3. The `qdrantClient` variable already exists at module scope (line 45). Pass it directly to `extractEntitiesBatch`.

4. Update the import line at the top to import the new functions:
```typescript
import { extractEntitiesBatch, markLowValueChunks } from '../kb/entity-extractor.js'
```
Remove the old `extractEntities` import.
  </action>
  <verify>
    <automated>npx tsc --noEmit 2>&1 | head -30</automated>
    <manual>Run `npx tsx src/kb/extract-entities-manual.ts --dry-run` on the server to verify it connects, counts chunks, and prints estimates without making any LLM calls.</manual>
  </verify>
  <done>
    - `src/kb/extract-entities-manual.ts` exists with --max-batches, --max-cost, --max-time, --batch-size, --skip-mark, --dry-run flags
    - CLI marks low-value chunks, counts remaining, estimates cost/time, then runs extraction
    - `src/worker/index.ts` uses `extractEntitiesBatch` with 100 batch / 2hr / $5 nightly budget
    - Worker always runs extraction (no totalCreated > 0 gate), marks low-value first
    - Worker passes qdrantClient for Qdrant entity_ids sync
    - TypeScript compiles with 0 errors
  </done>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit` -- zero type errors across all modified files
2. `npx tsx src/kb/extract-entities-manual.ts --dry-run` on server -- connects to DB, counts chunks, prints estimates, exits cleanly
3. After running actual extraction: `SELECT count(*) FROM kb_chunks WHERE entity_ids IS NOT NULL` shows increased count
4. After running actual extraction: `SELECT count(*) FROM kb_entities WHERE metadata->>'source' = 'extraction'` shows new entities
5. Qdrant check: query a few points and verify `entity_ids` payload is populated (not empty [])
</verification>

<success_criteria>
- Low-value chunks (stubs, drive, short text) are bulk-marked as processed without any LLM calls
- Smart chunk selection prioritizes slack > clickup > notion > gmail > calendar, filters text < 100 chars
- Multi-batch loop respects all 3 budget limits (time, cost, batches) and logs progress per batch
- Existing entity names appear in the extraction prompt for better dedup
- CLI script works with --dry-run for safe preview and --max-cost for budget control
- Qdrant entity_ids payload updated after extraction, enabling entity-filtered vector search
- Nightly worker uses budget-controlled multi-batch extraction instead of single batch
- All files under 800 lines, TypeScript compiles cleanly
</success_criteria>

<output>
After completion, create `.planning/phases/04-knowledge-base/entity-extraction-SUMMARY.md`
</output>
