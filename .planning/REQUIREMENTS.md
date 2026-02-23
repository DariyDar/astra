# Requirements: Astra

**Defined:** 2026-02-23
**Core Value:** Eliminate PM routine so the senior PM can focus on decisions, strategy, and people

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Infrastructure

- [ ] **INFRA-01**: System runs as Docker Compose stack on VPS with all services (Qdrant, PostgreSQL, Redis, LiteLLM, bot, worker)
- [ ] **INFRA-02**: All API tokens encrypted at rest using AES-256-GCM
- [ ] **INFRA-03**: Structured JSON logging (Pino) with audit trail for all bot actions
- [ ] **INFRA-04**: Multi-LLM routing: Haiku for triage/classification, Sonnet for standard work, Opus for complex analysis
- [ ] **INFRA-05**: LLM fallback chains: if primary model unavailable, route to fallback automatically

### Messaging Interface

- [ ] **MSG-01**: User can interact with Astra via Telegram personal chat in Russian and English
- [ ] **MSG-02**: User can interact with Astra via Slack DM in Russian and English
- [ ] **MSG-03**: Bot detects message language automatically and responds in the same language
- [ ] **MSG-04**: Bot supports multi-step conversations with context retention within a session
- [ ] **MSG-05**: User can configure notification preferences (what types of proactive alerts to receive)

### ClickUp Integration

- [ ] **CU-01**: User can search tasks by natural language query ("what's overdue in Project Alpha?")
- [ ] **CU-02**: User can create tasks via bot ("create task X in project Y with deadline Z")
- [ ] **CU-03**: User can update task status, assignee, and due date via bot
- [ ] **CU-04**: Bot monitors deadlines and alerts user about approaching (24h) and overdue tasks
- [ ] **CU-05**: User can request task summary for any project/space ("show me Project Alpha status")
- [ ] **CU-06**: Bot navigates ClickUp spaces/folders/lists using fuzzy name matching (no IDs required)

### Gmail Integration

- [ ] **MAIL-01**: Bot classifies incoming emails by priority (urgent/important/normal/low)
- [ ] **MAIL-02**: Bot generates digest of unread priority emails on demand
- [ ] **MAIL-03**: Bot drafts responses to emails using project context and communication history
- [ ] **MAIL-04**: Bot analyzes email threads and extracts key points and action items
- [ ] **MAIL-05**: Bot acts as ghost-writer for Gmail: prioritizes incoming, urgent — immediate alert with draft, rest — batched digest

### Google Calendar

- [ ] **CAL-01**: User can ask "what's on my calendar today/this week?" and get formatted schedule
- [ ] **CAL-02**: Bot sends configurable reminders before meetings (default: 15 min)
- [ ] **CAL-03**: User can create calendar events via bot ("schedule meeting with X on Tuesday at 3pm")
- [ ] **CAL-04**: Bot checks availability before suggesting meeting times

### Google Drive

- [ ] **DRIVE-01**: Bot indexes documents from specified Drive folders into RAG knowledge base
- [ ] **DRIVE-02**: User can ask questions about document content ("what does the GDD say about monetization?")
- [ ] **DRIVE-03**: Bot tracks document freshness and flags potentially outdated documents (not modified in N months)
- [ ] **DRIVE-04**: Bot re-indexes documents incrementally when they change (via Drive Changes API)

### Knowledge Base

- [ ] **KB-01**: RAG-based knowledge base aggregating data from Drive, Slack, Gmail, ClickUp
- [ ] **KB-02**: User can ask contextual questions and get answers with source citations
- [ ] **KB-03**: Knowledge base supports hybrid search (semantic + keyword) with per-project filtering
- [ ] **KB-04**: Bot understands company-specific terminology (gamedev jargon, project names, people)

### Report Generation

- [ ] **RPT-01**: User can request daily standup summary for any project (aggregated from ClickUp + Slack)
- [ ] **RPT-02**: User can request weekly status report for any project (tasks, blockers, progress)
- [ ] **RPT-03**: User can request monthly summary report (trends, completed milestones, risks)
- [ ] **RPT-04**: Reports generated as drafts for user review before sharing
- [ ] **RPT-05**: Reports support both Russian and English output regardless of source data language

### Ghost-Writing (Slack DM)

- [ ] **GW-01**: Bot monitors incoming Slack DMs and classifies by urgency
- [ ] **GW-02**: Urgent messages trigger immediate notification with context summary and draft response
- [ ] **GW-03**: Non-urgent messages batched into periodic digest with draft responses
- [ ] **GW-04**: User approves, edits, or rejects each draft before sending
- [ ] **GW-05**: Ghost-written responses use project context and communication history for relevance

### Self-Learning

- [ ] **LEARN-01**: Bot captures user corrections when drafts are edited before approval
- [ ] **LEARN-02**: User can explicitly teach bot preferences ("always CC John on Project Alpha emails")
- [ ] **LEARN-03**: Bot detects recurring behavioral patterns and suggests workflow automation
- [ ] **LEARN-04**: Bot stores learned preferences persistently across sessions

### Self-Extension

