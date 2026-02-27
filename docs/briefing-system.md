# Astra Briefing System

## Overview

The Briefing MCP Server aggregates data from multiple sources (Slack, Gmail, Calendar, ClickUp) into a single tool call. Instead of Claude making 4-14 separate tool calls (1 turn each, accumulating context), the briefing server fans out to all sources in parallel and returns compact, pre-filtered results.

**Before briefing:**
```
User: "Что нового?"
Claude: tool 1 → list_calendar_events (turn 1, +5KB)
        tool 2 → search_gmail_messages (turn 2, +8KB)
        tool 3 → get_gmail_message x3 (turns 3-5, +15KB)
        tool 4 → slack_get_channel_history (turn 6, +15KB)
        tool 5 → searchTasks (turn 7, +10KB)
= 7 turns, ~53KB context, $0.30+
```

**After briefing:**
```
User: "Что нового?"
Claude: briefing(sources=["calendar","gmail","slack","clickup"], period="today")
= 1 turn, ~3-5KB context, ~$0.05
```

## Architecture

```
Claude CLI
  └── MCP stdio transport
       └── briefing-server.ts
            ├── Slack API (direct REST, user token from env)
            ├── Gmail API (direct REST, OAuth token from disk)
            ├── Calendar API (direct REST, OAuth token from disk)
            └── ClickUp API (direct REST, API key from env)
```

- **Transport:** stdio (spawned by Claude CLI as child process)
- **No MCP-over-MCP:** Direct REST calls, no proxying through other MCP servers
- **Google tokens:** Read from `~/.google_workspace_mcp/credentials/{account}.json`
- **Auto token refresh:** If Google token is expired, refreshes using refresh_token
- **Parallel fanout:** All sources queried simultaneously via `Promise.allSettled`
- **Graceful degradation:** Failed sources return `{ error: "..." }`, don't crash the whole request

## Tools

### `briefing`

Flexible constructor for multi-source queries.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `sources` | string[] | Yes | — | Which sources: `"slack"`, `"gmail"`, `"calendar"`, `"clickup"` |
| `query_type` | string | No | `"recent"` | `"recent"`, `"unread"`, `"search"`, `"digest"` |
| `period` | string | No | `"today"` | `"today"`, `"yesterday"`, `"last_3_days"`, `"last_week"`, `"last_month"`, or ISO range `"2026-01-01/2026-01-20"` |
| `search_term` | string | No | — | Keyword for `query_type="search"` |
| `slack_channels` | string[] | No | top 5 | Specific Slack channels to query (by name) |
| `limit_per_source` | number | No | 10 | Max items per source |
| `fields` | string[] | No | all | Which fields to return: `"author"`, `"date"`, `"text"`, `"text_preview"`, `"subject"`, `"links"`, `"thread_info"`, `"status"`, `"assignee"`, `"due_date"`, `"channel"` |

**Examples:**

```json
// "Что у меня сегодня?"
{
  "sources": ["calendar", "gmail", "clickup"],
  "query_type": "recent",
  "period": "today",
  "fields": ["subject", "date", "author", "status"]
}

// "Что нового в Slack за неделю?"
{
  "sources": ["slack"],
  "query_type": "digest",
  "period": "last_week",
  "slack_channels": ["ohbibi-mwcf-project", "stt-team"],
  "fields": ["channel", "author", "text_preview", "date", "thread_info"]
}

// "Есть непрочитанные письма?"
{
  "sources": ["gmail"],
  "query_type": "unread",
  "period": "last_3_days",
  "fields": ["author", "subject", "date", "text_preview"]
}
```

### `search_everywhere`

Shortcut for keyword search across all sources.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `search_term` | string | Yes | — | Keyword or phrase |
| `period` | string | No | `"last_month"` | Time period |
| `limit_per_source` | number | No | 5 | Max results per source |

**Example:**
```json
// "Найди всё про Симфонию"
{ "search_term": "Симфония" }
```

## Response Format

