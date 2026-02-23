# Phase 1: Infrastructure and Security Foundation - Context

**Gathered:** 2026-02-23
**Status:** Ready for planning

<domain>
## Phase Boundary

All backend services run reliably with encrypted credentials, structured observability, and intelligent LLM routing — the invisible foundation every feature depends on. Docker Compose stack, encrypted credentials, structured logging, LLM integration via Claude Max OAuth.

</domain>

<decisions>
## Implementation Decisions

### Stack & Deployment
- VPS with 8+ GB RAM (Hetzner/DigitalOcean class, ~$30-50/month)
- Single Docker Compose setup for both dev and prod environments (same docker-compose.yml)
- Services: PostgreSQL, Redis, Qdrant, bot, worker (no LiteLLM — not needed)
- Health checks for all services with single-command startup

### Credential Management
- API tokens (Telegram, Slack, ClickUp) entered via .env file
- Tokens encrypted with AES-256-GCM when stored in PostgreSQL
- Google OAuth handled via one-time setup script (opens browser, saves tokens to DB encrypted)
- Encryption scope: API tokens and OAuth refresh tokens only — message content and conversation history stored as plaintext
- No key rotation mechanism needed now — single master key in .env, manual re-encryption if needed
- OAuth token auto-refresh handled by the application

### Logging & Observability
- Structured JSON logging only (Pino) — no Grafana, Loki, or dashboards
- View logs via `docker logs` and `jq`
- Audit trail stored in PostgreSQL, 30-day retention with automatic cleanup
- Each action logged with correlation ID (who requested, what was done, which model used)
- Health alerts sent to user via Telegram when services go down or LLM is unavailable

### LLM Routing
- Single provider: Claude via Max subscription OAuth (no LiteLLM proxy needed)
- Single model: Sonnet for all tasks — no tiering, no classification by complexity
- Fallback strategy: inform user with friendly message when Claude is unavailable (no silent retries, no alternative providers)
- Task complexity classification deferred — will add when multiple model tiers are needed
- Anthropic OAuth app not yet created — setup instructions needed in plan

### Claude's Discretion
- Runtime/language choice (TypeScript+Node.js vs Python)
- Network isolation strategy (which ports exposed vs Docker-internal only)
- Exact Docker Compose service configuration and resource limits
- Health check implementation details
- Log rotation strategy

</decisions>

<specifics>
## Specific Ideas

- Claude Max OAuth is the LLM access method — this is a subscription-based access, not pay-per-token API. Changes the architecture: no LiteLLM proxy, no cost tracking, no multi-provider routing
- Bot should alert the user in Telegram about infrastructure problems — the bot itself is the monitoring channel
- Keep it simple: one model, one provider, logs not dashboards, .env not CLI tools

</specifics>

<deferred>
## Deferred Ideas

- Key rotation mechanism — add when/if security audit requires it
- Task complexity classification and multi-tier routing — add when different models needed
- Grafana/Loki monitoring stack — add if log-based debugging proves insufficient
- Cost tracking per request — not applicable with Max subscription
- LiteLLM or multi-provider support — not needed with Claude-only approach

</deferred>

---

*Phase: 01-infrastructure-and-security-foundation*
*Context gathered: 2026-02-23*
