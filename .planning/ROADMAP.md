# Roadmap: Astra

## Overview

Astra is built in 8 phases following strict dependency order. Infrastructure and security come first because prompt architecture, credential encryption, and draft-first output are load-bearing constraints that cannot be retrofitted. Bot shells and the agent brain come second because every feature routes through them. Core integrations (ClickUp, Gmail, Calendar) deliver the PM's daily value as the first user-visible milestone. Google Drive and the RAG knowledge base follow because ghost-writing and reports gain dramatically from company context. Reports, ghost-writing with the full draft UX, self-learning, and self-extension each build on everything before them.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Infrastructure and Security Foundation** - Docker Compose stack, encrypted credentials, structured logging, single-model LLM integration
- [ ] **Phase 2: Bot Shell and Agent Brain** - Telegram + Slack bots, unified message router, LangGraph agent, conversation context, notification preferences
- [ ] **Phase 3: Core Integrations** - ClickUp task management, Gmail email triage, Google Calendar — the PM's daily toolkit
- [ ] **Phase 4: Knowledge Base** - Google Drive indexing, RAG pipeline, hybrid search with project filtering, company terminology
- [ ] **Phase 5: Report Generation** - Daily standups, weekly status, monthly summaries — all as draft-for-approval with bilingual output
- [ ] **Phase 6: Ghost-Writing and Draft System** - Slack DM monitoring, email ghost-writing, full draft approval UX with expiry and reasoning
- [ ] **Phase 7: Self-Learning** - Correction capture, explicit preference teaching, behavioral pattern detection, persistent memory
- [ ] **Phase 8: Self-Extension** - Natural language tool generation, Deno sandbox, approval gating, auto-disable on failure

## Phase Details

### Phase 1: Infrastructure and Security Foundation
**Goal**: All backend services run reliably with encrypted credentials, structured observability, and intelligent LLM routing — the invisible foundation every feature depends on
**Depends on**: Nothing (first phase)
**Requirements**: INFRA-01, INFRA-02, INFRA-03, INFRA-04, INFRA-05
**Success Criteria** (what must be TRUE):
  1. Docker Compose stack starts all services (PostgreSQL, Redis, Qdrant, bot, worker) with a single command and all health checks pass
  2. API tokens stored in PostgreSQL are encrypted at rest and cannot be read as plaintext from the database
  3. Every bot action produces a structured JSON log entry with correlation ID, and an audit trail query can reconstruct the sequence of actions for any request
  4. Single model (Sonnet) used for all LLM tasks — no tiering, no classification by complexity
  5. When Claude is unavailable, user receives a Telegram notification with a friendly message
**Plans**: 2 plans

Plans:
- [x] 01-01-PLAN.md — Project setup, Docker Compose stack, DB schema, bot/worker entry points
- [ ] 01-02-PLAN.md — Credential encryption, structured logging, Claude API client, health monitoring

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
**Plans**: TBD

Plans:
- [ ] 02-01: TBD
- [ ] 02-02: TBD

### Phase 3: Core Integrations
**Goal**: User can manage ClickUp tasks, triage Gmail, and check Google Calendar through natural language — the daily PM workflow works end-to-end
**Depends on**: Phase 2
**Requirements**: CU-01, CU-02, CU-03, CU-04, CU-05, CU-06, MAIL-01, MAIL-02, MAIL-03, MAIL-04, MAIL-05, CAL-01, CAL-02, CAL-03, CAL-04
**Success Criteria** (what must be TRUE):
  1. User asks "what's overdue in Project Alpha?" and gets an accurate list of overdue ClickUp tasks (not hallucinated — fetched from API)
  2. User says "create a task for John in Project Beta: review the GDD, due Friday" and a correctly populated task appears in ClickUp without needing to know space/folder/list IDs
  3. User asks "what's on my calendar today?" and sees a formatted schedule pulled from Google Calendar, with a reminder arriving 15 minutes before the next meeting
  4. User asks "show me my priority emails" and gets a prioritized digest of unread Gmail messages classified by urgency, with draft responses available for the most important ones
  5. Bot proactively alerts the user about tasks approaching their deadline (within 24 hours) and tasks that are overdue
**Plans**: TBD

Plans:
- [ ] 03-01: TBD
- [ ] 03-02: TBD
- [ ] 03-03: TBD

