# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-23)

**Core value:** Eliminate PM routine so the senior PM can focus on decisions, strategy, and people
**Current focus:** Phase 4 - Knowledge Base (Milestone 1: Information Assistant)

## Current Position

Milestone: 1 of 3 (Information Assistant)
Phase: 4 of 12 (Knowledge Base — in progress, 7/8 plans complete)
Status: Extraction done, entity cleanup done, wiki ingested, digest V2 deployed. Remaining: knowledge-map report

Progress (M1): [██████░░░░] 58% (3.9/6 phases complete)
Progress (overall): [███░░░░░░░] 27% (3.9/12 phases complete)

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

### Completed Work (7/8 plans)
- Gmail cleanup: 113K → 37K chunks (system/human classification)
- Drive smart-index: 6,650 → 21,425 chunks (3-tier indexing)
- Entity extraction: Gemini 2.5 Flash, ~4,500 chunks (slack + clickup), ~5,976 facts, ~2,328 entities
- Drive incremental: Changes API sync + stale document query
- Slack user cache: ID→name resolution + reset-slack-entities CLI
- Bulk extraction: all slack + clickup chunks processed
- Entity cleanup: 135 merges, 1,435 deletions via merge-entities.ts (user-reviewed)
- ClickUp Wiki ingestion: 4 wiki docs, 89 sections, 5,081 chunks
- Daily digest V2: Gemini-compiled, per-company separation, deployed
- Name resolution: KB entity aliases → display_name for digest
- Final counts: person 98, project 255, process 1,192, channel 194, company 157, client 53
- 121K+ total chunks across 7 sources (slack, gmail, calendar, clickup, drive, notion, wiki)

### Remaining Work
1. **Knowledge Map report** — structured per-project KB dump for user quality review (mandatory Phase 4 deliverable)

### Context
Context file: .planning/phases/04-knowledge-base/04-CONTEXT.md
Plans: gmail-cleanup, drive-smart-index, entity-extraction, drive-incremental, slack-user-cache, bulk-extraction, entity-review, knowledge-map

### Key Decisions
- 3-tier Drive indexing: <=30d full content export, 31-90d acquaintance, >90d metadata-only
- Skip binary files (PDF, images, Office docs) in Drive export — only Google Workspace native types
- Entity extraction: Gemini 2.5 Flash (FREE tier), batch size 20, 300s timeout
- Sources for LLM extraction: slack + clickup only; gmail/calendar/notion/drive indexed in Qdrant only
- thinkingBudget: 0 for all Gemini calls (thinking tokens consume output budget)
- Entity merging: NEVER auto-merge, always show user for approval
- SpongeBob split: KCO F2P [1199] + Netflix/Get Cookin' [1646]
- Ohbibi split: Motor World: Car Factory [18] + OhBibi Creatives [3649]
- 3 Gemini API keys with round-robin rotation

Last activity: 2026-03-10
