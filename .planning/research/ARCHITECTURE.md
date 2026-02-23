# Architecture Research

**Domain:** AI-powered PM assistant with multi-channel messaging, RAG knowledge base, and workflow automation
**Researched:** 2026-02-23
**Confidence:** HIGH

## Standard Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Interface Layer                          │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐               │
│  │ Telegram  │  │   Slack   │  │  Web API  │               │
│  │  (grammY) │  │  (Bolt)   │  │ (future)  │               │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘               │
│        │              │              │                      │
├────────┴──────────────┴──────────────┴──────────────────────┤
│                   Message Router                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Unified Message Bus (normalize → classify → route) │    │
│  └──────────────────────┬──────────────────────────────┘    │
├─────────────────────────┴───────────────────────────────────┤
│                    Agent Layer                               │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐               │
│  │  LLM      │  │ LangGraph │  │  Tool     │               │
│  │  Router   │  │ Workflows │  │ Registry  │               │
│  │ (LiteLLM) │  │ (stateful)│  │ (dynamic) │               │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘               │
│        │              │              │                      │
├────────┴──────────────┴──────────────┴──────────────────────┤
│                  Integration Layer                           │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐   │
│  │ClickUp │ │ Gmail  │ │  GCal  │ │ GDrive │ │ Slack  │   │
│  │ Client │ │ Client │ │ Client │ │ Client │ │  API   │   │
│  └────┬───┘ └────┬───┘ └────┬───┘ └────┬───┘ └────┬───┘   │
│       │          │          │          │          │        │
├───────┴──────────┴──────────┴──────────┴──────────┴────────┤
│                   Memory Layer                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │  Qdrant  │  │ Postgres │  │  Redis   │  │  BullMQ  │   │
│  │ (vector) │  │(episodic)│  │ (cache)  │  │ (queue)  │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| Telegram Bot | User interface via personal chat with PM | grammY + conversations plugin, long-polling |
| Slack Bot | Workspace interface, DM monitoring, channel monitoring | @slack/bolt + Socket Mode |
| Message Router | Normalize messages from all channels into unified format, classify intent, route to handler | Custom TypeScript module with Zod schemas |
| LLM Router | Select cheapest adequate model per request complexity | LiteLLM proxy with Haiku/Sonnet/Opus tiers |
| LangGraph Workflows | Stateful multi-step operations (report gen, email triage, ghost-writing) | LangGraph with PostgreSQL checkpointing |
| Tool Registry | Dynamic registry of integrations the agent can call | Custom ToolRegistry with Zod-validated tools |
| ClickUp Client | Task CRUD, deadline monitoring, report data extraction | Typed fetch wrapper over ClickUp API v2 |
| Gmail Client | Email reading, priority classification, draft creation | googleapis with OAuth2 |
| GCal Client | Calendar reading, availability checking, event creation | googleapis with OAuth2 |
| GDrive Client | Document indexing, actuality assessment, content extraction | googleapis + document parsers |
| Qdrant | Semantic memory — RAG over all ingested knowledge | Qdrant Docker with hybrid search |
| PostgreSQL | Structured data — users, preferences, feedback, audit log, episodic memory | PostgreSQL 16 + Drizzle ORM |
| Redis | Session state, caches, pub/sub for real-time events | Redis 7.2 |
| BullMQ | Job scheduling — cron reports, ingestion, notification delivery | BullMQ 5.x with priority queues |

## Recommended Project Structure