### Phase 4: Knowledge Base
**Goal**: User can ask questions about company documents and get accurate answers with source citations, powered by an auto-updating RAG pipeline over Google Drive
**Depends on**: Phase 3
**Requirements**: DRIVE-01, DRIVE-02, DRIVE-03, DRIVE-04, KB-01, KB-02, KB-03, KB-04
**Success Criteria** (what must be TRUE):
  1. User asks "what does the GDD say about monetization?" and gets an accurate answer citing the specific document and section
  2. User can filter knowledge queries by project ("in Project Alpha docs, what are the technical risks?") and results are scoped correctly
  3. Bot flags documents that have not been modified in a configurable period as potentially outdated, and the user can see which documents are stale
  4. When a document is updated in Google Drive, the knowledge base re-indexes it automatically without manual intervention
  5. Bot correctly understands company-specific terminology (project names, gamedev jargon, people's names) in queries and answers
**Plans**: TBD

Plans:
- [ ] 04-01: TBD
- [ ] 04-02: TBD

### Phase 5: Report Generation
**Goal**: User can request project reports at any granularity (daily, weekly, monthly) and receive well-structured drafts for review in either language
**Depends on**: Phase 4
**Requirements**: RPT-01, RPT-02, RPT-03, RPT-04, RPT-05
**Success Criteria** (what must be TRUE):
  1. User requests a daily standup for Project Alpha and gets a summary aggregated from ClickUp tasks and Slack activity for that project
  2. User requests a weekly status report and gets a structured document covering tasks completed, in progress, blocked, and key risks — drawn from ClickUp, Gmail, and Calendar
  3. User requests a monthly summary and gets trend analysis, completed milestones, and risk overview for the reporting period
  4. Every generated report is presented as a draft that the user can approve, edit, or reject before it goes anywhere
  5. User can request any report in Russian or English regardless of the language of the source data, and the output reads naturally in the target language
**Plans**: TBD

Plans:
- [ ] 05-01: TBD
- [ ] 05-02: TBD

### Phase 6: Ghost-Writing and Draft System
**Goal**: Bot monitors incoming Slack DMs and emails, classifies urgency, drafts contextual responses, and presents everything for approval with full reasoning — nothing sends without the PM's explicit say-so
**Depends on**: Phase 5
**Requirements**: GW-01, GW-02, GW-03, GW-04, GW-05, DRAFT-01, DRAFT-02, DRAFT-03, DRAFT-04
**Success Criteria** (what must be TRUE):
  1. When an urgent Slack DM arrives, the user receives an immediate notification with a context summary and a draft response ready for approval
  2. Non-urgent Slack DMs are batched into a periodic digest, each with a draft response the user can approve, edit, or reject
  3. All outgoing communications (emails, Slack messages, reports) appear as drafts with inline approve/edit/reject buttons — nothing sends automatically
  4. Each draft includes the bot's reasoning ("I wrote this because the sender is asking about Project Alpha's deadline, and the latest ClickUp data shows...")
  5. Drafts that the user does not act on expire after 24 hours and are archived, not sent
**Plans**: TBD

Plans:
- [ ] 06-01: TBD
- [ ] 06-02: TBD

### Phase 7: Self-Learning
**Goal**: Bot learns from the PM's corrections and explicit teachings, improving draft quality and workflow suggestions over time while preserving what it already does well
**Depends on**: Phase 6
**Requirements**: LEARN-01, LEARN-02, LEARN-03, LEARN-04
**Success Criteria** (what must be TRUE):
  1. When the user edits a draft before approving, the bot captures the diff and adjusts future drafts for similar contexts (e.g., the user always makes meeting invites more formal)
  2. User can explicitly teach preferences ("always CC John on Project Alpha emails") and the bot applies them in future drafts without being reminded
  3. Bot identifies recurring patterns in the PM's workflow and suggests automation ("I notice you check overdue tasks every morning — want me to send a digest at 9am?")
  4. Learned preferences and patterns persist across sessions and bot restarts — nothing is forgotten
**Plans**: TBD

Plans:
- [ ] 07-01: TBD
- [ ] 07-02: TBD

### Phase 8: Self-Extension
**Goal**: User can describe new tool integrations in natural language and the bot builds, sandboxes, and deploys them — with human approval at every gate
**Depends on**: Phase 7
**Requirements**: EXT-01, EXT-02, EXT-03, EXT-04
**Success Criteria** (what must be TRUE):
  1. User describes a new integration in natural language ("I want a tool that checks Jira for cross-team dependencies every morning") and the bot generates a working implementation
  2. Generated tools execute in a Deno sandbox with explicit permissions — they cannot access filesystem, network, or data beyond what is granted
  3. No new tool enters the active registry without the user reviewing and explicitly approving it
  4. Tools that fail repeatedly (3+ consecutive failures) are automatically disabled and the user is notified with a summary of what went wrong
**Plans**: TBD

Plans:
- [ ] 08-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Infrastructure and Security Foundation | 0/2 | Not started | - |
| 2. Bot Shell and Agent Brain | 0/2 | Not started | - |
| 3. Core Integrations | 0/3 | Not started | - |
| 4. Knowledge Base | 0/2 | Not started | - |
| 5. Report Generation | 0/2 | Not started | - |
| 6. Ghost-Writing and Draft System | 0/2 | Not started | - |
| 7. Self-Learning | 0/2 | Not started | - |
| 8. Self-Extension | 0/1 | Not started | - |
