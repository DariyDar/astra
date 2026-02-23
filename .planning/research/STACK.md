# Astra — Technology Stack Research

**Project:** Astra — AI PM Assistant for gamedev company
**Research Type:** Stack dimension — greenfield implementation
**Date:** 2026-02-23
**Researcher:** gsd-project-researcher agent
**Feeds into:** Roadmap creation, architecture decisions

---

## Executive Summary

Astra is a TypeScript-native AI assistant that bridges Telegram, Slack, and PM tooling (ClickUp, Gmail, Google Calendar, Google Drive) with an LLM orchestration layer and a persistent RAG knowledge base. The recommended stack is purpose-built for this exact profile: event-driven, AI-native, self-hosted, bilingual (RU+EN), with strong type safety throughout.

**Core stack verdict:** TypeScript monorepo + grammY + @slack/bolt + Anthropic SDK + LangGraph + LiteLLM + Qdrant + PostgreSQL + BullMQ/Redis + n8n (optional workflow layer) + Deno (sandboxed plugins).

---

## Stack Dimensions

### 1. Runtime & Language

| Choice | Version | Confidence |
|--------|---------|-----------|
| **Node.js** | 22 LTS (current as of 2025) | HIGH |
| **TypeScript** | 5.5+ | HIGH |
| **Package manager** | pnpm 9.x | HIGH |

**Rationale:**
- TypeScript provides compile-time safety for complex integration code, catching type mismatches between LLM outputs and structured data early.
- Node.js 22 LTS has native `--watch` mode, improved WebSocket performance, and full ESM support — all relevant for long-running bot processes.
- pnpm is faster than npm/yarn for monorepos and has better workspace support with `pnpm-workspace.yaml`.

**NOT recommended:**
- Bun as primary runtime — despite speed advantages, ecosystem compatibility issues with some LangChain packages persist as of mid-2025. Use only for build tooling if needed.
- Python — valid for AI/ML projects but splits the stack. Given TypeScript-native Anthropic SDK, LangGraph JS, and grammY, staying in one language eliminates context-switching and simplifies deployment.

---

### 2. Project Structure

| Choice | Approach | Confidence |
|--------|---------|-----------|
| **Monorepo** | pnpm workspaces | HIGH |
| **Build** | tsx (dev) + esbuild (prod) | HIGH |

**Recommended workspace layout:**
```
packages/
  core/         # LLM orchestration, agent logic
  telegram/     # grammY bot
  slack/        # @slack/bolt app
  integrations/ # ClickUp, Gmail, Calendar, Drive adapters
  rag/          # Qdrant ingestion + retrieval
  memory/       # PostgreSQL session + episodic store
  queue/        # BullMQ job definitions
  shared/       # Zod schemas, types, utilities
apps/
  api/          # Optional REST API for webhooks
  worker/       # Background job runner
```

**Rationale:** A monorepo lets all packages share Zod schemas, LLM types, and configuration without duplication. Each package can be independently deployed — the Telegram bot process, Slack bot process, and worker process run separately on the same VPS.

---

### 3. Telegram Bot Framework

| Choice | Version | Confidence |
|--------|---------|-----------|
| **grammY** | 1.29+ | HIGH |

**Key plugins:**
- `@grammyjs/conversations` 2.x — stateful multi-step dialogs (approval flows, onboarding)
- `@grammyjs/menu` 1.x — inline keyboard menus for draft approval UI
- `@grammyjs/storage-redis` — session persistence in Redis
- `@grammyjs/hydrate` — convenience typed access to message objects
- `@grammyjs/i18n` — bilingual (RU/EN) message templates with Fluent format

**Rationale:**
- grammY is the dominant TypeScript-first Telegram framework as of 2025, surpassing Telegraf in DX, TypeScript support, and active maintenance.
- The `conversations` plugin is critical for Astra's approval flow: "show draft → user reviews → approve/edit/reject" is a multi-step stateful conversation, not a one-shot command.
- Storage adapters enable session state to survive bot restarts — essential for long-running approval sessions.

**NOT recommended:**
- Telegraf — older API, weaker TypeScript types, slower ecosystem evolution as of 2025.
- node-telegram-bot-api — low-level, no conversation state management, requires building everything from scratch.

---

### 4. Slack Bot Framework

