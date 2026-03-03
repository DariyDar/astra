---
phase: 04-knowledge-base
plan: gmail-cleanup
type: execute
wave: 1
depends_on: []
files_modified:
  - src/kb/gmail-classifier.ts
  - src/kb/gmail-cleanup.ts
  - src/kb/ingestion/gmail.ts
autonomous: true
requirements: [KB-01, KB-02]

must_haves:
  truths:
    - "System emails (TestFlight, App Store, Clockify, etc.) are tagged as 'system' in metadata"
    - "Human emails (including Indium/Nisha, Indium/Jijo, Tilting Point/Andrianne) are tagged as 'human' in metadata"
    - "Only the last 200 emails per account retain full content (deep-indexed with Qdrant vectors)"
    - "Older emails are reduced to metadata-only stubs (chunk_index=0, no Qdrant vector, headers-only text)"
    - "New emails ingested via toChunks() are automatically classified and system emails produce only a metadata stub"
    - "Gmail chunk count drops from ~113K to ~37K after cleanup"
  artifacts:
    - path: "src/kb/gmail-classifier.ts"
      provides: "System sender patterns, keep-sender allowlist, classifyEmail function"
      exports: ["classifyEmail", "SYSTEM_PATTERNS", "KEEP_SENDERS"]
    - path: "src/kb/gmail-cleanup.ts"
      provides: "CLI script for one-time bulk Gmail cleanup with --dry-run"
      min_lines: 120
    - path: "src/kb/ingestion/gmail.ts"
      provides: "Modified toChunks() that classifies emails inline"
      contains: "classifyEmail"
  key_links:
    - from: "src/kb/gmail-cleanup.ts"
      to: "src/kb/gmail-classifier.ts"
      via: "import classifyEmail"
      pattern: "import.*classifyEmail.*gmail-classifier"
    - from: "src/kb/gmail-cleanup.ts"
      to: "src/kb/vector-store.ts"
      via: "KBVectorStore.deleteBySourceId()"
      pattern: "deleteBySourceId"
    - from: "src/kb/gmail-cleanup.ts"
      to: "src/kb/repository.ts"
      via: "Direct SQL for bulk chunk operations"
      pattern: "db\\.execute|db\\.delete|db\\.update"
    - from: "src/kb/ingestion/gmail.ts"
      to: "src/kb/gmail-classifier.ts"
      via: "import classifyEmail for inline classification"
      pattern: "import.*classifyEmail.*gmail-classifier"
---

<objective>
Clean up Gmail KB data to reduce chunk count from ~113K to ~37K while preserving important emails.

Purpose: Gmail ingestion produced ~94 chunks per email, with ~642 system emails (TestFlight, App Store, Clockify, etc.) bloating the knowledge base. This cleanup classifies emails as system vs human, keeps only the last 200 per account deep-indexed, converts the rest to metadata-only stubs, and modifies future ingestion to classify inline.

Output: Three files — a reusable classifier module, a one-time cleanup CLI script, and a modified gmail adapter.
</objective>

<execution_context>
@C:/Users/dimsh/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/dimsh/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/research/gmail-cleanup-RESEARCH.md
@src/kb/ingestion/gmail.ts
@src/kb/ingestion/runner.ts
@src/kb/ingestion/types.ts
@src/kb/repository.ts
@src/kb/vector-store.ts
@src/kb/chunker.ts
@src/kb/types.ts
@src/db/schema.ts
@src/kb/ingest-manual.ts
@src/kb/check-ingestion.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create gmail-classifier.ts and gmail-cleanup.ts</name>
  <files>src/kb/gmail-classifier.ts, src/kb/gmail-cleanup.ts</files>
  <action>
**1. Create `src/kb/gmail-classifier.ts` (~60 lines):**

Export three things:
- `SYSTEM_PATTERNS: string[]` — 11 case-insensitive partial-match patterns for the From header:
  `noreply@`, `no-reply@`, `testflight@apple.com`, `appstoreconnect@apple.com`, `clockify`, `noreply@google`, `atlassian`, `clickup`, `pagerduty`, `comments-noreply@docs.google.com`, `spaces-noreply@google.com`
  Also add a pattern for Slack weekly digests. Since `from` may contain "slack" in many legitimate messages, use a two-part check: from contains `slack` AND subject contains `weekly` (or pass subject as optional second param). Alternatively, match the specific sender like `feedback@slack.com` with subject check. Keep it simple: add `@slack` as a pattern but only for weekly digest detection — actually, safer to check `feedback@mail.slack.com` which is the typical weekly digest sender.

