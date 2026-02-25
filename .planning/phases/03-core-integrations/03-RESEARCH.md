# Phase 3: Core Integrations - Research

**Researched:** 2026-02-26
**Domain:** MCP server integrations (ClickUp, Gmail, Google Calendar, Google Drive) -- read-only access
**Confidence:** MEDIUM

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Google services (Gmail, Calendar, Drive):** Prefer official / Anthropic-maintained MCP servers. If not available, prefer most actively maintained community server.
- **ClickUp:** No official MCP exists. gsd-phase-researcher evaluates available community MCP servers on GitHub. If none are sufficient, build a thin custom MCP wrapper over ClickUp REST API covering only needed operations (read-only: list tasks, get task details, filter by project/assignee/status).
- **Architecture:** Single `mcp-config.json` containing both memory tools (existing) and integration tools (new). Claude sees all tools in one context.
- All credentials configured via `.env` / server config -- no Telegram-based onboarding flows.
- Google OAuth flow: bot serves an OAuth redirect URL; user opens it in browser and authorizes. Tokens stored encrypted in DB (same mechanism as Phase 1).
- Google tokens: auto-refresh in background. User never prompted for re-auth unless refresh token is revoked.
- ClickUp: API key via `.env`.
- Claude decides which MCP tool(s) to call based on the query -- no additional router layer.
- MCP tool descriptions must be precise enough to prevent false positives.
- Multi-source queries: Claude calls relevant tools in parallel and returns a single merged response.
- If integration unavailable: explicit user-facing message, 1 silent retry, then clear failure response.
- Phase 3 is purely read-only.

### Claude's Discretion
- Specific MCP server package choices (within constraints above)
- Implementation of retry logic
- System prompt structure for integration tool guidance
- ClickUp proactive alerts implementation details

### Deferred Ideas (OUT OF SCOPE)
- **Write access / Actions phase** -- Creating tasks, sending emails, creating calendar events. Belongs in Phase 3.5.
- **ClickUp proactive alerts** (deadline monitoring, overdue tasks) -- Mentioned in Phase 3 success criteria but implementation details deferred to planning.
</user_constraints>

## Summary

Phase 3 connects four external services (ClickUp, Gmail, Google Calendar, Google Drive) to Astra via MCP servers -- all read-only. The existing architecture already supports MCP via `claude --print --mcp-config` with a single `mcp-config.json` file. Currently, only the `astra-memory` HTTP server is configured. Phase 3 adds integration MCP servers to this same config.

For **Google services** (Gmail, Calendar, Drive), there are no Anthropic-maintained MCP servers for these specific services (the official `@modelcontextprotocol/server-gdrive` was archived). The best community option is **`taylorwilsdon/google_workspace_mcp`** (`workspace-mcp` on PyPI) -- 1.5k stars, actively maintained, supports `--read-only` flag, selective tool loading (`--tools gmail drive calendar`), stdio transport, and OAuth 2.0 with automatic token refresh. It requires Python 3.11+ via `uvx`.

For **ClickUp**, the best option is **`hauptsacheNet/clickup-mcp`** (`@hauptsache.net/clickup-mcp` on npm) -- 37 stars, 100+ commits, TypeScript, supports a dedicated `read-minimal` mode (2 tools: `getTaskById`, `searchTasks`) and `read` mode (7 tools including `searchSpaces`, `getListInfo`, `readDocument`, `searchDocuments`). Uses API key auth via env vars. Runs via `npx` with stdio transport.