| Choice | Version | Confidence |
|--------|---------|-----------|
| **@slack/bolt** | 4.x | HIGH |

**Key modules:**
- Socket Mode — for development/VPS without public HTTPS endpoint on startup
- Events API — for monitoring channel messages and DMs for ghost-writing triggers
- `@slack/web-api` 7.x — direct API calls for message posting, user lookups

**Rationale:**
- @slack/bolt is Slack's official SDK, actively maintained, with full TypeScript types in v4.
- Socket Mode eliminates the need for a publicly accessible webhook during development, simplifying VPS setup.
- The Events API subscription model (rather than polling) is efficient and respects Slack rate limits.

**NOT recommended:**
- Slackify or other community wrappers — less maintained, narrower API coverage.
- Building on raw HTTP — Bolt handles retry logic, signature verification, and OAuth automatically.

---

### 5. LLM Orchestration

| Choice | Version | Confidence |
|--------|---------|-----------|
| **Anthropic SDK** | `@anthropic-ai/sdk` 0.27+ | HIGH |
| **LangGraph (JS)** | `@langchain/langgraph` 0.2+ | HIGH |
| **LiteLLM** | `litellm` (Python proxy) or `@litellm/proxy` Docker image | MEDIUM |

#### 5a. Anthropic SDK

**Rationale:**
- Claude is the primary LLM for Astra. The native SDK provides streaming, tool use, batch processing, and the Claude-native format for system prompts.
- Claude's tool use (function calling) API is the mechanism for connecting LLM reasoning to ClickUp/Gmail/Calendar/Drive operations.
- No abstraction layer needed for primary LLM — use SDK directly in `packages/core`.

#### 5b. LangGraph JS

**Rationale:**
- LangGraph provides stateful, persistent multi-step workflows with checkpointing. Astra's agent needs to pause mid-task (show draft → wait for approval → resume), which requires explicit state machines.
- Checkpointing to PostgreSQL means in-progress tasks survive process restarts.
- The graph structure (nodes + edges) maps cleanly onto Astra's workflow logic: intake → classify → route → execute → draft → approve → send.
- LangGraph 0.2 introduced significant stability improvements and better TypeScript types.

**NOT recommended:**
- LangChain without LangGraph — LangChain's sequential chains and agents lack the persistence and state machine capabilities needed for Astra's approval flows.
- AutoGen / CrewAI — Python-only (as of mid-2025), creating a split stack.
- Raw prompt chaining without a framework — workable for simple tasks, but breaks down quickly with multi-step workflows, retries, and state recovery.

#### 5c. LiteLLM

**Rationale:**
- LiteLLM provides a unified OpenAI-compatible API proxy in front of multiple LLM providers (Anthropic, OpenAI, Gemini, local Ollama).
- Enables multi-LLM routing: Claude Haiku 3.5 for classification/triage, Claude Sonnet 4.5 for drafting, Claude Opus 4.5 for complex reasoning — with cost tracking per call.
- Self-hosted via Docker with a PostgreSQL backend for spend tracking and audit logs.

**Deployment:** Run as a Docker container on VPS, all LLM calls route through `http://litellm:4000/v1`. The Anthropic SDK can be configured to point to LiteLLM's OpenAI-compatible endpoint.

**MEDIUM confidence note:** LiteLLM's TypeScript SDK is less mature than the Python version. Recommended approach is to deploy LiteLLM as a Docker proxy and call it via standard HTTP from TypeScript (it speaks OpenAI protocol).

**NOT recommended:**
- OpenAI SDK as the primary routing layer — lock-in, weaker Anthropic integration.
- Building custom routing logic — LiteLLM handles fallbacks, retries, and cost attribution out of the box.

---

### 6. RAG Knowledge Base

| Choice | Version | Confidence |
|--------|---------|-----------|
| **Qdrant** | 1.10+ (self-hosted Docker) | HIGH |
| **`@qdrant/js-client-rest`** | 1.9+ | HIGH |
| **Embedding model** | `text-embedding-3-small` (OpenAI) or `claude-embed` | HIGH |

