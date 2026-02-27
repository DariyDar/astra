# Roadmap: Astra

## Overview

Astra is built across 3 milestones, 12 phases total. Each milestone represents a qualitative leap in what Astra can do for the user.

**Milestone 1 — Information Assistant (read-only):** Astra reads all connected tools and presents information in the format the user needs. Digests, overdue tasks, reminders, summaries, reports — all on demand. No write access.

**Milestone 2 — Proactive Advisor:** Astra proactively highlights problems and suggests solutions. Draft responses, flagged issues, recommendations — the user copies/applies manually.

**Milestone 3 — Autonomous Actor:** Astra proposes actions, the user approves, Astra executes. Write access to all integrations with confirmation before every action.

**Design Principle: Prefer ready-made solutions and MCP over custom code.** Use existing MCP servers wherever available. Only build custom connectors when no suitable MCP exists. MCP queries must be precise — filter at the MCP level, not with LLM. System prompt teaches Claude to form targeted requests and avoid wasting tokens on unnecessary data.

## Phases

- [x] **Phase 1: Infrastructure and Security Foundation** — Docker Compose stack, encrypted credentials, structured logging, LLM client (completed 2026-02-23)
- [x] **Phase 2: Bot Shell and Agent Brain** — Telegram + Slack bots, memory, conversation context, notification preferences (completed 2026-02-25)
- [ ] **Phase 3: Core Integrations** — ClickUp, Gmail, Google Calendar, Google Drive via MCP; read-only access + optimized MCP queries (precise filters, minimal token waste)
- [ ] **Phase 4: Data Harvest and Knowledge Base** — Ingest history from all sources, entity extraction, RAG with hybrid search, company terminology
- [ ] **Phase 5: Reports and Digests** — Daily standups, weekly status, email digests, on-demand summaries, bilingual output
- [ ] **Phase 6: Proactive Monitoring** — Deadline alerts, calendar reminders, overdue tracking, document freshness (all trigger-based, no cron LLM)
- [ ] **Phase 7: Smart Recommendations** — Suggest responses, flag project problems, highlight missed deadlines, recommend actions
- [ ] **Phase 8: Ghost-Writing (Read-Only)** — Draft responses for Slack DMs and emails; user reviews and copies manually
- [ ] **Phase 9: Team Oversight** — Monitor other PMs' processes, flag missing standups/updates, per-PM performance tracking
- [ ] **Phase 10: Write Actions** — Create/update ClickUp tasks, send emails, create calendar events — all with explicit user confirmation
- [ ] **Phase 11: Self-Learning** — Learn from corrections, adapt drafts, detect behavioral patterns, persistent preferences
- [ ] **Phase 12: Self-Extension** — Natural language tool generation, Deno sandbox, approval gating, auto-disable on failure

## Milestone 1: Information Assistant

*Astra reads all your tools and presents information in the format you need.*

### Phase 1: Infrastructure and Security Foundation
**Goal**: All backend services run reliably with encrypted credentials, structured observability, and LLM integration — the invisible foundation every feature depends on
**Depends on**: Nothing (first phase)
**Requirements**: INFRA-01, INFRA-02, INFRA-03, INFRA-04, INFRA-05
**Success Criteria** (what must be TRUE):
  1. Docker Compose stack starts all services (PostgreSQL, Redis, bot) with a single command and all health checks pass
  2. API tokens stored in PostgreSQL are encrypted at rest and cannot be read as plaintext from the database
  3. Every bot action produces a structured JSON log entry with correlation ID, and an audit trail query can reconstruct the sequence of actions for any request
  4. Single model (Sonnet) used for all LLM tasks — no tiering, no classification by complexity
  5. When Claude is unavailable, user receives a Telegram notification with a friendly message
**Plans**: 2 plans

Plans:
- [x] 01-01-PLAN.md — Project setup, Docker Compose stack, DB schema, bot/worker entry points
- [x] 01-02-PLAN.md — Credential encryption, structured logging, Claude API client, health monitoring

