---
phase: 02-bot-shell-and-agent-brain
plan: 01
subsystem: database, types
tags: [drizzle, postgresql, typescript, language-detection, channel-abstraction]

# Dependency graph
requires:
  - phase: 01-infrastructure-and-security-foundation
    provides: "DB schema with credentials and audit_trail tables, env config with Zod validation"
provides:
  - "messages, notificationPreferences, userFeedback DB tables"
  - "InboundMessage, OutboundMessage, ChannelAdapter, MessageHandler unified types"
  - "detectLanguage() utility for Russian/English detection"
  - "Env config with optional Slack tokens and Qdrant URL"
affects: [02-02, 02-03, 02-04, 02-05, phase-03, phase-07]

# Tech tracking
tech-stack:
  added: []
  patterns: [cyrillic-ratio-language-detection, channel-adapter-interface, unified-message-types]

key-files:
  created:
    - src/channels/types.ts
    - src/brain/language.ts
  modified:
    - src/db/schema.ts
    - src/config/env.ts

key-decisions:
  - "Cyrillic character ratio heuristic for language detection (no external lib needed for ru/en)"
  - "uniqueIndex on (userId, category) for notification preferences uniqueness constraint"
  - "bigserial with mode bigint for messages and userFeedback IDs (high-volume tables)"
  - "All Slack env vars optional so bot works without Slack configured"

patterns-established:
  - "Channel adapter pattern: ChannelAdapter interface for multi-platform abstraction"
  - "Language detection: Cyrillic vs Latin character count ratio"

requirements-completed: [MSG-01, MSG-02, MSG-03, MSG-05]

# Metrics
duration: 4min
completed: 2026-02-24
---

# Phase 2 Plan 01: Foundation Types and Schema Summary

**Drizzle schema extended with messages/notifications/feedback tables, unified channel types for Telegram+Slack, and Cyrillic-based language detection**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-24T09:06:56Z
- **Completed:** 2026-02-24T09:10:52Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Extended PostgreSQL schema with 3 new tables (messages, notificationPreferences, userFeedback) with proper indexes and constraints
- Created unified channel types (InboundMessage, OutboundMessage, ChannelAdapter) abstracting Telegram and Slack
- Implemented Cyrillic-based language detection for Russian/English without external dependencies
- Added optional Slack and Qdrant environment variables to env config

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend database schema with messages, notification preferences, and user feedback tables** - `3b29838` (feat)
2. **Task 2: Create unified channel types and language detection** - `a8c9ab7` (feat)

## Files Created/Modified
- `src/db/schema.ts` - Extended with messages, notificationPreferences, userFeedback tables (3 new tables, 10 indexes)
- `src/config/env.ts` - Added SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_ADMIN_USER_ID (optional), QDRANT_URL (with default)
- `src/channels/types.ts` - InboundMessage, OutboundMessage, ChannelAdapter, MessageHandler interfaces
- `src/brain/language.ts` - detectLanguage() function with Language type export

## Decisions Made
- Used Cyrillic character ratio heuristic for language detection -- simple, zero-dependency approach sufficient for Russian/English only
- Used uniqueIndex (not just unique constraint) for notification_preferences (userId, category) to match Drizzle API
- Used bigserial with mode: 'bigint' for messages and userFeedback tables anticipating high volume
- All Slack env vars marked optional so the bot continues to work without Slack configured

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- `drizzle-kit push` could not run because Docker/PostgreSQL is not available in the execution environment. Static type checking and runtime import verification passed. DB push deferred to deployment.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Schema tables ready for all subsequent Phase 2 plans (message pipeline, brain agent, Slack adapter, notification system)
- Channel types ready for Telegram adapter (02-02) and Slack adapter (02-04) to implement ChannelAdapter interface
- Language detection ready for brain agent (02-03) to use for response language selection
- userFeedback table is a forward-looking foundation for Phase 7 self-learning

## Self-Check: PASSED

- All 4 files (2 created, 2 modified) verified to exist on disk
- Both task commits verified: `3b29838`, `a8c9ab7`
- TypeScript compilation: zero errors
- Runtime import verification: all exports accessible
- Language detection runtime test: ru/en/mixed all correct

---
*Phase: 02-bot-shell-and-agent-brain*
*Completed: 2026-02-24*