**Rationale:**
- Qdrant is the leading self-hosted vector database as of 2025. Key advantages for Astra:
  - Payload filtering — essential for restricting RAG queries to specific projects, date ranges, or source types (Drive vs. Slack vs. Gmail).
  - Hybrid search (dense + sparse BM25) — better retrieval than dense-only for multilingual content (RU+EN).
  - Self-hosted with no data leaving the VPS (critical for sensitive PM data).
  - Free, no per-query charges.
  - Named collections map cleanly to Astra's knowledge domains (project docs, Slack history, email threads, ClickUp context).

**Collection architecture:**
```
qdrant_collections:
  - project_docs      # Google Drive indexed content
  - slack_history     # Slack channel archives
  - email_threads     # Gmail thread summaries
  - clickup_context   # Task descriptions, comments
  - company_knowledge # General company docs, runbooks
```

**Embedding strategy:**
- Primary: `text-embedding-3-small` (OpenAI) — 1536 dimensions, cost-effective at $0.02/1M tokens.
- Chunking: 512 token chunks with 64-token overlap, using `langchain/text_splitter` for document parsing.
- Metadata stored as Qdrant payload: source, project_id, author, created_at, language (ru/en), doc_type.

**NOT recommended:**
- Pinecone — cloud-hosted, data leaves VPS, recurring costs per vector.
- ChromaDB — good for prototyping, but lacks Qdrant's payload filtering and production stability.
- pgvector (PostgreSQL extension) — viable alternative if you want to minimize infrastructure, but Qdrant has superior filtering and performance at scale.

---

### 7. Persistent Storage

| Choice | Version | Confidence |
|--------|---------|-----------|
| **PostgreSQL** | 16 (self-hosted Docker) | HIGH |
| **Drizzle ORM** | 0.32+ | HIGH |
| **Redis** | 7.2 (self-hosted Docker) | HIGH |

#### 7a. PostgreSQL

**Schema domains:**
```sql
-- Episodic memory: what did Astra do and when
agent_actions (id, user_id, action_type, context, result, timestamp)

-- User preferences and learned patterns
user_preferences (user_id, preference_key, preference_value, confidence, updated_at)

-- Draft queue: pending approvals
drafts (id, type, content, context_json, created_at, expires_at, status)

-- Audit log: all external API calls
audit_log (id, service, operation, user_id, timestamp, success, error)

-- Integration tokens (encrypted)
integration_tokens (user_id, service, access_token_enc, refresh_token_enc, expires_at)

-- LangGraph checkpoints (managed by LangGraph)
checkpoints (...)
```

**Rationale:**
- PostgreSQL is the correct choice for structured relational data: user sessions, draft queues, audit logs, and LangGraph checkpoints.
- Drizzle ORM provides TypeScript-native schema definition with excellent type inference, migrations via `drizzle-kit`, and zero runtime overhead compared to Prisma.
- Unlike Prisma, Drizzle doesn't require a separate process and supports more flexible query patterns.

**NOT recommended:**
- Prisma — heavier, migration flow is clunkier, slower in TypeScript inference for complex queries.
- MongoDB — structured relational data (drafts, tokens, audit log) doesn't benefit from document flexibility; adds operational complexity.
- SQLite — insufficient for concurrent access from multiple bot processes on VPS.

#### 7b. Redis

**Usage:**
- Session storage for grammY conversations (approval flows, multi-step dialogs)
- BullMQ job queue backend
- Rate limiting counters (ClickUp API 100 req/min)
- Pub/sub for cross-process events (Slack bot notifying Telegram bot of incoming messages)

**Rationale:** Redis is the natural companion to Node.js bot processes. BullMQ is built on Redis. grammY's Redis session adapter is battle-tested. The pub/sub capability enables loose coupling between the Telegram, Slack, and worker processes.

---

### 8. Job Queue & Scheduling

| Choice | Version | Confidence |
|--------|---------|-----------|
| **BullMQ** | 5.x | HIGH |
| **`@bull-board/api`** | 5.x | MEDIUM |

**Job types:**
```typescript
// High priority: user-initiated actions
'draft.generate'    // LLM draft generation
'task.update'       // ClickUp task modification
'email.triage'      // Gmail inbox processing

// Normal priority: scheduled work
'report.daily'      // Daily standup generation (cron)
'report.weekly'     // Weekly client report (cron)
'calendar.sync'     // Google Calendar poll (every 15min)
'drive.index'       // Google Drive incremental indexing

// Low priority: maintenance
'rag.ingest'        // Add documents to Qdrant
'memory.consolidate' // Merge episodic memory patterns
```

