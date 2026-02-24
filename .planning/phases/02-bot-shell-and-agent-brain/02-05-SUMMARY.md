---
phase: 02-bot-shell-and-agent-brain
plan: 05
subsystem: notifications
tags: [notification-preferences, urgency-classification, dispatcher, digest, cron, natural-language-config]

# Dependency graph
requires:
  - phase: 02-01
    provides: "notificationPreferences DB table with unique (userId, category) constraint"
  - phase: 02-03
    provides: "MessageRouter, buildSystemPrompt, ChannelAdapter interface, bot entry point"
  - phase: 02-04
    provides: "SlackAdapter, multi-channel adapter array, conditional Slack registration"
provides:
  - "NotificationPreferences: CRUD with upsert and default preferences for 5 categories"
  - "UrgencyLevel type and classifyUrgency function (urgent/important/normal)"
  - "NotificationDispatcher: routes by urgency to immediate send, digest queue, or on-demand queue"
  - "DigestScheduler: compiles and delivers morning digest at 8 AM via cron"
  - "/settings command showing current preferences with urgency/channel icons"
  - "Natural language preference configuration via preference_update tags in system prompt"
  - "MessageRouter preference_update tag scanning and DB execution"
affects: [phase-03, phase-06, phase-07]

# Tech tracking
tech-stack:
  added: []
  patterns: [preference-update-tags, urgency-based-routing, cron-digest-scheduling, in-memory-notification-queues]

key-files:
  created:
    - src/notifications/preferences.ts
    - src/notifications/urgency.ts
    - src/notifications/dispatcher.ts
    - src/notifications/digest.ts
  modified:
    - src/brain/system-prompt.ts
    - src/brain/router.ts
    - src/worker/index.ts
    - src/bot/index.ts

key-decisions:
  - "In-memory queues for digest and on-demand notification items (Map<userId, items[]>)"
  - "preference_update XML tags in Claude responses for structured NL preference changes"
  - "Digest cron runs in bot process (not worker) since it needs adapter access"
  - "HTML parse mode for /settings response with urgency and channel icons"
  - "Fallback to Telegram when configured delivery channel adapter unavailable"

patterns-established:
  - "Structured tag pattern: Claude outputs <preference_update> JSON, router parses and executes"
  - "Urgency-based routing: urgent=immediate, important=digest, normal=on-demand"
  - "adapterMap (Map<string, ChannelAdapter>) for name-based adapter lookup alongside adapters array"

requirements-completed: [MSG-05]

# Metrics
duration: 6min
completed: 2026-02-24
---

# Phase 2 Plan 05: Notification System Summary

**Notification preferences CRUD with 3 urgency levels, multi-channel dispatcher, 8 AM digest scheduler, /settings command, and natural language preference configuration via Claude response tags**

## Performance

- **Duration:** 6 min
- **Started:** 2026-02-24T10:41:46Z
- **Completed:** 2026-02-24T10:47:40Z
- **Tasks:** 2
- **Files created:** 4
- **Files modified:** 4

## Accomplishments
- Built complete notification preferences CRUD with upsert on unique (userId, category) constraint and 5 default categories
- Implemented 3-level urgency classification: urgent (immediate delivery), important (morning digest), normal (on-demand)
- Created NotificationDispatcher routing notifications to correct channel with fallback to Telegram
- Built DigestScheduler compiling structured morning digests with category icons, scheduled at 8 AM daily via node-cron
- Added /settings command showing preferences in HTML format with urgency and channel icons
- Wired natural language preference configuration: system prompt instructs Claude to output preference_update tags, MessageRouter parses and executes DB updates
- Integrated all notification components into bot startup with graceful shutdown for digest cron

## Task Commits

Each task was committed atomically:

1. **Task 1: Notification preferences, urgency classification, and dispatcher** - `e2fb13e` (feat)
2. **Task 2: Digest scheduler, NL preference wiring, and bot integration** - `45065f8` (feat)

## Files Created/Modified
- `src/notifications/preferences.ts` - NotificationPreferences class: CRUD with upsert, defaults, enable/disable
- `src/notifications/urgency.ts` - UrgencyLevel type, NotificationItem interface, classifyUrgency function
- `src/notifications/dispatcher.ts` - NotificationDispatcher: urgency-based routing with immediate send, digest queue, on-demand queue
- `src/notifications/digest.ts` - DigestScheduler: morning digest compilation and delivery with category icons
- `src/brain/system-prompt.ts` - Added notification preference configuration instructions with preference_update tag format
- `src/brain/router.ts` - Added preference_update tag scanning, parsing, and DB execution after Claude response
- `src/worker/index.ts` - Added placeholder comment noting digest runs in bot process
- `src/bot/index.ts` - Wired NotificationPreferences, Dispatcher, DigestScheduler, /settings command, digest cron job, graceful shutdown

## Decisions Made
- Used in-memory Maps for digest and on-demand notification queues (sufficient for single-user bot, can migrate to Redis later)
- Structured preference_update XML tags in Claude responses for deterministic parsing of NL preference changes
- Digest cron runs in bot process (not worker) because it needs direct adapter access for message delivery
- /settings response uses HTML parse mode with Unicode icons for urgency levels and delivery channels
- Dispatcher falls back to Telegram adapter when configured Slack adapter is unavailable

## Deviations from Plan

None -- plan executed exactly as written.

## Issues Encountered
- Integration test for NotificationPreferences could not run locally (PostgreSQL in Docker on remote server, ECONNREFUSED). TypeScript compilation verified all types, imports, and interfaces are correct.

## Next Phase Readiness
- Notification infrastructure ready for Phase 3 integrations (ClickUp, Gmail, Calendar) to dispatch notifications
- DigestScheduler can be extended with configurable schedule time via preferences
- NotificationDispatcher supports both Telegram and Slack channels
- In-memory queues can be migrated to Redis for persistence across bot restarts in future phases

## Self-Check: PASSED

- All 8 files (4 created, 4 modified) verified to exist on disk
- Both task commits verified: `e2fb13e`, `45065f8`
- TypeScript compilation: zero errors

---
*Phase: 02-bot-shell-and-agent-brain*
*Completed: 2026-02-24*
