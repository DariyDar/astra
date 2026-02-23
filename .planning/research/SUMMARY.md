# Project Research Summary

**Project:** Astra — AI PM Assistant for Gamedev
**Domain:** Multi-channel AI agent with RAG, multi-LLM routing, workflow automation, and self-extension
**Researched:** 2026-02-23
**Confidence:** HIGH

## Executive Summary

Astra is a deeply integrated personal AI assistant for a senior PM in a Russian-speaking gamedev company. Unlike horizontal AI tools (Lindy.ai, Dust.tt), Astra's defensible position is domain depth: it lives where the PM already works (Telegram + Slack), speaks the team's language (RU/EN), knows the company's projects through a RAG corpus of GDDs, postmortems, and Slack history, and progressively learns the PM's communication style. The research confirms this is a buildable product on a well-supported TypeScript stack — not experimental territory — but the complexity is real: five external integrations, a stateful multi-step agent, a vector knowledge base, and self-learning/self-extension features that must be carefully gated.

The recommended approach is layered construction in strict dependency order: infrastructure and observability first, then bot shells and the agent brain, then integrations one by one, then the RAG knowledge base, then background automation, and only then the advanced capabilities (ghost-writing with self-learning, self-extension). The research is unambiguous that skipping this order creates hard-to-fix problems — specifically, prompt architecture decisions made early become load-bearing for every feature that follows, and multi-integration rate limiting must be designed before the first scheduled job ships. The stack is well-chosen and battle-tested: grammY, @slack/bolt, LangGraph JS, Qdrant, PostgreSQL/Drizzle, BullMQ, and LiteLLM are all production-ready for this exact profile as of mid-2025.

The highest risks are not technical but behavioral: ghost-writing must be hardcoded as draft-only with no auto-send path; the LLM must never answer operational questions (tasks, emails, calendar) without a preceding API fetch; and self-extension must be gated behind human approval and a sandboxed runtime. These are architectural constraints that cannot be retrofitted — they must be baked into Phase 1. Secondary risks are operational: silent OAuth token expiry, ClickUp rate limit cascades during morning report generation, and RAG staleness from un-refreshed Drive documents. All are solvable with patterns identified in the research.

---

## Key Findings

### Recommended Stack

The stack is TypeScript-native from top to bottom, deployed on a single VPS via Docker Compose. The full dependency set is well-understood, and no component requires experimental or unproven technology for the core path. The two medium-confidence components — LiteLLM (deployed as a Docker proxy rather than a TypeScript SDK) and Deno sandboxing for self-extension (deferred to v2) — are isolated from the critical path. See `STACK.md` for full version table and rationale.

**Core technologies:**
- **Node.js 22 LTS + TypeScript 5.5 + pnpm workspaces** — monorepo runtime, full type safety across all packages
- **grammY 1.29 + @grammyjs/conversations** — Telegram bot with stateful multi-step approval flows; grammY is the current TypeScript-first standard, superseding Telegraf
- **@slack/bolt 4.x + Socket Mode** — Slack bot without requiring a public HTTPS endpoint; events API for DM monitoring
- **Anthropic SDK + LangGraph JS 0.2+ + LiteLLM (Docker proxy)** — primary LLM, stateful workflow engine with PostgreSQL checkpointing, and multi-model routing (Haiku for classification, Sonnet for drafting, Opus for complex reasoning)
- **Qdrant 1.10 (self-hosted)** — vector database with hybrid search and payload filtering; critical for multilingual RAG and per-project scoping
- **PostgreSQL 16 + Drizzle ORM** — structured data: sessions, drafts, audit log, preferences, LangGraph checkpoints
- **Redis 7.2 + BullMQ 5.x** — session storage, job queues with priority/cron/rate limiting, cross-process pub/sub
- **googleapis 140+** — Gmail, Google Calendar, Google Drive under one OAuth2 client
- **Custom fetch + Zod** — ClickUp API v2 wrapper (thin typed wrapper preferred over the official SDK due to maintenance lag)
- **Pino 9.x** — structured JSON logging for all processes; never console.log in production
- **Vitest 2.x + Playwright 1.45+** — unit/integration testing and E2E for critical flows

**What NOT to use:** Telegraf (weaker TS), Prisma (slower than Drizzle), ChromaDB (weak filtering), AutoGen/CrewAI (Python-only), LangChain without LangGraph (no state persistence), Express (use Fastify if HTTP needed), Winston (slower than Pino).

