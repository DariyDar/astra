# Roadmap: Astra

## Overview

Astra is built in 11 phases following strict dependency order. Infrastructure and security come first. Bot shell and agent brain come second. All integrations are built on top of ready-made solutions and MCP servers — no custom connectors from scratch. Data flows from initial harvest (Phase 4) through user-guided refinement (Phase 5) into full ingestion (Phase 6), ensuring the knowledge base is grounded in reality before RAG and reports are layered on top.

**Design Principle: Prefer ready-made solutions and MCP over custom code.** Use existing MCP servers (Slack MCP, Gmail MCP, Google Drive MCP, ClickUp MCP, etc.) wherever available. Only build custom connectors when no suitable MCP exists or the available one is insufficient.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3...): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Infrastructure and Security Foundation** - Docker Compose stack, encrypted credentials, structured logging, single-model LLM integration (completed 2026-02-23)
- [x] **Phase 2: Bot Shell and Agent Brain** - Telegram + Slack bots, unified message router, MCP memory server, conversation context, notification preferences (completed 2026-02-25)
- [ ] **Phase 3: Core Integrations** - ClickUp, Gmail, Google Calendar, Google Drive — all via MCP; natural language task/email/calendar access
- [ ] **Phase 4: Initial Data Harvest** - Test ingestion from all sources (Slack, Gmail, Drive, ClickUp), entity extraction, populate initial knowledge base — foundation for interview phase
- [ ] **Phase 5: Interview and Entity Refinement** - Present extracted entities by category (people, projects, channels, project context) with LLM assumptions; user corrects and enriches; finalize knowledge base before full ingestion
- [ ] **Phase 6: Full Data Ingestion** - Slack + Gmail history (months), full ClickUp data, tiered by urgency and secrecy (additional tiers TBD); smart LLM batching by channel priority
- [ ] **Phase 7: Knowledge Base and RAG** - Hybrid search over ingested data, Google Drive document indexing, company terminology, query filtering by project
- [ ] **Phase 8: Report Generation** - Daily standups, weekly status, monthly summaries — draft-for-approval, bilingual output, powered by full knowledge base
- [ ] **Phase 9: Ghost-Writing and Draft System** - Slack DM and email monitoring, contextual draft responses, approve/edit/reject UX with reasoning, draft expiry
- [ ] **Phase 10: Self-Learning** - Correction capture, explicit preference teaching, behavioral pattern detection, persistent memory
- [ ] **Phase 11: Self-Extension** - Natural language tool generation, Deno sandbox, approval gating, auto-disable on failure

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
**Goal**: User can manage ClickUp tasks, triage Gmail, check Google Calendar, and query Google Drive through natural language — the full daily PM workflow works end-to-end via MCP
**Depends on**: Phase 2
**Design**: Use MCP servers for all integrations (ClickUp MCP, Gmail MCP, Google Calendar MCP, Google Drive MCP). Research and evaluate available MCP servers before building anything custom.
**Requirements**: CU-01, CU-02, CU-03, CU-04, CU-05, CU-06, MAIL-01, MAIL-02, MAIL-03, MAIL-04, MAIL-05, CAL-01, CAL-02, CAL-03, CAL-04, DRIVE-01, DRIVE-02
**Success Criteria** (what must be TRUE):
  1. User asks "what's overdue in Project Alpha?" and gets an accurate list of overdue ClickUp tasks fetched from API via MCP
  2. User says "create a task for John in Project Beta: review the GDD, due Friday" and a correctly populated task appears in ClickUp
  3. User asks "what's on my calendar today?" and sees a formatted schedule pulled from Google Calendar
  4. User asks "show me my priority emails" and gets a prioritized digest of unread Gmail messages classified by urgency
  5. User asks "find the GDD for Project Alpha" and gets the relevant document from Google Drive
  6. Bot proactively alerts about tasks approaching their deadline (within 24 hours) and overdue tasks