### Phase 2: Bot Shell and Agent Brain
**Goal**: User can talk to Astra in Telegram and Slack, hold multi-step conversations with context, and configure how proactive alerts reach them
**Depends on**: Phase 1
**Requirements**: MSG-01, MSG-02, MSG-03, MSG-04, MSG-05
**Success Criteria** (what must be TRUE):
  1. User sends a message in Telegram (in Russian or English) and receives a contextually appropriate response in the same language
  2. User sends a message in Slack DM and receives a contextually appropriate response in the same language
  3. User can have a multi-step conversation (e.g., "create a task" -> "in which project?" -> "Project Alpha" -> "done") and the bot retains context throughout
  4. User can configure notification preferences (e.g., "only alert me about urgent items" or "batch non-critical notifications hourly") and the bot respects those settings
  5. Bot auto-detects whether a message is in Russian or English and responds in the matching language without being told
**Plans**: 5 plans

Plans:
- [x] 02-01-PLAN.md — Database schema extensions (messages, preferences, feedback), unified channel types, language detection
- [x] 02-02-PLAN.md — Three-tier memory system (Redis short-term, PostgreSQL medium-term, Qdrant long-term semantic)
- [x] 02-03-PLAN.md — Telegram adapter refactor + conversation brain (context builder, system prompt, message router)
- [x] 02-04-PLAN.md — Slack adapter (Bolt Socket Mode) with optional registration
- [x] 02-05-PLAN.md — Notification system (preferences, urgency, dispatcher, morning digest)

### Phase 3: Core Integrations
**Goal**: User can read ClickUp tasks, triage Gmail, check Google Calendar, and query Google Drive through natural language — read-only access via MCP with optimized, precise queries
**Depends on**: Phase 2
**Design**: Use MCP servers for all integrations. Prefer official/Anthropic-maintained MCP servers. MCP queries must be precise: filter fields, date ranges, and statuses at the MCP/API level — not by sending everything to Claude and letting LLM filter. System prompt teaches Claude to form targeted tool calls that return only what's needed. Single mcp-config.json with both memory and integration tools.
**Requirements**: CU-01, CU-04, CU-05, CU-06, MAIL-01, MAIL-02, CAL-01, DRIVE-02
**Success Criteria** (what must be TRUE):
  1. User asks "what's overdue in Project Alpha?" and gets an accurate list from ClickUp via MCP
  2. User asks "what's on my calendar today?" and sees a formatted schedule from Google Calendar
  3. User asks "show me my priority emails" and gets a prioritized digest of unread Gmail messages
  4. User asks "find the GDD for Project Alpha" and gets the relevant document from Google Drive
  5. Multi-source queries ("show everything this week") call relevant tools in parallel and return a single merged response
  6. If an integration is unavailable: explicit error message, 1 silent retry, then clear failure response
  7. Bot proactively alerts about ClickUp tasks approaching deadline (within 24h) and overdue tasks
  8. MCP queries use precise filters (date ranges, statuses, fields) — no redundant data sent to LLM for filtering
**Plans**: 3 plans

Plans:
- [x] 03-01-PLAN.md — MCP infrastructure: env vars, dynamic config generator, system prompt integration tool guidance
- [ ] 03-02-PLAN.md — Proactive monitors: ClickUp deadline alerts, Google Calendar reminders via NotificationDispatcher
- [ ] 03-03-PLAN.md — Server setup (Python/uvx, MCP pre-cache, Google OAuth consent) + end-to-end verification

### Phase 4: Data Harvest and Knowledge Base
**Goal**: Ingest bounded history from all connected sources, extract entities, build a RAG-powered knowledge base with hybrid search — the user can ask any question about their work data and get accurate answers with sources
**Depends on**: Phase 3
**Design**: Lightweight bounded ingestion first (not months of history — enough to discover entities). Entity extraction with LLM-generated assumptions. Qdrant for vector search, PostgreSQL for structured filters. Hybrid search (semantic + keyword). Company terminology support. Ingestion is idempotent and resumable. Full history ingestion as a follow-up once entities are verified with user.
**Requirements**: DRIVE-01, DRIVE-03, DRIVE-04, KB-01, KB-02, KB-03, KB-04
**Success Criteria** (what must be TRUE):
  1. System ingests a bounded sample from each source (Slack channels, Gmail inbox, Google Drive, ClickUp) without manual intervention
  2. Entity extractor identifies people, projects, channels, and context from ingested data
  3. User can ask "what did John say about the deadline last month?" and get accurate answer with source
  4. User can filter queries by project, source, or person
  5. Bot understands company-specific terminology (project names, people, jargon)
  6. Google Drive documents are indexed and re-indexed when changed
  7. Ingestion is idempotent — re-running does not create duplicates