---

### Expected Features

The research analyzed Lindy.ai, Dust.tt, Reclaim.ai, Motion, and custom PM bots to establish the feature baseline. See `FEATURES.md` for the full complexity and dependency map.

**Must have (table stakes) — all Phase 1:**
- Natural language task creation, lookup, and status updates in ClickUp
- ClickUp project/space navigation by name (no IDs required from PM)
- Daily standup digest (tasks due, overdue, upcoming meetings, priority emails)
- Calendar event lookup and creation via natural language
- Email triage and prioritization (top 3-5 to act on today)
- Meeting summary and action item extraction to ClickUp
- Bilingual RU/EN interaction — auto-detect language, handle mixed-language source data (English task names in Russian reports)

**Should have (differentiators) — Phase 1-2:**
- Ghost-writing for Slack DMs and Gmail with company context from RAG — always draft-and-present, never auto-send
- Company knowledge base (RAG over Google Drive: GDDs, postmortems, sprint reports, wikis)
- Gamedev-specific report templates (GDD progress, milestone delivery, publisher updates)
- Proactive blocker detection from ClickUp dependency graph
- Weekly/sprint report auto-generation from ClickUp + Gmail + Calendar

**Phase 2 extension:**
- Onboarding knowledge capture (curated briefing for new team members)

**Defer to v2+:**
- Self-learning from PM corrections (very high complexity, quality gate architecture required)
- Self-extension via natural language (very high risk, needs sandboxed runtime and human approval gating)
- Cross-integration context linking (entity resolution across all systems — compounding complexity)

**Hard anti-features (never build):**
- Own task tracker or Kanban board (compete with ClickUp)
- Mobile app (live inside Telegram/Slack mobile)
- Full email client UI
- Multi-tenant SaaS billing (premature scaling)
- Public plugin marketplace
- HR/performance management features
- Voice/audio transcription pipeline (integrate with existing tools instead)

**Key insight:** The differentiation stack is gamedev domain depth + Russian-first bilingual + lives where team works + ghost-writing with organizational memory + self-extension. But table stakes reliability must come before differentiators. PMs will abandon the bot immediately if daily digest or task management is unreliable.

---

### Architecture Approach

Astra follows a four-layer architecture: Interface Layer (Telegram + Slack bots), Agent Layer (LLM router + LangGraph workflows + Tool Registry), Integration Layer (ClickUp, Gmail, Calendar, Drive, Slack clients), and Memory Layer (Qdrant + PostgreSQL + Redis + BullMQ). All messages normalize into a unified `MessageEnvelope` before reaching the agent — the agent never knows which channel originated a request. All outgoing communications pass through a draft queue with explicit PM approval before sending. See `ARCHITECTURE.md` for component diagram, data flows, and build order.

**Major components:**
1. **Message Router** — normalizes Telegram/Slack/Gmail input into `MessageEnvelope`; extracts language, intent classification via Haiku; routes to agent
2. **Agent Engine (LangGraph)** — stateful workflow graphs per task type (email-triage, report-gen, ghost-writer, task-manager); PostgreSQL checkpointing for crash recovery; tool registry for all external calls
3. **LLM Router (LiteLLM)** — Haiku for cheap classification, Sonnet for drafting, Opus for complex reasoning; cost tracking; model fallbacks
4. **Integration clients** — typed fetch wrappers with Zod validation; OAuth2 token management; rate limiting enforced at BullMQ queue level
5. **RAG pipeline (Qdrant)** — structure-aware chunking, hybrid dense+sparse search, payload filtering by project/source/date, incremental re-indexing on Drive webhook events
6. **Draft queue** — all outgoing comms (ghost-written messages, reports) staged for PM approval; 24-hour expiry; full audit log
7. **BullMQ workers** — scheduled reports (cron), Drive indexing, Calendar sync, notification delivery; priority queues separate urgent from background

**Three patterns to enforce from Day 1:**
- Unified `MessageEnvelope` (channel-agnostic agent logic)
- Draft-first output (no external communication without PM approval)
- Event-driven ingestion via BullMQ (no real-time polling chaos)

---

### Critical Pitfalls

The research identified 23 pitfalls across 7 categories. See `PITFALLS.md` for full list with warning signs and prevention strategies. The five highest-risk pitfalls requiring architectural enforcement:

