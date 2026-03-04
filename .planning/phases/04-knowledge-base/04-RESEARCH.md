# Phase 4: Data Harvest and Knowledge Base - Research

**Researched:** 2026-03-04
**Domain:** KB ingestion pipeline, Slack user ID resolution, entity extraction at scale, entity dedup/merge, hybrid RAG search, incremental Drive sync
**Confidence:** HIGH

## Summary

Phase 4 is **partially implemented**: ingestion pipeline for 6 sources is deployed and running (116K chunks), entity extraction code is written and tested (1 batch succeeded producing 52 entities), Gmail cleanup reduced 113K to 37K chunks, and Drive smart-indexing upgraded from metadata-only to 3-tier content indexing. The KB has hybrid search (semantic + keyword with RRF) and entity graph (199 entities, 398 relations from seeds + 1 extraction batch).

**The critical remaining work is operational, not architectural.** The code is written; what remains is (1) building a Slack user ID-to-name lookup cache, (2) re-ingesting all 25K Slack chunks with resolved names, (3) running entity extraction in escalating batches with user quality verification at each stage, (4) merging known entity duplicates, (5) implementing Drive incremental re-indexing via Changes API (DRIVE-04), and (6) verifying that RAG search returns accurate answers with source citations.

**Primary recommendation:** The planner should structure work as sequential user-gated waves -- each wave produces a verifiable result that requires user confirmation before the next wave starts. No bulk operation without user signoff on test results.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- All Slack user IDs (`<@U123>`) MUST be resolved to display names at ingestion time, BEFORE saving to chunks
- Need a Slack user lookup cache built from `users.list` API for both workspaces (AC + HG)
- Existing 25K Slack chunks must be fully re-ingested with ID resolution (not mixed ID/name data)
- This is a one-time re-ingest operation: reset Slack watermarks, re-ingest all with names
- Different spellings of the same entity are aliases, not duplicates (LifeQuest = Life Quest, Motor World: The Car Factory = Ohbibi MWCF)
- Entity extraction prompt should use existing entity names as context to prevent new duplicates
- After extraction, known duplicates must be merged into canonical entity + aliases
- `Motor World: The Car Factory` and `Ohbibi MWCF` are ONE project -- merge required
- Every large operation must follow escalating test pattern: small test (2-3 batches) -> quality review WITH USER -> fix if needed; medium test (10 batches per source) -> quality review WITH USER -> fix; full bulk run -> final quality review WITH USER
- Quality review = user asks dozens of specific questions about extracted entities, relations, and cross-source mapping
- Review checks CONTENT QUALITY, not just "it ran successfully"
- This applies to ALL sources, not just Slack
- No bulk operation without user confirmation of test results
- After Slack re-ingest with ID resolution: run 10 batches per source (Slack, Notion, Gmail, Calendar, ClickUp = ~50 batches)
- Present entity/relation results for user review
- Only proceed to bulk extraction after user confirms quality

### Claude's Discretion
- Chunk filtering thresholds and heuristics
- Extraction prompt wording and optimization
- Batch size tuning for different sources
- Technical implementation of user lookup cache

### Deferred Ideas (OUT OF SCOPE)
- Gmail API filters (gmail.settings.basic scope) -- needs re-auth, not Phase 4 scope
- Daily digests -- Phase 5 scope
- RAG search quality verification -- can only be done after extraction is complete, may be Phase 4 close criterion or Phase 5 prerequisite
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DRIVE-01 | Bot indexes documents from specified Drive folders into RAG knowledge base | Already implemented: 3-tier Drive indexing (full/acquaintance/metadata) in `src/kb/ingestion/drive.ts`. 21,425 chunks. No further work needed. |
| DRIVE-03 | Bot tracks document freshness and flags potentially outdated documents (not modified in N months) | Partially addressed by tier system (metadata-only for >90 day files). Need: query to surface stale documents. Implementable via `kb_chunks` metadata filter on `source='drive'` + `source_date` age. |
| DRIVE-04 | Bot re-indexes documents incrementally when they change (via Drive Changes API) | Not yet implemented. Research below covers Drive Changes API (`changes.getStartPageToken` + `changes.list` polling). Pattern: store pageToken in `kb_ingestion_state`, poll during nightly cron, re-export changed files at appropriate tier. |
| KB-01 | RAG-based knowledge base aggregating data from Drive, Slack, Gmail, ClickUp | Core infrastructure deployed: 116K chunks across 6 sources + Notion. Remaining: Slack re-ingest with name resolution, entity extraction at scale. |
| KB-02 | User can ask contextual questions and get answers with source citations | `kb_search` MCP tool exists with hybrid search (`src/kb/search.ts`). Source citations returned via `source` + `sourceId` fields. Quality depends on entity extraction completeness. |
| KB-03 | Knowledge base supports hybrid search (semantic + keyword) with per-project filtering | Implemented: `hybridSearch()` uses Qdrant semantic + PG keyword with RRF. Entity-based filtering via `entity_ids` in Qdrant payload. Requires entity extraction to populate `entity_ids`. |
| KB-04 | Bot understands company-specific terminology (gamedev jargon, project names, people) | Entity graph (199 entities, 87 aliases) provides terminology support. Entity resolver handles cross-language (Russian/English) via `ilike` + alias table. Needs: bulk extraction to expand entity coverage. |
</phase_requirements>

