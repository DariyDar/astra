# PITFALLS.md — Astra AI PM Assistant
## Common Mistakes in AI PM Assistant / Multi-Integration Bot Projects

**Project:** Astra — AI PM assistant for Telegram + Slack, integrating ClickUp, Gmail, Google Calendar, Google Drive. Features: email triage, report generation, task management, ghost-writing, RAG knowledge base, self-learning, self-extension. Bilingual RU/EN. Self-hosted VPS.

**Purpose:** This document prevents critical mistakes during roadmap execution. Each pitfall includes warning signs, prevention strategy, and the phase where it must be addressed.

---

## CATEGORY 1: LLM & PROMPT ENGINEERING PITFALLS

---

### P-001: Prompt Drift Across Multi-Integration Contexts

**Description:** The LLM behaves inconsistently because prompts are written separately for each integration (Telegram, Slack, ClickUp, Gmail) without a unified system prompt architecture. Context from one channel bleeds into responses for another, or tone/language shifts unexpectedly between integrations.

**Warning Signs:**
- PM notices Astra uses different terminology for the same ClickUp concept depending on whether the question came via Telegram or Slack
- Ghost-written Slack DM replies sound like email drafts (wrong tone/channel register)
- RU/EN language switching is inconsistent — bot responds in wrong language mid-session
- No single place where "how Astra talks" is defined

**Prevention Strategy:**
- Define a single Master System Prompt that establishes persona, tone, bilingual rules, and output format constraints
- All integration-specific prompts are extensions of the master, not replacements
- Store prompt versions in version control with semantic versioning (prompts are code)
- Build a prompt regression test suite: for each major integration, maintain 10-20 golden input/output pairs and run them before any prompt change

**Phase:** Phase 1 (Core Architecture) — must be resolved before any integration work begins

---

### P-002: Hallucination in Task and Calendar Data

**Description:** The LLM generates plausible-sounding but incorrect task IDs, due dates, assignee names, or meeting times when it lacks grounding in real API data. A PM acting on hallucinated ClickUp task statuses or Gmail thread summaries makes real business mistakes.

**Warning Signs:**
- Astra references a task or email that doesn't exist in ClickUp/Gmail
- Generated reports contain dates that are slightly wrong (off by one day, wrong timezone)
- Ghost-written replies reference details not in the actual email thread
- No API call was made before the LLM generated a factual-sounding statement

**Prevention Strategy:**
- Enforce a strict "Retrieve Before Assert" rule: any factual claim about tasks, emails, events, or files MUST be preceded by an API fetch in the tool-call chain
- Never allow the LLM to answer from memory for operational data (ClickUp, Gmail, Calendar) — treat operational data as always stale unless freshly fetched
- Add a post-generation validation layer for dates, task IDs, and user mentions: regex/schema check the output before sending
- Include explicit "I don't have this information" fallback in all prompts for operational data

**Phase:** Phase 1 (Core Architecture) + Phase 2 (each integration at point of build)

---

### P-003: Token Budget Exhaustion in Long Conversations

**Description:** Astra is a PM assistant with persistent context (daily standups, ongoing project threads). Long conversations quickly exhaust the context window. The LLM silently starts "forgetting" earlier conversation, leading to contradictory advice or repeated questions.

**Warning Signs:**
- Astra asks for information it was given 20 messages ago
- Report quality degrades in long sessions (missing earlier discussed points)
- Costs spike unexpectedly without clear cause
- No conversation summarization or truncation strategy exists

**Prevention Strategy:**
- Implement a sliding window with periodic summarization: after N messages, compress earlier context into a structured summary
- Define a context budget per session type (triage session: 8K tokens max, report generation: 16K tokens)
- Use a dedicated "memory layer" (structured key-value store, not raw message history) for session-critical facts: today's priorities, current project phase, PM's name
- Set hard token limits per request with graceful degradation behavior

**Phase:** Phase 2 (Telegram/Slack bot core) — before first production use

---

### P-004: Language Mixing (Russian/English Bleed)

**Description:** Bilingual LLM behavior is underspecified. The model responds in the wrong language, mixes languages mid-sentence, or inconsistently translates ClickUp task names (which may be in English) into Russian reports.

**Warning Signs:**
- Report contains English task names mid-Russian sentence without consistent formatting rule
- PM sends a Russian message and gets an English response
- Ghost-written content in one language contains phrases from the other
- No documented rule for how to handle mixed-language source data (English ClickUp task names in Russian reports)