**Plans**: TBD

Plans:
- [ ] 03-01: TBD — MCP server research and setup (ClickUp, Gmail, Calendar, Drive)
- [ ] 03-02: TBD — Natural language routing to integrations
- [ ] 03-03: TBD — Proactive alerts and deadline monitoring

### Phase 4: Initial Data Harvest
**Goal**: Test ingestion from all connected sources to extract entities and build the initial knowledge base — prerequisite for the interview phase
**Depends on**: Phase 3 (all connectors must exist)
**Design**: Lightweight, bounded ingestion — not months of history, just enough to discover entities. Smart LLM batching: process by channel/source priority, not message-by-message.
**Success Criteria** (what must be TRUE):
  1. System ingests a bounded sample from each source (Slack channels, Gmail inbox, Google Drive, ClickUp) without manual intervention
  2. Entity extractor identifies people, projects, channels, and context from ingested data and stores them in categorized tables
  3. Each extracted entity has an LLM-generated assumption/summary (e.g., "John Smith — appears to be a developer on Project Alpha based on 12 Slack messages")
  4. User can see a count of extracted entities per category before proceeding to the interview phase
  5. Ingestion is idempotent — re-running does not create duplicates
**Plans**: TBD

Plans:
- [ ] 04-01: TBD — Entity schema (people, projects, channels, context), ingestion pipeline
- [ ] 04-02: TBD — Entity extraction worker with LLM batching

### Phase 5: Interview and Entity Refinement
**Goal**: User reviews all extracted entities with LLM assumptions, corrects errors, fills gaps, and adds context — producing a verified knowledge base before full ingestion
**Depends on**: Phase 4
**Design**: Conversational interview via Telegram/Slack. Present entities by category, one category at a time. User can confirm, correct, enrich, or delete. After interview, entities are marked as verified.
**Success Criteria** (what must be TRUE):
  1. User receives a structured list of all extracted entities grouped by category (people, projects, channels, project context, etc.)
  2. Each entity shows LLM assumptions with confidence level and source evidence ("seen in 12 Slack messages, 3 emails")
  3. User can correct any entity inline (e.g., "John is not a developer, he's the CEO") and the change persists
  4. User can add missing entities that were not auto-detected
  5. After interview completion, all entities are marked as verified and ready for full ingestion
  6. Interview is resumable — user can stop and continue later without losing progress
**Plans**: TBD

Plans:
- [ ] 05-01: TBD — Interview flow, entity presentation UI (Telegram/Slack)
- [ ] 05-02: TBD — Entity correction, enrichment, verification persistence

### Phase 6: Full Data Ingestion
**Goal**: Ingest complete history from all sources with tiered classification — producing a comprehensive, structured knowledge store
**Depends on**: Phase 5 (verified entity base guides classification)
**Design**: Months of Slack + Gmail + ClickUp history. Smart batching by channel/source priority. Two initial tiers: urgency (urgent/normal/low) and secrecy (private/internal/public). Additional tiers TBD based on Phase 5 learnings.
**Success Criteria** (what must be TRUE):
  1. System ingests full Slack history (configurable lookback, e.g. 6 months) across all accessible channels
  2. System ingests full Gmail history (configurable lookback) with thread reconstruction
  3. System ingests complete ClickUp task history including comments and attachments
  4. Every ingested item is classified by urgency tier and secrecy tier
  5. Smart batching ensures LLM processing stays within cost/rate limits — high-priority channels processed first
  6. Progress is resumable — partial ingestion can continue after interruption
**Plans**: TBD

Plans:
- [ ] 06-01: TBD — Full ingestion pipeline with tiering logic
- [ ] 06-02: TBD — Batching strategy and rate limiting

