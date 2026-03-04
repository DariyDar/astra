---
phase: 04-knowledge-base
plan: drive-incremental
subsystem: database
tags: [google-drive, changes-api, incremental-sync, stale-documents]

# Dependency graph
requires:
  - phase: 04-knowledge-base
    plan: drive-smart-index
    provides: 3-tier indexing with determineTier, isExportable functions
provides:
  - Drive Changes API incremental sync via fetchDriveChanges/syncDriveChanges
  - Stale document query via findStaleDriveDocuments (DRIVE-03)
  - Nightly cron Drive sync (after ingestion, before entity extraction)
  - Separate watermark storage (drive:changes:{account}) from files.list watermark
affects: [bulk-extraction, knowledge-map]

# Tech tracking
tech-stack:
  added: []
  patterns: [changes-api-polling, separate-watermark-keys, non-blocking-sync]

key-files:
  created:
    - tests/kb/drive-changes.test.ts
  modified:
    - src/kb/ingestion/drive.ts
    - src/worker/index.ts

key-decisions:
  - decision: Use separate kb_ingestion_state key for Changes API watermark
    why: Changes API uses opaque page tokens vs ISO date strings for files.list. Mixing them would break either system.
  - decision: Drive sync is non-blocking in nightly cron
    why: A Drive sync failure must not prevent entity extraction or other tasks from running.

# Outcome
status: complete
summary: >
  Added Google Drive Changes API incremental sync to detect modified files
  without re-fetching all 6,650 files. Uses separate watermark from existing
  files.list ingestion. First run initializes the page token; subsequent runs
  fetch only changed files and handle removals (PG + Qdrant deletion).
  Stale document query (findStaleDriveDocuments) enables freshness tracking.
  Nightly cron polls Changes API after standard ingestion, before entity
  extraction. 3 new tests pass.

self-check:
  result: PASSED
  typescript-errors: 0
  test-results: "3/3 pass"
  files-verified:
    - src/kb/ingestion/drive.ts (syncDriveChanges, fetchDriveChanges, getStartPageToken, findStaleDriveDocuments exported)
    - src/worker/index.ts (syncDriveChanges wired after ingestion, before extraction)
    - tests/kb/drive-changes.test.ts (findStaleDriveDocuments export check, tier classification)
---