**Prevention Strategy:**
- Define explicit bilingual rules in the master system prompt: response language = user's language of last message (with override command)
- Define a "foreign term" policy: English technical terms/task names in Russian context are kept in English with no translation, clearly formatted (e.g., in quotes or code formatting)
- Create a bilingual test matrix: 20 scenarios with expected language of response and term handling
- Add a language detection check at ingestion: tag each incoming message with detected language before routing to LLM

**Phase:** Phase 1 (Core Architecture)

---

## CATEGORY 2: RAG & KNOWLEDGE BASE PITFALLS

---

### P-005: RAG Returning Stale or Conflicting Documents

**Description:** The knowledge base (Google Drive, project docs) is indexed once and never refreshed. The LLM confidently answers from an outdated document while a newer version exists in Drive. In a gamedev company, game design documents, milestone plans, and team structures change frequently.

**Warning Signs:**
- Astra references a feature that was cut 3 months ago (still in old GDD)
- PM receives contradictory information from Astra because two versions of the same doc are indexed
- No document versioning or recency scoring in retrieval results
- Chunks retrieved are from doc version 1.0 while Drive has version 3.0

**Prevention Strategy:**
- Implement incremental re-indexing triggered by Google Drive webhook (file modified event) — not periodic batch re-indexing
- Store document metadata with each chunk: source file ID, last modified date, version
- Add recency bias to retrieval ranking: when two chunks conflict, surface the newer one and flag the conflict to the PM
- Define a "canonical document" tagging system: only Drive files tagged/in specific folders are indexed as authoritative

**Phase:** Phase 3 (RAG/Knowledge Base) — architecture decision before first indexing

---

### P-006: Chunk Boundary Destroys Context

**Description:** RAG performance collapses because documents are chunked naively (fixed 512-token windows). A game design spec split at the wrong boundary gives the LLM half a feature description, producing confident but incomplete answers.

**Warning Signs:**
- Astra gives answers that seem to have half the story (correct start, wrong conclusion)
- Retrieval returns chunks that are clearly incomplete sentences or mid-table
- No chunk overlap strategy exists
- Document structure (headers, sections, tables) is ignored during chunking

**Prevention Strategy:**
- Use structure-aware chunking: respect document headings, sections, and paragraph boundaries as natural chunk delimiters
- Add 15-20% chunk overlap to prevent boundary artifacts
- For tabular data (milestone spreadsheets, budget tables): chunk entire tables as single units with metadata, do not split mid-row
- Store parent document ID with each chunk and implement parent-document retrieval: when a chunk is retrieved, optionally fetch its full parent section for context

**Phase:** Phase 3 (RAG/Knowledge Base)

---

### P-007: Embedding Model / LLM Mismatch

**Description:** The embedding model used for indexing is different from (or inconsistent with) the LLM used for generation. Semantic similarity scores become unreliable, retrieval quality degrades, and the system produces confident answers grounded in irrelevant chunks.

**Warning Signs:**
- Top-k retrieved chunks are clearly unrelated to the query
- Switching LLM version causes sudden RAG quality drop
- No documented pairing of embedding model + LLM model
- Embeddings were generated with one API key/model and queries use another

**Prevention Strategy:**
- Document the exact embedding model version and LLM model version as a paired configuration (treat as infrastructure, not a runtime setting)
- Lock embedding model version — never change it without full re-indexing
- Create a retrieval quality test suite: 30 queries with known correct source documents; measure recall@5 before any model change
- When upgrading either model, treat it as a migration: re-index everything, run quality tests, deploy atomically

**Phase:** Phase 3 (RAG/Knowledge Base) — before first deployment

---

### P-008: No Retrieval Fallback — Silent Failure

**Description:** When RAG retrieval returns no relevant results (query outside indexed documents), the LLM silently answers from its pre-training knowledge rather than saying "I don't have this in the knowledge base." The PM receives authoritative-sounding misinformation.

**Warning Signs:**
- Astra answers questions about company-specific processes even when the relevant doc was never uploaded
- No "knowledge gap" log exists — there is no visibility into what Astra couldn't find
- Retrieval threshold is set to 0 or very low similarity scores are accepted
- No "I don't have a source for this" response path in any prompt

