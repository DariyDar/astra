---
phase: 04-knowledge-base
plan: slack-user-cache
type: execute
wave: 3
depends_on: []
files_modified:
  - src/kb/slack-user-cache.ts
  - src/kb/ingestion/slack.ts
  - src/kb/reset-slack-entities.ts
autonomous: true
requirements:
  - KB-01
  - KB-04

must_haves:
  truths:
    - "All Slack chunks contain resolved display names instead of raw user IDs like U09AKPXRQ81"
    - "No person entities in the KB graph have names matching raw Slack ID pattern (U[A-Z0-9]{8,})"
    - "Slack user cache covers both AC and HG workspaces, including deactivated users"
    - "After re-ingest, 25K Slack chunks have human-readable author names in metadata"
  artifacts:
    - path: "src/kb/slack-user-cache.ts"
      provides: "Slack user ID to display name lookup cache"
      exports: ["buildSlackUserCache", "resolveSlackMentions"]
    - path: "src/kb/reset-slack-entities.ts"
      provides: "CLI script to delete raw-ID person entities and reset Slack watermarks"
    - path: "src/kb/ingestion/slack.ts"
      provides: "Slack ingestion adapter with user ID resolution"
      contains: "resolveSlackMentions"
  key_links:
    - from: "src/kb/slack-user-cache.ts"
      to: "Slack users.list API"
      via: "fetch with workspace tokens from SLACK_WORKSPACES"
      pattern: "users\\.list"
    - from: "src/kb/ingestion/slack.ts"
      to: "src/kb/slack-user-cache.ts"
      via: "import resolveSlackMentions, call before chunking"
      pattern: "resolveSlackMentions"
    - from: "src/kb/reset-slack-entities.ts"
      to: "src/db/schema.ts"
      via: "delete entities where name matches raw ID regex"
      pattern: "kbEntities.*U\\[A-Z0-9\\]"
---

<objective>
Build a Slack user ID-to-display-name cache from `users.list` API, integrate it into the Slack ingestion adapter to resolve `<@U123>` patterns before saving chunks, delete the ~70 raw-ID person entities, reset Slack watermarks, and trigger a full re-ingest of all 25K Slack chunks with resolved names.

Purpose: CONTEXT.md mandates "All Slack user IDs MUST be resolved at ingestion time." Currently 70+ person entities are stored as raw IDs (U09AKPXRQ81) which breaks entity extraction quality and makes the knowledge graph unusable for person-based queries.

Output: Clean Slack chunks with human-readable names, no raw-ID entities in the graph, ready for entity extraction.
</objective>

<execution_context>
@C:/Users/dimsh/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/dimsh/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/04-knowledge-base/04-CONTEXT.md
@.planning/phases/04-knowledge-base/04-RESEARCH.md
@src/kb/ingestion/slack.ts
@src/mcp/briefing/slack.ts
@src/kb/repository.ts
@src/db/schema.ts
@src/kb/chunker.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Build Slack user cache and integrate into ingestion adapter</name>
  <files>src/kb/slack-user-cache.ts, src/kb/ingestion/slack.ts</files>
  <action>
Create `src/kb/slack-user-cache.ts` with two exports:

1. `buildSlackUserCache(): Promise<Map<string, string>>` — Fetches users from both AC and HG Slack workspaces via `users.list` API (Tier 2, 20+/min). Import workspace configs from `src/mcp/briefing/slack.ts` (use `SLACK_WORKSPACES` array with `token` and `label` fields). Paginate with `limit: 200` and `cursor`. Include deactivated users (`deleted: true`) — they appear in historical messages. For each user, prefer `profile.display_name`, fall back to `profile.real_name`, then `real_name`, then user ID. Log workspace label and user count via pino logger.

2. `resolveSlackMentions(text: string, cache: Map<string, string>): string` — Replace `<@U123>` AND `<@U123|display_name>` patterns with resolved display names from cache. Regex: `/<@(U[A-Z0-9]+)(?:\|[^>]*)?>/g`. If user ID not found in cache, keep the raw ID (do not crash). Log unresolved IDs at debug level.

Then modify `src/kb/ingestion/slack.ts`:
- Import `buildSlackUserCache` and `resolveSlackMentions` from the new file
- In the adapter initialization or `fetchSince()`, call `buildSlackUserCache()` once and store the result
- Before formatting each message into a chunk, call `resolveSlackMentions(msg.text, cache)` on the message text
- Also resolve the `user` field in RawItem metadata: `userCache.get(msg.user) ?? msg.user ?? 'unknown'`
- The cache must be built ONCE per ingestion run (not per message), passed into toChunks or toRawItem

