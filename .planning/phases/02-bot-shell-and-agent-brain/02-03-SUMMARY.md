---
phase: 02-bot-shell-and-agent-brain
plan: 03
subsystem: brain, channels
tags: [telegram-adapter, context-builder, system-prompt, message-router, claude-brain]

# Dependency graph
requires:
  - phase: 02-bot-shell-and-agent-brain
    plan: 01
    provides: "ChannelAdapter interface, InboundMessage/OutboundMessage types, detectLanguage(), messages DB table"
  - phase: 02-bot-shell-and-agent-brain
    plan: 02
    provides: "ShortTermMemory, MediumTermMemory, LongTermMemory, embedder pipeline"
provides:
  - "TelegramAdapter: grammY Bot wrapped in ChannelAdapter with admin guard"
  - "buildContext: three-tier memory assembly into structured context string"
  - "buildSystemPrompt: Astra persona with language-aware instructions"
  - "MessageRouter: central message processing engine connecting adapters to Claude"
  - "Refactored bot entry point with adapter pattern and memory initialization"
affects: [02-04, 02-05, phase-03, phase-06, phase-07]

# Tech tracking
tech-stack:
  added: []
  patterns: [adapter-pattern, context-assembly-pipeline, graceful-degradation, fire-and-forget-embedding]

key-files:
  created:
    - src/channels/telegram/adapter.ts
    - src/brain/context-builder.ts
    - src/brain/system-prompt.ts
    - src/brain/router.ts
  modified:
    - src/bot/index.ts

key-decisions:
  - "HTML parse mode for Telegram responses (supports structured formatting)"
  - "Context token budget ~3000 tokens (~12000 chars) with priority: short-term > medium-term > long-term"
  - "Fire-and-forget long-term storage (embed + Qdrant upsert) to avoid blocking response"
  - "Graceful degradation: each memory tier failure is caught and logged, never blocks the pipeline"
  - "Language-aware error messages sent to user on processing failures"

patterns-established:
  - "MessageRouter pattern: adapter.onMessage -> process -> adapter.send"
  - "Context assembly pipeline: short-term + medium-term + long-term with budget truncation"
  - "Startup sequence: Redis -> embedder -> Qdrant -> health checker -> router"

requirements-completed: [MSG-01, MSG-03, MSG-04]

# Metrics
duration: 4min
completed: 2026-02-24
---

# Phase 2 Plan 03: Conversation Brain and Telegram Adapter Summary

**TelegramAdapter wrapping grammY in ChannelAdapter pattern, three-tier context assembly pipeline, and MessageRouter connecting Claude with language-aware system prompt**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-24T09:52:31Z
- **Completed:** 2026-02-24T09:56:10Z
- **Tasks:** 2
- **Files created:** 4
- **Files modified:** 1

## Accomplishments
- Created TelegramAdapter implementing ChannelAdapter interface with admin-only guard and HTML parse mode
- Built context assembly pipeline from three-tier memory (Redis short-term, PostgreSQL medium-term, Qdrant long-term) with ~3000 token budget and graceful degradation
- Defined Astra persona system prompt with language awareness (Russian/English auto-detection)
- Created MessageRouter as the central message processing engine: language detection -> context assembly -> Claude invocation -> memory storage -> response delivery
- Refactored bot entry point to use adapter pattern with proper startup sequence (Redis, embedder, Qdrant, health checker, router)
- Preserved existing /start, /health commands and correlation ID middleware
- Added language-aware error messages (Russian/English) when processing fails

## Task Commits

Each task was committed atomically:

1. **Task 1: Create Telegram adapter, context builder, and system prompt** - `7d45b70` (feat)
2. **Task 2: Create message router and refactor bot entry point** - `5b5108d` (feat)

## Files Created/Modified
- `src/channels/telegram/adapter.ts` - TelegramAdapter: grammY Bot wrapped in ChannelAdapter with admin guard, HTML parse mode
- `src/brain/context-builder.ts` - buildContext: assembles Redis + PostgreSQL + Qdrant context with token budget and graceful degradation
- `src/brain/system-prompt.ts` - buildSystemPrompt: Astra persona with language-aware instructions (~1000 chars)
- `src/brain/router.ts` - MessageRouter: central engine connecting adapters to Claude through memory pipeline
- `src/bot/index.ts` - Refactored to use adapter pattern with full startup/shutdown sequence

## Decisions Made
- Used HTML parse mode for Telegram (supports lists, headers, bold/italic for structured responses)
- Set context token budget at ~3000 tokens (~12000 chars) with priority: short-term > medium-term > long-term
- Fire-and-forget pattern for long-term memory storage (embed + Qdrant upsert doesn't block response)
- Each memory tier failure is caught independently -- context assembly never fails, just degrades
- Language-aware error messages: Russian for Cyrillic input, English otherwise

## Deviations from Plan

None -- plan executed exactly as written.

## Issues Encountered
- None. TypeScript compilation and runtime verification passed on first attempt.

## Next Phase Readiness
- Telegram adapter ready for Slack adapter (02-04) to follow same ChannelAdapter pattern
- MessageRouter accepts multiple adapters array, ready for Slack addition
- Context builder and system prompt reusable across all channels
- Memory storage pipeline handles both user and assistant messages across all three tiers

## Self-Check: PASSED

- All 5 files (4 created, 1 modified) verified to exist on disk
- Both task commits verified: `7d45b70`, `5b5108d`
- TypeScript compilation: zero errors
- Runtime verification: buildSystemPrompt produces language-specific prompts (ru/en)

---
*Phase: 02-bot-shell-and-agent-brain*
*Completed: 2026-02-24*
