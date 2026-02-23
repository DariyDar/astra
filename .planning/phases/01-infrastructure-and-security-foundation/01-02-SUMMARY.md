---
phase: 01-infrastructure-and-security-foundation
plan: 02
subsystem: infra
tags: [aes-256-gcm, pino, audit-trail, anthropic-sdk, grammy, health-check, ioredis, qdrant, node-cron]

# Dependency graph
requires:
  - phase: 01-01
    provides: "Project skeleton, Docker Compose stack, Drizzle schema (credentials + audit_trail), env config"
provides:
  - "AES-256-GCM encryption service for credential storage with fresh IV per call"
  - "CredentialRepository for encrypted upsert/retrieve/delete/list"
  - "Pino structured JSON logging with sensitive field redaction"
  - "Correlation ID generation for request-scoped tracing"
  - "Audit trail writer (fire-and-forget) with 30-day cleanup"
  - "Claude API wrapper (single Sonnet model, error-specific Telegram alerts)"
  - "Health checker monitoring PostgreSQL, Redis, Qdrant, Claude in parallel"
  - "Telegram alert sender with 5-minute rate limiting"
  - "Bot middleware: correlation IDs, audit entries, /health command"
  - "Worker: daily audit trail cleanup via node-cron"
affects: [01-03, phase-2, phase-3, phase-4, phase-5]

# Tech tracking
tech-stack:
  added: []
  patterns: ["AES-256-GCM with fresh random IV per encrypt call", "Fire-and-forget audit writes (never block request)", "Pino child loggers with correlation ID for request tracing", "Rate-limited Telegram alerts (5 min cooldown per service)", "Promise.allSettled for parallel health checks", "Single Claude model (Sonnet) with no tiering or classification"]

key-files:
  created: ["src/crypto/types.ts", "src/crypto/encrypt.ts", "src/db/repositories/credentials.ts", "src/logging/logger.ts", "src/logging/correlation.ts", "src/logging/audit.ts", "src/llm/types.ts", "src/llm/client.ts", "src/health/alerter.ts", "src/health/checker.ts"]
  modified: ["src/bot/index.ts", "src/worker/index.ts", "package.json"]

key-decisions:
  - "Used Node.js built-in crypto module (not third-party) for AES-256-GCM encryption"
  - "Removed @types/node-cron (v4 ships its own types, conflicts with v3 type definitions)"
  - "Qdrant health check uses getCollections() instead of internal api().healthz() due to type constraints"
  - "ioredis imported as named export { Redis } for ESM/NodeNext compatibility"
  - "LLM client uses pino logger bindings to extract correlationId for audit entries"

patterns-established:
  - "Encryption pattern: encrypt/decrypt with EncryptedPayload interface (ciphertext + iv + tag as base64)"
  - "Repository pattern: CredentialRepository class with constructor-injected encryption key"
  - "Audit pattern: writeAuditEntry as fire-and-forget (catch + log, never throw)"
  - "Alert pattern: sendHealthAlert with rate limiting per message key (5 min cooldown)"
  - "Middleware pattern: grammY bot.use creating request logger, storing on ctx for downstream"
  - "Graceful shutdown: stop services (health checker, cron) then close DB"

requirements-completed: [INFRA-02, INFRA-03, INFRA-04, INFRA-05]

# Metrics
duration: 10min
completed: 2026-02-23
---

# Phase 1 Plan 02: Application Service Layer Summary

**AES-256-GCM credential encryption, Pino structured logging with correlation IDs and audit trail, Claude Sonnet API wrapper with Telegram error alerts, and parallel health monitoring for all infrastructure services**

## Performance

- **Duration:** 10 min
- **Started:** 2026-02-23T13:42:00Z
- **Completed:** 2026-02-23T13:52:52Z
- **Tasks:** 2
- **Files modified:** 13

## Accomplishments
- AES-256-GCM encryption service with fresh IV per call, auth tag verification, and CredentialRepository for encrypted DB storage
- Pino structured JSON logging with redaction of sensitive fields, correlation IDs via crypto.randomUUID(), and fire-and-forget audit trail writer with 30-day cleanup
- Claude API wrapper hardcoded to Sonnet model with error-specific handling: 529/503 trigger Telegram alerts, 429 logs warning only, 401 alerts + logs critical
- Health checker monitoring PostgreSQL (SELECT 1), Redis (PING), Qdrant (getCollections), Claude (models.retrieve) with parallel Promise.allSettled execution
- Bot wired with correlation ID middleware, audit entries per message, /health command, and graceful shutdown
- Worker wired with daily 3 AM audit trail cleanup via node-cron

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement credential encryption service and structured logging infrastructure** - `749c272` (feat)
2. **Task 2: Implement LLM client and health monitoring, wire bot and worker** - `baa78ab` (feat)