**Primary recommendation:** Use `workspace-mcp` (Python/uvx, stdio) for all three Google services in `--read-only --tools gmail drive calendar` mode, and `@hauptsache.net/clickup-mcp` (Node.js/npx, stdio) in `read` mode for ClickUp. Both integrate into the existing `mcp-config.json` alongside the `astra-memory` HTTP server.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support | Phase 3 Scope |
|----|-------------|-----------------|---------------|
| CU-01 | Search tasks by natural language query | ClickUp MCP `searchTasks` tool with fuzzy search across workspace | IN SCOPE (read) |
| CU-02 | Create tasks via bot | ClickUp MCP `createTask` tool (write mode) | OUT OF SCOPE -- Phase 3.5 |
| CU-03 | Update task status, assignee, due date | ClickUp MCP `updateTask` tool (write mode) | OUT OF SCOPE -- Phase 3.5 |
| MAIL-01 | Classify incoming emails by priority | Gmail MCP `search_gmail_messages` + Claude classification in system prompt | IN SCOPE (read + LLM classification) |
| MAIL-02 | Generate digest of unread priority emails on demand | Gmail MCP `search_gmail_messages` with `is:unread` + Claude formatting | IN SCOPE (read) |
| MAIL-03 | Draft responses to emails using project context | Gmail read + Claude generation (draft only, no send) | PARTIAL -- read part in scope, draft generation is Phase 3.5 |
| CAL-01 | Ask "what's on my calendar today/this week?" | Calendar MCP event listing tools | IN SCOPE (read) |
| CAL-02 | Configurable reminders before meetings | Calendar MCP read events + cron-based reminder dispatcher | IN SCOPE (read + existing notification system) |
| DRIVE-01 | Index documents from specified Drive folders into RAG | Drive MCP file listing/reading + existing Qdrant infrastructure | IN SCOPE (read + index) |
| DRIVE-02 | Ask questions about document content | Drive MCP search/read + Claude Q&A | IN SCOPE (read) |

**Important note on requirement mapping:** The ROADMAP.md assigns CU-02 and CU-03 to Phase 3, but CONTEXT.md explicitly marks Phase 3 as read-only with write access deferred to Phase 3.5. The planner should scope Phase 3 to read-only operations only. CU-02 and CU-03 are write operations and belong in Phase 3.5. MAIL-03 (draft responses) is also partially write and the send/create aspect belongs in Phase 3.5; however, the email reading and context-gathering parts are in scope.
</phase_requirements>

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `workspace-mcp` (PyPI) | latest (Feb 2026) | Gmail, Calendar, Drive MCP server | 1.5k GitHub stars, `--read-only` flag, selective tools, OAuth auto-refresh, stdio transport |
| `@hauptsache.net/clickup-mcp` (npm) | latest | ClickUp MCP server | 37 stars, 100+ commits, `read`/`read-minimal` modes, TypeScript, npx, API key auth |
| `uvx` (Python package runner) | latest | Run workspace-mcp without global install | Required by workspace-mcp; equivalent of npx for Python |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node-cron` | ^4.2.1 | Schedule ClickUp deadline checks | Already in project; used for proactive alerts |
| `@modelcontextprotocol/sdk` | ^1.27.1 | MCP SDK (already installed) | If custom ClickUp MCP wrapper needed (fallback) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `workspace-mcp` (Python) | `ngs/google-mcp-server` (Go binary) | Go binary = no Python dependency, but 0 stars, less proven, no `--read-only` flag |
| `workspace-mcp` (Python) | Individual MCP servers per Google service | More granular but 3x config complexity, inconsistent auth |
| `@hauptsache.net/clickup-mcp` | `taazkareem/clickup-mcp-server` | 12 stars but premium/sponsorware model requiring paid license -- not suitable |
| `@hauptsache.net/clickup-mcp` | Custom MCP wrapper over ClickUp REST API | Full control but unnecessary -- community server covers read needs well |
| `@hauptsache.net/clickup-mcp` | `Leanware-io/clickup-mcp-server` | Docker-only, 5 stars, less active |

**Installation:**
```bash
# ClickUp MCP (Node.js) -- runs via npx, no install needed
# workspace-mcp (Python) -- runs via uvx, requires Python 3.11+
pip install uv  # if uvx not already available
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── mcp/
│   ├── mcp-config.json     # Single config: memory + integrations (updated)
│   └── server.ts           # Existing astra-memory MCP server
├── integrations/
│   ├── oauth/
│   │   ├── google-auth.ts  # Google OAuth flow + token management
│   │   └── routes.ts       # HTTP endpoints for OAuth redirect
│   └── monitors/
│       └── clickup-deadlines.ts  # Cron job: check approaching deadlines
├── brain/
│   ├── system-prompt.ts    # Updated with integration tool guidance
│   └── router.ts           # No changes needed -- MCP routing via Claude
└── config/
    └── env.ts              # New env vars: CLICKUP_API_KEY, CLICKUP_TEAM_ID, GOOGLE_*