**Prevention Strategy:**
- Set a minimum cosine similarity threshold (e.g., 0.75) below which retrieval is considered a miss
- On retrieval miss: return an explicit "I couldn't find this in the knowledge base" with offer to search broader or ask PM to upload the relevant doc
- Log all retrieval misses to a "knowledge gap" dashboard — this becomes the backlog for what to add to the knowledge base
- Never allow the LLM to answer operational/company-specific questions without at least one retrieved source

**Phase:** Phase 3 (RAG/Knowledge Base)

---

## CATEGORY 3: INTEGRATION & API PITFALLS

---

### P-009: OAuth Token Expiry Breaks Silent Operations

**Description:** Gmail, Google Calendar, and Google Drive all use OAuth 2.0 with access tokens that expire. In a bot that performs background operations (scheduled email triage, auto-reports), a token expiry causes silent failure: the job fails, nothing is delivered, and the PM doesn't know until they ask why Astra didn't do something.

**Warning Signs:**
- Scheduled reports stop arriving without error notification to PM
- ClickUp sync fails silently during off-hours
- No token health monitoring exists
- Re-authentication requires developer intervention, not a self-service PM flow

**Prevention Strategy:**
- Implement proactive token refresh: refresh access tokens before expiry (not on failure)
- For background jobs: if any API call fails with 401, immediately notify PM via Telegram/Slack with a re-auth link — never silently skip the job
- Build a "credentials health" status command: `/status` shows which integrations are authenticated and token expiry dates
- Store refresh tokens securely (encrypted at rest) and test the refresh flow explicitly in integration tests

**Phase:** Phase 2 (Integration setup) — must be solved before first scheduled job

---

### P-010: Rate Limiting Cascade Across Multiple Integrations

**Description:** Astra hits API rate limits on Gmail (250 quota units/second), Google Calendar, or ClickUp during peak operations (e.g., morning report generation that touches all integrations simultaneously). Requests fail, are retried in parallel, escalating the cascade.

**Warning Signs:**
- Morning report generation fails or is incomplete
- API error logs show 429 responses from multiple providers simultaneously
- No per-integration request queue or rate limiter exists
- Retry logic uses fixed delays rather than exponential backoff with jitter

**Prevention Strategy:**
- Implement a per-integration request queue with rate limiting (token bucket algorithm per API)
- Use exponential backoff with random jitter on all retries — never fixed delay
- Stagger scheduled operations: email triage at 08:00, ClickUp sync at 08:05, Calendar fetch at 08:10 — not all at once
- Monitor API quota consumption and alert before hitting limits (e.g., alert at 80% daily quota)

**Phase:** Phase 2 (Integration setup)

---

### P-011: ClickUp Webhook Payload Schema Drift

**Description:** ClickUp, Gmail, and Google Calendar webhook payloads change when the third-party service updates their API. A breaking schema change silently corrupts task data or causes webhook processing to fail, causing Astra to operate on stale data.

**Warning Signs:**
- Task statuses in Astra are inconsistent with ClickUp after a ClickUp release
- Webhook processor throws parse errors in logs but bot continues running on cached data
- No webhook payload schema validation exists
- No alerting when webhook processing fails > N times in a row

**Prevention Strategy:**
- Validate all incoming webhook payloads against a defined schema (Zod) immediately at ingestion — reject and alert on schema mismatch before processing
- Log raw webhook payloads for 7 days for debugging schema drift
- Subscribe to changelogs of all third-party APIs (ClickUp, Google Workspace) and treat API updates as a maintenance trigger
- Implement dead-letter queue for failed webhook events with automatic PM notification

**Phase:** Phase 2 (each integration at point of build)

---

### P-012: Ghost-Writing Sends Without PM Review

**Description:** Astra ghost-writes Slack DMs and Gmail replies. A critical pitfall is any flow path where Astra sends a message on behalf of the PM without explicit confirmation. A mis-tone, factually wrong, or prematurely sent message to a client, investor, or team lead is a serious professional incident.

**Warning Signs:**
- "Auto-send" mode exists or is being considered for convenience
- Confirmation UI is a single click next to a long message (easy to misclick)
- No audit log of sent ghost-written messages
- PM can't see what was sent after the fact

**Prevention Strategy:**
- Ghost-writing is ALWAYS a "draft and present, never auto-send" flow — this is a hard architectural rule with no exceptions
- Confirmation requires explicit action: present the draft, require PM to actively approve (not just "don't reject within N seconds")
- Maintain a full audit log of all ghost-written drafts (approved and rejected) with timestamps
- Add a "sending as PM" warning label visible in the confirmation UI