**Plans**: TBD

### Phase 5: Reports and Digests
**Goal**: User can request project reports at any granularity and receive well-structured output in either language — daily standups, weekly status, email digests, on-demand summaries
**Depends on**: Phase 4 (knowledge base provides the data for reports)
**Design**: Reports pull from knowledge base + live MCP queries. All reports are drafts for review. Bilingual output (Russian/English regardless of source language). Email digest with priority classification.
**Requirements**: MAIL-04, RPT-01, RPT-02, RPT-03, RPT-04, RPT-05
**Success Criteria** (what must be TRUE):
  1. User requests a daily standup for Project Alpha and gets a summary from ClickUp tasks and Slack activity
  2. User requests a weekly status report covering tasks, blockers, and risks
  3. User requests a monthly summary with trends, completed milestones, and risks
  4. Bot generates prioritized email digest on demand with key points and action items extracted
  5. Reports available in Russian and English regardless of source data language
  6. Every report is a draft — user reviews before sharing anywhere
**Plans**: TBD

### Phase 6: Proactive Monitoring
**Goal**: Astra monitors all connected sources and alerts the user about important events without being asked — all trigger-based, no cron LLM calls
**Depends on**: Phase 5
**Design**: All proactive features are trigger-based (incoming events, state changes, threshold crossings). No scheduled LLM calls. Direct REST API checks (like ClickUp deadline monitor) are fine on cron. Configurable: user sets what triggers alerts via natural language.
**Requirements**: CU-04, CAL-02, DRIVE-03
**Success Criteria** (what must be TRUE):
  1. Bot alerts about ClickUp tasks approaching deadline (within 24h) and overdue tasks — automatic, no user request needed
  2. Bot sends configurable reminders before calendar meetings (default: 15 min)
  3. Bot flags potentially outdated documents (not modified in N months)
  4. All proactive alerts are trigger-based — no cron-based LLM calls
  5. User can configure alert rules via natural language ("only alert me about urgent items", "remind me 30 min before meetings")
**Plans**: TBD

## Milestone 2: Proactive Advisor

*Astra proactively highlights problems and suggests solutions — the user copies/applies manually.*

### Phase 7: Smart Recommendations
**Goal**: Astra analyzes incoming data and proactively suggests responses, flags project problems, highlights missed deadlines, and recommends next actions
**Depends on**: Phase 6
**Design**: LLM analyzes incoming messages/events against knowledge base context. Recommendations are suggestions only — user decides what to do. Priority-based: urgent recommendations are immediate, others are batched.
**Requirements**: MAIL-03, MAIL-05
**Success Criteria** (what must be TRUE):
  1. When a Slack message asks a question, Astra suggests a response with context from the knowledge base
  2. Astra flags when a project has unaddressed blockers or stale tasks
  3. Astra recommends responses to emails based on project context and communication history
  4. All recommendations are suggestions — user copies/applies manually, nothing is sent automatically
  5. Recommendations include reasoning ("I suggest this because...")
**Plans**: TBD

### Phase 8: Ghost-Writing (Read-Only)
**Goal**: Astra drafts responses for Slack DMs and emails — user reviews, copies, and sends manually. Nothing is sent automatically.
**Depends on**: Phase 7
**Design**: Monitor incoming Slack DMs and emails. Urgent: immediate notification with draft. Non-urgent: batched digest with drafts. User copies the draft text and sends it themselves. Drafts include reasoning. Draft expiry after 24h.
**Requirements**: GW-01, GW-02, GW-03, GW-05, DRAFT-04
**Success Criteria** (what must be TRUE):
  1. Urgent Slack DM triggers immediate notification with context summary and draft response
  2. Non-urgent DMs batched into periodic digest, each with draft response
  3. Each draft includes reasoning ("I wrote this because...")
  4. User copies draft text manually — bot does not send anything
  5. Drafts expire after 24 hours and are archived
**Plans**: TBD