```
astra/
├── packages/
│   ├── core/                 # Shared types, config, utilities
│   │   ├── src/
│   │   │   ├── config.ts     # Environment validation (Zod)
│   │   │   ├── types.ts      # Shared interfaces
│   │   │   └── logger.ts     # Pino logger setup
│   │   └── package.json
│   ├── agent/                # LLM agent engine
│   │   ├── src/
│   │   │   ├── router.ts     # Intent classification + model selection
│   │   │   ├── workflows/    # LangGraph workflow definitions
│   │   │   │   ├── email-triage.ts
│   │   │   │   ├── report-gen.ts
│   │   │   │   ├── ghost-writer.ts
│   │   │   │   └── task-manager.ts
│   │   │   ├── tools/        # Tool definitions for agent
│   │   │   │   ├── registry.ts
│   │   │   │   ├── clickup.ts
│   │   │   │   ├── gmail.ts
│   │   │   │   ├── calendar.ts
│   │   │   │   ├── drive.ts
│   │   │   │   └── slack.ts
│   │   │   └── memory/       # Memory management
│   │   │       ├── episodic.ts
│   │   │       ├── semantic.ts
│   │   │       └── feedback.ts
│   │   └── package.json
│   ├── telegram/             # Telegram bot interface
│   │   ├── src/
│   │   │   ├── bot.ts        # grammY setup
│   │   │   ├── conversations/ # Multi-step flows (approval, config)
│   │   │   ├── handlers/     # Command and message handlers
│   │   │   └── i18n/         # RU/EN translations
│   │   └── package.json
│   ├── slack/                # Slack bot interface
│   │   ├── src/
│   │   │   ├── app.ts        # Bolt setup
│   │   │   ├── listeners/    # Event, message, action handlers
│   │   │   └── dm-monitor.ts # DM ghost-writing monitor
│   │   └── package.json
│   ├── integrations/         # External service clients
│   │   ├── src/
│   │   │   ├── clickup/      # ClickUp API wrapper
│   │   │   ├── google/       # Gmail, Calendar, Drive shared auth
│   │   │   └── shared/       # OAuth token manager, rate limiter
│   │   └── package.json
│   ├── rag/                  # RAG pipeline
│   │   ├── src/
│   │   │   ├── ingest/       # Document ingestion per source
│   │   │   ├── search.ts     # Agentic RAG search
│   │   │   ├── chunker.ts    # Semantic chunking
│   │   │   └── reranker.ts   # Result re-ranking
│   │   └── package.json
│   └── queue/                # Job definitions and workers
│       ├── src/
│       │   ├── jobs/         # Job definitions (report, sync, ingest)
│       │   ├── scheduler.ts  # Cron job setup
│       │   └── worker.ts     # BullMQ worker entry
│       └── package.json
├── apps/
│   ├── bot/                  # Main bot process (Telegram + Slack)
│   │   ├── src/
│   │   │   └── index.ts      # Startup: init both bots + agent
│   │   └── package.json
│   └── worker/               # Background worker process
│       ├── src/
│       │   └── index.ts      # Startup: BullMQ workers
│       └── package.json
├── docker/
│   ├── docker-compose.yml    # All services orchestration
│   ├── Dockerfile.bot        # Bot process image
│   └── Dockerfile.worker     # Worker process image
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── .env.example
```

### Structure Rationale

