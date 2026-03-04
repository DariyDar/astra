---
phase: 04-knowledge-base
plan: slack-user-cache
subsystem: database
tags: [slack, user-resolution, entity-cleanup, re-ingestion]

# Dependency graph
requires:
  - phase: 03-core-integrations
    provides: Slack MCP + workspace tokens via SLACK_WORKSPACES
provides:
  - Slack user ID-to-display-name cache (buildSlackUserCache)
  - User mention resolution in chunk text (resolveSlackMentions)
  - Reset script for raw-ID entity cleanup + Slack re-ingestion
  - Slack ingestion adapter with resolved user names
affects: [bulk-extraction, entity-review, knowledge-map]

# Tech tracking
tech-stack:
  added: []
  patterns: [user-cache-per-run, mention-resolution, cleanup-script]

key-files:
  created:
    - src/kb/slack-user-cache.ts
    - src/kb/reset-slack-entities.ts
    - tests/kb/slack-user-cache.test.ts
  modified:
    - src/kb/ingestion/slack.ts

key-decisions:
  - decision: Build cache once per ingestion run, not per message
    why: users.list returns all users in 1-2 API calls (200/page). Per-message users.info would be 25K+ API calls.
  - decision: Include deactivated users in cache
    why: Historical messages reference users who have since left. Without them, old messages would retain raw IDs.
  - decision: Reset script does NOT auto-trigger re-ingestion
    why: Re-ingesting 25K chunks takes significant time and API calls. User should run manually or wait for nightly cron.

# Outcome
status: complete
summary: >
  Built Slack user ID-to-display-name cache from users.list API covering both
  AC and HG workspaces (including deactivated users). Integrated into Slack
  ingestion adapter — resolveSlackMentions replaces <@U123> and <@U123|name>
  patterns before saving chunks, and user metadata field stores resolved names.
  Created reset-slack-entities.ts CLI (--dry-run supported) that deletes raw-ID
  person entities, resets Slack watermarks, purges Slack chunks from PG + Qdrant.
  Re-ingestion triggers on next nightly cron or manual run. 9 new tests pass.

self-check:
  result: PASSED
  typescript-errors: 0
  test-results: "9/9 pass"
  files-verified:
    - src/kb/slack-user-cache.ts (buildSlackUserCache, resolveSlackMentions exported)
    - src/kb/ingestion/slack.ts (imports and uses buildSlackUserCache, resolveSlackMentions)
    - src/kb/reset-slack-entities.ts (CLI script with --dry-run, entity deletion, watermark reset)
    - tests/kb/slack-user-cache.test.ts (9 tests for resolveSlackMentions)
---