### Phase 9: Team Oversight
**Goal**: Astra monitors whether other PMs follow processes and flags deviations — standups conducted, tasks updated, time tracked, deadlines met
**Depends on**: Phase 8
**Design**: Per-PM monitoring rules. Checks: daily standups happened, ClickUp tasks updated, no stale tasks beyond threshold, time tracking entries present. Generates per-PM performance digest.
**Requirements**: PMO-01, PMO-02, PMO-03, PMO-04
**Success Criteria** (what must be TRUE):
  1. Astra detects when a PM hasn't conducted a daily standup and flags it
  2. Astra detects stale tasks (not updated in N days) per PM and flags them
  3. User can request a per-PM performance digest (tasks closed, updates posted, response times)
  4. Astra alerts when a PM's project has tasks overdue beyond configurable threshold
**Plans**: TBD

## Milestone 3: Autonomous Actor

*Astra proposes actions, the user approves, Astra executes.*

### Phase 10: Write Actions
**Goal**: User can create and update data across all integrations through natural language — every action requires explicit user confirmation before execution
**Depends on**: Phase 9
**Design**: Same MCP-first approach. Every write action requires explicit user confirmation ("yes", "do it", "confirm"). After execution, bot confirms what was done with a summary. Draft-first: all outgoing communications shown as drafts with approve/edit/reject.
**Requirements**: CU-02, CU-03, CAL-03, CAL-04, GW-04, DRAFT-01, DRAFT-02, DRAFT-03
**Success Criteria** (what must be TRUE):
  1. User says "create a task for John in Project Beta: review the GDD, due Friday" — bot confirms, then creates
  2. User says "send a reply to Alex's email about the deadline" — bot drafts, shows, sends only after approval
  3. User says "add a meeting with the team on Thursday at 3pm" — bot creates calendar event after confirmation
  4. No action executes without explicit user confirmation
  5. After execution, bot confirms what was done with a summary
  6. All outgoing communications appear as drafts with approve/edit/reject buttons
**Plans**: TBD

### Phase 11: Self-Learning
**Goal**: Astra learns from corrections and explicit teachings, improving over time while preserving what it does well
**Depends on**: Phase 10
**Design**: Capture diffs when user edits drafts. Explicit teaching via conversation. Behavioral pattern detection. Persistent preference storage across sessions.
**Requirements**: LEARN-01, LEARN-02, LEARN-03, LEARN-04
**Success Criteria** (what must be TRUE):
  1. When user edits a draft before approving, bot captures the diff and adjusts future drafts for similar contexts
  2. User can explicitly teach preferences and bot applies them in future without reminders
  3. Bot identifies recurring patterns and suggests automation
  4. Learned preferences persist across sessions and restarts
**Plans**: TBD

### Phase 12: Self-Extension
**Goal**: User describes new tool integrations in natural language and bot builds, sandboxes, and deploys them with human approval at every gate
**Depends on**: Phase 11
**Design**: Natural language to tool generation. Deno sandbox with explicit permissions. Approval gating. Auto-disable on repeated failure.
**Requirements**: EXT-01, EXT-02, EXT-03, EXT-04
**Success Criteria** (what must be TRUE):
  1. User describes integration in natural language and bot generates working implementation
  2. Generated tools execute in Deno sandbox with explicit permissions
  3. No new tool enters registry without user review and approval
  4. Tools that fail repeatedly (3+) are auto-disabled with failure summary
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute sequentially: 1 → 2 → 3 → 4 → 5 → 6 (M1) → 7 → 8 → 9 (M2) → 10 → 11 → 12 (M3)

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Infrastructure and Security Foundation | M1 | 2/2 | Complete | 2026-02-23 |
| 2. Bot Shell and Agent Brain | M1 | 5/5 | Complete | 2026-02-25 |
| 3. Core Integrations (read-only + MCP optimization) | M1 | 1/3 | In progress | - |
| 4. Data Harvest and Knowledge Base | M1 | 0/? | Not started | - |
| 5. Reports and Digests | M1 | 0/? | Not started | - |
| 6. Proactive Monitoring | M1 | 0/? | Not started | - |
| 7. Smart Recommendations | M2 | 0/? | Not started | - |
| 8. Ghost-Writing (Read-Only) | M2 | 0/? | Not started | - |
| 9. Team Oversight | M2 | 0/? | Not started | - |
| 10. Write Actions | M3 | 0/? | Not started | - |
| 11. Self-Learning | M3 | 0/? | Not started | - |
| 12. Self-Extension | M3 | 0/? | Not started | - |