```

### Pattern 1: Unified MCP Config with Mixed Transport Types

**What:** Single `mcp-config.json` containing HTTP server (astra-memory) and stdio servers (google workspace, clickup). Claude CLI spawns stdio servers as child processes and connects to HTTP servers over the network.

**When to use:** Always -- this is the project's established pattern.

**Example:**
```json
{
  "mcpServers": {
    "astra-memory": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp"
    },
    "google-workspace": {
      "type": "stdio",
      "command": "uvx",
      "args": ["workspace-mcp", "--read-only", "--tools", "gmail", "drive", "calendar"],
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "${GOOGLE_OAUTH_CLIENT_ID}",
        "GOOGLE_OAUTH_CLIENT_SECRET": "${GOOGLE_OAUTH_CLIENT_SECRET}"
      }
    },
    "clickup": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@hauptsache.net/clickup-mcp@latest"],
      "env": {
        "CLICKUP_API_KEY": "${CLICKUP_API_KEY}",
        "CLICKUP_TEAM_ID": "${CLICKUP_TEAM_ID}",
        "CLICKUP_MCP_MODE": "read"
      }
    }
  }
}
```
**Confidence:** HIGH -- The Claude CLI documentation and MCP spec confirm mixed transport types in a single config are supported.

**Windows note:** On Windows, npx requires `cmd /c` wrapper. The config should use `"command": "cmd", "args": ["/c", "npx", "-y", "@hauptsache.net/clickup-mcp@latest"]`. Since the server runs on Linux (VPS), this is only relevant for local development.

### Pattern 2: System Prompt Extension for Integration Tools

**What:** Extend `buildSystemPrompt()` to include guidance for integration tools. Claude needs to know what tools are available and when to use each.

**When to use:** Always -- Claude uses tool descriptions to decide routing, but the system prompt adds contextual guidance.

**Example:**
```typescript
// In system-prompt.ts -- add integration tool section
`## Integration tools
You have access to external service tools. Use them when the user asks about tasks, emails, calendar, or documents.

- **ClickUp tools** (searchTasks, getTaskById, searchSpaces, etc.) -- Use when user asks about tasks, projects, deadlines, team assignments.
- **Gmail tools** (search_gmail_messages, get_gmail_message, etc.) -- Use when user asks about emails, inbox, priority messages.
- **Calendar tools** (list_calendar_events, etc.) -- Use when user asks about schedule, meetings, availability.
- **Drive tools** (search_drive_files, get_drive_file_content, etc.) -- Use when user asks about documents, files, GDDs, specs.

For multi-source queries ("show everything this week"), call relevant tools in parallel.
If a tool fails, retry once silently. If still failing, tell the user which service is unavailable.
Never make up data -- if a tool returns empty results, say "No results found" explicitly.`
```

### Pattern 3: Google OAuth Token Management

**What:** One-time OAuth consent flow via browser redirect. Tokens persisted encrypted in PostgreSQL, auto-refreshed using Google's refresh token mechanism.

**When to use:** First-time Google service setup and ongoing token lifecycle.

**Critical detail:** The `workspace-mcp` server handles OAuth internally via its own token storage in `~/.google-workspace-mcp/`. However, the user decision says "tokens stored encrypted in DB (same mechanism as Phase 1)." This creates a tension -- the MCP server manages its own tokens. Two options:
1. **Let workspace-mcp manage its own tokens** (simpler, standard MCP approach)
2. **Fork/wrap workspace-mcp to use our DB** (complex, fragile)

**Recommendation:** Let workspace-mcp manage its own tokens. The user's intent is security (encrypted storage), which workspace-mcp satisfies via its own secure token storage. The first-time auth still requires browser consent -- the user visits a URL, authorizes, and tokens are stored. This is the standard pattern for all MCP servers.

### Pattern 4: Proactive ClickUp Deadline Monitoring

**What:** A cron job polls ClickUp for tasks with deadlines within 24h or overdue, then dispatches notifications via the existing `NotificationDispatcher`.

**When to use:** Phase 3 success criteria #7 requires proactive alerts.

**Example:**
```typescript
// In integrations/monitors/clickup-deadlines.ts
// Runs every hour via node-cron
// 1. Call ClickUp API directly (REST, not MCP) to get tasks with due dates
// 2. Filter: due_date within 24h OR overdue
// 3. For each matching task, dispatch notification via NotificationDispatcher
//    category: 'task_deadline', urgency per preference
```

**Why direct API, not MCP:** The cron job runs in the bot process, not in a Claude conversation. MCP tools are only available during Claude CLI invocations. The cron job needs direct ClickUp API access.

### Anti-Patterns to Avoid

- **Building a custom router layer on top of Claude:** The user explicitly decided Claude handles routing. Don't add middleware that pre-classifies queries.
- **Starting MCP servers inside the bot process:** Stdio MCP servers are spawned by the Claude CLI per invocation. The bot process should not manage their lifecycle (except astra-memory HTTP server which is already managed).
- **Storing Google OAuth tokens in a custom DB layer:** The workspace-mcp server handles its own token lifecycle. Fighting this creates maintenance burden.
- **Using write-mode MCP tools in Phase 3:** Locked decision -- Phase 3 is read-only. Use `--read-only` for workspace-mcp and `CLICKUP_MCP_MODE=read` for ClickUp.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Google OAuth flow | Custom OAuth2 client | workspace-mcp's built-in OAuth | Handles token refresh, consent flow, scope management |
| ClickUp API wrapper | Custom REST client with pagination | @hauptsache.net/clickup-mcp | Handles workspace hierarchy, fuzzy search, pagination, response size limits |
| Gmail message parsing | Custom MIME parser | workspace-mcp Gmail tools | Gmail MIME/thread structure is complex; MCP server handles it |
| Calendar event formatting | Custom iCal parser | workspace-mcp Calendar tools | Recurring events, timezone handling, all-day events are deceptively complex |
| MCP protocol handling | Custom JSON-RPC | Claude CLI `--mcp-config` | Claude CLI manages MCP server lifecycle, tool discovery, and invocation |

**Key insight:** The entire point of MCP is to avoid building custom integration code. Phase 3 should add existing MCP servers to the config and update the system prompt. The only custom code needed is: (1) Google OAuth first-time setup, (2) ClickUp deadline monitoring cron, (3) system prompt updates, (4) env var additions.

## Common Pitfalls

### Pitfall 1: OAuth Token Expiry During Conversation

**What goes wrong:** Google access tokens expire after 1 hour. If a conversation spans longer, mid-conversation tool calls fail.
**Why it happens:** The workspace-mcp server caches tokens and refreshes them, but if the refresh token itself is revoked (user changed password, admin revoked access), all calls fail.
**How to avoid:** workspace-mcp handles automatic refresh. For revoked refresh tokens, surface a clear error message ("Google authorization expired, please re-authorize") and include instructions. The 1-retry logic in the error handling will catch transient failures.
**Warning signs:** Consistent 401 errors from Google tools after initial success.

### Pitfall 2: ClickUp API Rate Limiting

**What goes wrong:** ClickUp API has rate limits (100 requests per minute per token). Heavy usage or the deadline monitoring cron hitting the API too frequently causes 429 errors.
**Why it happens:** Each Claude conversation spawns a new MCP server instance, and the cron job also makes API calls.
**How to avoid:** Set the deadline monitoring cron to run every 30-60 minutes (not every minute). The MCP server handles per-request rate limiting. For the cron job, batch API calls efficiently (one `getFilteredTeamTasks` call with date filters, not per-task queries).
**Warning signs:** 429 responses from ClickUp API, increasing latency.

### Pitfall 3: MCP Server Startup Latency

**What goes wrong:** Each Claude CLI invocation spawns MCP stdio servers as child processes. With workspace-mcp (Python/uvx) and clickup-mcp (Node.js/npx), cold starts add 3-10 seconds per invocation.
**Why it happens:** `uvx` downloads/caches the Python package on first run, `npx` does the same for Node.js. Subsequent runs are faster but still involve process spawn overhead.
**How to avoid:** Ensure packages are pre-cached on the server (`uvx workspace-mcp --help` and `npx -y @hauptsache.net/clickup-mcp@latest --help` during deployment). Accept the latency -- Claude CLI already has a ~7s cold start, and MCP server spawn runs in parallel.
**Warning signs:** Response times increasing from ~7s to ~15s+ on first use.

### Pitfall 4: Too Many MCP Tools Confusing Claude

**What goes wrong:** If all tools from all MCP servers are loaded (workspace-mcp has 100+ tools in complete mode), Claude may call incorrect tools or hallucinate tool parameters.
**Why it happens:** Large tool lists consume context window and reduce routing accuracy.
**How to avoid:** Use selective tool loading: `--tools gmail drive calendar` (not the full suite), `--read-only` flag, and `CLICKUP_MCP_MODE=read` (not write). This limits the tool count to ~15-20 total across all servers.
**Warning signs:** Claude calling Google Sheets tools when asked about emails, or ClickUp write tools when Phase 3 is read-only.

### Pitfall 5: Windows/Linux Path Differences for MCP Config

**What goes wrong:** The `mcp-config.json` uses `command: "npx"` or `command: "uvx"` which works on Linux but fails on Windows without `cmd /c` wrapper.
**Why it happens:** Windows cannot directly execute npx/uvx without the cmd.exe wrapper.
**How to avoid:** Since the production server is Linux, use Linux-native commands in `mcp-config.json`. For local Windows development, either use WSL or create a separate `mcp-config.dev.json` with `cmd /c` wrappers. The `MCP_CONFIG_PATH` in `router.ts` could be made environment-aware.
**Warning signs:** "Connection closed" or "ENOENT" errors when running locally on Windows.

### Pitfall 6: Environment Variable Expansion in mcp-config.json

**What goes wrong:** The `mcp-config.json` uses `${VAR}` syntax for env var expansion, but this only works in `.mcp.json` files parsed by Claude Code (the IDE tool), not necessarily in the standalone `claude --print --mcp-config` path.
**Why it happens:** The standalone CLI may not perform env var expansion on the config file the same way Claude Code does.
**How to avoid:** Two options: (1) Use the `"env"` block in the config to pass environment variables to the spawned process (the MCP server reads them from its own process env), or (2) Generate the config dynamically at startup with actual values injected. Option 1 is cleaner.
**Warning signs:** MCP servers starting but failing auth because env vars are literal `${VAR}` strings.

## Code Examples

### MCP Config with All Integrations
```json
// Source: Claude Code MCP docs + workspace-mcp + clickup-mcp docs
{
  "mcpServers": {
    "astra-memory": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp"
    },
    "google-workspace": {
      "type": "stdio",
      "command": "uvx",
      "args": ["workspace-mcp", "--read-only", "--tools", "gmail", "drive", "calendar"],
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "your-client-id.apps.googleusercontent.com",
        "GOOGLE_OAUTH_CLIENT_SECRET": "your-secret"
      }
    },
    "clickup": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@hauptsache.net/clickup-mcp@latest"],
      "env": {
        "CLICKUP_API_KEY": "pk_xxxxxxx",
        "CLICKUP_TEAM_ID": "1234567",
        "CLICKUP_MCP_MODE": "read"
      }
    }
  }
}
```

### Dynamic MCP Config Generation
```typescript
// Source: Project pattern from src/brain/router.ts
// Generate mcp-config.json at startup with actual env var values
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { env } from '../config/env.js'