**Phase:** Phase 2 (Ghost-writing feature) — architectural constraint, not a feature flag

---

## CATEGORY 4: SELF-LEARNING & SELF-EXTENSION PITFALLS

---

### P-013: Self-Learning Degrades Model Quality Over Time

**Description:** Self-learning (fine-tuning or RAG feedback loops on PM corrections) can degrade quality if implemented naively. Feedback is collected without quality gates: the PM's quick correction in a bad mood, a correction to a context the model no longer has, or a single outlier correction can skew behavior.

**Warning Signs:**
- Astra's quality metrics start declining 2-4 weeks after self-learning is enabled
- No review queue for feedback before it enters the training loop
- Self-learning runs automatically without human validation
- No baseline evaluation set to compare model versions against

**Prevention Strategy:**
- Treat every correction as a candidate, not an immediate training signal — all corrections go into a review queue
- Define a minimum correction batch size (e.g., 50 corrections) before any fine-tuning or prompt update is triggered
- Maintain a frozen evaluation set of 100 representative scenarios — run it before and after every self-learning cycle; require quality >= baseline before deploying
- Self-learning operates on a weekly cycle maximum, never real-time

**Phase:** Phase 4 (Self-learning) — quality gate architecture before any learning is enabled

---

### P-014: Self-Extension Creates Unaudited Capabilities

**Description:** Self-extension (Astra adding new tools or integrations to itself) creates a capability audit nightmare. An autonomously added integration may have security vulnerabilities, excessive OAuth scopes, or create unintended side effects in production.

**Warning Signs:**
- Astra can propose and deploy new integrations without PM approval
- No sandboxed testing environment for self-extension code before production deployment
- New capabilities added by Astra are not logged or versioned
- No scope limitation on what Astra is allowed to extend itself with

**Prevention Strategy:**
- All self-extension is gated: Astra proposes an extension, PM reviews and approves before any code runs in production
- Extensions are deployed to a staging environment first, with a defined testing checklist
- Maintain a capability registry: every tool/integration Astra has access to is explicitly listed with its OAuth scopes, rate limits, and data access
- Apply the principle of least privilege to every new extension: minimum scopes needed, no write access by default for new integrations

**Phase:** Phase 5 (Self-extension) — governance model must be designed before any self-extension code is written

---

### P-015: Feedback Loop Creates Confidentiality Breach

**Description:** Self-learning collects PM corrections and interaction logs. If not carefully scoped, these logs contain sensitive business data (client names, deal terms, salaries, unreleased game content) that then becomes training data accessible to future sessions or exported for model improvement.

**Warning Signs:**
- Interaction logs include full message bodies (not just metadata)
- No PII/sensitive data scrubbing before logs enter the training pipeline
- Training data is stored in the same location as the main knowledge base (accessible to RAG)
- No data retention policy for training logs

**Prevention Strategy:**
- Separate training data storage from operational knowledge base — training logs must never be retrievable by RAG
- Implement automatic PII/sensitive data detection (regex + LLM classification) before any interaction enters the training queue
- Define explicit data categories that must never appear in training data: client names, financial figures, personal data
- Set a 90-day retention limit on raw interaction logs; only keep the anonymized/scrubbed corrections

**Phase:** Phase 4 (Self-learning) — data architecture before any logging is enabled

---

## CATEGORY 5: MULTI-CHANNEL & UX PITFALLS

---

### P-016: Channel-Specific Formatting Breaks Cross-Channel Sync

**Description:** Astra generates a ClickUp task from a Telegram message and posts a summary to Slack. Markdown formatting, mentions (@username), links, and emoji rendering differ between Telegram, Slack, and ClickUp. A message that renders correctly in Telegram looks broken in Slack.

**Warning Signs:**
- Slack messages contain raw Telegram markdown (`**bold**` instead of `*bold*`)
- ClickUp task descriptions contain Telegram-specific formatting characters
- Links from one platform are not converted to the format expected by another
- No channel-agnostic intermediate representation exists in the message pipeline

**Prevention Strategy:**
- Define a canonical internal message format (AST or structured JSON) that all channels translate to/from — never pass raw text from one channel's format to another
- Build explicit format adapters for each channel: Telegram-in → canonical, canonical → Slack-out, canonical → ClickUp-out
- Maintain a rendering test suite: for each cross-channel operation, verify the output renders correctly in the target channel
- Never expose raw API markdown to the LLM for generation — give it the canonical format and let the adapter handle rendering