```json
{
  "query": { /* original request */ },
  "results": {
    "calendar": [
      { "source": "calendar", "subject": "Sprint Review", "date": "2026-02-27T10:00:00Z", "attendees": "..." }
    ],
    "gmail": [
      { "source": "gmail", "author": "Marina <marina@...>", "subject": "Art Planning", "text_preview": "..." }
    ],
    "slack": { "error": "Slack not configured" },
    "clickup": [
      { "source": "clickup", "subject": "Onboarding flow", "status": "in progress", "due_date": "..." }
    ]
  },
  "meta": {
    "sources_queried": ["calendar", "gmail", "slack", "clickup"],
    "sources_ok": ["calendar", "gmail", "clickup"],
    "sources_failed": ["slack"],
    "total_items": 15,
    "query_time_ms": 1200
  }
}
```

## When to Use Briefing vs Raw Tools

| Scenario | Use | Why |
|----------|-----|-----|
| "Что нового?" / daily overview | `briefing` | Multi-source, 1 call |
| "Что в канале X?" | `briefing` with slack_channels | Compact, filtered |
| "Найди X" across sources | `search_everywhere` | Parallel search |
| "Открой тред Y" (follow-up) | `slack_get_thread_replies` | Specific deep dive |
| "Покажи полный текст письма" | `get_gmail_message` | Full body needed |
| Browse channels list | `slack_list_channels` | Not a briefing task |

## Gap Analysis Workflow

When Claude uses raw tools instead of `briefing`, it may indicate a missing preset or parameter. Track these gaps to continuously improve the briefing server.

### How to identify gaps

1. **Monitor MCP logs:** Check `/tmp/astra-briefing.log` and `/tmp/slack-mcp.log`
2. **Compare tool usage:** If Claude calls raw Slack/Gmail/Calendar tools directly, ask: "Could briefing have handled this?"
3. **Track patterns:** Common raw tool usage patterns → candidate for new `query_type` or parameter

### How to add a new preset

1. **Identify the pattern:** e.g., "User often asks for messages mentioning specific person"
2. **Add query_type or parameter:** e.g., `query_type: "mentions"`, `mentioned_user: "Костя"`
3. **Implement in `briefing-server.ts`:** Add the source fetcher logic
4. **Update system prompt:** Add usage example in `system-prompt.ts`
5. **Test:** Run through the A/B test framework (`tests/ab-test-prompts.sh`)

### Gap tracking template

When reviewing bot interactions, log gaps in this format:

```
DATE: 2026-02-27
USER QUERY: "Покажи что Костя писал на этой неделе"
WHAT CLAUDE DID: search_gmail_messages(from:kostya) + slack_get_channel_history(general) + slack_get_channel_history(stt-team)
TURNS USED: 4
WHAT BRIEFING COULD DO: briefing(sources=["gmail","slack"], query_type="search", search_term="Костя", period="last_week")
TURNS WITH BRIEFING: 1
GAP: briefing search_term works but Claude didn't use it — update system prompt example
```

## File Locations

| File | Purpose |
|------|---------|
| `src/mcp/briefing-server.ts` | The MCP server implementation |
| `src/mcp/config-generator.ts` | Wires briefing server into MCP config |
| `src/brain/system-prompt.ts` | Tells Claude when/how to use briefing |
| `docs/briefing-system.md` | This documentation |
| `/tmp/astra-briefing.log` | Runtime debug log (on server) |
| `tests/ab-test-prompts.sh` | A/B/C test framework for prompt variants |
| `tests/ab-results/` | Test results from prompt comparison |

## Token Economics

Based on A/B/C/D testing with 10 standard questions:

| Approach | Avg cost/question | Avg turns |
|----------|-------------------|-----------|
| No optimization (old) | ~$0.18 | ~5 |
| Variant D (prompt only) | ~$0.14* | ~6 |
| With briefing (projected) | ~$0.05-0.08 | ~2-3 |

*Excluding Q8 outlier ($0.52)

Briefing reduces cost by:
- Fewer turns (1-2 vs 4-14)
- Smaller response payloads (filtered fields, truncated previews)
- No redundant data (parallel fetch, no re-reading previous turn results)