### Phase 7: Knowledge Base and RAG
**Goal**: User can ask questions about any ingested data and get accurate answers with source citations, powered by hybrid search
**Depends on**: Phase 6
**Design**: Qdrant for vector search, PostgreSQL for structured filters. Hybrid search combining semantic + keyword. Respect secrecy tiers in retrieval (don't surface private items in shared contexts).
**Success Criteria** (what must be TRUE):
  1. User asks "what did John say about the deadline last month?" and gets accurate answer with message source
  2. User can filter queries by project, source, or person
  3. Bot correctly understands company-specific terminology in queries (project names, people, jargon)
  4. Secrecy tiers are respected — private items never appear in responses unless explicitly requested
  5. When a document is updated in Google Drive, the knowledge base re-indexes it automatically
**Plans**: TBD

Plans:
- [ ] 07-01: TBD
- [ ] 07-02: TBD

### Phase 8: Report Generation
**Goal**: User can request project reports at any granularity and receive well-structured drafts for review in either language
**Depends on**: Phase 7
**Success Criteria** (what must be TRUE):
  1. User requests a daily standup for Project Alpha and gets a summary from ClickUp tasks and Slack activity
  2. User requests a weekly status report covering tasks, blockers, and risks
  3. Every report is a draft — user approves, edits, or rejects before it goes anywhere
  4. Reports available in Russian and English regardless of source data language
**Plans**: TBD

Plans:
- [ ] 08-01: TBD
- [ ] 08-02: TBD

### Phase 9: Ghost-Writing and Draft System
**Goal**: Bot monitors Slack DMs and emails, drafts contextual responses, presents for approval with reasoning — nothing sends without explicit user say-so
**Depends on**: Phase 8
**Success Criteria** (what must be TRUE):
  1. Urgent Slack DM triggers immediate notification with context summary and draft response
  2. Non-urgent DMs batched into periodic digest, each with draft response
  3. All outgoing communications appear as drafts with approve/edit/reject — nothing sends automatically
  4. Each draft includes bot's reasoning
  5. Drafts expire after 24 hours and are archived, not sent
**Plans**: TBD

Plans:
- [ ] 09-01: TBD
- [ ] 09-02: TBD

### Phase 10: Self-Learning
**Goal**: Bot learns from PM's corrections and explicit teachings, improving over time while preserving what it does well
**Depends on**: Phase 9
**Success Criteria** (what must be TRUE):
  1. When user edits a draft before approving, bot captures the diff and adjusts future drafts for similar contexts
  2. User can explicitly teach preferences and bot applies them in future without reminders
  3. Bot identifies recurring patterns and suggests automation
  4. Learned preferences persist across sessions and restarts
**Plans**: TBD

Plans:
- [ ] 10-01: TBD
- [ ] 10-02: TBD

### Phase 11: Self-Extension
**Goal**: User describes new tool integrations in natural language and bot builds, sandboxes, and deploys them with human approval at every gate
**Depends on**: Phase 10
**Success Criteria** (what must be TRUE):
  1. User describes integration in natural language and bot generates working implementation
  2. Generated tools execute in Deno sandbox with explicit permissions
  3. No new tool enters registry without user review and approval
  4. Tools that fail repeatedly (3+) are auto-disabled with failure summary
**Plans**: TBD

Plans:
- [ ] 11-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Infrastructure and Security Foundation | 2/2 | Complete    | 2026-02-23 |
| 2. Bot Shell and Agent Brain              | 5/5 | Complete    | 2026-02-25 |
| 3. Core Integrations                      | 0/3 | Not started | - |
| 4. Initial Data Harvest                   | 0/2 | Not started | - |
| 5. Interview and Entity Refinement        | 0/2 | Not started | - |
| 6. Full Data Ingestion                    | 0/2 | Not started | - |
| 7. Knowledge Base and RAG                 | 0/2 | Not started | - |
| 8. Report Generation                      | 0/2 | Not started | - |
| 9. Ghost-Writing and Draft System         | 0/2 | Not started | - |
| 10. Self-Learning                         | 0/2 | Not started | - |
| 11. Self-Extension                        | 0/1 | Not started | - |
