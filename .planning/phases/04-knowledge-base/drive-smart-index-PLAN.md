---
phase: 04-knowledge-base
plan: drive-smart-index
type: execute
wave: 1
depends_on: []
files_modified:
  - src/kb/ingestion/drive.ts
  - src/kb/reset-drive.ts
  - tests/kb/drive-tier.test.ts
autonomous: true
requirements: [DRIVE-01, DRIVE-03, DRIVE-04]

must_haves:
  truths:
    - "Google Docs/Sheets/Slides modified in the last 30 days are exported as full text and chunked"
    - "Files modified 30-90 days ago get truncated single-chunk acquaintance content"
    - "Files older than 90 days remain metadata-only (current behavior preserved)"
    - "Binary files (PDFs, images, Office docs) are skipped gracefully"
    - "Export failures fall back to metadata-only without blocking other files"
    - "Re-running ingestion never downgrades a file's tier"
    - "reset-drive.ts cleans both PostgreSQL chunks and Qdrant vectors"
  artifacts:
    - path: "src/kb/ingestion/drive.ts"
      provides: "Tier-aware Drive adapter with content export"
      contains: "determineTier"
    - path: "src/kb/reset-drive.ts"
      provides: "Full Drive data cleanup including Qdrant vectors"
      contains: "qdrant"
    - path: "tests/kb/drive-tier.test.ts"
      provides: "Unit tests for tier determination and content truncation"
      contains: "determineTier"
  key_links:
    - from: "src/kb/ingestion/drive.ts"
      to: "Google Drive API files.export"
      via: "fetch with Authorization header"
      pattern: "googleapis\\.com/drive/v3/files/.+/export"
    - from: "src/kb/ingestion/drive.ts"
      to: "src/kb/chunker.ts"
      via: "splitText for Tier 1 content"
      pattern: "splitText"
    - from: "src/kb/reset-drive.ts"
      to: "@qdrant/js-client-rest"
      via: "QdrantClient.delete with source filter"
      pattern: "qdrant.*delete|delete.*astra_knowledge"
---

<objective>
Evolve the Drive ingestion adapter from metadata-only to 3-tier smart indexing.

Purpose: Google Drive files currently produce 1 chunk per file with only file name/type/owner metadata. Recent documents (last 30 days) should have their full text content exported and chunked for semantic search. Files aged 30-90 days get a truncated single-chunk summary. Files older than 90 days keep the existing metadata-only behavior.

Output: Modified `src/kb/ingestion/drive.ts` with tier-aware export logic, enhanced `src/kb/reset-drive.ts` with Qdrant cleanup, and unit tests for tier logic.
</objective>

<execution_context>
@C:/Users/dimsh/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/dimsh/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/research/drive-smart-index-RESEARCH.md
@src/kb/ingestion/drive.ts
@src/kb/ingestion/types.ts
@src/kb/ingestion/runner.ts
@src/kb/ingestion/gmail.ts (reference for splitText usage pattern in toChunks)
@src/kb/chunker.ts
@src/kb/types.ts
@src/kb/vector-store.ts
@src/kb/reset-drive.ts
@src/kb/check-ingestion.ts
@src/mcp/briefing/google-auth.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add tier logic, export function, and unit tests to drive.ts</name>
  <files>
    src/kb/ingestion/drive.ts
    tests/kb/drive-tier.test.ts
  </files>
  <action>
**TDD first: create `tests/kb/drive-tier.test.ts`** with tests for the pure functions before modifying drive.ts.

Test cases for `determineTier(modifiedTime: Date): IndexTier`:
- File modified 5 days ago returns `'full'`
- File modified 29 days ago returns `'full'`
- File modified 31 days ago returns `'acquaintance'`
- File modified 89 days ago returns `'acquaintance'`
- File modified 91 days ago returns `'metadata'`
- File modified 365 days ago returns `'metadata'`
- File modified today (0 days) returns `'full'`
- File modified exactly 30 days ago returns `'full'` (boundary: <=30)
- File modified exactly 90 days ago returns `'acquaintance'` (boundary: <=90)

Test cases for `truncateContent(text: string, maxChars: number): string`:
- Text shorter than limit returns unchanged
- Text longer than limit truncates and appends `'\n[... truncated]'`
- Empty string returns empty string

Test cases for `isExportable(mimeType: string): boolean`:
- Returns true for `application/vnd.google-apps.document`
- Returns true for `application/vnd.google-apps.spreadsheet`
- Returns true for `application/vnd.google-apps.presentation`
- Returns false for `application/pdf`
- Returns false for `image/png`
- Returns false for `application/vnd.openxmlformats-officedocument.wordprocessingml.document`