Do NOT use `users.info` per-user — use bulk `users.list` (2 API calls total for ~40 users across both workspaces).
  </action>
  <verify>
    <automated>npx tsx -e "import { resolveSlackMentions } from './src/kb/slack-user-cache.js'; const cache = new Map([['U123', 'Dariy']]); const result = resolveSlackMentions('Hello <@U123> and <@U456|John>', cache); console.assert(result === 'Hello Dariy and John', 'Got: ' + result); console.log('PASS')"</automated>
    <manual>Check that slack-user-cache.ts exports both functions, and slack.ts imports and uses resolveSlackMentions</manual>
  </verify>
  <done>Slack user cache builds from both workspaces, resolveSlackMentions replaces all user ID patterns in text, and the Slack ingestion adapter uses the cache before creating chunks</done>
</task>

<task type="auto">
  <name>Task 2: Delete raw-ID entities, reset Slack watermarks, and run full re-ingest</name>
  <files>src/kb/reset-slack-entities.ts</files>
  <action>
Create `src/kb/reset-slack-entities.ts` — a CLI script (runnable via `npx tsx`) that performs these steps in order:

1. **Delete raw-ID person entities:** Query `kb_entities` for all entities where `type = 'person'` AND name matches regex `^U[A-Z0-9]{8,}$`. For each:
   - Delete from `kb_entity_aliases` (or rely on CASCADE)
   - Delete from `kb_entity_relations` (both `from_id` and `to_id`)
   - Remove the entity ID from `kb_chunks.entity_ids` arrays: `UPDATE kb_chunks SET entity_ids = array_remove(entity_ids, $id) WHERE $id = ANY(entity_ids)`
   - Delete the entity from `kb_entities`
   - Log each deleted entity name and ID

2. **Reset Slack watermarks:** Delete or reset rows in `kb_ingestion_state` where source starts with `slack:`. This forces full re-ingestion on next run.

3. **Delete existing Slack chunks:** Delete all rows from `kb_chunks` where `source = 'slack'`. Also delete corresponding Qdrant points (use `deleteByFilter` on collection `astra_knowledge` with `source: 'slack'`).

4. **Trigger re-ingestion:** Import and call the Slack ingestion adapter's `fetchSince` with the reset watermark (empty/null). The adapter will now use the user cache (from Task 1) to resolve all IDs. The re-ingestion MUST be triggered directly by the script — do NOT skip this step or defer to manual action.

Add `--dry-run` flag that shows what would be deleted without executing. Log totals at the end (entities deleted, chunks deleted, watermarks reset).

Import DB connection from `src/db/index.ts`, Qdrant client from existing KB infrastructure, schema from `src/db/schema.ts`.
  </action>
  <verify>
    <automated>npx tsx src/kb/reset-slack-entities.ts --dry-run 2>&1 | grep -E "(dry run|entities|chunks|watermarks)"</automated>
    <manual>After running without --dry-run on the server: verify no entities with names matching U[A-Z0-9]{8,} exist; verify Slack chunks have resolved names (spot-check 5 chunks)</manual>
  </verify>
  <done>All raw-ID person entities deleted from KB graph, Slack watermarks reset, existing Slack chunks purged, re-ingestion completes with resolved display names in all 25K chunks</done>
</task>

</tasks>

<verification>
1. No person entities in `kb_entities` have names matching `/^U[A-Z0-9]{8,}$/`
2. Random sample of 10 Slack chunks shows human-readable names (e.g., "Dariy" not "U09AKPXRQ81")
3. `resolveSlackMentions` handles both `<@U123>` and `<@U123|name>` formats
4. User cache includes deactivated users from both workspaces
5. Total Slack chunk count after re-ingest is approximately 25K (within 10%)
</verification>

<success_criteria>
- Slack user cache builds successfully from both AC and HG workspaces
- All `<@U123>` patterns in Slack chunk text are resolved to display names
- ~70 raw-ID person entities deleted from entity graph
- 25K Slack chunks re-ingested with resolved names
- No regression in other source ingestion (Gmail, Drive, Notion, Calendar, ClickUp)
</success_criteria>

<output>
After completion, create `.planning/phases/04-knowledge-base/slack-user-cache-SUMMARY.md`
</output>
