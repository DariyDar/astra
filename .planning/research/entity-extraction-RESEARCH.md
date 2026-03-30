# Entity Extraction - Research

**Researched:** 2026-03-04
**Domain:** LLM-powered entity extraction from KB chunks, batch processing, entity graph enrichment
**Confidence:** HIGH

## Summary

The entity extraction infrastructure is **already fully built and deployed**. The file `src/kb/entity-extractor.ts` contains a working `extractEntities()` function that reads unprocessed chunks (where `entity_ids IS NULL`), batches them (50 at a time), sends them to Claude via CLI subprocess, parses the JSON response, and merges extracted entities/relations into the PostgreSQL entity graph. The worker process (`src/worker/index.ts`) already schedules this as part of the nightly ingestion cron job at 20:00 UTC (04:00 Bali time).

The entity graph is seeded with 62 entities (7 companies, 13 projects, 4 processes, 38 people), 87 aliases, and 74 relations from the Master Document v2 via `src/kb/seed.ts`. The extraction prompt correctly targets entity types (person, project, channel, client, company, process) and relation types (works_on, manages, owns, member_of, client_of).

**The critical gap is not code but strategy**: the current `findUnprocessedChunks()` function simply grabs the first 50 chunks where `entity_ids IS NULL` with no filtering by source quality, content richness, or text length. With ~116K total chunks (many of which are metadata stubs, system email stubs, or low-value calendar entries), the extraction will waste Claude calls on chunks that yield zero entities. The implementation needs a **smart chunk selection strategy** and a **multi-batch loop** (not just one batch of 50 per night).

**Primary recommendation:** Enhance `findUnprocessedChunks()` with source priority, minimum text length filtering, and metadata-based quality scoring. Add a multi-batch loop to `extractEntities()` that processes chunks in waves until a nightly budget/time limit is reached.

## Existing Code Analysis

### What Already Exists (HIGH confidence - read from source)

| File | Status | What It Does |
|------|--------|-------------|
| `src/kb/entity-extractor.ts` | Complete, 204 lines | `extractEntities()` - batch extraction with Claude, JSON parsing, entity/relation merging |
| `src/kb/repository.ts` | Complete, 387 lines | `findUnprocessedChunks()`, `createEntity()`, `addAlias()`, `addRelation()`, `findEntityByName()`, `updateChunkEntityIds()` |
| `src/kb/seed.ts` | Complete, 308 lines | Seeds 62 entities, 87 aliases, 74 relations from Master Document v2 |
| `src/kb/entity-resolver.ts` | Complete, 37 lines | `resolveEntity()` - name/alias lookup for KB search filtering |
| `src/kb/types.ts` | Complete | `EntityType`, `RelationType`, `ChunkSource` type definitions |
| `src/worker/index.ts` | Complete | Nightly cron at `0 20 * * *` - runs ingestion then `extractEntities()` |
| `src/llm/client.ts` | Complete | `callClaude()` via CLI subprocess, Sonnet model, 180s timeout |

### Current Flow (working but limited)

```
Nightly Cron (20:00 UTC)
  --> runIngestion() (fetches new data from 6 sources)
  --> if new chunks created:
       --> extractEntities(db)
            --> findUnprocessedChunks(db, 50) -- grabs first 50 with entity_ids IS NULL
            --> concatenate chunk texts (800 chars each)
            --> callClaude(prompt) -- single LLM call
            --> parseExtraction(response)
            --> merge entities (dedup via findEntityByName + alias)
            --> merge relations (dedup via from+to+relation)
            --> updateChunkEntityIds() for all 50 chunks
```

### Current Limitations

1. **Single batch of 50 chunks per night** - with ~116K chunks to process, this would take ~2,320 nights (6+ years) to complete
2. **No chunk quality filtering** - `findUnprocessedChunks()` has no WHERE clause for source, text length, or content type
3. **No metadata-stub exclusion** - Gmail stubs (text = `[metadata-only stub]`) and Drive metadata chunks will be sent to Claude uselessly
4. **No budget tracking** - no cost estimation or stopping condition
5. **No progress logging** - no way to track how many chunks remain
6. **Chunk text truncated to 800 chars** - reasonable but could miss context in longer chunks

