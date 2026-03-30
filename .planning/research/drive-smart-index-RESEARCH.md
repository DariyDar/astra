# Drive Smart-Index - Research

**Researched:** 2026-03-03
**Domain:** Google Drive API v3, tiered content indexing, KB ingestion pipeline
**Confidence:** HIGH (codebase patterns well-understood, Drive API well-known)

## Summary

The current Drive adapter (`src/kb/ingestion/drive.ts`) indexes metadata only -- one chunk per file containing file name, type, owner, and modification date. It calls `files.list` with just `id,name,mimeType,modifiedTime,owners` and never calls `files.export` or `files.get?alt=media`. The goal is to evolve this into a 3-tier system: full content for files modified in the last month, summary/entity-level for 1-3 months, and metadata-only (current behavior) for 3+ months.

The existing ingestion infrastructure (adapter pattern, chunker, runner, vector store, PostgreSQL dedup) is mature and well-tested across 6 sources. The Drive adapter is the simplest of all adapters. Adding content export requires extending the adapter to call the Drive API export endpoint for Google Workspace files (Docs, Sheets, Slides). No new dependencies are needed.

**Primary recommendation:** Extend the existing `drive.ts` adapter with tier-aware logic in `fetchSince()`. Use `files.export` with `text/plain` MIME for Google Workspace files. Reset Drive watermarks via existing `reset-drive.ts` and re-run ingestion to upgrade existing metadata-only chunks to content chunks.

## Standard Stack

### Core (already in project -- no new dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js `fetch` | built-in | Google Drive API REST calls | Already used by all adapters |
| `@huggingface/transformers` | ^3.8.1 | Local embeddings (384-dim) | Already used for KB vectors |
| `@qdrant/js-client-rest` | ^1.17.0 | Vector storage | Already used for KB |
| `drizzle-orm` | ^0.45.1 | PostgreSQL ORM | Already used for chunks/entities |
| `pino` | ^10.3.1 | Logging | Already used throughout |

### Supporting (project-internal utilities)

| Utility | Location | Purpose |
|---------|----------|---------|
| `splitText` | `src/kb/chunker.ts` | Chunk long documents with sentence-boundary splitting |
| `contentHash` | `src/kb/chunker.ts` | SHA-256 for dedup of unchanged files |
| `resolveGoogleTokens` | `src/mcp/briefing/google-auth.ts` | Drive API auth with auto-refresh |
| `jsonOrThrow` | `src/mcp/briefing/utils.ts` | Safe API response parsing |
| `upsertChunk` | `src/kb/repository.ts` | PostgreSQL upsert with contentHash-based dedup |

## Architecture Patterns

### Current Adapter Interface (must preserve)

```typescript
// src/kb/ingestion/types.ts
interface SourceAdapter {
  name: string                    // e.g., 'drive:dariy@astrocat.co'
  source: ChunkSource             // 'drive'
  fetchSince(watermark: string): Promise<{ items: RawItem[]; nextWatermark: string }>
  toChunks(item: RawItem): KBChunkInput[]
}
```

### Recommended Approach: Single Adapter, Tier-Aware Logic

Rather than creating 3 separate adapters per tier, extend the existing adapter with tier logic inside `fetchSince()`. The tier is determined per-file based on `modifiedTime` relative to "now".

```
fetchSince(watermark):
  1. files.list with fields: id, name, mimeType, modifiedTime, owners, size
  2. For each file, determine tier based on modifiedTime:
     - Tier 1 (< 30 days): full content
     - Tier 2 (30-90 days): acquaintance depth
     - Tier 3 (> 90 days): metadata only (current behavior)
  3. For Tier 1 + Tier 2 files:
     - Export content via files.export (Google Workspace files)
     - Truncate to appropriate limit per tier
     - Graceful fallback to metadata on export failure
  4. toChunks() uses splitText for Tier 1, single chunk for Tier 2/3
```

### File Content Export Strategy

Google Drive has two distinct download mechanisms:

**Google Workspace files (Docs, Sheets, Slides):**
- Use `files.export` endpoint: `GET https://www.googleapis.com/drive/v3/files/{fileId}/export?mimeType=text/plain`
- These files have NO meaningful `size` field in `files.list` (size is 0 or absent)

| Source MIME | Export As | Method |
|-------------|-----------|--------|
| `application/vnd.google-apps.document` | `text/plain` | `files.export` |
| `application/vnd.google-apps.spreadsheet` | `text/csv` | `files.export` |
| `application/vnd.google-apps.presentation` | `text/plain` | `files.export` |

**Binary files (PDFs, images, Office docs):**
- Use `files.get` with `alt=media`
- **Recommendation: skip binary files initially.**

### Tier Determination Logic