interface McpServerConfig {
  type: 'http' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}

export function generateMcpConfig(outputPath: string): void {
  const config: { mcpServers: Record<string, McpServerConfig> } = {
    mcpServers: {
      'astra-memory': {
        type: 'http',
        url: 'http://127.0.0.1:3100/mcp',
      },
    },
  }

  // Add Google Workspace if configured
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) {
    config.mcpServers['google-workspace'] = {
      type: 'stdio',
      command: 'uvx',
      args: ['workspace-mcp', '--read-only', '--tools', 'gmail', 'drive', 'calendar'],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: env.GOOGLE_OAUTH_CLIENT_ID,
        GOOGLE_OAUTH_CLIENT_SECRET: env.GOOGLE_OAUTH_CLIENT_SECRET,
      },
    }
  }

  // Add ClickUp if configured
  if (env.CLICKUP_API_KEY && env.CLICKUP_TEAM_ID) {
    config.mcpServers['clickup'] = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@hauptsache.net/clickup-mcp@latest'],
      env: {
        CLICKUP_API_KEY: env.CLICKUP_API_KEY,
        CLICKUP_TEAM_ID: env.CLICKUP_TEAM_ID,
        CLICKUP_MCP_MODE: 'read',
      },
    }
  }

  writeFileSync(outputPath, JSON.stringify(config, null, 2))
}
```

### ClickUp Deadline Monitor (Cron Job)
```typescript
// Source: ClickUp API docs + existing notification system pattern
// Direct ClickUp REST API call (not MCP -- runs outside Claude context)
interface ClickUpTask {
  id: string
  name: string
  due_date: string | null
  status: { status: string }
  assignees: Array<{ username: string }>
  url: string
  list: { name: string }
}