**Phase:** Phase 2 (Multi-channel core)

---

### P-017: No Graceful Degradation When LLM Is Unavailable

**Description:** When the LLM API is down, slow, or over quota, the entire Astra bot becomes unresponsive. The PM has no fallback for urgent operations (checking if a task is overdue, sending a message, checking calendar).

**Warning Signs:**
- Bot goes completely silent during OpenAI/Anthropic outages
- No timeout or circuit breaker on LLM API calls
- No "dumb mode" for simple operations that don't need LLM reasoning
- PM has no way to know if Astra is down vs. just slow

**Prevention Strategy:**
- Implement a circuit breaker on all LLM API calls: after 3 consecutive failures, enter "degraded mode"
- In degraded mode, expose direct API commands (structured commands without NLU): `/tasks overdue`, `/calendar today` — these bypass the LLM entirely
- Send a proactive notification to PM when entering/exiting degraded mode
- Set a 30-second timeout on all LLM calls with immediate user feedback ("thinking takes longer than usual…")

**Phase:** Phase 2 (Bot core infrastructure)

---

### P-018: PM Notification Fatigue

**Description:** Astra is connected to Gmail, ClickUp, Calendar, Slack, and Telegram. Without a smart aggregation and prioritization layer, Astra becomes a notification firehose — forwarding every update from every integration and creating more noise than the problem it solves.

**Warning Signs:**
- PM receives >20 Astra messages per day within the first week
- Notification volume increases as more integrations are added
- PM starts muting or ignoring Astra messages
- No "digest mode" or notification batching exists

**Prevention Strategy:**
- Define notification tiers at architecture level: Critical (immediate), Important (batched hourly), FYI (daily digest)
- Default to digest mode for all integrations — PM must opt-in to real-time notifications
- Build a notification deduplication layer: if the same task/email/event generates signals from multiple integrations, send one consolidated notification
- Include weekly "notification review" where Astra reports what it surfaced vs. what PM acted on — use this to tune suppression rules

**Phase:** Phase 2 (Notification system) — design before adding more than 2 integrations

---

## CATEGORY 6: INFRASTRUCTURE & OPERATIONS PITFALLS

---

### P-019: No Observability — Running Blind in Production

**Description:** The bot is deployed on a VPS and runs silently. Without structured logging, metrics, and alerting, the first sign of a problem is the PM asking why something didn't happen. Debugging in production without traces is 10x harder than with them.

**Warning Signs:**
- Logs are unstructured (plain text, mixed formats)
- No way to trace a specific PM command through all its steps (Telegram → LLM → ClickUp → response)
- No alerting on error rate or latency spikes
- No dashboard showing integration health at a glance

**Prevention Strategy:**
- Instrument every bot action with structured logs from Day 1: correlation ID (one per PM command), step name, duration, success/failure, integration touched
- Add basic metrics from the start: LLM latency p95, integration success rate, cost per command
- Set up alerting thresholds before production: error rate > 5% in 5 minutes triggers notification to developer channel
- Implement a `/health` admin command that shows integration status, last successful operation per integration, and current queue depths

**Phase:** Phase 1 (Infrastructure) — must be in place before first deployment

---

### P-020: VPS Single-Point-of-Failure for Production PM Use

**Description:** Self-hosted VPS without redundancy means any server maintenance, disk failure, or resource exhaustion takes down Astra entirely. A PM who depends on Astra for daily workflow is blocked.

**Warning Signs:**
- Single VPS with no backup strategy
- No automated restart on process crash (no process supervisor)
- Database/vector store has no backup
- Deployment process requires manual intervention

**Prevention Strategy:**
- Use a process supervisor (PM2, systemd) for automatic restart on crash from Day 1
- Schedule daily automated backups for all persistent data (vector store, credentials store, interaction logs) to a separate location (Backblaze B2, Google Drive)
- Define and test a recovery procedure: "How long to restore from backup?" — target < 30 minutes
- For the MVP phase, document planned maintenance windows and communicate them to the PM

**Phase:** Phase 1 (Infrastructure)

---

### P-021: Credentials Stored Insecurely

**Description:** Astra stores OAuth tokens for Gmail, Google Calendar, Google Drive, ClickUp, and potentially Telegram/Slack API keys. Storing these in plaintext config files, environment variables without secrets management, or in the repository creates a significant security and operational risk on a self-hosted VPS.