```typescript
const TIER_1_DAYS = 30
const TIER_2_DAYS = 90

type IndexTier = 'full' | 'acquaintance' | 'metadata'

function determineTier(modifiedTime: Date): IndexTier {
  const ageDays = (Date.now() - modifiedTime.getTime()) / 86_400_000
  if (ageDays <= TIER_1_DAYS) return 'full'
  if (ageDays <= TIER_2_DAYS) return 'acquaintance'
  return 'metadata'
}
```

### Content Size Guards

```typescript
const MAX_EXPORT_CHARS = 50_000       // Cap Tier 1 exported text at 50K chars
const MAX_ACQUAINTANCE_CHARS = 3_000  // Cap Tier 2 at ~3K chars
const EXPORT_TIMEOUT_MS = 30_000      // 30s timeout per export
const EXPORT_DELAY_MS = 100           // 100ms between exports (rate limiting)
```

### Metadata Enhancement

Store index depth in chunk metadata for tracking:

```typescript
metadata: {
  account,
  fileName: file.name,
  mimeType: file.mimeType,
  owner,
  indexDepth: 'full' | 'acquaintance' | 'metadata',  // NEW
}
```

## Common Pitfalls

### Pitfall 1: Google Workspace Files Have No Size Field
Checking `file.size` to skip large files -- it's always undefined/0 for Docs/Sheets/Slides. Export with timeout and truncate after receiving.

### Pitfall 2: Export MIME Type Mismatch
Sheets export as `text/csv`, not `text/plain`. Use `EXPORT_MIMES` mapping per type.

### Pitfall 3: Token Expiry During Long Export Runs
Call `resolveGoogleTokens()` every ~50 files. It handles refresh automatically.

### Pitfall 4: Chunk Explosion for Large Documents
Cap at `MAX_EXPORT_CHARS` (50K) → at most ~55 chunks. Tier 2 cap at 3K → 3-4 chunks max.

### Pitfall 5: OOM During Large File Export
`AbortSignal.timeout(30_000)` prevents hanging. `MAX_EXPORT_CHARS` truncation prevents memory issues.

### Pitfall 6: Shared Drive / Permission Errors
Wrap each export in try-catch, log error, skip file. One file failure must not block entire run.

### Pitfall 7: Tier Downgrade on Re-runs
Never downgrade. Once content is indexed at a higher tier, keep it. Watermark-based approach handles this naturally.

## Code Examples

### Export File Content
```typescript
const EXPORT_MIMES: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
}

async function exportFileContent(
  fileId: string,
  mimeType: string,
  accessToken: string,
): Promise<string | null> {
  const exportMime = EXPORT_MIMES[mimeType]
  if (!exportMime) return null

  try {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    })
    if (!resp.ok) return null

    let text = await resp.text()
    if (text.length > MAX_EXPORT_CHARS) {
      text = text.slice(0, MAX_EXPORT_CHARS) + '\n[... truncated]'
    }
    return text.trim() || null
  } catch {
    return null
  }
}
```

### Periodic Token Refresh
```typescript
const REFRESH_INTERVAL = 50
let fileCount = 0
let currentToken = accessToken

for (const file of files) {
  fileCount++
  if (fileCount % REFRESH_INTERVAL === 0) {
    const freshTokens = await resolveGoogleTokens()
    currentToken = freshTokens.get(account) ?? currentToken
  }
}
```

## Implementation Guidance

### Files to Modify

| File | Change | Estimated Lines |
|------|--------|----------------|
| `src/kb/ingestion/drive.ts` | Major: add export logic, tier constants, tier determination, export function | ~100-150 lines added |
| `src/kb/reset-drive.ts` | Minor: add Qdrant vector cleanup | ~10 lines added |

### Suggested Task Sequence

1. Add `EXPORT_MIMES`, `determineTier()`, `exportFileContent()` helper functions
2. Update `files.list` fields to include `size` (for logging/diagnostics)
3. Update `fetchSince()` with tier-aware export logic + periodic token refresh
4. Update `toChunks()` to use `splitText()` for full-depth content
5. Enhance `reset-drive.ts` to clean Qdrant vectors
6. Reset watermarks and run full Drive ingestion
7. Verify results via `inspect.ts` and spot-check in PostgreSQL

### Estimated Outcomes

- **Chunk count**: ~6,500-17,000 (up from 6,650 metadata-only)
- **Ingestion time**: ~25-40 minutes for initial migration
- **Storage increase**: PostgreSQL ~5-15MB additional, Qdrant ~2-5MB additional

## Open Questions

1. **PDF text extraction**: skip in v1 or include? (recommend skip)
2. **Qdrant cleanup in reset-drive.ts**: need to add
3. **Actual file date distribution**: will determine chunk counts
4. **Spreadsheet export quality**: CSV can be huge — cap at lower limit