- **packages/**: Monorepo with pnpm workspaces. Each package has clear boundaries and can be tested independently. `agent` is the brain, `telegram` and `slack` are the mouths, `integrations` are the hands, `rag` is the memory, `queue` is the scheduler.
- **apps/**: Two deployable processes — `bot` (user-facing, always on) and `worker` (background jobs, can restart without affecting chat). Separating these means a stuck ingestion job doesn't freeze the chat bot.
- **docker/**: Single docker-compose for VPS deployment. All infrastructure (Qdrant, Postgres, Redis, LiteLLM, n8n) runs alongside the two app processes.

## Architectural Patterns

### Pattern 1: Unified Message Envelope

**What:** All incoming messages (Telegram, Slack, email) normalized into a single `MessageEnvelope` before reaching the agent.
**When to use:** Always — the agent should never know which channel a message came from.
**Trade-offs:** Adds a normalization step (+5ms latency) but massively simplifies agent logic and enables channel-agnostic workflows.

```typescript
interface MessageEnvelope {
  id: string
  source: 'telegram' | 'slack' | 'gmail' | 'system'
  userId: string
  text: string
  language: 'ru' | 'en'
  replyTo?: string          // for threaded conversations
  attachments?: Attachment[]
  metadata: Record<string, unknown>  // channel-specific data
  timestamp: Date
}
```

### Pattern 2: Draft-First Output

**What:** All outgoing communications pass through a draft queue. The agent never sends directly — it creates a draft, notifies the user, and waits for approval.
**When to use:** All external communications in v1. Internal notifications (reminders to user) can bypass.
**Trade-offs:** Adds friction to every output action. Essential for trust-building. Can be relaxed per-category once the user approves.

```typescript
interface DraftEnvelope {
  id: string
  target: { channel: 'slack' | 'gmail'; recipient: string }
  content: string
  context: string            // why the agent wrote this
  priority: 'urgent' | 'normal' | 'low'
  status: 'pending' | 'approved' | 'rejected' | 'edited'
  createdAt: Date
  expiresAt: Date           // drafts expire after 24h
}
```

### Pattern 3: Event-Driven Ingestion

**What:** All data sources feed into a unified ingestion pipeline via BullMQ. New emails, Slack messages, ClickUp changes, Drive document updates — all become ingestion jobs.
**When to use:** For building and maintaining the knowledge base.
**Trade-offs:** Near-real-time (seconds delay) vs real-time. Acceptable for a PM assistant where 30-second-old data is perfectly fine.

## Data Flow

### User Query Flow

```
[User message in Telegram/Slack]
    ↓
[Message Router] → normalize to MessageEnvelope
    ↓
[Intent Classifier] (Haiku — fast, cheap)
    ↓ returns: intent + complexity + required_tools
[Model Router] → select LLM tier based on complexity
    ↓
[Agent Engine] (Sonnet/Opus)
    ↓ calls tools as needed
[Tool Registry] → ClickUp, Gmail, Calendar, Drive, RAG search
    ↓ collects results
[Agent Engine] → generates response
    ↓
[Output Router]
    ├── [Direct response] → back to user in same channel
    └── [Draft] → draft queue → notify user → wait approval
```

### Background Processing Flow

```
[Cron Scheduler / Webhook / Event]
    ↓
[BullMQ Job Queue]
    ↓ (worker picks up)
[Job Handler]
    ├── [Ingestion] → parse → chunk → embed → store in Qdrant
    ├── [Report Gen] → gather data → LLM summarize → create draft
    ├── [Deadline Check] → query ClickUp → evaluate → alert if needed
    └── [Sync] → pull latest from Gmail/Calendar/Drive → update stores
```

### Knowledge Ingestion Flow

```
[Source: Drive/Slack/Gmail/ClickUp]
    ↓ (webhook or poll)
[Ingestion Queue] (BullMQ, low priority)
    ↓
[Parser] → extract text, metadata
    ↓
[Chunker] → semantic chunking with metadata enrichment
    ↓
[Embedder] → text-embedding-3-small
    ↓
[Qdrant] → upsert with payload metadata (source, project, date, author)
    ↓
[PostgreSQL] → update ingestion log (for staleness tracking)
```

### Key Data Flows

1. **Morning briefing:** Cron (8:00 AM) → BullMQ job → gather: Calendar events today, overdue ClickUp tasks, unread priority emails, Slack DM queue → LLM summarize → draft to Telegram
2. **Ghost-writing:** Slack DM arrives → event → classify priority → if urgent: immediate notification + draft. If normal: batch into digest → show drafts on demand
3. **Report generation:** User asks "weekly report for Project X" → Agent queries ClickUp (tasks completed/in progress/blocked), Slack (#project-x messages), Drive (recent doc updates) → LLM synthesizes → draft for approval
4. **Self-learning feedback:** User edits draft before approving → diff captured → preference extracted → stored in PostgreSQL → injected into future prompts for similar contexts

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1 PM (current) | Single VPS, monolith processes, all Docker Compose. This is the target. |
| 3 PMs | Same architecture, add per-user config/preferences in PostgreSQL. Qdrant collections partitioned by user. |
| 10+ PMs | Separate bot and worker to dedicated containers. Redis Cluster. Consider managed Qdrant Cloud. |

### Scaling Priorities

1. **First bottleneck:** LLM API rate limits. Morning briefing for 3 PMs simultaneously hits Claude API hard. Fix: stagger jobs by 2 min, use BullMQ rate limiter.
2. **Second bottleneck:** Qdrant memory on VPS. 8 projects × thousands of docs/messages = millions of vectors. Fix: aggressive TTL on Slack message vectors (90 days), keep Drive docs permanently.

## Anti-Patterns

### Anti-Pattern 1: God Agent

**What people do:** One massive system prompt with all tool definitions, all context, all instructions.
**Why it's wrong:** Exceeds context window, confuses the model, slow, expensive.
**Do this instead:** Use LangGraph to route to specialized sub-graphs. Email triage agent only sees email tools. Report agent only sees data-gathering tools.

### Anti-Pattern 2: Real-Time Everything

**What people do:** WebSocket connections to every service, processing every event immediately.
**Why it's wrong:** Creates notification storm, wastes LLM tokens on irrelevant events, complex error handling.
**Do this instead:** Event-driven with BullMQ. Batch non-urgent events. Only urgent items (high-priority emails, imminent deadlines) bypass the queue.

### Anti-Pattern 3: Storing Raw API Responses

**What people do:** Dump full ClickUp task JSON / Gmail message objects into the knowledge base.
**Why it's wrong:** Bloats vector store with irrelevant fields. Embeddings of JSON are terrible.
**Do this instead:** Extract meaningful text + structured metadata. Store human-readable summaries as vector content, keep structured data in PostgreSQL.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| ClickUp API v2 | REST + Webhooks | 100 req/min rate limit. Use webhooks for real-time task changes. |
| Gmail API | REST + Push notifications (pub/sub) | OAuth2 with refresh. Push via Google Cloud Pub/Sub for new emails. |
| Google Calendar | REST + polling | OAuth2 shared with Gmail. Poll every 5 min (push requires public endpoint). |
| Google Drive | REST + Changes API | OAuth2 shared. Use `changes.watch` for document updates. |
| Slack API | Events API via Socket Mode | No public endpoint needed. Subscribe to `message.im` for DM monitoring. |
| Anthropic API | REST via LiteLLM | Route through LiteLLM proxy for model selection and fallback. |
| OpenAI API | REST via LiteLLM | Embeddings and fallback models. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Bot ↔ Agent | Direct function call (same process) | Agent returns response or draft |
| Bot ↔ Worker | BullMQ job queue (Redis) | Async, decoupled. Worker results stored in PostgreSQL. |
| Agent ↔ Integrations | Tool calls via Tool Registry | Each tool is a typed async function |
| Agent ↔ Memory | Direct query to Qdrant + PostgreSQL | RAG search returns ranked chunks with sources |
| Worker ↔ Integrations | Direct API calls | Background sync jobs |

## Build Order (Dependencies)

```
Phase 1: Foundation
├── packages/core (types, config, logger)
├── PostgreSQL + Redis + Qdrant (Docker)
└── LiteLLM proxy setup

Phase 2: Bot Shell
├── packages/telegram (basic grammY bot)
├── packages/slack (basic Bolt bot)
└── Message Router (unified envelope)

Phase 3: Agent Brain
├── packages/agent (Anthropic SDK + basic tool loop)
├── Intent classifier
└── Model routing

Phase 4: Integrations
├── packages/integrations/clickup
├── packages/integrations/google (shared auth)
├── Gmail, Calendar, Drive clients
└── Tool definitions in agent

Phase 5: Knowledge Base
├── packages/rag (ingestion pipeline)
├── Chunking + embedding
└── Agentic RAG search

Phase 6: Background Processing
├── packages/queue (BullMQ setup)
├── Scheduled jobs (reports, sync, alerts)
└── Event processing (webhooks)

Phase 7: Ghost-Writing + Self-Learning
├── Draft queue + approval flow
├── Feedback capture
└── Preference learning
```

## Sources

- Anthropic Agent SDK documentation
- LangGraph documentation (TypeScript)
- grammY framework documentation
- @slack/bolt SDK documentation
- Google APIs documentation (Gmail, Calendar, Drive)
- ClickUp API v2 documentation
- Qdrant documentation
- BullMQ documentation
- LiteLLM documentation

---
*Architecture research for: AI PM assistant (Astra)*
*Researched: 2026-02-23*
