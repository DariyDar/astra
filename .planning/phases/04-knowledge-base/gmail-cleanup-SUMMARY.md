---
phase: 04-knowledge-base
plan: gmail-cleanup
subsystem: knowledge-base
tags: [gmail, cleanup, classification, ingestion]
dependency-graph:
  requires: [kb-ingestion, gmail-adapter]
  provides: [gmail-classifier, gmail-cleanup-cli, inline-classification]
  affects: [kb-chunks, qdrant-vectors]
tech-stack:
  added: []
  patterns: [system-sender-classification, metadata-only-stubs, batch-processing]
key-files:
  created:
    - src/kb/gmail-classifier.ts
    - src/kb/gmail-cleanup.ts
    - tests/gmail-classifier.test.ts
  modified:
    - src/kb/ingestion/gmail.ts
decisions:
  - "12 system sender patterns covering TestFlight, App Store, Clockify, Google, Atlassian, Slack digests, ClickUp, PagerDuty"
  - "3 keep-sender overrides for Indium QA (Nisha, Jijo) and Tilting Point (Andrianne)"
  - "Cleanup uses pool.query for raw SQL discovery query, Drizzle ORM for batch operations"
  - "Qdrant deletion first, then PG chunks (safety order: orphan vectors harmless, orphan PG rows pointing to deleted vectors would cause search errors)"
metrics:
  duration: ~4m
  completed: 2026-03-03T15:13:45Z
  tasks: 2/2
  files-created: 3
  files-modified: 1
---

# Phase 04 Gmail Cleanup Summary

Gmail email classification and cleanup for KB data reduction from ~113K to ~37K chunks.

## One-liner

System/human email classifier with batch cleanup CLI and inline ingestion classification.

## What Was Built

### 1. Gmail Classifier (`src/kb/gmail-classifier.ts`)

Pure utility module exporting:
- `SYSTEM_PATTERNS` (12 patterns): noreply@, no-reply@, testflight@apple.com, appstoreconnect@apple.com, clockify, noreply@google, atlassian, clickup, pagerduty, comments-noreply@docs.google.com, spaces-noreply@google.com, feedback@mail.slack.com
- `KEEP_SENDERS` (3 overrides): nisha, jijo, andrianne
- `classifyEmail(from, subject?)`: Returns 'system' | 'human' with priority: keep-senders first, then system patterns, then Slack weekly digest special case, then default human

### 2. Gmail Cleanup CLI (`src/kb/gmail-cleanup.ts`)

One-time batch cleanup script with `--dry-run` mode:

1. Discover all unique emails via chunk_index=0 query
2. Classify each email using classifyEmail()
3. Determine top-200 per account (by sourceDate DESC) to keep deep-indexed
4. Print summary (always, even in dry-run)
5. Delete Qdrant vectors for downgraded emails (safety: Qdrant first)
6. Delete PG chunks with chunk_index > 0 for downgraded emails
7. Update chunk_index=0 stubs with metadata-only text
8. Tag deep-indexed emails with emailType in metadata
9. Print final results

Error handling: Qdrant failures logged as warnings (continue), PG failures abort (data consistency).

### 3. Inline Classification (`src/kb/ingestion/gmail.ts`)

Modified `toChunks()` to classify emails during ingestion:
- System emails produce 1 chunk with `[system email -- metadata only]` body
- Human emails produce full split chunks as before
- All chunks include `emailType` in metadata

## Verification Results

- TypeScript compilation: 0 errors in src/ (full `npx tsc --noEmit`)
- Classifier tests: 11/11 passing (system patterns, keep-senders, defaults, Slack weekly)
- Cleanup script: ready for `--dry-run` on server (requires DATABASE_URL)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed db.execute type constraint error**
- **Found during:** Task 1
- **Issue:** Drizzle `db.execute<EmailRow>()` generic constraint requires `Record<string, unknown>`, incompatible with typed interface
- **Fix:** Used `pool.query<EmailRow>()` (pg Pool) for raw SQL discovery query, matching existing pattern in `check-ingestion.ts`
- **Files modified:** src/kb/gmail-cleanup.ts
- **Commit:** 0471323

**2. [Rule 3 - Blocking] Fixed Map.entries() iteration without downlevelIteration**
- **Found during:** Task 1
- **Issue:** `for...of` on `Map.entries()` requires `--downlevelIteration` or ES2015+ target iteration
- **Fix:** Wrapped with `Array.from(byAccount.entries())` for compatibility with project tsconfig (target ES2022 but without downlevelIteration)
- **Files modified:** src/kb/gmail-cleanup.ts
- **Commit:** 0471323

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 0471323 | feat(04-gmail-cleanup): add gmail classifier and cleanup CLI script |
| 2 | 4acbfc5 | feat(04-gmail-cleanup): classify emails inline in gmail toChunks() |

## Next Steps

1. Run `npx tsx src/kb/gmail-cleanup.ts --dry-run` on the server to verify counts
2. Run `npx tsx src/kb/gmail-cleanup.ts` on the server for actual cleanup
3. Verify with `npx tsx src/kb/check-ingestion.ts` that gmail chunks dropped from ~113K to ~37K

## Self-Check: PASSED

- FOUND: src/kb/gmail-classifier.ts
- FOUND: src/kb/gmail-cleanup.ts
- FOUND: tests/gmail-classifier.test.ts
- FOUND: src/kb/ingestion/gmail.ts (modified)
- FOUND: commit 0471323
- FOUND: commit 4acbfc5