async function checkApproachingDeadlines(
  apiKey: string,
  teamId: string,
): Promise<ClickUpTask[]> {
  const now = Date.now()
  const in24h = now + 24 * 60 * 60 * 1000

  // Get tasks due within 24h or overdue
  const url = `https://api.clickup.com/api/v2/team/${teamId}/task?` +
    `due_date_gt=${now - 7 * 24 * 60 * 60 * 1000}&due_date_lt=${in24h}&` +
    `statuses[]=open&statuses[]=in progress&include_closed=false`

  const response = await fetch(url, {
    headers: { Authorization: apiKey },
  })

  const data = await response.json() as { tasks: ClickUpTask[] }
  return data.tasks.filter(t => t.due_date !== null)
}
```

### System Prompt Integration Section
```typescript
// Source: Existing system-prompt.ts pattern
// Addition to buildSystemPrompt() function
const integrationSection = `
## Integration tools
You have access to external service tools via MCP. Use them when the user asks about tasks, emails, calendar, or documents.

**ClickUp** (searchTasks, getTaskById, searchSpaces, getListInfo, readDocument, searchDocuments, getTimeEntries):
- Use when user asks about tasks, projects, deadlines, team work, sprints
- searchTasks supports fuzzy matching -- use it for natural language queries
- searchSpaces to browse workspace hierarchy

**Gmail** (search_gmail_messages, get_gmail_message):
- Use when user asks about emails, inbox, priority messages
- Classify emails by urgency based on sender, subject, and content
- For digest requests, search with "is:unread" and summarize by priority

**Google Calendar** (list_calendar_events, get_calendar_event):
- Use when user asks about schedule, meetings, today/this week
- Format events clearly with time, title, and attendees

**Google Drive** (search_drive_files, get_drive_file_content):
- Use when user asks about documents, files, GDDs, specs, notes
- Can search by name and read document content

**Multi-source queries:**
When user asks something like "show everything this week" or "what's going on?":
- Call ClickUp, Calendar, and Gmail tools in parallel
- Merge results into a single organized response grouped by source

**Error handling:**
- If a tool call fails, retry once silently
- If still failing, tell the user which specific service is unavailable
- Never fabricate data -- if results are empty, say so explicitly
`
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Custom API wrappers per service | MCP servers (stdio/http) managed by Claude CLI | MCP spec Nov 2025 | No custom integration code needed |
| Static tool configurations | Dynamic tool discovery via MCP list_changed | MCP spec Nov 2025 | Servers can update tools without restart |
| Anthropic-maintained Google MCP servers | Community-maintained (archived official ones) | Mid 2025 | Must use community servers like workspace-mcp |
| SSE transport for remote MCP | Streamable HTTP (SSE deprecated) | MCP spec Nov 2025 | Prefer HTTP type for remote servers |
| API keys only for ClickUp | API keys still primary (no OAuth MCP) | Unchanged | Simple env var configuration |