## Standard Stack

### Core (already in project -- no new dependencies needed)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `drizzle-orm` | ^0.45.1 | PostgreSQL ORM for entity graph, chunks, ingestion state | Already used throughout KB |
| `@qdrant/js-client-rest` | ^1.17.0 | Vector storage and semantic search | Already used for `astra_knowledge` collection |
| `@huggingface/transformers` | ^3.8.1 | Local ONNX embeddings (384-dim, `Xenova/paraphrase-multilingual-MiniLM-L12-v2`) | Already used for KB embeddings |
| `pino` | ^10.3.1 | Structured JSON logging | Already used throughout |
| `node-cron` | (existing) | Nightly scheduling | Already used in worker |
| Node.js `fetch` | built-in | Slack API, Google APIs | Already used by all adapters |

### Supporting (project-internal, no new installs)

| Utility | Location | Purpose |
|---------|----------|---------|
| `callClaude` | `src/llm/client.ts` | Claude CLI subprocess for entity extraction |
| `resolveGoogleTokens` | `src/mcp/briefing/google-auth.ts` | Google API auth with auto-refresh |
| `SLACK_WORKSPACES` | `src/mcp/briefing/slack.ts` | Slack workspace config (AC + HG tokens) |
| `splitText` / `contentHash` | `src/kb/chunker.ts` | Chunking and dedup |
| `formatSlackMessage` | `src/kb/chunker.ts` | Slack message formatting |
| Ingestion runner | `src/kb/ingestion/runner.ts` | Adapter-based ingestion pipeline |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `users.list` bulk fetch | `users.info` per-user | 20+/min rate limit vs 50+/min, but `users.list` gets ALL users in 1-2 paginated calls; `users.info` would need hundreds of calls |
| Drive Changes API polling | Drive Push Notifications (webhooks) | Webhooks require publicly accessible HTTPS endpoint; polling via Changes API is simpler and fits the nightly cron pattern |
| Manual entity merge SQL | LLM-based dedup | Manual SQL is deterministic and instant; LLM dedup is expensive and non-deterministic; for known duplicates, SQL is correct |

**No new npm packages needed.** All required functionality is covered by existing dependencies and Node.js built-ins.

## Architecture Patterns

### Recommended Project Structure (additions to existing)

```
src/kb/
  slack-user-cache.ts      # NEW: Slack users.list -> Map<userId, displayName>
  entity-merge.ts          # NEW: SQL-based entity dedup/merge utilities
  ingestion/
    slack.ts               # MODIFY: use user cache for ID resolution
    drive.ts               # MODIFY: add Changes API support (DRIVE-04)
  entity-extractor.ts      # EXISTS: multi-batch extraction (already built)
  search.ts                # EXISTS: hybrid search (already built)
  repository.ts            # EXISTS: entity CRUD (already built)
```

### Pattern 1: Slack User ID Lookup Cache

**What:** Build an in-memory `Map<string, string>` mapping Slack user IDs to display names, populated from `users.list` API at ingestion startup. Use this to resolve `<@U123>` patterns in message text before saving chunks.

**When to use:** Every Slack ingestion run (nightly cron + manual re-ingest).

**Implementation:**