**Rationale:**
- BullMQ provides priority queues, delayed jobs, repeatable jobs (cron), job retries with backoff, and rate limiting — all needed for Astra's mixed workload.
- TypeScript-native with full type safety for job payloads.
- Bull Dashboard (`@bull-board/api`) provides a web UI for monitoring queue health on the VPS.

**NOT recommended:**
- `node-cron` for scheduling — adequate for simple cron, but cannot handle distributed rate limiting, retries, or job persistence across restarts.
- Agenda.js — MongoDB-backed, less active maintenance than BullMQ as of 2025.
- AWS SQS / Cloud queues — external dependency, data leaves VPS.

---

### 9. Integration Adapters

| Integration | Library | Version | Confidence |
|------------|---------|---------|-----------|
| **Gmail** | `googleapis` | 140+ | HIGH |
| **Google Calendar** | `googleapis` | 140+ | HIGH |
| **Google Drive** | `googleapis` | 140+ | HIGH |
| **ClickUp** | `@clickup/rest-api-client` or custom fetch | — | MEDIUM |
| **Composio** (optional) | `composio-core` | 0.5+ | MEDIUM |

#### 9a. Google APIs

**Rationale:**
- The official `googleapis` npm package covers Gmail, Calendar, and Drive under a single dependency with full TypeScript types.
- OAuth2 flow: standard Google OAuth2 with refresh token storage in PostgreSQL (encrypted).
- Gmail: `gmail.users.messages.list` + `gmail.users.messages.get` for triage; `gmail.users.drafts.create` for draft-first sending.
- Calendar: `calendar.events.list` for schedule reading; `calendar.freebusy.query` for availability checks.
- Drive: `drive.files.list` + `drive.files.export` for document indexing; watch channels for change notifications.

#### 9b. ClickUp

**Rationale:**
- ClickUp has an official `@clickup/rest-api-client` (TypeScript) but it's less maintained than the REST API itself.
- **Recommended approach:** Write a thin typed wrapper using `fetch` + Zod validation directly against ClickUp's REST API v2. This gives full control and avoids SDK lag behind API changes.
- Rate limit: 100 requests/min per token — use BullMQ's rate limiter for all ClickUp jobs.

#### 9c. Composio (Optional Fast Path)

**Rationale:**
- Composio provides 250+ pre-built integration connectors with OAuth management, normalizing API calls into LLM-compatible tool definitions.
- **When to use:** If initial development needs to move fast on integrations before writing custom adapters. Composio can bootstrap Gmail, Calendar, Drive, and ClickUp connectivity in hours.
- **Long-term:** Replace Composio adapters with custom implementations for cost control and reliability. Composio is a cloud service — it introduces an external dependency and potential data routing concerns.
- **Confidence MEDIUM:** Composio's maturity and rate limit handling for ClickUp in 2025 needs validation.

---

### 10. Workflow Automation Layer (Optional)

| Choice | Version | Confidence |
|--------|---------|-----------|
| **n8n** | 1.x (self-hosted) | MEDIUM |

**Rationale:**
- n8n provides a visual workflow editor with 400+ integrations, AI nodes, and a self-hosted option — zero vendor lock-in.
- **Use case for Astra:** PM-accessible automation layer. The user (a senior PM comfortable with AI tools) can create and modify notification workflows, recurring report triggers, and integration pipelines without code changes.
- n8n can trigger Astra's BullMQ jobs via webhook, or Astra can trigger n8n workflows via its REST API.
- AI nodes in n8n 1.x support Anthropic Claude natively.

**NOT recommended as primary orchestration:** n8n's workflow engine is not designed for stateful multi-step AI agent workflows. Use LangGraph for agent logic; use n8n for operational automation workflows the PM can edit visually.

**MEDIUM confidence note:** n8n adds operational overhead (another Docker container) and its AI node capabilities in v1.x are improving but not yet fully production-grade for complex agent workflows. Start without n8n and add only if the PM needs self-service workflow editing.

---

### 11. Self-Extension / Sandboxed Plugins

| Choice | Version | Confidence |
|--------|---------|-----------|
| **Deno** | 2.x | MEDIUM |