## Chunk Distribution Analysis

Based on MEMORY.md ingestion data and gmail-cleanup analysis:

| Source | Chunks | Useful for Entity Extraction | Why |
|--------|--------|------------------------------|-----|
| Gmail | ~37K (post-cleanup) | ~400 deep-indexed (200/account) | Most are metadata stubs after cleanup. Deep-indexed human emails contain people, projects |
| Slack | 25,514 | ~15-20K | Messages mentioning people and projects. Filter out bot messages, short messages |
| Notion | 15,822 | ~5-8K | Documents about projects, processes, team structure |
| Calendar | 13,724 | ~3-5K | Events have attendees (people) and subjects (projects). Short text, low entity density |
| Drive | 6,650 | ~1-2K metadata | Metadata-only currently. Title/owner useful but limited entity extraction value |
| ClickUp | 3,087 | ~2-3K | Tasks with assignees, project context, status updates |

**Estimated useful chunks: ~5-10K** (matches user's budget estimate)

## Architecture Patterns

### Pattern 1: Smart Chunk Selection

**What:** Replace naive `entity_ids IS NULL` query with priority-based selection that filters by source quality and content richness.

**Implementation approach:**

```typescript
// Priority tiers for chunk selection
const CHUNK_PRIORITY_SQL = sql`
  SELECT id, source, source_id, text, metadata
  FROM kb_chunks
  WHERE entity_ids IS NULL
    AND length(text) > 100                         -- skip stubs and tiny chunks
    AND text NOT LIKE '%[metadata-only stub]%'     -- skip gmail stubs
    AND source IN ('slack', 'notion', 'clickup', 'gmail', 'calendar')  -- skip drive metadata
  ORDER BY
    CASE source
      WHEN 'slack' THEN 1      -- highest entity density
      WHEN 'clickup' THEN 2   -- structured tasks with people/projects
      WHEN 'notion' THEN 3    -- documents about org structure
      WHEN 'gmail' THEN 4     -- human emails only (post-cleanup)
      WHEN 'calendar' THEN 5  -- events with attendees
      ELSE 6
    END,
    source_date DESC NULLS LAST  -- recent first
  LIMIT $1
`
```

### Pattern 2: Multi-Batch Loop with Budget

**What:** Process multiple batches per night until budget/time limit is reached, not just one batch of 50.

```typescript
const NIGHTLY_BUDGET = {
  maxBatches: 100,           // up to 100 batches per night
  maxChunksPerBatch: 50,     // 50 chunks per Claude call
  maxTimeMinutes: 120,       // 2 hour time limit
  maxCostUsd: 5.0,           // cost cap per night
}

async function extractEntitiesNightly(db: DB): Promise<NightlyStats> {
  const startTime = Date.now()
  const stats = { totalChunks: 0, totalEntities: 0, totalRelations: 0, batches: 0, costUsd: 0 }

  for (let batch = 0; batch < NIGHTLY_BUDGET.maxBatches; batch++) {
    // Check time limit
    const elapsed = (Date.now() - startTime) / 60_000
    if (elapsed > NIGHTLY_BUDGET.maxTimeMinutes) break

    // Check cost limit
    if (stats.costUsd >= NIGHTLY_BUDGET.maxCostUsd) break

    const result = await extractEntities(db)
    if (result.chunksProcessed === 0) break  // no more unprocessed chunks

    stats.totalChunks += result.chunksProcessed
    stats.totalEntities += result.entitiesCreated
    stats.totalRelations += result.relationsCreated
    stats.costUsd += result.costUsd ?? 0
    stats.batches++

    // Brief pause between batches to avoid rate limiting
    await new Promise(r => setTimeout(r, 2000))
  }

  return stats
}
```

### Pattern 3: Existing Entity Context in Prompt

**What:** Include the current entity list in the prompt so Claude can reference existing entities by their canonical names, improving dedup.

```typescript
// Fetch existing entity names for the prompt context
const existingEntities = await db.select({
  name: kbEntities.name,
  type: kbEntities.type,
}).from(kbEntities)

const entityContext = existingEntities
  .map(e => `${e.name} (${e.type})`)
  .join(', ')

const prompt = `${EXTRACTION_PROMPT}

EXISTING ENTITIES (use these canonical names when referencing known entities):
${entityContext}

--- TEXT CHUNKS ---
${chunkTexts}`
```

### Anti-Patterns to Avoid

- **Processing all 116K chunks** - most are low-value. Filter first, extract from the best ~5-10K.
- **One chunk per Claude call** - too expensive and slow. Batching 50 chunks per call is correct.
- **Ignoring existing entities in prompt** - without context, Claude will create duplicates with different name forms.
- **No idempotency** - re-running extraction must not create duplicate entities. The current code handles this via `findEntityByName()` + `onConflictDoNothing()`.
- **Blocking the nightly job** - if extraction takes too long, it blocks the next day's ingestion. Use a time budget.

## Cost and Time Estimation

### Claude CLI Cost Model (Sonnet)

Based on the current `callClaude()` setup using `--model sonnet`:

| Component | Estimate |
|-----------|----------|
| Prompt (system + extraction rules + entity context) | ~800 tokens |
| 50 chunks x 800 chars each = ~40K chars | ~10,000 tokens input |
| JSON response (entities + relations) | ~500-1,000 tokens output |
| **Total per batch** | ~11K input + ~750 output tokens |
| **Cost per batch** (Sonnet pricing ~$3/1M input, $15/1M output) | ~$0.044 |

### Processing Estimates

| Scenario | Chunks | Batches | Time (est.) | Cost (est.) |
|----------|--------|---------|-------------|-------------|
| Useful chunks only (~5K) | 5,000 | 100 | ~50 min | ~$4.40 |
| Moderate (~8K) | 8,000 | 160 | ~80 min | ~$7.00 |
| Full coverage (~10K) | 10,000 | 200 | ~100 min | ~$8.80 |

Time estimate assumes ~30 seconds per batch (Claude call + DB operations + 2s pause).

**This fits well within the user's budget estimate of $5-15 and 1-3 hours.**

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Entity dedup | Fuzzy string matching | Existing `findEntityByName()` + alias table | Already handles cross-language (ilike), aliases are the dedup mechanism |
| JSON parsing from LLM | Custom regex parser | Existing `parseExtraction()` | Already handles markdown fences, partial JSON |
| Scheduling | Custom timer/setInterval | `node-cron` (already in worker) | Already scheduled at `0 20 * * *` |
| Claude access | Direct API calls | `callClaude()` via CLI subprocess | Already handles auth, timeout, error recovery |

## Common Pitfalls

### Pitfall 1: Claude Returning Invalid JSON
**What goes wrong:** Claude sometimes wraps JSON in markdown fences, adds explanatory text, or returns malformed JSON.
**Why it happens:** LLMs are not deterministic JSON generators.
**How to avoid:** Already handled by `parseExtraction()` which strips fences and does regex fallback. The system prompt says "Return ONLY valid JSON (no markdown, no explanation)". Consider adding `--model sonnet` explicitly for more reliable JSON output.
**Warning signs:** `logger.warn('Entity extraction: failed to parse LLM response')` in logs.

### Pitfall 2: Entity Name Normalization
**What goes wrong:** Same person extracted as "Semyon", "Semen", "Semyon K." - creates duplicates.
**Why it happens:** Different sources use different name forms. Russian/English transliteration varies.
**How to avoid:** Include existing entity list in the prompt context (Pattern 3 above). The alias system handles resolution at query time, but prevention is better.
**Warning signs:** Multiple entities with similar names in different name forms.

### Pitfall 3: Claude CLI Timeout at 180 seconds
**What goes wrong:** If prompt is too large (too many chunks or too much entity context), Claude may timeout.
**Why it happens:** 50 chunks x 800 chars = ~40K chars in the prompt. Adding entity context adds more.
**How to avoid:** Keep batch size at 50, entity context under ~2K chars. Current 180s timeout is generous.
**Warning signs:** `Claude CLI timed out` error in logs.

### Pitfall 4: OOM During Extraction
**What goes wrong:** Server OOM-kills the worker process during long extraction runs.
**Why it happens:** Known issue from ingestion - ONNX model cache can grow. Multiple concurrent processes.
**How to avoid:** Run extraction sequentially (already does). Monitor memory. Don't deploy during extraction runs.
**Warning signs:** PM2 restart logs, ONNX cache corruption.

### Pitfall 5: Marking Low-Value Chunks as Processed
**What goes wrong:** Extraction runs on metadata stubs and empty chunks, marks them as processed (entity_ids = []), but extracts nothing.
**Why it happens:** `findUnprocessedChunks()` doesn't filter by content quality.
**How to avoid:** Either filter in the query (recommended) or mark non-extractable chunks as processed in a separate pass (set entity_ids = [] without sending to Claude).
**Warning signs:** High chunksProcessed but low entitiesCreated.

### Pitfall 6: Duplicate Relations
**What goes wrong:** Same relation extracted repeatedly from different chunks.
**Why it happens:** Multiple Slack messages or ClickUp tasks mention "Semyon works on Level One".
**How to avoid:** Already handled by `addRelation()` which checks for existing from+to+relation triplet. No action needed.

## Implementation Strategy

### Phase 1: Pre-process (mark non-extractable chunks)

Mark chunks that should never be sent to Claude as already processed:

```typescript
// Mark all metadata stubs and very short chunks as processed (no entities)
await db.update(kbChunks)
  .set({ entityIds: [] })
  .where(and(
    sql`${kbChunks.entityIds} IS NULL`,
    sql`(
      length(${kbChunks.text}) < 100
      OR ${kbChunks.text} LIKE '%[metadata-only stub]%'
      OR ${kbChunks.source} = 'drive'
    )`,
  ))
```

This reduces the extractable pool from ~116K to ~30-40K, then the smart selection query further prioritizes to ~5-10K high-value chunks.

### Phase 2: Enhanced extraction loop

1. Update `findUnprocessedChunks()` with source priority and length filter
2. Add multi-batch loop with time/cost budget
3. Include existing entity context in prompt
4. Add cost tracking via Claude CLI JSON output (`usage.costUsd`)
5. Add progress logging (remaining unprocessed count)

### Phase 3: Nightly integration

Update `src/worker/index.ts` to use the enhanced multi-batch extraction instead of the single-call version. The cron schedule stays at `0 20 * * *`.

### One-Time Initial Run

For the first extraction (processing the existing ~5-10K useful chunks), run as a CLI script rather than waiting for nightly batches:

```bash
npx tsx src/kb/extract-entities-manual.ts --max-batches 200 --max-cost 15
```

This processes the backlog in one session (~1-3 hours, ~$5-15).

## Code Examples

### Current callClaude() Pattern (verified from source)

```typescript
// Source: src/llm/client.ts
const result = await callClaude(prompt, {
  system: 'You are a JSON-only entity extraction tool. Output valid JSON only, no markdown.',
})

// Response includes usage metrics from Claude CLI JSON output
// result.usage?.costUsd tracks actual API cost
```

### Current Entity Merge Pattern (verified from source)

```typescript
// Source: src/kb/entity-extractor.ts
const existing = await findEntityByName(db, entity.name)
if (existing) {
  entityIdMap.set(entity.name.toLowerCase(), existing.id)
  // Add new aliases only
  for (const alias of entity.aliases ?? []) {
    await addAlias(db, existing.id, alias).catch(() => {})
  }
  continue
}
// Create new entity if not found
const entityId = await createEntity(db, { type, name, company, metadata: { source: 'extraction' } })
```

### Chunk Selection SQL (proposed)

```typescript
// Enhanced findUnprocessedChunks with priority ordering
const chunks = await db.execute(sql`
  SELECT id, source, source_id AS "sourceId", text, metadata
  FROM kb_chunks
  WHERE entity_ids IS NULL
    AND length(text) > 100
    AND text NOT LIKE '%[metadata-only stub]%'
    AND source != 'drive'
  ORDER BY
    CASE source
      WHEN 'slack' THEN 1
      WHEN 'clickup' THEN 2
      WHEN 'notion' THEN 3
      WHEN 'gmail' THEN 4
      WHEN 'calendar' THEN 5
      ELSE 6
    END,
    source_date DESC NULLS LAST
  LIMIT ${limit}
`)
```

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| Single batch of 50 per night | Multi-batch loop with budget | Process 5-10K chunks in 1-3 hours instead of 6+ years |
| No chunk filtering | Smart selection by source priority + text length | Avoid wasting Claude calls on stubs |
| No entity context in prompt | Include existing entities | Better dedup, use canonical names |
| No cost tracking | Track via `result.usage?.costUsd` | Stay within budget |

## Open Questions

1. **Should extraction run as initial batch CLI or nightly cron first?**
   - What we know: ~5-10K useful chunks exist now. Nightly cron at 50/batch would take months.
   - What's unclear: User preference for one-time initial run vs. gradual processing.
   - Recommendation: Create a CLI script for initial bulk run, then use nightly cron for ongoing incremental extraction of new chunks.

2. **What about channels as entities?**
   - What we know: Slack channels are defined as a valid entity type but not seeded.
   - What's unclear: Whether extracting channel entities is useful for the entity graph.
   - Recommendation: Let Claude extract them naturally. They link people to channels, which maps to teams/projects.

3. **Should we update Qdrant entity_ids after extraction?**
   - What we know: Qdrant points have an `entity_ids` payload field (currently empty `[]`). PostgreSQL chunks get `entity_ids` updated.
   - What's unclear: Whether Qdrant entity_ids should be kept in sync for vector search filtering.
   - Recommendation: Yes, update Qdrant after extraction. The `kbSearchTool` already filters by `entity_ids` in Qdrant. Without updating, entity-based search won't filter vector results.

4. **Relation role specificity**
   - What we know: Seed data has specific roles ("Dev Lead", "PM", "QA Lead"). Claude extraction will infer roles from context.
   - What's unclear: Whether extracted roles will match seed data quality.
   - Recommendation: Accept whatever Claude extracts. Roles are informational, not used for filtering.

## Sources

### Primary (HIGH confidence)
- `src/kb/entity-extractor.ts` - existing extraction code, read in full
- `src/kb/repository.ts` - DB operations, read in full
- `src/kb/seed.ts` - seed data, read in full
- `src/worker/index.ts` - nightly cron schedule, read in full
- `src/llm/client.ts` - Claude CLI integration, read in full
- `src/db/schema.ts` - PostgreSQL schema (kb_entities, kb_entity_aliases, kb_entity_relations, kb_chunks), read in full

### Secondary (MEDIUM confidence)
- Cost estimates based on Claude Sonnet pricing as of early 2026 ($3/1M input, $15/1M output)
- Chunk distribution based on MEMORY.md ingestion data (may have changed since 2026-03-03)

## Metadata

**Confidence breakdown:**
- Existing code analysis: HIGH - all source files read directly
- Chunk selection strategy: HIGH - based on actual schema and data distribution
- Cost/time estimates: MEDIUM - based on pricing assumptions and chunk size estimates
- Entity dedup approach: HIGH - verified from existing code patterns

**Research date:** 2026-03-04
**Valid until:** 2026-04-04 (stable codebase, no external dependency changes expected)
