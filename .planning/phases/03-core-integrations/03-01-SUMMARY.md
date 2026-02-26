---
phase: 03-core-integrations
plan: 01
subsystem: infra
tags: [mcp, clickup, google-workspace, gmail, calendar, drive, zod, env]

# Dependency graph
requires:
  - phase: 02-bot-shell-and-agent-brain
    provides: "MessageRouter, MCP memory server, system prompt, bot startup sequence"
provides:
  - "Dynamic MCP config generator with conditional server entries"
  - "Optional env vars for ClickUp and Google Workspace integrations"
  - "System prompt integration tool guidance for Claude"
affects: [03-02, 03-03, 03.5]

# Tech tracking
tech-stack:
  added: []
  patterns: ["conditional MCP server registration based on env vars", "dynamic config generation at startup"]

key-files:
  created: [src/mcp/config-generator.ts]
  modified: [src/config/env.ts, src/brain/system-prompt.ts, src/bot/index.ts, .env.example]

key-decisions:
  - "MCP config generated dynamically at startup (not static JSON) to inject actual env var values"
  - "All integration env vars are optional (z.string().optional()) so bot starts without them"
  - "System prompt includes static tool names regardless of MCP server availability (Claude handles tool-not-found gracefully)"

patterns-established:
  - "Conditional MCP server: check env vars -> add server entry -> log which servers were included/skipped"
  - "Integration env vars follow same optional pattern as Slack env vars"

requirements-completed: [CU-01, MAIL-01, MAIL-02, CAL-01, DRIVE-02]

# Metrics
duration: 3min
completed: 2026-02-26
---

# Phase 3 Plan 01: MCP Integration Infrastructure Summary

**Dynamic MCP config generator with conditional ClickUp and Google Workspace servers, plus system prompt tool guidance for 4 integrations**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-26T04:51:56Z
- **Completed:** 2026-02-26T04:54:43Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Dynamic MCP config generator that conditionally adds google-workspace and clickup servers based on env var availability
- 4 optional integration env vars (CLICKUP_API_KEY, CLICKUP_TEAM_ID, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET) with graceful degradation
- System prompt with comprehensive integration tool guidance covering ClickUp, Gmail, Calendar, Drive, multi-source queries, and error handling

## Task Commits

Each task was committed atomically:

1. **Task 1: Integration env vars and dynamic MCP config generator** - `ab4fe37` (feat)
2. **Task 2: System prompt integration tool guidance** - `dec6e30` (feat)

## Files Created/Modified
- `src/config/env.ts` - Added 4 optional integration env vars to Zod schema
- `src/mcp/config-generator.ts` - New file: generateMcpConfig() with conditional server entries
- `src/brain/system-prompt.ts` - Added ## Integration tools section with 4 service descriptions
- `src/bot/index.ts` - Added generateMcpConfig() call at startup before MessageRouter
- `.env.example` - Documented ClickUp and Google Workspace env vars

## Decisions Made
- MCP config is generated dynamically at startup rather than maintained as a static JSON file, so actual env var values are injected without hardcoded secrets
- All integration env vars are optional (z.string().optional()) following the same pattern as Slack env vars, ensuring the bot starts cleanly without them
- System prompt includes static tool names for all integrations regardless of whether the MCP server is configured -- Claude will handle tool-not-found gracefully if a server is not present

## Deviations from Plan

None - plan executed exactly as written.

## User Setup Required

External services require manual configuration before integrations will activate:
- **ClickUp**: Set CLICKUP_API_KEY (from ClickUp Settings -> Apps) and CLICKUP_TEAM_ID (from ClickUp URL)
- **Google Workspace**: Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (from Google Cloud Console -> APIs & Services -> Credentials -> OAuth 2.0 Client IDs)
- **Google APIs**: Enable Gmail API, Google Calendar API, Google Drive API in Google Cloud Console

See plan 03-03 for detailed server setup and OAuth consent flow.

## Next Phase Readiness
- MCP infrastructure is ready for plan 03-02 (proactive monitors) and plan 03-03 (server setup + e2e verification)
- Config generator will automatically include integration servers once env vars are set
- No blockers

## Self-Check: PASSED

All files found. All commits verified.

---
*Phase: 03-core-integrations*
*Completed: 2026-02-26*