1. **P-012: Ghost-writing auto-sends** — Any flow path where Astra sends on the PM's behalf without explicit confirmation creates irreversible professional damage. Prevention: hard-code draft-and-present as an architectural constraint with no auto-send mode, explicit confirmation UI, and full audit log. This is a Phase 1 architectural rule, not a feature flag.

2. **P-002: Hallucination in operational data** — The LLM must never answer factual questions about tasks, emails, or calendar events from memory. Prevention: enforce "Retrieve Before Assert" — every factual claim about operational data requires a preceding API fetch in the tool-call chain. Add post-generation schema validation for dates, task IDs, and mentions.

3. **P-021: Credentials stored insecurely** — OAuth tokens for Gmail, Calendar, Drive, ClickUp, Slack, Telegram on a VPS. Prevention: AES-256-GCM encryption at rest in PostgreSQL from Day 1, `.env` excluded from git with pre-commit hook, no plaintext credential files.

4. **P-001: Prompt drift across integrations** — Prompts written separately per integration cause inconsistent behavior and tone. Prevention: single Master System Prompt defines persona, bilingual rules, and output format; all integration prompts are extensions, not replacements; prompt regression test suite with golden I/O pairs.

5. **P-009: Silent OAuth token expiry breaks background jobs** — Scheduled reports silently fail when tokens expire. Prevention: proactive token refresh before expiry, 401 errors trigger immediate PM notification with re-auth link, `/status` command shows credential health.

**Phase-specific pitfall clusters:**
- Phase 1 (Core Architecture): P-001, P-002, P-003, P-004, P-019, P-020, P-021
- Phase 2 (Integrations + Bot Core): P-009, P-010, P-011, P-012, P-016, P-017, P-018, P-023
- Phase 3 (RAG): P-005, P-006, P-007, P-008, P-022
- Phase 4 (Self-Learning): P-013, P-015
- Phase 5 (Self-Extension): P-014

---

## Implications for Roadmap

The architecture research is explicit about build order based on hard dependencies. The phase structure below follows that dependency graph and front-loads the pitfalls that cannot be retrofitted.

### Phase 1: Foundation and Infrastructure
**Rationale:** Nothing else can be built safely without this. Observability (P-019), process supervision (P-020), credential security (P-021), and the Master System Prompt architecture (P-001, P-004) are load-bearing for every subsequent phase. Build the monorepo scaffold, Docker Compose environment (PostgreSQL + Redis + Qdrant + LiteLLM), structured logging (Pino with correlation IDs), and the prompt architecture before writing a single integration.
**Delivers:** Deployed infrastructure stack; monorepo with core/shared packages; Pino logging with correlation IDs; encrypted credential storage; Master System Prompt with bilingual rules; `/health` admin command showing integration status.
**Addresses:** No user features yet — this is invisible infrastructure.
**Avoids:** P-001 (prompt drift), P-004 (language mixing), P-019 (no observability), P-020 (no recovery), P-021 (insecure credentials).
**Research flag:** Standard patterns — skip research-phase. Docker Compose, Drizzle migrations, Pino setup are well-documented.

---

### Phase 2: Bot Shell and Agent Brain
**Rationale:** The Telegram and Slack bots, unified message router, intent classifier, and LangGraph agent core are prerequisites for every feature. The draft-first output pattern (P-012) and degraded mode for LLM outages (P-017) must be baked in here. The notification fatigue architecture (P-018) must be designed before more than two integrations are connected.
**Delivers:** Working Telegram bot + Slack bot responding to messages; unified `MessageEnvelope` normalization; intent classification via Haiku; LangGraph agent with tool-call loop; draft queue with PM approval flow; circuit breaker for LLM outages; notification tiering (Critical / Hourly batch / Daily digest).
**Addresses:** Architecture foundation for all features.
**Uses:** grammY + @grammyjs/conversations, @slack/bolt Socket Mode, LangGraph JS, Anthropic SDK via LiteLLM, BullMQ.
**Avoids:** P-012 (auto-send), P-016 (cross-channel format mismatch), P-017 (no LLM degraded mode), P-018 (notification fatigue).
**Research flag:** Standard patterns — LangGraph + grammY conversation patterns are well-documented. LangGraph JS API is pre-1.0; pin to minor version.

---