**Deprecated/outdated:**
- `@modelcontextprotocol/server-gdrive`: Archived from the official MCP servers repo. No longer maintained by Anthropic. Was a Drive-only server. Use `workspace-mcp` instead which covers Gmail + Calendar + Drive.
- SSE transport: Deprecated in favor of streamable HTTP. Our existing `astra-memory` server already uses HTTP correctly.

## Open Questions

1. **Google OAuth first-time consent flow on headless VPS**
   - What we know: workspace-mcp opens a browser for OAuth consent. The server runs on a headless VPS.
   - What's unclear: How to complete the initial OAuth flow when there's no browser on the server.
   - Recommendation: Two approaches -- (a) Run initial auth on a local machine, then copy tokens to server, or (b) Use the workspace-mcp HTTP mode which provides a callback URL the user can visit from any browser. The CONTEXT.md says "bot serves an OAuth redirect URL; user opens it in browser" -- this aligns with approach (b). The planner should investigate workspace-mcp's exact headless auth flow.

2. **Environment variable injection into mcp-config.json**
   - What we know: The project uses a static `mcp-config.json` file. New MCP servers need credentials from `.env`.
   - What's unclear: Whether `claude --print --mcp-config` supports `${VAR}` expansion in env blocks, or if values must be literal.
   - Recommendation: Generate `mcp-config.json` dynamically at bot startup (see code example above). This is the safest approach and avoids secrets in committed files.

