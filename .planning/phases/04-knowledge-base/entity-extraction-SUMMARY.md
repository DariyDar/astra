---
phase: 04-knowledge-base
plan: entity-extraction
subsystem: knowledge-base
tags: [entity-extraction, qdrant, drizzle, claude-cli, batch-processing, budget-control]

# Dependency graph
requires:
  - phase: 03-core-integrations
    provides: "MCP infrastructure, Claude CLI client, source adapters"
  - phase: 04-knowledge-base/gmail-cleanup
    provides: "Cleaned Gmail chunks (37K from 113K), system email stubs"
  - phase: 04-knowledge-base/drive-smart-index
    provides: "3-tier Drive indexing (full/acquaintance/metadata)"
provides:
  - "Multi-batch entity extraction with time/cost/batch budget controls"
  - "Smart chunk selection with source priority and quality filters"
  - "Low-value chunk marking (stubs, metadata-only, short text, drive) without LLM calls"
  - "Qdrant entity_ids payload sync for entity-filtered vector search"
  - "CLI script for bulk initial extraction with dry-run and budget flags"
  - "Nightly worker using budget-controlled multi-batch extraction"
affects: [bulk-extraction, entity-review, knowledge-map, daily-digests]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Budget-controlled batch loop (time/cost/batches) for LLM processing"
    - "Source-prioritized chunk selection (slack > clickup > notion > gmail > calendar)"
    - "Entity context injection into extraction prompt for dedup"
    - "Shared extractableChunkConditions helper for DRY filtering"

key-files:
  created:
    - src/kb/extract-entities-manual.ts
    - tests/entity-extractor.test.ts
  modified:
    - src/kb/entity-extractor.ts
    - src/kb/repository.ts
    - src/worker/index.ts
    - src/llm/client.ts

key-decisions:
  - "300s timeout for entity extraction (Claude CLI needs more time for large batches)"
  - "Batch size 20 recommended for production (50 times out even at 300s)"
  - "Entity context capped at 3000 chars and refreshed every 10 batches"
  - "Low-value chunk marking uses empty array (not null) to distinguish processed-no-entities from unprocessed"
  - "Qdrant failures during entity_ids sync log warnings but do not fail the batch"

patterns-established:
  - "Budget loop pattern: check time > cost > batches before each iteration"
  - "CLI script pattern: --dry-run for estimation, --skip-mark for incremental runs"
  - "Source priority ordering via SQL CASE statement in Drizzle"

requirements-completed: []

# Metrics
duration: 0min
completed: 2026-03-04
---

# Phase 4: Entity Extraction Summary

**Multi-batch budget-controlled entity extraction with smart chunk selection, Qdrant entity_ids sync, CLI for bulk runs, and nightly worker integration**

## Performance

- **Duration:** Previously executed (commits 6e4d1ca + 567dac7)
- **Started:** Prior session
- **Completed:** 2026-03-04 (summary formalized)
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Enhanced entity extraction from single-batch to multi-batch budget-controlled loop (time/cost/batches)
- Smart chunk selection: source-prioritized (slack > clickup > notion > gmail > calendar), quality-filtered (skip stubs, short text, drive metadata)
- Low-value chunk bulk marking: 107K+ chunks marked as processed without LLM calls, reducing extractable set to ~8K
- Qdrant entity_ids payload sync enabling entity-filtered vector search
- CLI script with --dry-run, --skip-mark, --max-cost, --max-batches for controlled bulk extraction
- Nightly worker upgraded from single-batch to budget-controlled multi-batch (100 batches / 2hr / $5)
- Entity context injection: existing entity names included in prompt for better dedup
- 17 unit tests covering parseExtraction, budget logic, entity context formatting

## Task Commits

Each task was committed atomically:

1. **Task 1: Enhance repository queries and entity extractor with multi-batch budget loop** - `6e4d1ca` (feat)
2. **Task 2: Create CLI script and update nightly worker** - `567dac7` (fix: timeout increase, included CLI and worker updates)

**Plan metadata:** (this commit)

## Files Created/Modified
- `src/kb/entity-extractor.ts` (378 lines) - Multi-batch extraction with budget controls, entity context, Qdrant sync
- `src/kb/repository.ts` (450 lines) - Source-prioritized chunk queries, count, entity names, bulk mark processed
- `src/kb/extract-entities-manual.ts` (108 lines) - CLI for bulk extraction with dry-run and budget flags
- `src/worker/index.ts` (119 lines) - Nightly cron using budget-controlled multi-batch extraction
- `src/llm/client.ts` (197 lines) - Added timeoutMs option to callClaude
- `tests/entity-extractor.test.ts` (198 lines) - 17 tests for parsing, budget logic, entity context

## Decisions Made
- **300s timeout for extraction:** Claude CLI needs more time for large batches with entity context
- **Batch size 20 in production:** Batch size 50 times out even at 300s; 20 is reliable
- **Entity context cap at 3000 chars:** Prevents prompt bloat while providing dedup guidance
- **Entity context refresh every 10 batches:** Balance between freshness and query cost
- **Empty array vs null for entity_ids:** `[]` means processed-no-entities, `null` means unprocessed
- **Qdrant failures are non-fatal:** Log warning, continue extraction -- data consistency can be repaired later

## Deviations from Plan

None - plan executed exactly as written. Code was implemented in prior sessions (commits 6e4d1ca + 567dac7) and this execution formalizes the summary documentation.

## Issues Encountered
- First extraction run with batch size 50 timed out at 180s default timeout
- Fixed by adding timeoutMs option to callClaude and setting 300s for extraction
- Batch size reduced from 50 to 20 for reliability (documented in MEMORY.md)

## User Setup Required

None - no external service configuration required. Entity extraction uses existing Claude CLI, PostgreSQL, and Qdrant infrastructure.

## Next Phase Readiness
- Entity extraction infrastructure is ready for bulk runs
- Next step: Run bulk extraction on server (`--skip-mark --batch-size 20 --max-cost 15`)
- Remaining ~8K extractable chunks need processing (~417 batches at batch size 20)
- After bulk extraction: entity review and dedup pass needed (entity-review-PLAN.md)
- Slack user ID resolution needed before extraction quality is optimal (slack-user-cache-PLAN.md)

## Self-Check: PASSED

All 6 files verified present on disk. Both commits (6e4d1ca, 567dac7) verified in git history. TypeScript compiles with 0 errors. 17/17 tests pass.

---
*Phase: 04-knowledge-base*
*Completed: 2026-03-04*
