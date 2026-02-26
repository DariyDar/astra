# Phase 3: Core Integrations - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Connect ClickUp, Gmail, Google Calendar, and Google Drive to Astra via MCP — read-only access only. User can query any of these sources through natural language. Claude routes requests, calls the right MCP tools, and returns a unified answer.

Write access (creating tasks, sending emails, creating calendar events) is a separate future phase.

</domain>

<decisions>
## Implementation Decisions

### MCP server selection
- **Google services (Gmail, Calendar, Drive):** Prefer official / Anthropic-maintained MCP servers. If not available, prefer most actively maintained community server.
- **ClickUp:** No official MCP exists. gsd-phase-researcher evaluates available community MCP servers on GitHub. If none are sufficient, build a thin custom MCP wrapper over ClickUp REST API covering only needed operations (read-only: list tasks, get task details, filter by project/assignee/status).
- **Architecture:** Single `mcp-config.json` containing both memory tools (existing) and integration tools (new). Claude sees all tools in one context.

### Authorization and setup
- All credentials configured via `.env` / server config — no Telegram-based onboarding flows.
- Google OAuth flow: handled by workspace-mcp internally. User runs `uvx workspace-mcp` auth flow on the server, tokens stored in `~/.google-workspace-mcp/` (workspace-mcp's own storage). No custom OAuth route or DB token storage — workspace-mcp manages its own token lifecycle.
- Google tokens: auto-refresh by workspace-mcp. User never prompted for re-auth unless refresh token is revoked.
- ClickUp: API key via `.env`.

### Routing
- Claude decides which MCP tool(s) to call based on the query — no additional router layer.
- MCP tool descriptions must be precise enough to prevent false positives.
- Multi-source queries (e.g. "show everything this week"): Claude calls relevant tools in parallel and returns a single merged response.

### Errors and unavailability
- If an integration is unavailable or returns an error: explicit user-facing message ("Could not fetch data from Gmail — service unavailable, try later").
- 1 silent retry before surfacing the error.
- Empty result: concrete answer ("No tasks in Project Alpha", not a prompt to create one).

### What's read-only in Phase 3
- Gmail: read inbox, threads, labels — no send/reply
- Calendar: read events, schedule — no create/update
- Google Drive: read/search documents — no write
- ClickUp: read tasks, projects, members, statuses — no create/update

</decisions>

<specifics>
## Specific Ideas

- Phase 3 is purely read. All write operations (create task, send email, create event) belong to a dedicated "Actions" phase to be added to the roadmap.
- Research should evaluate MCP ecosystem state at planning time — the landscape changes fast.

</specifics>

<deferred>
## Deferred Ideas

- **Write access / Actions phase** — Creating tasks, sending emails, creating calendar events. User confirmed this is needed but belongs in its own phase after Phase 3. Should be added to roadmap as a new phase between Phase 3 and Phase 4.
- **ClickUp proactive alerts** (deadline monitoring, overdue tasks) — Mentioned in Phase 3 success criteria in ROADMAP.md. Belongs here but implementation details deferred to planning.

</deferred>

---

*Phase: 03-core-integrations*
*Context gathered: 2026-02-26*