**Warning Signs:**
- `.env` file contains API keys and is not encrypted
- OAuth tokens are stored in a JSON file on disk without encryption
- Credentials are in the Git repository (even in `.gitignore` misconfigurations)
- No rotation strategy exists for any credential

**Prevention Strategy:**
- Use encrypted secrets storage from Day 1: HashiCorp Vault (free tier) or at minimum OS-level secret store (Linux keyring) — never plaintext files
- All credentials are loaded from environment at runtime, not bundled in code
- `.env` files are excluded from git with pre-commit hook verification
- Define a credential rotation schedule: API keys every 90 days, OAuth tokens rotated on each use (refresh token flow)

**Phase:** Phase 1 (Infrastructure) — before any credential is generated

---

## CATEGORY 7: PROJECT-SPECIFIC GAMEDEV PITFALLS

---

### P-022: Gamedev-Specific Jargon Not in RAG Corpus

**Description:** Gamedev companies use highly specialized vocabulary (GDD = Game Design Document, sprint = game development sprint with different semantics than software sprint, milestone = submission milestone, not project milestone). Generic LLM knowledge of these terms does not match the company's specific usage, and if the RAG corpus doesn't include company-specific definitions, Astra gives generic advice that doesn't fit.

**Warning Signs:**
- Astra's reports use the word "sprint" in a software-development sense when the company means a different thing
- Answers about "milestones" reference generic PM frameworks instead of the company's milestone submission process
- No company-specific glossary exists in the knowledge base
- Onboarding docs and GDD templates are not indexed

**Prevention Strategy:**
- Create a company glossary as the first document added to the RAG knowledge base before any other indexing
- Include GDD templates, milestone submission checklists, and internal process documents in the initial corpus
- Add a "domain calibration" evaluation set: 20 questions using company-specific terminology, verify Astra uses the company definition not the generic one
- Review Astra's first 50 responses with the PM for terminology correctness before declaring the RAG system ready

**Phase:** Phase 3 (RAG/Knowledge Base) — glossary is Day 1 of RAG setup

---

### P-023: Game Release Crunch vs. Bot Maintenance Conflict

**Description:** Gamedev companies experience crunch periods (intense work before game releases, submission deadlines). During crunch, the PM needs Astra most AND has zero time to maintain or troubleshoot it. If the bot requires frequent manual intervention, it becomes a liability during the period of highest value.

**Warning Signs:**
- Bot has required manual intervention more than once per week during normal operations
- No "autopilot mode" configuration for crunch periods
- Feature additions are planned without considering the crunch calendar
- No "frozen state" capability: ability to lock Astra to its current working configuration without any changes

**Prevention Strategy:**
- Define an explicit "crunch mode" configuration: notifications reduced to critical-only, self-extension and self-learning paused, no scheduled maintenance
- Before any major game release date (trackable from ClickUp/Calendar), auto-activate crunch mode
- Set a "feature freeze" period of 2 weeks before major release dates — no new integrations or prompt changes during this window
- Ensure all self-healing capabilities (auto-restart, token refresh, error recovery) work without any manual intervention

**Phase:** Phase 2+ — operational policy defined before first production crunch

---

## SUMMARY: Phase Mapping

| Phase | Pitfalls to Address |
|-------|-------------------|
| Phase 1 — Core Architecture | P-001, P-002, P-003, P-004, P-019, P-020, P-021 |
| Phase 2 — Integrations & Bot Core | P-009, P-010, P-011, P-012, P-016, P-017, P-018, P-023 |
| Phase 3 — RAG / Knowledge Base | P-005, P-006, P-007, P-008, P-022 |
| Phase 4 — Self-Learning | P-013, P-015 |
| Phase 5 — Self-Extension | P-014 |

---

## QUICK REFERENCE: Highest-Risk Pitfalls

| Rank | Pitfall | Why Critical |
|------|---------|-------------|
| 1 | P-012: Ghost-writing auto-sends | Irreversible professional damage |
| 2 | P-002: Hallucination in operational data | PM makes real decisions on fake data |
| 3 | P-021: Credentials insecure | Full account compromise on VPS |
| 4 | P-014: Self-extension unaudited | Uncontrolled capability growth |
| 5 | P-009: Silent OAuth expiry | Core features fail invisibly |

---

*Research date: 2026-02-23. Domain: AI PM assistant bots, multi-integration LLM systems, RAG knowledge bases, gamedev PM context.*
