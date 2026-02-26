---
phase: 03-core-integrations
plan: 02
subsystem: integrations
tags: [clickup, rest-api, cron, deadline-monitor, notifications]

# Dependency graph
requires:
  - phase: 03-core-integrations
    provides: "MCP integration infrastructure, optional ClickUp env vars, NotificationDispatcher"
  - phase: 02-bot-shell-and-agent-brain
    provides: "NotificationDispatcher, DigestScheduler, bot startup/shutdown lifecycle"
provides:
  - "ClickUp deadline monitor checking every 30 minutes via REST API"
  - "Proactive overdue/approaching task notifications via NotificationDispatcher"
affects: [03-03]

# Tech tracking
tech-stack:
  added: []
  patterns: ["conditional monitor lifecycle (start/stop) based on env var presence", "session-based deduplication with Set<string>"]

key-files:
  created: [src/integrations/monitors/clickup-deadlines.ts]
  modified: [src/bot/index.ts]

key-decisions:
  - "Direct REST API calls only (no LLM/Claude invocation) for ClickUp deadline monitoring"
  - "Session-based deduplication via Set<string> resets on bot restart (acceptable for 30-min check interval)"
  - "Monitor is opt-in: only starts when both CLICKUP_API_KEY and CLICKUP_TEAM_ID are configured"

patterns-established:
  - "Monitor lifecycle pattern: conditional creation at module scope, start() in startup(), stop() in shutdown()"
  - "REST API monitor pattern: cron job + immediate check on start + try/catch to never crash the bot"

requirements-completed: [CU-01]

# Metrics
duration: 2min
completed: 2026-02-26
---

# Phase 3 Plan 02: ClickUp Deadline Monitor Summary

**ClickUp deadline monitor using direct REST API calls every 30 minutes, dispatching overdue/approaching task alerts via NotificationDispatcher**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-26T04:57:22Z
- **Completed:** 2026-02-26T04:59:33Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- ClickUp deadline monitor that checks REST API every 30 minutes for tasks with deadlines within 24 hours or overdue (up to 7 days back)
- Notifications dispatched through existing NotificationDispatcher with proper urgency levels (urgent for overdue, important for approaching)
- Bot lifecycle integration with conditional creation, startup, and graceful shutdown

## Task Commits

Each task was committed atomically:

1. **Task 1: ClickUp deadline monitor (direct REST API, no LLM)** - `b3455a3` (feat)
2. **Task 2: Wire ClickUp monitor into bot entry point** - `d9eee10` (feat)

## Files Created/Modified
- `src/integrations/monitors/clickup-deadlines.ts` - ClickUpDeadlineMonitor class with cron-based REST API checking, deduplication, and NotificationDispatcher integration
- `src/bot/index.ts` - Conditional monitor creation, startup start(), and shutdown stop()

## Decisions Made
- Direct REST API calls only -- no LLM/Claude invocation for deadline monitoring, keeping this as a simple cron-based HTTP check
- Session-based deduplication using a `Set<string>` of notified task IDs that resets on bot restart (acceptable since the 30-min interval means at most one re-notification per task after restart)
- Monitor is opt-in: only created and started when both `CLICKUP_API_KEY` and `CLICKUP_TEAM_ID` environment variables are configured

## Deviations from Plan

None - plan executed exactly as written.

## User Setup Required

External services require manual configuration before the ClickUp monitor will activate:
- **CLICKUP_API_KEY**: Obtain from ClickUp Settings -> Apps -> API Token
- **CLICKUP_TEAM_ID**: Found in ClickUp URL (e.g., `https://app.clickup.com/{teamId}/...`)

Set both in `.env` file. The bot will log "ClickUp credentials not configured, deadline monitor disabled" when they are missing.

## Next Phase Readiness
- ClickUp deadline monitor is ready for end-to-end verification in plan 03-03
- No blockers

## Self-Check: PASSED

All files found. All commits verified.

---
*Phase: 03-core-integrations*
*Completed: 2026-02-26*
