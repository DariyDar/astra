---
phase: 04-knowledge-base
plan: drive-incremental
type: execute
wave: 3
depends_on: []
files_modified:
  - src/kb/ingestion/drive.ts
  - src/worker/index.ts
autonomous: true
requirements:
  - DRIVE-04
  - DRIVE-03
  - DRIVE-01

must_haves:
  truths:
    - "Drive re-indexing detects only changed files via Changes API instead of re-fetching all 6,650 files"
    - "Changed files are re-indexed at the correct tier (full/acquaintance/metadata) based on modifiedTime"
    - "Nightly cron polls Drive Changes API and re-indexes modified documents"
    - "Stale documents (not modified in N months) can be queried and flagged"
  artifacts:
    - path: "src/kb/ingestion/drive.ts"
      provides: "Drive adapter with Changes API incremental sync and stale document query"
      contains: "changes.list"
      exports: ["findStaleDriveDocuments"]
    - path: "src/worker/index.ts"
      provides: "Nightly cron with Drive incremental re-indexing"
      contains: "drive.*changes"
  key_links:
    - from: "src/kb/ingestion/drive.ts"
      to: "Google Drive Changes API"
      via: "fetch to googleapis.com/drive/v3/changes"
      pattern: "changes\\.list|getStartPageToken"
    - from: "src/worker/index.ts"
      to: "src/kb/ingestion/drive.ts"
      via: "nightly cron calls Drive incremental sync"
      pattern: "drive.*incremental|changes"
---

<objective>
Implement Google Drive Changes API for incremental re-indexing (DRIVE-04) and add a stale document query for freshness tracking (DRIVE-03). Instead of re-fetching all 6,650 files every run, poll only changed files via Changes API and re-index them at the appropriate tier.

Purpose: DRIVE-04 requires incremental re-indexing when documents change. Current approach re-fetches all files. Changes API returns only modified files, saving API quota and time. DRIVE-03 requires freshness tracking to flag outdated documents. DRIVE-01 is already implemented (3-tier indexing) but benefits from incremental sync to keep content current.

Output: Drive adapter with Changes API support, stale document query, nightly cron integration.
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
@src/kb/ingestion/drive.ts
@src/worker/index.ts
@src/kb/ingestion/runner.ts
@src/mcp/briefing/google-auth.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add Drive Changes API support and stale document query</name>
  <files>src/kb/ingestion/drive.ts</files>
  <action>
Add two new capabilities to the existing Drive adapter in `src/kb/ingestion/drive.ts`:

**1. Changes API incremental sync:**

Add function `fetchDriveChanges(accessToken: string, startPageToken: string): Promise<{ files: DriveFile[]; newPageToken: string }>`:
- Call `https://www.googleapis.com/drive/v3/changes?pageToken={startPageToken}` with fields: `nextPageToken,newStartPageToken,changes(fileId,file(id,name,mimeType,modifiedTime,owners,trashed))`
- Set `includeRemoved: true`, `restrictToMyDrive: true`
- Paginate via `nextPageToken` until `newStartPageToken` is returned
- Filter out trashed files
- Return list of changed files + new page token

Add function `getStartPageToken(accessToken: string): Promise<string>`:
- Call `https://www.googleapis.com/drive/v3/changes/startPageToken`
- Return `startPageToken` from response
- This is called ONCE on first run to initialize the watermark

Add function `syncDriveChanges(account: string): Promise<{ filesReIndexed: number; newToken: string }>`:
- Read existing watermark from `kb_ingestion_state` with key `drive:changes:{account}` (separate from existing `drive:{account}` used by `files.list`)
- If no watermark exists, call `getStartPageToken()` to initialize, save it, and return (no files to process on first run)
- If watermark exists, call `fetchDriveChanges(token, watermark)`
- For each changed file: call existing `determineTier(modifiedTime)` to get tier, then re-export/re-index at that tier using existing logic (export content for tier 1-2, metadata-only for tier 3)
- Handle removed files: delete corresponding chunks from `kb_chunks` and Qdrant
- Save `newPageToken` as the updated watermark
- Use `resolveGoogleTokens` from `src/mcp/briefing/google-auth.ts` for auth (same as existing Drive adapter)