**Rationale:**
- Deno's permission model (`--allow-net=api.clickup.com`, `--allow-env=CLICKUP_TOKEN`) provides the security boundary needed for bot-generated code.
- When Astra generates a new tool (e.g., "create a Jira integration"), it writes a Deno script, runs it in a subprocess with specific permissions, and validates output.
- Deno 2.x improved Node.js compatibility, making it easier to use npm packages from within sandboxed scripts.

**Implementation pattern:**
```typescript
// Run Deno plugin with minimal permissions
const result = await Deno.run({
  cmd: ['deno', 'run',
    '--allow-net=api.clickup.com',
    '--no-prompt',
    plugin.scriptPath
  ],
  stdout: 'piped',
  stderr: 'piped'
})
```

**MEDIUM confidence note:** Sandboxed plugin execution is experimental territory. The Deno permission model is solid, but the workflow for Astra generating, validating, and running its own plugins needs careful design. Consider v2 feature scope.

---

### 12. Security & Configuration

| Choice | Version | Confidence |
|--------|---------|-----------|
| **`dotenv`** | 16.x | HIGH |
| **`node:crypto`** (AES-256-GCM) | Built-in | HIGH |
| **Zod** | 3.23+ | HIGH |

**Token encryption pattern:**
```typescript
// Integration tokens stored encrypted in PostgreSQL
const encryptToken = (plaintext: string, key: Buffer): string => {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  // ... returns base64(iv + authTag + ciphertext)
}
```

**Audit logging:** Every external API call (Gmail, ClickUp, Calendar, Drive, LLM) writes to `audit_log` table in PostgreSQL with user_id, service, operation, timestamp, and success/error status.

**NOT recommended:**
- Storing tokens in environment variables — insufficient for multi-user or rotation scenarios.
- External secret managers (HashiCorp Vault, AWS Secrets Manager) — unnecessary overhead for single-user VPS deployment.

---

### 13. Observability

| Choice | Version | Confidence |
|--------|---------|-----------|
| **Pino** | 9.x | HIGH |
| **`pino-pretty`** | 11.x | HIGH |

**Rationale:**
- Pino is the fastest structured JSON logger in the Node.js ecosystem — critical for a long-running bot that logs every LLM call, API request, and job execution.
- Structured JSON logging enables future log aggregation (Loki, Elasticsearch) without changing the logging code.
- No `console.log` in production code (per coding style rules).

**NOT recommended:**
- Winston — significantly slower than Pino, overly complex configuration.
- Datadog/New Relic — external SaaS, unnecessary for VPS deployment.

---

### 14. Testing

| Choice | Version | Confidence |
|--------|---------|-----------|
| **Vitest** | 2.x | HIGH |
| **`@vitest/coverage-v8`** | 2.x | HIGH |
| **Playwright** | 1.45+ | HIGH (E2E) |

**Rationale:**
- Vitest is the fastest TypeScript-native test runner, replacing Jest for new projects in 2025. Native ESM support, HMR in watch mode, compatible with Jest API.
- Coverage target: 80%+ per the mandatory workflow rules.
- Playwright for E2E: critical user flows (Telegram approval flow, ClickUp task creation) tested against real or mocked API endpoints.

---

### 15. Deployment

| Choice | Version | Confidence |
|--------|---------|-----------|
| **Docker Compose** | v2 (Compose V2) | HIGH |
| **Process manager** | Docker (built-in restart policies) | HIGH |

**Service topology:**
```yaml
services:
  telegram-bot:   # grammY bot process
  slack-bot:      # @slack/bolt process
  worker:         # BullMQ job processor
  api:            # Webhook receiver (optional)
  postgres:       # PostgreSQL 16
  redis:          # Redis 7.2
  qdrant:         # Qdrant vector DB
  litellm:        # LiteLLM proxy
  n8n:            # Workflow automation (optional)
```

**Rationale:**
- Docker Compose on a VPS is the simplest path for a single-user deployment. No Kubernetes overhead, straightforward service orchestration, easy volume management.
- All data volumes mounted from VPS storage — Qdrant, PostgreSQL, Redis data persists across container restarts.

---

## What NOT to Use (And Why)