- `KEEP_SENDERS: string[]` — Senders that look like system but MUST be classified as human:
  `nisha` (Indium QA), `jijo` (Indium QA), `andrianne` (Tilting Point EOD reports)
  These are partial matches on the From header.

- `classifyEmail(from: string, subject?: string): 'system' | 'human'` function:
  1. Lowercase the from string
  2. Check KEEP_SENDERS first — if any pattern matches, return `'human'`
  3. Check SYSTEM_PATTERNS — if any pattern matches, return `'system'`
  4. Special case for Slack weekly: if from contains `slack` and subject (lowercased) contains `weekly`, return `'system'`
  5. Default: return `'human'`

Use pino logger to import from `../../logging/logger.js` — no, this is a pure utility module, no logging needed.

**2. Create `src/kb/gmail-cleanup.ts` (~150 lines):**

CLI script, follows the pattern from `check-ingestion.ts` and `ingest-manual.ts`. Shebang: `#!/usr/bin/env node`.

Usage: `npx tsx src/kb/gmail-cleanup.ts [--dry-run]`

Implementation:
```
import 'dotenv/config'
import pg Pool
import drizzle
import QdrantClient + KBVectorStore
import * as schema
import { sql, eq, and, inArray } from 'drizzle-orm'
import { kbChunks } from '../db/schema.js'
import { classifyEmail } from './gmail-classifier.js'
import { formatEmail, contentHash } from './chunker.js'
```

Constants:
- `DEEP_INDEX_LIMIT = 200` — per account
- `BATCH_SIZE = 100` — process sourceIds in batches

Steps (each step logs progress):

**Step 1 — Discover unique emails:**
```sql
SELECT DISTINCT source_id,
  metadata->>'account' as account,
  metadata->>'from' as from_addr,
  metadata->>'subject' as subject,
  source_date
FROM kb_chunks
WHERE source = 'gmail' AND chunk_index = 0
ORDER BY source_date DESC
```
This gets one row per email (chunk_index=0 is the first chunk).

**Step 2 — Classify each email:**
For each row, call `classifyEmail(from_addr, subject)`. Build two maps:
- `byAccount: Map<string, Array<{sourceId, emailType, sourceDate}>>` — grouped by account, sorted by sourceDate DESC

**Step 3 — Determine which emails to downgrade:**
For each account:
- The first 200 (most recent by sourceDate) stay deep-indexed regardless of type
- Everything after position 200 that is type `'system'` → downgrade to metadata-only
- Everything after position 200 that is type `'human'` → downgrade to metadata-only (still keep stub)
- Actually per research: ALL emails outside top-200 get downgraded to stubs. The classification is for the `emailType` tag only.

So: top 200 per account = keep full content + vectors. Rest = metadata stub only.

Collect `sourceIdsToDowngrade: string[]` (all sourceIds beyond position 200 in each account).
Also collect `allEmailClassifications: Map<string, 'system' | 'human'>` for tagging ALL emails.

**Step 4 — Print dry-run summary (always):**
```
=== Gmail Cleanup Summary ===
  Total emails: {N}
  Per account:
    {account}: {total} emails ({system} system, {human} human)
      Keep deep-indexed: {min(200, total)}
      Downgrade to stub: {rest}
  Chunks to delete: ~{estimate} (sourceIds * avg chunks)
  Qdrant vectors to remove: ~{estimate}
```

If `--dry-run` flag is present, exit here.

**Step 5 — Delete Qdrant vectors FIRST (safety order):**
Process `sourceIdsToDowngrade` in batches of BATCH_SIZE:
```typescript
for (let i = 0; i < sourceIdsToDowngrade.length; i += BATCH_SIZE) {
  const batch = sourceIdsToDowngrade.slice(i, i + BATCH_SIZE)
  for (const sourceId of batch) {
    await vectorStore.deleteBySourceId(sourceId)
  }
  console.log(`  Qdrant: deleted vectors for ${Math.min(i + BATCH_SIZE, sourceIdsToDowngrade.length)}/${sourceIdsToDowngrade.length} emails`)
}
```

