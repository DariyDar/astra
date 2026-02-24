# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-23)

**Core value:** Eliminate PM routine so the senior PM can focus on decisions, strategy, and people
**Current focus:** Phase 2 - Bot Shell and Agent Brain

## Current Position

Phase: 2 of 8 (Bot Shell and Agent Brain)
Plan: 4 of 5 in current phase
Status: Executing Phase 2
Last activity: 2026-02-24 — Plan 02-04 complete (Slack DM adapter)

Progress: [█████░░░░░] 27%

## Performance Metrics

**Velocity:**
- Total plans completed: 6
- Average duration: 6.5 min
- Total execution time: 0.6 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 | 2 | 16 min | 8 min |
| 2 | 4 | 21 min | 5.3 min |

**Recent Trend:**
- Last 5 plans: 01-02 (10 min), 02-01 (4 min), 02-02 (7 min), 02-03 (4 min), 02-04 (6 min)
- Trend: stable, consistent ~5 min/plan in Phase 2

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Roadmap: 8-phase layered construction following strict dependency order from research
- Roadmap: Draft-first architectural constraint baked into Phase 2, full UX in Phase 6
- Roadmap: Phase 3 groups all table-stakes integrations (ClickUp + Gmail + Calendar) for coherent daily-value delivery
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

### Pending Todos

None yet.

### Blockers/Concerns

None yet.

## Session Continuity

Last session: 2026-02-24
Stopped at: Completed 02-04-PLAN.md (Slack DM adapter)
Resume file: .planning/phases/02-bot-shell-and-agent-brain/02-04-SUMMARY.md
