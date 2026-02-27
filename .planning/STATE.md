# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-23)

**Core value:** Eliminate PM routine so the senior PM can focus on decisions, strategy, and people
**Current focus:** Phase 3 - Core Integrations (Milestone 1: Information Assistant)

## Current Position

Milestone: 1 of 3 (Information Assistant)
Phase: 3 of 12 (Core Integrations)
Plan: 1 of 3 complete in current phase
Status: In progress
Last activity: 2026-02-26 — Roadmap restructured into 3 milestones, 12 phases

Progress (M1): [████░░░░░░] 33% (2/6 phases complete)
Progress (overall): [██░░░░░░░░] 17% (2/12 phases complete)

## Performance Metrics

**Velocity:**
- Total plans completed: 9
- Average duration: 5.6 min
- Total execution time: 0.8 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 | 2 | 16 min | 8 min |
| 2 | 5 | 27 min | 5.4 min |
| 3 | 1 | 3 min | 3 min |

**Recent Trend:**
- Last 5 plans: 02-03 (4 min), 02-04 (6 min), 02-05 (6 min), 03-01 (3 min), 03-02 (2 min)
- Trend: improving, Phase 3 plans completing quickly

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Roadmap restructured: 3 milestones (Information → Advisor → Actor), 12 phases total
- M1 scope: read-only information access + knowledge base + reports + proactive monitoring
- M2 scope: recommendations + ghost-writing (read-only) + team oversight
- M3 scope: write actions + self-learning + self-extension
- MCP optimization is part of Phase 3 (not separate phase): precise MCP filters, no redundant data to LLM
- No cron-based LLM calls ever — proactive features are trigger-based (Phase 6)
- Direct REST API monitors (like ClickUp deadline check) are OK on cron
- Roadmap: Draft-first architectural constraint baked into Phase 2, full UX in Phase 10
- 01-01: ESM-only project (type: module) with NodeNext resolution
- 01-01: Zod 4.x for env validation (backwards compatible with 3.x API)
- 01-01: No host port exposure for infrastructure services (Docker-internal only)
- 01-01: pg Pool for connection pooling in database layer
- 01-02: Node.js built-in crypto for AES-256-GCM (no third-party encryption lib)
- 01-02: Removed @types/node-cron (v4 ships own types, conflicts with v3 DefinitelyTyped)
- 01-02: ioredis named import { Redis } for ESM/NodeNext compatibility
- 01-02: Qdrant health check via getCollections() (typed, avoids api() type issues)
- 01-02: Pino logger bindings used to extract correlationId for audit trail
- 02-01: Cyrillic character ratio heuristic for language detection (no external lib for ru/en)
- 02-01: uniqueIndex on (userId, category) for notification preferences
- 02-01: bigserial with mode bigint for high-volume tables (messages, userFeedback)
- 02-01: All Slack env vars optional so bot works without Slack configured
- 02-02: Local ONNX embeddings via @huggingface/transformers (no API keys needed)
- 02-02: 384-dim multilingual vectors for Russian+English support
- 02-02: Redis LPUSH/LRANGE with 24h TTL and 100-message cap for short-term
- 02-02: Qdrant cosine similarity search for long-term semantic recall
- 02-03: HTML parse mode for Telegram responses (structured formatting)
- 02-03: Context token budget ~3000 tokens with priority short-term > medium-term > long-term
- 02-03: Fire-and-forget long-term storage (embed + Qdrant) to avoid blocking response
- 02-03: Graceful degradation for each memory tier failure
- 02-03: Language-aware error messages sent to user on processing failures
- 02-04: GenericMessageEvent from @slack/types (not @slack/bolt) for correct TypeScript types
- 02-04: Socket Mode for Slack (no public URL required, WebSocket-based)
- 02-04: Conditional adapter registration — Telegram-only mode when Slack tokens missing
- 02-05: In-memory queues for digest and on-demand notification items (Map<userId, items[]>)
- 02-05: preference_update XML tags in Claude responses for structured NL preference changes
- 02-05: Digest cron runs in bot process (not worker) since it needs adapter access
- 02-05: HTML parse mode for /settings with urgency and channel icons
- 02-05: Fallback to Telegram when configured Slack adapter unavailable
- 03-01: MCP config generated dynamically at startup (not static JSON) to inject actual env var values
- 03-01: All integration env vars optional (z.string().optional()) so bot starts without them
- 03-01: System prompt includes static tool names regardless of MCP server availability
- 03-02: Direct REST API calls only (no LLM) for ClickUp deadline monitoring
- 03-02: Session-based deduplication via Set<string> resets on bot restart (acceptable for 30-min interval)
- 03-02: Monitor is opt-in: only starts when both CLICKUP_API_KEY and CLICKUP_TEAM_ID are configured

### Pending Todos

None yet.

### Blockers/Concerns

None yet.

## Session Continuity

Last session: 2026-02-26
Stopped at: Roadmap restructured into 3 milestones. Phase 3 in progress (03-01 complete, 03-02 and 03-03 pending).
Resume file: .planning/phases/03-core-integrations/03-CONTEXT.md