| Technology | Reason to Avoid |
|-----------|----------------|
| **LangChain (without LangGraph)** | Sequential chains lack state persistence needed for approval flows |
| **AutoGen / CrewAI** | Python-only as of mid-2025; splits the stack |
| **Telegraf** | Weaker TypeScript support, slower updates than grammY |
| **Pinecone** | Cloud-hosted, data leaves VPS, per-query costs |
| **ChromaDB** | Insufficient production stability, weak filtering |
| **Prisma** | Heavier than Drizzle, slower TypeScript inference, clunkier migrations |
| **MongoDB** | Structured relational data model doesn't benefit from document DB |
| **node-cron** | No persistence, no retries, no priority across restarts |
| **Express.js** | Use Fastify if HTTP server needed — Express has no native TypeScript support and is slower |
| **Winston logger** | Significantly slower than Pino |
| **Bun (primary runtime)** | Some LangChain/LangGraph packages have compatibility issues; re-evaluate in 6 months |
| **OpenAI SDK as primary** | Anthropic SDK provides better Claude tool use types; use LiteLLM for routing |

---

## Dependency Version Summary

| Package | Version | Role |
|---------|---------|------|
| `typescript` | 5.5+ | Language |
| `tsx` | 4.x | Dev runner |
| `esbuild` | 0.21+ | Production build |
| `grammy` | 1.29+ | Telegram bot |
| `@grammyjs/conversations` | 2.x | Dialog state management |
| `@grammyjs/menu` | 1.x | Inline keyboards |
| `@grammyjs/storage-redis` | 2.x | Session persistence |
| `@grammyjs/i18n` | 1.x | RU/EN translations |
| `@slack/bolt` | 4.x | Slack bot |
| `@slack/web-api` | 7.x | Slack REST API |
| `@anthropic-ai/sdk` | 0.27+ | Claude LLM |
| `@langchain/langgraph` | 0.2+ | Agent state machines |
| `@langchain/core` | 0.3+ | LangGraph dependency |
| `@qdrant/js-client-rest` | 1.9+ | Vector DB client |
| `drizzle-orm` | 0.32+ | PostgreSQL ORM |
| `drizzle-kit` | 0.23+ | DB migrations |
| `postgres` | 3.x | PostgreSQL driver (`postgres.js`) |
| `ioredis` | 5.x | Redis client |
| `bullmq` | 5.x | Job queues |
| `googleapis` | 140+ | Gmail/Calendar/Drive |
| `zod` | 3.23+ | Schema validation |
| `pino` | 9.x | Structured logging |
| `pino-pretty` | 11.x | Dev log formatting |
| `vitest` | 2.x | Testing |
| `@vitest/coverage-v8` | 2.x | Coverage |
| `playwright` | 1.45+ | E2E testing |

**Version confidence note:** Versions verified against knowledge cutoff August 2025. Verify exact latest versions via `npm info <package> version` before pinning in `package.json`.

---

## Risk Register

| Risk | Severity | Mitigation |
|------|---------|-----------|
| LangGraph JS API churn (pre-1.0) | MEDIUM | Pin to minor version, test on upgrade |
| LiteLLM TypeScript SDK lag | LOW | Use Docker proxy, call via HTTP |
| Composio reliability for ClickUp | MEDIUM | Custom adapter as fallback |
| Deno sandbox for self-extension | HIGH | Defer to v2, design carefully |
| n8n AI nodes immaturity | LOW | Optional component, not on critical path |
| Google Drive watch channel expiry | MEDIUM | Implement renewal via BullMQ scheduled job |
| ClickUp API rate limits (100/min) | MEDIUM | BullMQ rate limiter enforced at queue level |

---

## Open Questions

1. **Composio vs. custom adapters:** Is Composio's reliability sufficient for production use, or should custom adapters be the baseline with Composio as a prototype tool?
2. **n8n inclusion:** Does the user actually want a no-code workflow layer, or is the TypeScript codebase sufficient for all automation?
3. **Embedding model:** `text-embedding-3-small` (OpenAI, external) vs. a self-hosted model (`nomic-embed-text` via Ollama). Trade-off: cost vs. data sovereignty.
4. **LangGraph persistence backend:** PostgreSQL (consistent with other data) or Redis (faster for checkpoint reads)?

---

*Last updated: 2026-02-23*
*Knowledge cutoff for version data: August 2025*
*Verify all versions via npm before pinning*
