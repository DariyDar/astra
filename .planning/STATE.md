# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-23)

**Core value:** Eliminate PM routine so the senior PM can focus on decisions, strategy, and people
**Current focus:** Phase 4 - Knowledge Base (Milestone 1: Information Assistant)

## Current Position

Milestone: 1 of 3 (Information Assistant)
Phase: 4 of 12 (Knowledge Base — in progress, context gathered)
Status: Phase 4 Waves 1-3 complete (gmail-cleanup, drive-smart-index, entity-extraction, drive-incremental, slack-user-cache), Wave 4+ in progress

Progress (M1): [██████░░░░] 50% (3/6 phases complete)
Progress (overall): [███░░░░░░░] 25% (3/12 phases complete)

## Completed Phases

| Phase | Name | Completed |
|-------|------|-----------|
| 1 | Bot Shell & Agent Brain | 2026-02-18 |
| 2 | Memory & Context | 2026-02-19 |
| 3 | Core Integrations | 2026-03-02 |

## Phase 3 Accomplishments (beyond original scope)

- Slack multi-workspace (AC + HG)
- Google multi-account OAuth (AC + HG emails)
- ClickUp integration + deadline monitor
- Briefing MCP server (aggregated multi-source queries)
- Skill Engine with auto-discovery
- Notion MCP integration
- Clockify time tracking integration
- Prompt optimization (A/B/C/D/E testing → Variant E winner)

## Phase 4 — Knowledge Base (In Progress)

### Completed Work
- Gmail cleanup: 113K → 37K chunks (system/human classification)
- Drive smart-index: 3-tier indexing (full/acquaintance/metadata)
- Entity extraction code: multi-batch budget loop, CLI, nightly cron
- Drive incremental: Changes API sync + stale document query (DRIVE-03/04)
- Slack user cache: ID→name resolution + reset-slack-entities CLI
- 199 entities, 398 relations (62 seed + extracted from 1 Slack batch)
- 116K total chunks across 6 sources

### Identified Issues (from 2026-03-04 context review)
- 70+ person entities stored as Slack IDs instead of names — need re-ingest
- Cross-source mapping only covers Slack (218 chunks) — need extraction from all sources
- Entity duplicates: LifeQuest/Life Quest, Motor World/Ohbibi MWCF — need merge

### Next Steps
1. Build Slack user ID→name lookup cache
2. Re-ingest all Slack chunks with ID resolution (25K chunks)
3. Test extraction: 2-3 batches → quality review with user
4. If OK: 10 batches per source → quality review
5. If OK: bulk extraction → final review
6. Entity dedup/merge pass

### Context
Context file: .planning/phases/04-knowledge-base/04-CONTEXT.md
Plans: gmail-cleanup, drive-smart-index, entity-extraction, drive-incremental, slack-user-cache, bulk-extraction, entity-review, knowledge-map
Summaries: gmail-cleanup, drive-smart-index, entity-extraction, drive-incremental, slack-user-cache

### Key Decisions
- 3-tier Drive indexing: <=30d full content export, 31-90d acquaintance, >90d metadata-only
- Skip binary files (PDF, images, Office docs) in Drive export -- only Google Workspace native types
- Content caps: 50K chars (tier 1), 3K chars (tier 2) to prevent chunk explosion
- Qdrant cleanup added to reset-drive.ts with graceful fallback
- Entity extraction: 300s timeout, batch size 20, entity context capped at 3000 chars
- Low-value chunks marked with empty array (not null) to distinguish from unprocessed
- Qdrant entity_ids sync failures are non-fatal (log warning, continue)
- Drive Changes API uses separate watermark key (drive:changes:{account}) from files.list (drive:{account})
- Drive sync is non-blocking in nightly cron — failure doesn't prevent entity extraction
- Slack user cache built once per ingestion run (not per message) — covers both workspaces + deactivated users
- Reset script does NOT auto-trigger re-ingestion — user runs manually or waits for nightly cron

Last activity: 2026-03-04