**Step 6 — Delete PG chunks with chunk_index > 0 for downgraded emails:**
Process in batches:
```typescript
for (let i = 0; i < sourceIdsToDowngrade.length; i += BATCH_SIZE) {
  const batch = sourceIdsToDowngrade.slice(i, i + BATCH_SIZE)
  await db.delete(kbChunks).where(
    and(
      eq(kbChunks.source, 'gmail'),
      inArray(kbChunks.sourceId, batch),
      sql`${kbChunks.chunkIndex} > 0`
    )
  )
}
```

**Step 7 — Update chunk_index=0 stubs for downgraded emails:**
For each downgraded sourceId, update the chunk_index=0 row:
- Replace `text` with headers-only (re-format using `formatEmail` with empty body)
- Set `qdrant_id = NULL`
- Add `emailType` to metadata JSONB
- Update `content_hash` to match new text

Process in batches. For each sourceId in the batch:
```typescript
const [row] = await db.select({ id: kbChunks.id, metadata: kbChunks.metadata })
  .from(kbChunks)
  .where(and(
    eq(kbChunks.source, 'gmail'),
    eq(kbChunks.sourceId, sourceId),
    eq(kbChunks.chunkIndex, 0)
  ))
  .limit(1)

if (!row) continue

const meta = (row.metadata ?? {}) as Record<string, unknown>
const stubText = formatEmail({
  from: meta.from as string ?? '',
  to: meta.to as string ?? '',
  subject: meta.subject as string ?? '',
  body: '[metadata-only stub]',
  date: meta.date as string,
})
const hash = contentHash(stubText)
const emailType = allEmailClassifications.get(sourceId) ?? 'human'

await db.update(kbChunks)
  .set({
    text: stubText,
    contentHash: hash,
    qdrantId: null,
    metadata: { ...meta, emailType },
  })
  .where(eq(kbChunks.id, row.id))
```

**Step 8 — Tag deep-indexed emails (top 200) with emailType:**
For each sourceId that stays deep-indexed, update metadata to include `emailType`:
```typescript
for (const sourceId of deepIndexedSourceIds) {
  const emailType = allEmailClassifications.get(sourceId) ?? 'human'
  await db.execute(sql`
    UPDATE kb_chunks
    SET metadata = metadata || ${JSON.stringify({ emailType })}::jsonb
    WHERE source = 'gmail' AND source_id = ${sourceId}
  `)
}
```

**Step 9 — Print final summary:**
```
=== Cleanup Complete ===
  Qdrant vectors removed: {N} sourceIds
  PG chunks deleted: {count}
  Stubs updated: {count}
  Deep-indexed tagged: {count}
```

Close pool at the end.

**Error handling:** Wrap each major step in try/catch. If Qdrant deletion fails for a sourceId, log warning and continue (orphan is harmless). If PG operation fails, log error and exit (data inconsistency risk).
  </action>
  <verify>
    <automated>npx tsx --eval "import { classifyEmail, SYSTEM_PATTERNS, KEEP_SENDERS } from './src/kb/gmail-classifier.js'; const tests = [ ['noreply@apple.com', undefined, 'system'], ['testflight@apple.com', undefined, 'system'], ['nisha@indium.com', undefined, 'human'], ['jijo@indium.co', undefined, 'human'], ['andrianne@tiltingpoint.com', undefined, 'human'], ['john@example.com', undefined, 'human'], ['feedback@mail.slack.com', 'Your Weekly Slack Update', 'system'], ]; let pass = 0; for (const [from, subj, expected] of tests) { const result = classifyEmail(from, subj); if (result === expected) pass++; else console.error('FAIL:', from, 'expected', expected, 'got', result); } console.log(pass + '/' + tests.length + ' tests passed'); if (pass < tests.length) process.exit(1);"</automated>
    <manual>Run `npx tsx src/kb/gmail-cleanup.ts --dry-run` on the server to verify it connects to PG and prints classification summary without modifying data</manual>
  </verify>
  <done>
    - `gmail-classifier.ts` exports `classifyEmail`, `SYSTEM_PATTERNS`, `KEEP_SENDERS`
    - `classifyEmail` correctly classifies all 11 system patterns and 3 keep-senders
    - `gmail-cleanup.ts` runs with `--dry-run`, connects to DB, prints email counts by account and type
    - No data is modified during dry-run
  </done>
</task>

<task type="auto">
  <name>Task 2: Modify gmail.ts toChunks() for inline classification</name>
  <files>src/kb/ingestion/gmail.ts</files>
  <action>