**Export these pure functions from drive.ts** so tests can import them:
```typescript
export type IndexTier = 'full' | 'acquaintance' | 'metadata'

const TIER_1_DAYS = 30
const TIER_2_DAYS = 90

export function determineTier(modifiedTime: Date): IndexTier {
  const ageDays = (Date.now() - modifiedTime.getTime()) / 86_400_000
  if (ageDays <= TIER_1_DAYS) return 'full'
  if (ageDays <= TIER_2_DAYS) return 'acquaintance'
  return 'metadata'
}
```

**Then modify `src/kb/ingestion/drive.ts`:**

1. Add constants at top of file:
```typescript
const MAX_EXPORT_CHARS = 50_000       // Tier 1 content cap
const MAX_ACQUAINTANCE_CHARS = 3_000  // Tier 2 content cap
const EXPORT_TIMEOUT_MS = 30_000      // 30s per export
const EXPORT_DELAY_MS = 100           // rate limiting between exports
const TOKEN_REFRESH_INTERVAL = 50     // refresh token every N files
```

2. Add `EXPORT_MIMES` mapping (alongside existing `MIME_LABELS`):
```typescript
const EXPORT_MIMES: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
}
```

3. Add `exportFileContent(fileId, mimeType, accessToken)` async function:
   - Look up export MIME from `EXPORT_MIMES[mimeType]`; return `null` if not found (binary file)
   - Call `GET https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`
   - Use `AbortSignal.timeout(EXPORT_TIMEOUT_MS)`
   - If response not OK, log warning and return `null`
   - Return the text content (no truncation here; truncation happens per-tier in fetchSince)
   - Wrap entire function in try-catch, return `null` on any error
   - Log at debug level: `{ fileId, mimeType, chars: text.length }` on success

4. Add `truncateContent(text: string, maxChars: number): string` helper:
   - If `text.length <= maxChars`, return text
   - Otherwise return `text.slice(0, maxChars) + '\n[... truncated]'`

5. Update `DriveFile` interface: add optional `size?: number` field (for logging/diagnostics)

6. Update `files.list` fields string to include `size`:
   `'nextPageToken,files(id,name,mimeType,modifiedTime,owners,size)'`

7. **Rewrite `fetchSince()` with tier-aware logic:**
   - After fetching the file list (existing pagination loop), add a second pass:
   - Track `fileCount` for periodic token refresh
   - For each file in the fetched list:
     a. `const tier = determineTier(new Date(file.modifiedTime))`
     b. If tier is `'metadata'`: current behavior (metadata-only RawItem, no export)
     c. If tier is `'full'` or `'acquaintance'`:
        - `fileCount++`; if `fileCount % TOKEN_REFRESH_INTERVAL === 0`, call `resolveGoogleTokens()` and update `accessToken`
        - Call `exportFileContent(file.id, file.mimeType, accessToken)`
        - If export returns `null`: fall back to metadata-only
        - If export succeeds: truncate with appropriate limit (`MAX_EXPORT_CHARS` for full, `MAX_ACQUAINTANCE_CHARS` for acquaintance)
        - Store the exported+truncated content in `item.text` instead of just the type label
        - Add `indexDepth: tier` to `item.metadata`
        - `await new Promise(r => setTimeout(r, EXPORT_DELAY_MS))` between exports
     d. For metadata tier: add `indexDepth: 'metadata'` to metadata
   - IMPORTANT: Restructure the loop. Currently files are pushed to `items` inside the pagination do-while. Change to:
     - Phase 1: Collect all files from paginated API calls into a `DriveFile[]` array
     - Phase 2: Process each file (determine tier, export if needed, build RawItem)
     This separation makes token refresh and rate limiting cleaner.
   - Log summary after processing: `{ account, total: files.length, full: N, acquaintance: N, metadata: N }`

8. **Rewrite `toChunks()` with tier-aware chunking:**
   - Read `item.metadata.indexDepth` to determine chunking strategy
   - If `indexDepth === 'full'`:
     - Import `splitText` from `../chunker.js`
     - Build header: `"Google Doc: {fileName}\nOwner: {owner}\nModified: {date}\n\n"`
     - Prepend header to `item.text` (which now contains exported content)
     - Call `splitText(fullText)` to get chunks array
     - Return array of `KBChunkInput` with incrementing `chunkIndex`
   - If `indexDepth === 'acquaintance'`:
     - Build same header + content (already truncated to 3K in fetchSince)
     - Return single chunk (chunkIndex 0)
   - If `indexDepth === 'metadata'` or missing:
     - Current behavior: single chunk with type label + owner + date
   - All chunks use `chunkType: 'document'` and `source: 'drive'`

