# Phase 4: Data Harvest and Knowledge Base - Context

**Gathered:** 2026-03-04
**Status:** In progress — Wave 1+2 code deployed, quality verification pending

<domain>
## Phase Boundary

Ingest bounded history from all connected sources, extract entities, build a RAG-powered knowledge base with hybrid search. The user can ask any question about their work data and get accurate answers with sources. Cross-source entity mapping must work (Notion article ↔ Slack channel ↔ Gmail thread ↔ Calendar meeting ↔ ClickUp task).

</domain>

<decisions>
## Implementation Decisions

### Slack User ID Resolution
- All Slack user IDs (`<@U123>`) MUST be resolved to display names at ingestion time, BEFORE saving to chunks
- Need a Slack user lookup cache built from `users.list` API for both workspaces (AC + HG)
- Existing 25K Slack chunks must be fully re-ingested with ID resolution (not mixed ID/name data)
- This is a one-time re-ingest operation: reset Slack watermarks, re-ingest all with names

### Entity Dedup and Aliases
- Different spellings of the same entity are aliases, not duplicates (LifeQuest = Life Quest, Motor World: The Car Factory = Ohbibi MWCF)
- Entity extraction prompt should use existing entity names as context to prevent new duplicates
- After extraction, known duplicates must be merged into canonical entity + aliases
- `Motor World: The Car Factory` and `Ohbibi MWCF` are ONE project — merge required

### Incremental Quality Verification (CRITICAL)
- Every large operation must follow escalating test pattern:
  1. Small test (2-3 batches) → detailed quality review WITH USER → fix if needed
  2. Medium test (10 batches per source) → quality review WITH USER → fix
  3. Full bulk run → final quality review WITH USER
- Quality review = user asks dozens of specific questions about extracted entities, relations, and cross-source mapping
- Review checks CONTENT QUALITY, not just "it ran successfully"
- This applies to ALL sources, not just Slack
- No bulk operation without user confirmation of test results

### Extraction Test Plan
- After Slack re-ingest with ID resolution: run 10 batches per source (Slack, Notion, Gmail, Calendar, ClickUp = ~50 batches)
- Present entity/relation results for user review
- Only proceed to bulk extraction after user confirms quality

### Chunk Quality Filtering
- Claude's discretion on aggressive filtering of low-entity-density chunks
- Current filter (min text length 100, skip stubs/drive) is adequate
- Trust the implementation to balance cost vs coverage

### Claude's Discretion
- Chunk filtering thresholds and heuristics
- Extraction prompt wording and optimization
- Batch size tuning for different sources
- Technical implementation of user lookup cache

</decisions>

<specifics>
## Specific Ideas

- User wants cross-source entity mapping as primary quality indicator: "which Notion articles relate to which Slack channels, which emails arrive about it, which calendar meetings, which processes exist"
- Quality check format: user receives dozens of questions per source about entities and their relationships, confirms correctness
- The Slack ID-to-name issue was discovered during this review — 70+ person entities stored as raw Slack IDs (U09AKPXRQ81) instead of names. This must never happen again with any source

</specifics>

<deferred>
## Deferred Ideas

- Gmail API filters (gmail.settings.basic scope) — needs re-auth, not Phase 4 scope
- Daily digests — Phase 5 scope
- RAG search quality verification — can only be done after extraction is complete, may be Phase 4 close criterion or Phase 5 prerequisite

</deferred>

---

*Phase: 04-knowledge-base*
*Context gathered: 2026-03-04*