### Phase 3: Core Integrations (Table Stakes)
**Rationale:** This phase delivers the PM's daily value: task management, calendar, email triage, and morning digest. Integration order within this phase: ClickUp first (highest daily-use, no OAuth complexity), then Google APIs (shared OAuth client for Gmail + Calendar + Drive). Rate limiting strategy (P-010) and webhook schema validation (P-011) must be built once and applied to each integration as it is added.
**Delivers:** ClickUp natural language task creation, lookup, status updates, and space navigation; Google Calendar event lookup and creation; Gmail email triage and prioritization (top 3-5 daily); daily standup digest (ClickUp + Calendar + Gmail aggregated); meeting summary and action item extraction.
**Implements:** All 8 table stakes features from FEATURES.md.
**Uses:** Custom fetch + Zod for ClickUp; googleapis for Google APIs; BullMQ rate limiters per integration; per-integration dead-letter queues.
**Avoids:** P-002 (hallucination — API fetch before every factual claim), P-009 (silent OAuth expiry), P-010 (rate limit cascade), P-011 (webhook schema drift).
**Research flag:** Needs research-phase for ClickUp webhook payload validation specifics and Google Cloud Pub/Sub setup for Gmail push notifications. Rate limit behaviors at the exact API quota levels need validation.

---

### Phase 4: RAG Knowledge Base
**Rationale:** Ghost-writing (Phase 5) requires company context from RAG, and the daily digest value increases significantly when Astra can reference Drive documentation. The RAG architecture decisions (chunk strategy, embedding model version lock, retrieval threshold) cannot be changed after indexing without a full re-index — they must be designed correctly upfront. Company glossary must be the first document ingested (P-022).
**Delivers:** Google Drive document indexing pipeline (parse, chunk, embed, store in Qdrant); structure-aware chunking with 15-20% overlap; hybrid dense+sparse search; payload filtering by project/source/date; retrieval threshold (0.75 cosine similarity minimum); retrieval miss logging ("knowledge gap" dashboard); incremental re-indexing on Drive webhook events; company glossary as seed corpus.
**Implements:** RAG knowledge base feature (Differentiator #10), Onboarding knowledge capture (Differentiator #17).
**Uses:** Qdrant 1.10, @qdrant/js-client-rest, text-embedding-3-small (locked version), BullMQ ingest queue.
**Avoids:** P-005 (stale docs), P-006 (bad chunking), P-007 (embedding/LLM mismatch), P-008 (silent retrieval failure), P-022 (gamedev jargon not in corpus).
**Research flag:** Needs research-phase for chunking strategy on GDD-format documents (highly structured, often long) and Qdrant hybrid search configuration for RU+EN mixed corpora.

---

### Phase 5: Background Automation and Proactive Features
**Rationale:** With all integrations and RAG in place, the background job layer can run full scheduled workflows: weekly reports drawing on ClickUp + Gmail + Calendar + Drive, proactive blocker detection, and gamedev-specific report templates. This phase also implements crunch mode (P-023) since it must be operational before the first game release window.
**Delivers:** Weekly/sprint report auto-generation (draft to Telegram for approval); proactive blocker detection with configurable thresholds; gamedev-specific report templates (GDD progress, milestone delivery, publisher updates); crunch mode configuration (reduced notifications, frozen self-extension, no prompt changes); auto-crunch-mode activation from ClickUp/Calendar release dates; BullMQ cron job monitoring dashboard.
**Implements:** Differentiators #11 (weekly report), #15 (gamedev templates), #16 (proactive blockers).
**Avoids:** P-023 (crunch vs. maintenance conflict), P-010 (rate limit cascade on report generation via staggered job scheduling).
**Research flag:** Standard patterns — BullMQ cron and priority queue patterns are well-documented.

---

### Phase 6: Ghost-Writing with Organizational Memory
**Rationale:** Ghost-writing is the highest-value differentiator but depends on RAG context (Phase 4) and a working draft queue (Phase 2). It is placed after background automation because the draft approval UI patterns established in Phase 5 reports are the same patterns ghost-writing uses. The "sending as PM" UI constraint (P-012) must be explicitly tested here.
**Delivers:** Ghost-writing for Slack DMs (draft for PM approval, never auto-send); ghost-writing for Gmail replies (draft, present, approve/edit/reject); company-context injection from RAG into drafts; tone calibration (formal/informal, per-recipient); multi-turn refinement ("make it more concise"); full audit log of approved and rejected drafts.
**Implements:** Differentiator #9 (ghost-writing).
**Avoids:** P-012 (auto-send is prohibited), P-004 (language mixing in drafts).
**Research flag:** Needs research-phase for tone calibration patterns in LLM prompting for bilingual ghost-writing — limited published patterns for RU/EN business communication style injection.

---

### Phase 7: Self-Learning from PM Corrections
**Rationale:** Self-learning is deferred to Phase 7 because it requires a sufficient corpus of PM interactions (produced in Phases 2-6) and a quality gate architecture that must be designed before any corrections enter any feedback loop. Data separation from the RAG corpus (P-015) is a hard architectural constraint. Weekly learning cycle minimum — never real-time.
**Delivers:** Correction detection pipeline (PM edits a draft → diff captured); preference extraction from diffs; user preference store (PostgreSQL); preference injection into future prompts for similar contexts; correction review queue with minimum batch size (50) before any prompt update; frozen evaluation set (100 scenarios) for pre/post quality comparison; 90-day retention on raw interaction logs; anonymization before training storage.
**Implements:** Differentiator #12 (self-learning).
**Avoids:** P-013 (quality degradation), P-015 (confidentiality breach from interaction logs).
**Research flag:** Needs research-phase. Preference learning from corrections in a PM assistant context is not well-documented in public literature. Custom approach likely required.

---

### Phase 8: Self-Extension
**Rationale:** Self-extension is the most complex and highest-risk feature. It requires all other phases to be stable, and the Deno sandboxing approach needs careful design. This is a v2 feature that should only be planned once Phases 1-7 are production-stable. The governance model (PM approval for all extensions, capability registry, minimum scope principles) must be designed before any self-extension code is written.
**Delivers:** Conversational automation creation (PM describes a trigger+action in natural language); Astra proposes implementation; PM reviews and approves; extension deploys to staging first; capability registry with OAuth scopes and data access for every tool; least-privilege enforcement on new integrations; extension audit log.
**Implements:** Differentiator #13 (self-extension).
**Avoids:** P-014 (unaudited capabilities).
**Research flag:** Needs research-phase. Deno sandboxed plugin execution as a Node.js subprocess is experimental. LLM-generated code safety patterns need dedicated research.

---

### Phase Ordering Rationale

- **Phases 1-2 before anything else** because prompt architecture (P-001, P-004), credential security (P-021), and draft-first output (P-012) cannot be retrofitted. Fixing these after integrations are live requires touching every integration.
- **Phase 3 (integrations) before Phase 4 (RAG)** because RAG query quality increases significantly when integration data (ClickUp task names, Gmail thread subjects, Calendar event names) is available as payload metadata on Qdrant vectors. The RAG corpus alone is less useful without integration context linking.
- **Phase 4 (RAG) before Phase 6 (ghost-writing)** because ghost-writing with generic LLM output is only marginally better than no ghost-writing. The value comes from company context: knowing who the recipient is, what project is at risk, what the company's tone with that publisher looks like. That context lives in RAG.
- **Phase 5 (background automation) before Phase 6 (ghost-writing)** because draft approval UI patterns established in scheduled reports reuse directly in ghost-writing flows. Building them in the same mental context avoids architectural divergence.
- **Phases 7-8 at the end** because they require data produced by all earlier phases, and their risk profiles demand stability in the foundation they build on.

---

### Research Flags

**Needs `/gsd:research-phase` during planning:**
- **Phase 3** — ClickUp webhook validation specifics; Google Cloud Pub/Sub for Gmail push notifications; exact API quota behaviors at production scale
- **Phase 4** — Chunking strategy for GDD-format documents; Qdrant hybrid search configuration for RU+EN mixed corpora; embedding model selection (OpenAI external vs. self-hosted Ollama for data sovereignty)
- **Phase 6** — Tone calibration patterns for bilingual (RU/EN) business communication in LLM prompting; limited published patterns for this specific use case
- **Phase 7** — Preference learning from correction diffs; quality gate architecture for PM assistant self-learning; no established reference implementations
- **Phase 8** — Deno sandbox as Node.js subprocess; LLM-generated code safety patterns; self-extension governance models

**Standard patterns — skip research-phase:**
- **Phase 1** — Docker Compose, Drizzle migrations, Pino structured logging, AES-256-GCM encryption: all well-documented
- **Phase 2** — grammY conversations, @slack/bolt Socket Mode, LangGraph stateful graphs with PostgreSQL checkpointing: official documentation is thorough
- **Phase 5** — BullMQ cron jobs, priority queues, rate limiters: well-documented with TypeScript examples

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All core technologies (grammY, LangGraph JS, Qdrant, BullMQ, Drizzle) are current production choices with official TypeScript support as of mid-2025. Two MEDIUM components (LiteLLM TS SDK, Deno sandboxing) are isolated from critical path. |
| Features | HIGH | Competitor analysis (Lindy, Dust, Reclaim, Motion) is thorough. Table stakes are well-established. Differentiator complexity estimates are well-calibrated against known implementations. |
| Architecture | HIGH | Patterns (unified message envelope, draft-first, event-driven ingestion) are established in production multi-channel bot systems. LangGraph checkpointing pattern is from official documentation. |
| Pitfalls | HIGH | All 23 pitfalls are grounded in concrete failure modes from documented deployments of similar systems. Prevention strategies are specific and actionable, not generic. |

**Overall confidence:** HIGH

### Gaps to Address

- **Embedding model choice (Phase 4):** Open question between `text-embedding-3-small` (OpenAI, external, proven) and `nomic-embed-text` via Ollama (self-hosted, no data sovereignty concern). Decision depends on how sensitive Drive document content is. Recommend deferring to Phase 4 planning with explicit data classification review.

- **Composio vs. custom adapters (Phase 3):** Composio can accelerate initial integration development but introduces an external cloud dependency and data routing concern. Recommend custom adapters as the baseline, with Composio only as a prototyping tool if speed is critical in early Phase 3.

- **n8n inclusion:** n8n adds a PM-accessible no-code automation layer but adds operational overhead. Include only if the PM explicitly wants self-service workflow editing beyond what conversational self-extension (Phase 8) provides. Not on critical path.

- **LangGraph persistence backend (Phase 2):** PostgreSQL (consistent with other structured data) vs. Redis (faster checkpoint reads). Recommend PostgreSQL for consistency; re-evaluate if checkpoint read latency becomes a bottleneck.

- **Self-learning architecture (Phase 7):** No established reference implementation for PM assistant preference learning from correction diffs. This needs dedicated research-phase before any implementation planning. Budget 2-3 days of research.

---

## Sources

### Primary (HIGH confidence)
- grammY official documentation (grammy.dev) — Telegram bot architecture, conversations plugin, session adapters
- @slack/bolt v4 official documentation (api.slack.com/tools/bolt) — Socket Mode, Events API, TypeScript types
- LangGraph JS documentation (langchain-ai.github.io/langgraphjs) — stateful graphs, PostgreSQL checkpointing, tool nodes
- Anthropic SDK documentation (docs.anthropic.com) — Claude tool use, streaming, batch API
- Qdrant documentation (qdrant.tech/documentation) — hybrid search, payload filtering, collections architecture
- BullMQ documentation (docs.bullmq.io) — priority queues, rate limiters, repeatable jobs, worker patterns
- Drizzle ORM documentation (orm.drizzle.team) — schema definition, migrations, query patterns
- Google APIs Node.js client documentation — Gmail, Calendar, Drive, OAuth2 flow
- ClickUp API v2 documentation — REST endpoints, webhook payloads, rate limits

### Secondary (MEDIUM confidence)
- Lindy.ai product documentation and feature announcements — competitor feature baseline
- Dust.tt product documentation and GitHub — RAG architecture patterns, enterprise connector design
- Reclaim.ai and Motion feature pages + G2/Product Hunt reviews — PM tool user expectations
- LiteLLM documentation — proxy configuration, model routing, cost tracking
- Community implementations of Telegram + ClickUp bots on GitHub — integration patterns, rate limit handling

### Tertiary (LOW confidence / needs validation)
- Composio documentation — integration connector maturity, ClickUp reliability in 2025 (needs validation in Phase 3)
- n8n AI nodes documentation — production-readiness of AI workflow nodes in v1.x (validate before including in deployment)
- Deno 2.x subprocess sandboxing patterns — experimental for self-extension use case (validate in Phase 8 research)

---

*Research completed: 2026-02-23*
*Ready for roadmap: yes*