Modify the `toChunks()` method in the Gmail adapter to classify emails inline during ingestion.

**Import at top of file:**
```typescript
import { classifyEmail } from '../gmail-classifier.js'
```

**Modify `toChunks(item: RawItem): KBChunkInput[]`:**

Current behavior: always produces full content chunks for every email.
New behavior:
1. Call `classifyEmail(item.metadata.from as string, item.metadata.subject as string)` to get `emailType`
2. Add `emailType` to `item.metadata` in all chunks
3. If `emailType === 'system'`: produce ONLY a single chunk (chunk_index=0) with headers-only text (use `formatEmail` with body set to `'[system email — metadata only]'`). Do NOT split into multiple chunks. This means system emails get no Qdrant vector (the runner will still embed it, but it will be a single small chunk instead of many).

Actually, looking at the runner code, it always embeds every chunk. To truly avoid embedding system emails, we would need to modify the runner — which is out of scope. Instead, just produce a single small chunk for system emails. The single chunk IS acceptable (1 chunk vs ~94 chunks is a 99% reduction). The runner will embed that one chunk, which is fine.

```typescript
toChunks(item: RawItem): KBChunkInput[] {
  const from = item.metadata.from as string
  const subject = item.metadata.subject as string
  const emailType = classifyEmail(from, subject)
  const enrichedMetadata = { ...item.metadata, emailType }

  if (emailType === 'system') {
    // System emails: single metadata-only stub
    const text = formatEmail({
      from,
      to: item.metadata.to as string,
      subject,
      body: '[system email — metadata only]',
      date: item.date?.toISOString(),
    })
    return [{
      source: 'gmail' as const,
      sourceId: item.id,
      chunkIndex: 0,
      text,
      chunkType: 'email' as const,
      metadata: enrichedMetadata,
      sourceDate: item.date,
    }]
  }

  // Human emails: full content with splitting
  const text = formatEmail({
    from,
    to: item.metadata.to as string,
    subject,
    body: item.text,
    date: item.date?.toISOString(),
  })

  const chunks = splitText(text)
  return chunks.map((chunkText, i) => ({
    source: 'gmail' as const,
    sourceId: item.id,
    chunkIndex: i,
    text: chunkText,
    chunkType: 'email' as const,
    metadata: enrichedMetadata,
    sourceDate: item.date,
  }))
},
```

This ensures:
- System emails produce 1 chunk instead of ~94
- All emails get `emailType` in metadata for future filtering
- Human emails continue to be fully indexed as before
- No changes to the runner or other adapters needed
  </action>
  <verify>
    <automated>npx tsc --noEmit src/kb/ingestion/gmail.ts 2>&1 | head -20</automated>
    <manual>Review the diff to confirm: (a) classifyEmail import added, (b) system emails produce 1 chunk, (c) human emails unchanged, (d) emailType added to metadata for both paths</manual>
  </verify>
  <done>
    - `toChunks()` imports and calls `classifyEmail`
    - System emails produce exactly 1 chunk with `[system email — metadata only]` body
    - Human emails produce full split chunks as before
    - All chunks include `emailType: 'system' | 'human'` in metadata
    - TypeScript compiles without errors
  </done>
</task>

</tasks>

<verification>
1. `npx tsc --noEmit` passes for all three new/modified files
2. `npx tsx src/kb/gmail-cleanup.ts --dry-run` connects to the production DB and prints classification summary
3. Classification tests pass: system senders detected, keep-senders preserved as human, defaults to human
4. After actual cleanup run (manual step by user): `npx tsx src/kb/check-ingestion.ts` shows gmail chunks reduced from ~113K to ~37K
</verification>

<success_criteria>
1. `gmail-classifier.ts` correctly classifies all 11 system patterns and 3 keep-sender exceptions
2. `gmail-cleanup.ts --dry-run` prints accurate counts per account without modifying data
3. `gmail-cleanup.ts` (without --dry-run) reduces Gmail chunks from ~113K to ~37K
4. Cleanup order is Qdrant-first, then PG (safety guarantee)
5. Modified `toChunks()` produces 1 chunk for system emails, full chunks for human emails
6. All emails have `emailType` in metadata after cleanup and for new ingestion
</success_criteria>

<output>
After completion, create `.planning/phases/04-knowledge-base/gmail-cleanup-SUMMARY.md`
</output>