```typescript
// src/kb/slack-user-cache.ts
import { SLACK_WORKSPACES } from '../mcp/briefing/slack.js'
import { logger } from '../logging/logger.js'

/** Map: userId -> displayName (e.g. "U09AKPXRQ81" -> "Dariy") */
const userCache = new Map<string, string>()

export async function buildSlackUserCache(): Promise<Map<string, string>> {
  userCache.clear()

  for (const ws of SLACK_WORKSPACES) {
    const headers = { Authorization: `Bearer ${ws.token}`, 'Content-Type': 'application/json' }
    let cursor = ''

    do {
      const params = new URLSearchParams({ limit: '200' })
      if (cursor) params.set('cursor', cursor)

      const resp = await fetch(
        `https://slack.com/api/users.list?${params}`,
        { headers, signal: AbortSignal.timeout(15_000) },
      )
      const data = await resp.json() as {
        ok: boolean
        members?: Array<{
          id: string
          real_name?: string
          profile?: { display_name?: string; real_name?: string }
          deleted?: boolean
          is_bot?: boolean
        }>
        response_metadata?: { next_cursor?: string }
      }
      if (!data.ok) break

      for (const user of data.members ?? []) {
        // Prefer display_name, fall back to real_name, then user.id
        const name = user.profile?.display_name
          || user.profile?.real_name
          || user.real_name
          || user.id
        userCache.set(user.id, name)
      }

      cursor = data.response_metadata?.next_cursor || ''
    } while (cursor)

    logger.info({ workspace: ws.label, users: userCache.size }, 'Slack user cache built')
  }

  return userCache
}

/** Replace <@U123> patterns in text with resolved display names. */
export function resolveSlackMentions(text: string, cache: Map<string, string>): string {
  return text.replace(/<@(U[A-Z0-9]+)>/g, (_match, userId: string) => {
    const name = cache.get(userId)
    return name ?? userId
  })
}
```

**Rate limit consideration:** `users.list` is Tier 2 (20+/min). With ~200 users per page and ~40 people across both workspaces, this requires at most 2 API calls total -- well within limits.

**Source:** [Slack users.list API docs](https://docs.slack.dev/reference/methods/users.list/)

### Pattern 2: Slack Chunk Text Resolution

**What:** Integrate the user cache into `src/kb/ingestion/slack.ts` so that every message has `<@U123>` patterns resolved to display names before chunking.

**Implementation in `slack.ts`:**

```typescript
// In toRawItem() or toChunks(), before formatting:
const resolvedText = resolveSlackMentions(msg.text ?? '', userCache)
```

Also resolve the `user` field in the RawItem metadata:
```typescript
metadata: {
  user: userCache.get(msg.user) ?? msg.user ?? 'unknown',
  // ... rest
}
```

### Pattern 3: Entity Dedup/Merge

**What:** SQL-based merge of duplicate entities. Moves all aliases, relations, and chunk references from the duplicate entity to the canonical entity, then deletes the duplicate.

**Implementation:**

```typescript
// src/kb/entity-merge.ts
export async function mergeEntities(
  db: DB,
  canonicalId: number,
  duplicateId: number,
): Promise<void> {
  // 1. Move aliases from duplicate to canonical
  await db.update(kbEntityAliases)
    .set({ entityId: canonicalId })
    .where(eq(kbEntityAliases.entityId, duplicateId))

  // 2. Add the duplicate's name as an alias of the canonical
  const duplicate = await db.select().from(kbEntities).where(eq(kbEntities.id, duplicateId)).limit(1)
  if (duplicate.length > 0) {
    await db.insert(kbEntityAliases).values({
      entityId: canonicalId,
      alias: duplicate[0].name,
    }).onConflictDoNothing()
  }

  // 3. Re-point relations: from_id and to_id
  await db.update(kbEntityRelations)
    .set({ fromId: canonicalId })
    .where(eq(kbEntityRelations.fromId, duplicateId))
  await db.update(kbEntityRelations)
    .set({ toId: canonicalId })
    .where(eq(kbEntityRelations.toId, duplicateId))

  // 4. Update chunk entity_ids arrays (replace duplicate ID with canonical)
  // This requires raw SQL for array element replacement
  await db.execute(sql`
    UPDATE kb_chunks
    SET entity_ids = array_replace(entity_ids, ${duplicateId}, ${canonicalId})
    WHERE ${duplicateId} = ANY(entity_ids)
  `)

  // 5. Update Qdrant entity_ids (batch update for affected chunks)
  // ... fetch affected chunks, update Qdrant payload

  // 6. Delete duplicate entity (cascades aliases)
  await db.delete(kbEntities).where(eq(kbEntities.id, duplicateId))
}
```

### Pattern 4: Drive Incremental Re-indexing (DRIVE-04)

**What:** Use Google Drive Changes API to detect modified files and re-index them, instead of re-fetching the entire file list.

**Flow:**
1. On first run: call `changes.getStartPageToken()`, store token in `kb_ingestion_state` as watermark
2. On subsequent runs: call `changes.list(pageToken)` to get changed files
3. For each changed file: determine tier, re-export if tier requires content, upsert chunk
4. Store `newStartPageToken` as next watermark

```typescript
// In drive.ts fetchSince():
// If watermark looks like a Drive Changes pageToken (numeric string),
// use Changes API instead of files.list