**Do NOT change the adapter interface** (`SourceAdapter`). The `fetchSince`/`toChunks` signatures remain identical. The runner does not need changes.
  </action>
  <verify>
    <automated>cd "C:/Users/dimsh/Downloads/Personal Assistant" && npx tsx --test tests/kb/drive-tier.test.ts</automated>
    <manual>Review drive.ts for: EXPORT_MIMES mapping, determineTier function, exportFileContent with timeout+fallback, tier-aware toChunks with splitText for full tier</manual>
    <sampling_rate>run after this task commits, before next task begins</sampling_rate>
  </verify>
  <done>
    - determineTier correctly classifies files by age into full/acquaintance/metadata
    - exportFileContent calls files.export for Google Workspace MIME types, returns null for binary
    - fetchSince exports content for Tier 1+2 files with rate limiting and periodic token refresh
    - toChunks uses splitText for full-depth files, single chunk for acquaintance, metadata-only for old files
    - All unit tests pass
    - Export failures gracefully fall back to metadata-only (no thrown errors)
    - indexDepth stored in chunk metadata for all tiers
  </done>
</task>

<task type="auto">
  <name>Task 2: Enhance reset-drive.ts with Qdrant cleanup and add TypeScript compilation check</name>
  <files>
    src/kb/reset-drive.ts
  </files>
  <action>
**Modify `src/kb/reset-drive.ts`** to also delete Qdrant vectors for Drive source, not just PostgreSQL rows.

Current behavior: deletes rows from `kb_chunks` and `kb_ingestion_state` tables only. Missing: Qdrant vectors remain orphaned.

Changes:

1. Add Qdrant client import and initialization:
```typescript
import { QdrantClient } from '@qdrant/js-client-rest'
```

2. After the existing PostgreSQL deletions, add Qdrant cleanup:
```typescript
// Delete Drive vectors from Qdrant
const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333'
const qdrant = new QdrantClient({ url: qdrantUrl })

try {
  const deleteResult = await qdrant.delete('astra_knowledge', {
    wait: true,
    filter: {
      must: [{ key: 'source', match: { value: 'drive' } }],
    },
  })
  console.log('Deleted Drive vectors from Qdrant:', JSON.stringify(deleteResult))
} catch (err) {
  console.warn('Qdrant cleanup failed (may not be running):', err instanceof Error ? err.message : err)
}
```

3. The Qdrant cleanup should be wrapped in try-catch so the script still succeeds if Qdrant is unreachable (e.g., running locally without Qdrant). Log a warning, do not throw.

4. Keep the existing PostgreSQL cleanup logic exactly as-is.

5. After all changes, verify the entire project compiles:
```bash
npx tsc --noEmit
```
Fix any type errors in drive.ts or reset-drive.ts. Common issues:
- Missing imports (splitText from chunker.js)
- Type narrowing on metadata fields
- Optional chaining for new DriveFile.size field
  </action>
  <verify>
    <automated>cd "C:/Users/dimsh/Downloads/Personal Assistant" && npx tsc --noEmit 2>&1 | head -30</automated>
    <manual>Read reset-drive.ts and confirm it has both PostgreSQL DELETE and Qdrant filter-based delete for source='drive'</manual>
    <sampling_rate>run after this task commits</sampling_rate>
  </verify>
  <done>
    - reset-drive.ts deletes Drive chunks from PostgreSQL (existing behavior preserved)
    - reset-drive.ts deletes Drive vectors from Qdrant collection 'astra_knowledge' with source='drive' filter
    - Qdrant failure is caught and logged as warning, does not crash the script
    - `npx tsc --noEmit` passes with zero errors for the entire project
    - No regression in existing ingestion adapters (runner.ts, gmail.ts, etc.)
  </done>
</task>

</tasks>

<verification>
After both tasks complete:

1. **Unit tests pass:**
   ```bash
   npx tsx --test tests/kb/drive-tier.test.ts
   ```

2. **TypeScript compilation passes:**
   ```bash
   npx tsc --noEmit
   ```

3. **Spot-check drive.ts structure:**
   - EXPORT_MIMES has 3 entries (document, spreadsheet, presentation)
   - determineTier uses 30/90 day boundaries
   - exportFileContent has AbortSignal.timeout(30000)
   - fetchSince has EXPORT_DELAY_MS between exports
   - fetchSince refreshes token every 50 files
   - toChunks imports and uses splitText for 'full' tier
   - All metadata includes indexDepth field

4. **Spot-check reset-drive.ts:**
   - QdrantClient imported and used
   - Filter uses `source: 'drive'` on collection `astra_knowledge`
   - Wrapped in try-catch with console.warn fallback
</verification>

<success_criteria>
- drive.ts implements 3-tier indexing: full (<=30d), acquaintance (31-90d), metadata (>90d)
- Google Workspace files (Docs, Sheets, Slides) are exported via files.export API
- Binary files are skipped (return null from exportFileContent)
- Content capped at 50K chars (Tier 1) and 3K chars (Tier 2)
- Rate limiting: 100ms delay between exports
- Token refresh every 50 files
- Export failure falls back to metadata-only gracefully
- Tier stored in metadata.indexDepth for tracking
- reset-drive.ts cleans both PostgreSQL and Qdrant
- All unit tests pass
- TypeScript compiles without errors
</success_criteria>

<output>
After completion, create `.planning/phases/04-knowledge-base/drive-smart-index-SUMMARY.md`
</output>