CRITICAL: Use a SEPARATE `kb_ingestion_state` row (`drive:changes:{account}`) from the existing `drive:{account}` row. The existing row stores ISO date strings as watermarks. The Changes API uses opaque page tokens. Do NOT mix them.

**2. Stale document query (DRIVE-03):**

Add exported function `findStaleDriveDocuments(db: DB, staleDays: number = 90): Promise<Array<{ name: string; sourceId: string; lastModified: Date; ageDays: number }>>`:
- Query `kb_chunks` where `source = 'drive'` AND `source_date < (now - staleDays)`
- Group by `sourceId` (file ID), return file name from metadata, last modified date, and age in days
- Sort by age descending (oldest first)
- This is a read-only query for DRIVE-03 compliance — no modifications

Use `AbortSignal.timeout(15_000)` on all fetch calls. Log file counts and errors via pino logger.
  </action>
  <verify>
    <automated>npx tsx -e "import { findStaleDriveDocuments } from './src/kb/ingestion/drive.js'; console.log(typeof findStaleDriveDocuments === 'function' ? 'PASS: findStaleDriveDocuments exported' : 'FAIL')"</automated>
    <manual>Verify drive.ts has fetchDriveChanges, getStartPageToken, syncDriveChanges, findStaleDriveDocuments functions. Check that syncDriveChanges uses separate watermark key from existing files.list watermark.</manual>
  </verify>
  <done>Drive adapter supports Changes API incremental sync with separate watermark storage, and stale document query is available for freshness tracking</done>
</task>

<task type="auto">
  <name>Task 2: Wire Drive incremental sync into nightly cron</name>
  <files>src/worker/index.ts</files>
  <action>
Modify `src/worker/index.ts` to include Drive incremental sync in the nightly cron job:

- Import `syncDriveChanges` from `src/kb/ingestion/drive.ts`
- In the existing nightly cron handler (which already runs ingestion + entity extraction), add a Drive incremental sync step AFTER the standard ingestion run
- Call `syncDriveChanges(account)` for each Google account configured in `GOOGLE_ACCOUNTS` env var
- Log the number of files re-indexed per account
- Wrap in try/catch — a Drive sync failure must NOT block entity extraction or other nightly tasks
- Add the sync AFTER existing ingestion but BEFORE entity extraction (so newly re-indexed files are available for extraction)

Do NOT remove the existing `files.list`-based ingestion. The Changes API sync is additive — it catches files modified between full ingestion runs. The full `files.list` run handles initial population and tier reassignment based on age.
  </action>
  <verify>
    <automated>grep -c "syncDriveChanges" src/worker/index.ts</automated>
    <manual>Verify the nightly cron sequence: ingestion -> Drive changes sync -> entity extraction. Verify error handling wraps the sync call.</manual>
  </verify>
  <done>Nightly cron polls Drive Changes API for each account, re-indexes changed files at the correct tier, and the sync is resilient to failures</done>
</task>

</tasks>

<verification>
1. `syncDriveChanges` uses a separate `kb_ingestion_state` key (`drive:changes:{account}`) from existing `drive:{account}`
2. First run initializes the page token without processing files
3. Subsequent runs fetch only changed files and re-index at the correct tier
4. Trashed files are handled (chunks deleted)
5. `findStaleDriveDocuments` returns files older than the specified threshold
6. Nightly cron includes Drive sync without breaking existing ingestion or extraction
</verification>

<success_criteria>
- Drive Changes API integration polls only modified files instead of all 6,650
- Changed files are re-indexed at the correct tier (full <=30d, acquaintance 31-90d, metadata >90d)
- Stale documents can be queried by age threshold
- Nightly cron runs Drive sync reliably without blocking other tasks
- No regression in existing Drive ingestion via `files.list`
</success_criteria>

<output>
After completion, create `.planning/phases/04-knowledge-base/drive-incremental-SUMMARY.md`
</output>
