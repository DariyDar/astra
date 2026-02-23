# Astra

## What This Is

Astra is an AI-powered Project Management assistant for a senior PM in a gamedev company. It lives in Telegram and Slack, connects to ClickUp, Gmail, Google Calendar, and Google Drive, and acts as an intelligent co-pilot that handles PM routine: communication drafting, report generation, task tracking, calendar management, email triage, document management, and team oversight. Astra learns from explicit feedback and behavioral observation, and can extend its own capabilities through a sandboxed plugin system.

## Core Value

Astra eliminates PM routine so the senior PM can focus on decisions, strategy, and people — not on copying data between tools, writing repetitive updates, and chasing deadlines manually.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Telegram bot interface with full conversational capabilities (RU + EN)
- [ ] Slack bot interface with channel monitoring and DM support
- [ ] ClickUp integration: read tasks, create tasks, update statuses, track deadlines, generate reports
- [ ] Gmail integration: email triage with priority detection, draft responses, thread analysis
- [ ] Google Calendar integration: read schedule, remind about meetings, suggest scheduling, check availability
- [ ] Google Drive integration: index documents, assess actuality, understand project context from docs
- [ ] Company knowledge base: persistent RAG-based memory across all sources (Drive, Slack, Gmail, ClickUp)
- [ ] Report generation: daily standups for team, weekly status for clients, monthly summaries for leadership
- [ ] Ghost writer for Slack DM and Gmail: prioritize incoming messages, draft responses, alert on urgent items
- [ ] Proactive notifications: configurable alerts for deadlines, meetings, overdue tasks, important messages
- [ ] PM team oversight: monitor whether 2 other PMs follow processes, update tasks, meet deadlines
- [ ] Multi-LLM routing: cheap model for routine, powerful model for complex analysis
- [ ] Self-learning: explicit feedback loop + behavioral pattern detection + workflow automation suggestions
- [ ] Self-extension: bot can generate new tools/integrations in a sandboxed environment (Deno)
- [ ] Draft-first approach: all outgoing communications shown as drafts for approval before sending

### Out of Scope

- Mobile app — Telegram and Slack are the mobile interfaces
- Direct client-facing chatbot — Astra serves the PM, not clients directly
- Code review / CI-CD integration — not a development tool
- Auto-sending messages without approval in v1 — safety first, trust must be earned
- Voice/video call transcription — complex, defer to specialized tools (Otter.ai, Fireflies)

## Context

**Environment:**
- Gamedev company, ~8 active projects, 2 PMs reporting to the user
- Projects use ClickUp with 1 Space per project structure
- Communication: Slack for team (RU), clients on English
- Standups: mix of sync calls and async updates depending on project
- Reports: daily to team, weekly to clients, monthly to leadership
- Google Drive: mixed content (docs, sheets, presentations, files) across projects

**User profile:**
- Senior PM who manages projects directly and oversees other PMs
- Typical day: base routine (mail, Slack, standups, tasks, meetings, updates) frequently interrupted by urgent requests
- Will maintain the system using AI assistants — complexity is not a constraint
- Wants comprehensive automation of all routine PM tasks

**Technical infrastructure:**
- VPS/VDS server available for deployment
- Hybrid LLM subscription: cheap model for routine + powerful model for complex tasks
- Self-hosted preferred for data storage (security: moderate — encrypted tokens, audit log, access controls)

**Research completed:**
- Extensive market research on PM automation tools, frameworks, and architectures conducted
- Recommended stack: TypeScript + grammY (Telegram) + @slack/bolt (Slack) + Anthropic Agent SDK + LangGraph + LiteLLM + Qdrant + PostgreSQL + BullMQ + Redis + n8n
- Key references: Lindy.ai, Dust.tt, Composio for inspiration

## Constraints

- **Languages**: Must support Russian and English for all generated content
- **Security**: All data stored self-hosted (Qdrant, PostgreSQL, Redis). Only LLM API calls go external
- **Approval**: All outgoing communications require user approval in v1 (draft-first)
- **Budget**: LLM costs estimated $25-75/month with tiered model routing
- **APIs**: ClickUp rate limit 100 req/min, Gmail/Calendar OAuth required, Google Drive API for indexing
- **Privacy**: Bot has access to sensitive PM data — tokens encrypted, audit logging required

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| TypeScript as primary language | Type safety, single stack for bot + integrations, rich async ecosystem | — Pending |
| grammY for Telegram | Best TypeScript DX, conversations plugin, runs everywhere | — Pending |
| @slack/bolt for Slack | Official SDK, Socket Mode for dev, battle-tested | — Pending |
| Anthropic Agent SDK + LangGraph | Best Claude integration + stateful workflows with persistence | — Pending |
| LiteLLM for model routing | Multi-provider, fallbacks, cost tracking, self-hosted | — Pending |
| Qdrant for vector DB | Best filtering, hybrid search, self-hosted, free | — Pending |
| PostgreSQL for structured data | Episodic memory, user preferences, audit log | — Pending |
| BullMQ + Redis for events | TypeScript-native queues, priority, scheduling | — Pending |
| n8n for visual workflows | 400+ integrations, AI nodes, self-hosted, PM can modify | — Pending |
| Deno for sandboxed tools | Permissions model for bot-generated code safety | — Pending |
| Draft-first for all outbound | Safety — build trust before allowing auto-send | — Pending |
| Composio for rapid integrations | 250+ pre-built tool integrations, handles OAuth | — Pending |

---
*Last updated: 2026-02-23 after initialization*