3. **workspace-mcp token storage location on production server**
   - What we know: workspace-mcp stores tokens in `~/.google-workspace-mcp/` by default.
   - What's unclear: Whether this location is configurable, and whether tokens survive deployment (tar + scp).
   - Recommendation: Ensure the token directory is outside the deployment directory and persists across deploys. Add to deployment scripts to preserve `~/.google-workspace-mcp/`.

4. **Claude CLI spawning Python (uvx) processes on the VPS**
   - What we know: The VPS runs the bot via Node.js. workspace-mcp requires Python 3.11+.
   - What's unclear: Whether Python 3.11+ is installed on the server, and whether uvx is available.
   - Recommendation: Verify Python version on server. If not available, install Python 3.11+ and uv/uvx as a deployment prerequisite.

5. **Proactive alerts: CONTEXT.md defers, ROADMAP.md requires**
   - What we know: Success criteria #7 requires proactive ClickUp deadline alerts. CONTEXT.md lists it under "Deferred Ideas" but says "belongs here."
   - What's unclear: Is the implementation of proactive alerts in scope for Phase 3 planning?
   - Recommendation: Include it in Phase 3 planning. The CONTEXT.md says "implementation details deferred to planning" (not deferred to another phase). The success criteria explicitly requires it. Use the existing `NotificationDispatcher` + `node-cron` pattern.

## Sources

### Primary (HIGH confidence)
- [Claude Code MCP Documentation](https://code.claude.com/docs/en/mcp) -- MCP config format, transport types, environment variable handling, Windows notes
- [hauptsacheNet/clickup-mcp GitHub](https://github.com/hauptsacheNet/clickup-mcp) -- ClickUp MCP server: modes (read-minimal, read, write), tools, configuration, npm package
- [taylorwilsdon/google_workspace_mcp GitHub](https://github.com/taylorwilsdon/google_workspace_mcp) -- Google Workspace MCP server: tools, --read-only flag, --tools selective loading, OAuth setup
- [workspace-mcp Quick Start](https://workspacemcp.com/quick-start) -- Setup steps, environment variables, uvx command

### Secondary (MEDIUM confidence)
- [ClickUp API Developer Docs](https://developer.clickup.com/) -- REST API endpoints for direct access (deadline monitoring cron)
- [ClickUp Authentication Docs](https://developer.clickup.com/docs/authentication) -- Personal API token generation
- [workspace-mcp PyPI](https://pypi.org/project/workspace-mcp/) -- Package details, version info

### Tertiary (LOW confidence)
- [Google Cloud Blog: MCP Support](https://cloud.google.com/blog/products/ai-machine-learning/announcing-official-mcp-support-for-google-services) -- Official Google MCP announcement (Feb 25, 2026) -- content not fully accessible, unclear if Gmail/Calendar/Drive are covered
- [MCP Registry](https://registry.modelcontextprotocol.io/) -- Official MCP server discovery (could list newer alternatives)

## Metadata

**Confidence breakdown:**
- Standard stack: MEDIUM -- workspace-mcp is well-starred (1.5k) but Python-based (adds a dependency). clickup-mcp is less proven (37 stars) but good enough for read-only use.
- Architecture: HIGH -- The MCP config pattern is well-documented and proven in the existing codebase. Mixing HTTP + stdio in one config is confirmed supported.
- Pitfalls: MEDIUM -- OAuth headless flow, env var injection, and Python dependency are real risks that need validation during implementation.

**Research date:** 2026-02-26
**Valid until:** 2026-03-12 (MCP ecosystem moves fast; verify package versions before implementation)