- [ ] **EXT-01**: Bot can generate new tool integrations from natural language descriptions
- [ ] **EXT-02**: Generated tools execute in sandboxed environment (Deno with explicit permissions)
- [ ] **EXT-03**: User must approve any new tool before it enters active registry
- [ ] **EXT-04**: Tools that fail repeatedly are auto-disabled with user notification

### Draft-First Output

- [ ] **DRAFT-01**: All outgoing communications (emails, Slack messages, reports) shown as drafts
- [ ] **DRAFT-02**: User can approve, edit, or reject each draft via inline buttons
- [ ] **DRAFT-03**: Drafts expire after 24 hours if not acted upon
- [ ] **DRAFT-04**: Bot explains reasoning/context for each draft ("I wrote this because...")

## v2 Requirements

### PM Team Oversight

- **PMO-01**: Bot monitors whether other PMs conduct daily standups
- **PMO-02**: Bot checks if PMs keep ClickUp tasks updated (no stale tasks)
- **PMO-03**: Bot generates per-PM performance digest (tasks closed, updates posted, response times)
- **PMO-04**: Bot alerts when PM's project has tasks overdue beyond threshold

### Scheduled Reports

- **SCHED-01**: Automated daily standup generation every morning
- **SCHED-02**: Automated weekly status report generation every Friday
- **SCHED-03**: Automated monthly summary generation on 1st of month

### Advanced Calendar

- **CAL-05**: Proactive meeting prep (agenda suggestions based on project context)
- **CAL-06**: Post-meeting action item extraction from notes/transcripts

### Auto-Send Capability

- **AUTO-01**: User can designate categories of messages for auto-send without approval
- **AUTO-02**: Configurable auto-send rules with confidence thresholds

## Out of Scope

| Feature | Reason |
|---------|--------|
| Mobile app | Telegram and Slack are the mobile interfaces |
| Voice/video transcription | High complexity, specialized tools exist (Otter.ai, Fireflies) |
| Client-facing chatbot | Astra serves the PM, not clients directly |
| CI/CD or code review integration | Not a development tool |
| Built-in task tracker / Kanban | ClickUp is the task tracker, Astra augments it |
| HR/performance management | Out of domain for PM assistant |
| Multi-tenant SaaS | Single user (PM) tool, not a product for sale |
| Public integration marketplace | Self-extension is internal only |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | Phase 1 | Pending |
| INFRA-02 | Phase 1 | Pending |
| INFRA-03 | Phase 1 | Pending |
| INFRA-04 | Phase 1 | Pending |
| INFRA-05 | Phase 1 | Pending |
| MSG-01 | Phase 2 | Pending |
| MSG-02 | Phase 2 | Pending |
| MSG-03 | Phase 2 | Pending |
| MSG-04 | Phase 2 | Pending |
| MSG-05 | Phase 2 | Pending |
| CU-01 | Phase 3 | Pending |
| CU-02 | Phase 3 | Pending |
| CU-03 | Phase 3 | Pending |
| CU-04 | Phase 3 | Pending |
| CU-05 | Phase 3 | Pending |
| CU-06 | Phase 3 | Pending |
| MAIL-01 | Phase 3 | Pending |
| MAIL-02 | Phase 3 | Pending |
| MAIL-03 | Phase 3 | Pending |
| MAIL-04 | Phase 3 | Pending |
| MAIL-05 | Phase 3 | Pending |
| CAL-01 | Phase 3 | Pending |
| CAL-02 | Phase 3 | Pending |
| CAL-03 | Phase 3 | Pending |
| CAL-04 | Phase 3 | Pending |
| DRIVE-01 | Phase 4 | Pending |
| DRIVE-02 | Phase 4 | Pending |
| DRIVE-03 | Phase 4 | Pending |
| DRIVE-04 | Phase 4 | Pending |
| KB-01 | Phase 4 | Pending |
| KB-02 | Phase 4 | Pending |
| KB-03 | Phase 4 | Pending |
| KB-04 | Phase 4 | Pending |
| RPT-01 | Phase 5 | Pending |
| RPT-02 | Phase 5 | Pending |
| RPT-03 | Phase 5 | Pending |
| RPT-04 | Phase 5 | Pending |
| RPT-05 | Phase 5 | Pending |
| GW-01 | Phase 6 | Pending |
| GW-02 | Phase 6 | Pending |
| GW-03 | Phase 6 | Pending |
| GW-04 | Phase 6 | Pending |
| GW-05 | Phase 6 | Pending |
| DRAFT-01 | Phase 6 | Pending |
| DRAFT-02 | Phase 6 | Pending |
| DRAFT-03 | Phase 6 | Pending |
| DRAFT-04 | Phase 6 | Pending |
| LEARN-01 | Phase 7 | Pending |
| LEARN-02 | Phase 7 | Pending |
| LEARN-03 | Phase 7 | Pending |
| LEARN-04 | Phase 7 | Pending |
| EXT-01 | Phase 8 | Pending |
| EXT-02 | Phase 8 | Pending |
| EXT-03 | Phase 8 | Pending |
| EXT-04 | Phase 8 | Pending |

**Coverage:**
- v1 requirements: 55 total
- Mapped to phases: 55
- Unmapped: 0

---
*Requirements defined: 2026-02-23*
*Last updated: 2026-02-23 after roadmap creation*