async function fetchChanges(
  accessToken: string,
  startPageToken: string,
): Promise<{ files: DriveFile[]; newPageToken: string }> {
  const headers = { Authorization: `Bearer ${accessToken}` }
  const changedFiles: DriveFile[] = []
  let pageToken = startPageToken

  do {
    const params = new URLSearchParams({
      pageToken,
      fields: 'nextPageToken,newStartPageToken,changes(fileId,file(id,name,mimeType,modifiedTime,owners,trashed))',
      includeRemoved: 'true',
      restrictToMyDrive: 'true',
    })

    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/changes?${params}`,
      { headers, signal: AbortSignal.timeout(15_000) },
    )
    const data = await resp.json()

    for (const change of data.changes ?? []) {
      if (change.file && !change.file.trashed) {
        changedFiles.push(change.file)
      }
    }

    pageToken = data.nextPageToken || ''
    if (data.newStartPageToken) return { files: changedFiles, newPageToken: data.newStartPageToken }
  } while (pageToken)

  return { files: changedFiles, newPageToken: startPageToken }
}
```

**Source:** [Google Drive Changes API guide](https://developers.google.com/workspace/drive/api/guides/manage-changes)

### Pattern 5: Quality Verification Report Format

**What:** After each extraction wave, generate a structured report for user review.

**Format:**

```
=== Entity Extraction Quality Report ===
Source: slack (10 batches, 200 chunks)
New entities: 45
New relations: 72
Entity types: 28 person, 9 project, 5 channel, 3 process

Sample entities (verify these):
  - "Dariy Shatskikh" (person, hg) -- relations: manages Level One, owns Astra
  - "Oregon Trail" (project, ac) -- relations: Tilting Point client_of
  - "ac/dev-chat" (channel) -- members: [list]

Cross-source mapping examples:
  - "Level One": mentioned in 15 Slack chunks, 3 Notion docs, 2 ClickUp tasks, 4 Gmail threads
  - "Dariy": mentioned in 89 Slack chunks, 12 Gmail threads, 8 Calendar events

Questions for user:
  1. Is "Dariy Shatskikh" correctly identified as managing Level One?
  2. Is "Oregon Trail" correctly linked to Tilting Point as client?
  3. [etc.]
```

### Anti-Patterns to Avoid

- **Running bulk extraction before user quality review:** User explicitly requires escalating verification. Never run full extraction without user signoff on small/medium test results.
- **Mixed ID/name data in Slack chunks:** Never ingest Slack messages without resolving user IDs first. The 70+ person entities with raw IDs must not happen again.
- **Guessing entity merges:** Only merge entities the user has explicitly identified as duplicates (LifeQuest/Life Quest, Motor World/Ohbibi MWCF). Do not auto-merge based on fuzzy matching.
- **Re-ingesting all sources for name resolution:** Only Slack chunks need re-ingestion. Other sources (Gmail, Calendar, ClickUp, Notion, Drive) already store human-readable names.
- **Skipping Qdrant entity_ids sync:** After entity extraction updates PG `entity_ids`, Qdrant must also be updated. Without this, entity-filtered vector search returns zero results.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Slack user resolution | Custom user lookup per message | Bulk `users.list` cache | 2 API calls vs hundreds; ~40 users total |
| Entity dedup at extraction time | Fuzzy string matching | Existing `findEntityByName()` + alias table + entity context in prompt | Already handles ilike + aliases |
| Known entity merges | LLM-based merge | Direct SQL (`mergeEntities()`) | Deterministic, instant, user-specified |
| JSON parsing from LLM | Custom regex | Existing `parseExtraction()` | Already handles markdown fences, partial JSON |
| Drive change detection | `files.list` with modifiedTime filter | Drive Changes API `changes.list` | Purpose-built, returns only changed files, includes removals |
| Hybrid search | Custom scoring | Existing RRF in `hybridSearch()` | Already implemented with rrfK=60 |

**Key insight:** The KB infrastructure is mature. The remaining work is mostly operational (run extraction, verify quality, merge duplicates) with two focused code additions (Slack user cache, Drive Changes API).

## Common Pitfalls

### Pitfall 1: Slack User IDs Not Fully Resolved

**What goes wrong:** Some `<@U123>` patterns remain in chunk text, leading to entity extraction creating person entities like "U09AKPXRQ81" instead of "Dariy".
**Why it happens:** User cache doesn't include deactivated users, bots, or users from other workspaces. Some messages use formats like `<@U123|display_name>` which the regex needs to handle.
**How to avoid:** (1) Build cache from both workspaces (AC + HG). (2) Include deactivated users (`deleted: true`) in the cache -- they still appear in historical messages. (3) Handle the `<@U123|name>` format in the regex. (4) Log unresolved IDs for review after re-ingestion.
**Warning signs:** Person entities in the graph whose names start with "U0" or match `/^U[A-Z0-9]{8,}$/`.

### Pitfall 2: Entity Extraction Timeout at Large Batch Sizes

**What goes wrong:** Claude CLI times out when batch size exceeds ~20 chunks with the 300s timeout.
**Why it happens:** Entity context list (200+ entities) + 50 chunks x 800 chars = very large prompt. Claude CLI subprocess has overhead.
**How to avoid:** Use batch size 20 (proven to work). The 300s timeout is already deployed. Do not increase batch size above 20.
**Warning signs:** "Claude CLI timed out" errors in logs.

### Pitfall 3: Duplicate Relations After Re-extraction

**What goes wrong:** After Slack re-ingestion with names, re-running extraction creates duplicate relations because the old raw-ID entities still exist.
**How to avoid:** Delete the ~70 person entities that are raw Slack IDs BEFORE re-ingesting. Also delete their relations and aliases. Then re-ingest Slack, then re-extract.
**Warning signs:** Entities like both "U09AKPXRQ81" and "Dariy" existing simultaneously.

### Pitfall 4: OOM Kill During Long Extraction Runs

**What goes wrong:** Server kills the process during multi-hour extraction.
**Why it happens:** ONNX model cache corruption, memory leaks from many Claude CLI subprocess spawns.
**How to avoid:** (1) Use budget controls (already built: maxBatches, maxTimeMinutes, maxCostUsd). (2) Run extraction as a separate CLI process, not as part of the worker. (3) Do NOT deploy during extraction runs. (4) If OOM occurs, delete ONNX cache: `rm -rf node_modules/@huggingface/transformers/.cache`.
**Warning signs:** PM2 restart logs, sudden process termination.

### Pitfall 5: Drive Changes API Token Confusion

**What goes wrong:** Watermark stored as ISO date string (current approach) is not compatible with Drive Changes API pageToken (opaque string).
**How to avoid:** Use a separate `kb_ingestion_state` row for Changes API (e.g., `drive:changes:account`) distinct from the `drive:account` row used for `files.list`. Or switch the watermark format for drive adapters entirely to use Changes API tokens.
**Warning signs:** "Invalid pageToken" errors from Drive API.

### Pitfall 6: Qdrant-PostgreSQL Entity ID Desync

**What goes wrong:** PostgreSQL `kb_chunks.entity_ids` is updated after extraction, but Qdrant payload `entity_ids` is not, causing entity-filtered searches to miss results.
**How to avoid:** The entity extractor already updates both PG and Qdrant (code exists in `entity-extractor.ts`). For entity merges, also update Qdrant using `array_replace` equivalent logic. For the Slack re-ingest, Qdrant points get recreated with new UUIDs, so entity_ids start empty again and get populated during extraction.
**Warning signs:** `kb_search` with `person` filter returns 0 results even though entities exist.

## Code Examples

### Verified: Current Slack Message Format in Chunks

```typescript
// Source: src/kb/chunker.ts formatSlackMessage()
// Current output: "[#ac/general] U09AKPXRQ81: message text here"
// After fix:     "[#ac/general] Dariy: message text here"
```

### Verified: Entity Extraction Budget Loop

```typescript
// Source: src/kb/entity-extractor.ts extractEntitiesBatch()
// Already deployed and tested. Use with:
const stats = await extractEntitiesBatch(db, {
  maxBatches: 100,
  maxTimeMinutes: 120,
  maxCostUsd: 5.0,
  chunkBatchSize: 20,  // NOT 50 -- 50 times out at 300s
  pauseBetweenMs: 2000,
}, qdrantClient)
```

### Verified: Drive Tier Determination

```typescript
// Source: src/kb/ingestion/drive.ts
export function determineTier(modifiedTime: Date): IndexTier {
  const ageDays = (Date.now() - modifiedTime.getTime()) / 86_400_000
  if (ageDays <= TIER_1_DAYS) return 'full'       // <= 30 days
  if (ageDays <= TIER_2_DAYS) return 'acquaintance' // 31-90 days
  return 'metadata'                                  // > 90 days
}
```

### Proposed: Delete Raw-ID Entities Before Re-ingest

```typescript
// Clean up the ~70 person entities stored as Slack IDs
const rawIdEntities = await db.select({ id: kbEntities.id, name: kbEntities.name })
  .from(kbEntities)
  .where(and(
    eq(kbEntities.type, 'person'),
    sql`${kbEntities.name} ~ '^U[A-Z0-9]{8,}$'`,
  ))

for (const entity of rawIdEntities) {
  // CASCADE deletes aliases and relations
  await db.delete(kbEntities).where(eq(kbEntities.id, entity.id))
}

// Also clean up chunk entity_ids references
await db.execute(sql`
  UPDATE kb_chunks
  SET entity_ids = array_remove(entity_ids, ${entityId})
  WHERE ${entityId} = ANY(entity_ids)
`)
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Metadata-only Drive indexing | 3-tier content indexing (full/acquaintance/metadata) | Wave 1 (2026-03-03) | 6,650 -> 21,425 chunks |
| 113K Gmail chunks (raw) | 37K chunks (system/human classified, stubs) | Wave 1 (2026-03-03) | 3x reduction, better entity density |
| Single batch of 50/night | Multi-batch budget loop (100 batch / 2hr / $5) | Wave 2 (2026-03-04) | Can process 5-10K chunks in hours, not years |
| No entity context in prompt | Existing entity names injected, refreshed every 10 batches | Wave 2 (2026-03-04) | Better dedup, canonical name usage |
| Raw Slack user IDs in chunks | (PENDING) Resolved display names via users.list cache | Upcoming | Fix 70+ broken person entities |
| `files.list` for Drive sync | (PENDING) Changes API for incremental detection | Upcoming (DRIVE-04) | Only re-index changed files |

**Deprecated/outdated:**
- `extractEntities(db)` single-batch function -- superseded by `extractEntitiesBatch()` with budget controls
- `findUnprocessedChunks()` without quality filters -- already enhanced with source priority and min text length
- `callClaude()` with default 180s timeout -- entity extraction now uses 300s via `timeoutMs` option

## Open Questions

1. **How to handle the ~70 existing raw-ID person entities?**
   - What we know: These were created during the first extraction batch from Slack chunks that had unresolved IDs. They have relations pointing to them.
   - What's unclear: Whether to delete them before re-ingest (losing their relations) or keep them and merge after re-extraction with correct names.
   - Recommendation: Delete them before re-ingest. The relations they have are low-quality (based on raw IDs, not names). Re-extraction from name-resolved chunks will recreate the correct entities and relations.

2. **Should Drive use Changes API or continue with `files.list` + modifiedTime filter?**
   - What we know: Current approach uses `files.list` with `modifiedTime > watermark`. Changes API is purpose-built for incremental sync.
   - What's unclear: Whether the complexity of switching to Changes API is worth it for ~6,650 files that change infrequently.
   - Recommendation: Implement Changes API for DRIVE-04 compliance. Store the pageToken separately from the files.list watermark. The nightly cron can poll changes.list and only re-export/re-index changed files.

3. **What is the expected entity count after full extraction?**
   - What we know: Seed has 62 entities. First batch (20 Slack chunks) produced 52 new entities. ~8K extractable chunks remain.
   - What's unclear: Diminishing returns -- later batches will find mostly existing entities, fewer new ones.
   - Recommendation: Expect 200-400 total entities after full extraction (current 199 + ~100-200 new from non-Slack sources). The entity graph will be rich enough for meaningful cross-source mapping.

4. **How to verify cross-source entity mapping quality?**
   - What we know: User wants to verify "which Notion articles relate to which Slack channels, which emails arrive about it, which calendar meetings, which processes exist."
   - What's unclear: What specific queries to use for verification.
   - Recommendation: After extraction, generate a per-entity report showing chunk counts by source. Example: "Level One: 15 Slack, 3 Notion, 2 ClickUp, 4 Gmail, 1 Calendar." User reviews this mapping for correctness.

5. **Batch size 20 vs. source-specific tuning?**
   - What we know: Batch size 50 times out. Batch size 20 works. Different sources have different text densities.
   - What's unclear: Whether Slack messages (shorter) could use larger batches than Notion documents (longer).
   - Recommendation: Keep batch size 20 for all sources. The current implementation selects mixed-source batches ordered by priority. Source-specific tuning adds complexity for marginal cost savings.

## Validation Architecture

> Note: `workflow.nyquist_validation` is not set in config.json (only `research`, `plan_check`, `verifier` are configured). Skipping formal Nyquist validation framework.

### Test Infrastructure

| Property | Value |
|----------|-------|
| Framework | Custom inline tests (no formal framework) |
| Test file | `tests/entity-extractor.test.ts` (17 tests) |
| Quick run command | `npx tsx tests/entity-extractor.test.ts` |
| Coverage | parseExtraction, budget logic, entity context formatting |

### Existing Tests
- 7 parse extraction tests (plain JSON, markdown fenced, embedded, invalid, empty, missing keys)
- 7 budget logic tests (within limits, time/cost/batch exceeded, priority, zero budget)
- 3 entity context formatting tests (basic, empty, truncation)

### Testing Gaps
- No integration tests for Slack user cache (would require Slack API mock)
- No integration tests for entity merge (requires DB)
- No tests for Drive Changes API integration
- UAT quality verification is manual (user asks questions about extracted entities) per user preference

## Sources

### Primary (HIGH confidence)
- `src/kb/entity-extractor.ts` - multi-batch extraction code, read in full
- `src/kb/repository.ts` - entity CRUD, chunk operations, read in full
- `src/kb/ingestion/slack.ts` - Slack adapter, read in full
- `src/kb/ingestion/drive.ts` - Drive adapter with 3-tier indexing, read in full
- `src/kb/search.ts` - hybrid search with RRF, read in full
- `src/kb/mcp-tools.ts` - MCP tool definitions, read in full
- `src/kb/types.ts` - type definitions, read in full
- `src/db/schema.ts` - DB schema (5 KB tables), read in full
- `src/llm/client.ts` - Claude CLI integration, read in full
- `src/worker/index.ts` - nightly cron, read in full
- `src/mcp/briefing/slack.ts` - Slack API patterns (channels, history), read in full
- `src/memory/embedder.ts` - ONNX embedding pipeline, read in full
- `.planning/phases/04-knowledge-base/04-CONTEXT.md` - user decisions, read in full
- `.planning/phases/04-knowledge-base/entity-extraction-PLAN.md` - prior plan, read in full
- `.planning/research/entity-extraction-RESEARCH.md` - prior research, read in full
- `.planning/research/drive-smart-index-RESEARCH.md` - prior research, read in full

### Secondary (MEDIUM confidence)
- [Slack users.list API docs](https://docs.slack.dev/reference/methods/users.list/) - Tier 2 rate limit, response fields, pagination
- [Google Drive Changes API guide](https://developers.google.com/workspace/drive/api/guides/manage-changes) - incremental sync flow
- [Google Drive changes.list reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list) - API parameters

### Tertiary (LOW confidence)
- Entity count estimates (200-400 total after full extraction) -- based on extrapolation from 1 batch, actual count depends on data density

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all dependencies already in project, read from package.json
- Architecture: HIGH - all patterns verified from existing codebase, read from source files
- Slack user cache: HIGH - users.list API is well-documented, implementation straightforward
- Entity merge: HIGH - SQL operations are deterministic, schema read from source
- Drive Changes API: MEDIUM - API is well-documented but not yet implemented in project, integration pattern needs validation
- Pitfalls: HIGH - all pitfalls based on actual incidents documented in MEMORY.md (OOM kills, timeout at batch 50, raw Slack IDs)
- Cost/time estimates: MEDIUM - based on 1 successful batch ($0.65 for 20 chunks), extrapolated to 8K chunks

**Research date:** 2026-03-04
**Valid until:** 2026-04-04 (stable codebase, no external dependency changes expected)