## Files Created/Modified
- `src/crypto/types.ts` - EncryptedPayload interface (ciphertext, iv, tag as base64)
- `src/crypto/encrypt.ts` - AES-256-GCM encrypt/decrypt/deriveKeyFromHex functions
- `src/db/repositories/credentials.ts` - CredentialRepository class with encrypted store/retrieve/delete/list
- `src/logging/logger.ts` - Pino logger factory with JSON output, isoTime, and sensitive field redaction
- `src/logging/correlation.ts` - createRequestLogger with UUID v4 correlation IDs
- `src/logging/audit.ts` - writeAuditEntry (fire-and-forget), queryAuditTrail, cleanupOldEntries
- `src/llm/types.ts` - LlmRequestContext interface
- `src/llm/client.ts` - callClaude wrapper with Sonnet model, token logging, error-specific alerts
- `src/health/alerter.ts` - sendHealthAlert with 5-minute rate limiting per service
- `src/health/checker.ts` - HealthChecker class with parallel service checks and periodic scheduling
- `src/bot/index.ts` - Added correlation ID middleware, audit entries, /health command, graceful shutdown
- `src/worker/index.ts` - Added daily audit trail cleanup via node-cron, graceful shutdown
- `package.json` - Removed @types/node-cron (v4 ships own types)

## Decisions Made
- Used Node.js built-in `crypto` module for AES-256-GCM (no third-party dependency needed for encryption)
- Removed @types/node-cron because node-cron v4 ships its own TypeScript types that conflicted with the DefinitelyTyped v3 types
- Used `getCollections()` for Qdrant health check instead of internal `api().healthz()` due to TypeScript type constraints with the generated API client
- Imported ioredis as `{ Redis }` named export for proper ESM/NodeNext module compatibility
- LLM client extracts correlationId from pino logger bindings for audit entries

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Removed conflicting @types/node-cron**
- **Found during:** Task 2 (Worker wiring)
- **Issue:** node-cron v4 ships its own TypeScript types (`TaskOptions`, `TaskFn`, `ScheduledTask`). The @types/node-cron package provides v3 types with a different `ScheduleOptions` interface. Both active caused TS errors (`scheduled` property not in `TaskOptions`).
- **Fix:** Ran `npm uninstall @types/node-cron` and used the v4 built-in types directly.
- **Files modified:** package.json, package-lock.json
- **Verification:** `npx tsc --noEmit` passes cleanly
- **Committed in:** baa78ab (Task 2 commit)

**2. [Rule 3 - Blocking] Fixed ioredis ESM import for NodeNext resolution**
- **Found during:** Task 2 (Health checker implementation)
- **Issue:** `import Redis from 'ioredis'` resolved to a non-constructable type under NodeNext module resolution. The default export wraps the class differently in CJS types.
- **Fix:** Changed to `import { Redis } from 'ioredis'` (named export) which resolves correctly.
- **Files modified:** src/health/checker.ts
- **Verification:** `npx tsc --noEmit` passes cleanly
- **Committed in:** baa78ab (Task 2 commit)

**3. [Rule 3 - Blocking] Fixed Qdrant health check method**
- **Found during:** Task 2 (Health checker implementation)
- **Issue:** `client.api('service').healthz()` had type errors: `api()` takes 0 arguments in v1.17, and `healthz()` TypedFetch requires request params.
- **Fix:** Replaced with `client.getCollections()` -- a lightweight typed method that verifies Qdrant connectivity.
- **Files modified:** src/health/checker.ts
- **Verification:** `npx tsc --noEmit` passes cleanly, module loads successfully
- **Committed in:** baa78ab (Task 2 commit)

**4. [Rule 3 - Blocking] Fixed grammY Context.updateType property**
- **Found during:** Task 2 (Bot wiring)
- **Issue:** `ctx.updateType` does not exist on grammY's `Context` type. The property is not part of the public API.
- **Fix:** Changed to `ctx.update.update_id` which is the standard grammY way to reference the update.
- **Files modified:** src/bot/index.ts
- **Verification:** `npx tsc --noEmit` passes cleanly
- **Committed in:** baa78ab (Task 2 commit)

---

**Total deviations:** 4 auto-fixed (4 blocking issues -- all type/import incompatibilities)
**Impact on plan:** All fixes necessary for TypeScript compilation. No scope creep. Functionality matches plan exactly.

## Issues Encountered
- TypeScript type incompatibilities between library versions and NodeNext module resolution required 4 adjustments (documented above as deviations). All resolved in Task 2 before committing.

## User Setup Required

None for this plan. All services are code-only and will work when the Docker Compose stack is running with a valid `.env` file (configured in Plan 01).

## Next Phase Readiness
- Full application service layer is in place: encryption, logging, LLM client, health monitoring
- All modules compile cleanly and load successfully at runtime
- Ready for Phase 2 (Telegram bot features) to build on this infrastructure
- The bot can receive messages with correlation IDs, call Claude, and alert on failures
- The worker can run scheduled jobs (audit cleanup)

## Self-Check: PASSED

- All 12 source files verified on disk (10 created, 2 modified)
- All 2 task commits verified in git history (749c272, baa78ab)

---
*Phase: 01-infrastructure-and-security-foundation*
*Completed: 2026-02-23*
