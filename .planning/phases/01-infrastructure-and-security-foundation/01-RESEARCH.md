# Phase 1: Infrastructure and Security Foundation - Research

**Researched:** 2026-02-23
**Domain:** Docker orchestration, credential encryption, structured logging, LLM integration
**Confidence:** HIGH (Docker, encryption, logging) / MEDIUM (LLM access strategy due to policy changes)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- VPS with 8+ GB RAM (Hetzner/DigitalOcean class, ~$30-50/month)
- Single Docker Compose setup for both dev and prod environments (same docker-compose.yml)
- Services: PostgreSQL, Redis, Qdrant, bot, worker (no LiteLLM -- not needed)
- Health checks for all services with single-command startup
- API tokens (Telegram, Slack, ClickUp) entered via .env file
- Tokens encrypted with AES-256-GCM when stored in PostgreSQL
- Google OAuth handled via one-time setup script (opens browser, saves tokens to DB encrypted)
- Encryption scope: API tokens and OAuth refresh tokens only -- message content and conversation history stored as plaintext
- No key rotation mechanism needed now -- single master key in .env, manual re-encryption if needed
- OAuth token auto-refresh handled by the application
- Structured JSON logging only (Pino) -- no Grafana, Loki, or dashboards
- View logs via `docker logs` and `jq`
- Audit trail stored in PostgreSQL, 30-day retention with automatic cleanup
- Each action logged with correlation ID (who requested, what was done, which model used)
- Health alerts sent to user via Telegram when services go down or LLM is unavailable
- Single provider: Claude via Max subscription OAuth (no LiteLLM proxy needed)
- Single model: Sonnet for all tasks -- no tiering, no classification by complexity
- Fallback strategy: inform user with friendly message when Claude is unavailable (no silent retries, no alternative providers)
- Task complexity classification deferred
- Anthropic OAuth app not yet created -- setup instructions needed in plan

### Claude's Discretion
- Runtime/language choice (TypeScript+Node.js vs Python)
- Network isolation strategy (which ports exposed vs Docker-internal only)
- Exact Docker Compose service configuration and resource limits
- Health check implementation details
- Log rotation strategy

### Deferred Ideas (OUT OF SCOPE)
- Key rotation mechanism -- add when/if security audit requires it
- Task complexity classification and multi-tier routing -- add when different models needed
- Grafana/Loki monitoring stack -- add if log-based debugging proves insufficient
- Cost tracking per request -- not applicable with Max subscription
- LiteLLM or multi-provider support -- not needed with Claude-only approach
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INFRA-01 | System runs as Docker Compose stack on VPS with all services (Qdrant, PostgreSQL, Redis, bot, worker) | Docker Compose multi-service patterns, health checks, depends_on with service_healthy |
| INFRA-02 | All API tokens encrypted at rest using AES-256-GCM | Node.js crypto module patterns, IV management, auth tag handling |
| INFRA-03 | Structured JSON logging (Pino) with audit trail for all bot actions | Pino child loggers, correlation IDs, PostgreSQL audit table design |
| INFRA-04 | Multi-LLM routing: Haiku for triage, Sonnet for standard, Opus for complex | **USER OVERRIDE: Single model (Sonnet) for all tasks. No tiering.** |
| INFRA-05 | LLM fallback chains: if primary model unavailable, route to fallback automatically | **USER OVERRIDE: Inform user via Telegram when Claude unavailable. No silent fallback.** |
</phase_requirements>

## Summary

This phase builds the invisible foundation: a Docker Compose stack running PostgreSQL, Redis, Qdrant, a Telegram bot, and a background worker -- all starting with one command, all health-checked. API credentials are encrypted at rest with AES-256-GCM, every action produces structured JSON logs with correlation IDs, and the system talks to Claude for LLM work.

**CRITICAL FINDING: Anthropic banned Claude Max subscription OAuth for third-party applications in January-February 2026.** The user's original plan to use Claude Max OAuth is no longer viable. The system MUST use the Anthropic API with API key authentication and usage-based billing ($3/MTok input, $15/MTok output for Sonnet). This is a significant architectural change that the user needs to be informed about.

**Primary recommendation:** Use TypeScript + Node.js runtime, Drizzle ORM for PostgreSQL, Pino for logging, grammY for Telegram bot, `@anthropic-ai/sdk` for Claude API access with API key (not OAuth). Inform the user about the Claude Max OAuth ban and the shift to usage-based API billing.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js | 22 LTS | Runtime | Long-term support, current LTS, required by Anthropic SDK |
| TypeScript | 5.x | Type safety | Standard for production Node.js, full ecosystem support |
| @anthropic-ai/sdk | latest | Claude API client | Official SDK, TypeScript-first, streaming support |
| drizzle-orm | latest | PostgreSQL ORM | Lightweight (~7kb), TypeScript-first, SQL-centric, zero binary deps |
| drizzle-kit | latest | Schema migrations | Generate + migrate workflow, schema-as-code |
| pino | 9.x | Structured logging | Fastest Node.js JSON logger, 5x faster than alternatives |
| grammy | 1.40.x | Telegram bot | TypeScript-first, active maintenance, plugin ecosystem |
| ioredis | 5.x | Redis client | Standard Node.js Redis client, cluster support, TypeScript types |
| @qdrant/js-client-rest | latest | Qdrant vector DB client | Official JS client for Qdrant REST API |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| pino-pretty | latest | Dev log formatting | Development only -- human-readable log output |
| dotenv | latest | Env var loading | Load .env files in development |
| zod | 3.x | Schema validation | Validate config, API inputs, env vars |
| uuid | latest | Correlation IDs | Generate v4 UUIDs for request tracing |
| pg | latest | PostgreSQL driver | Low-level driver used by Drizzle |
| tsx | latest | TypeScript execution | Run .ts files directly in dev |
| node-cron | latest | Scheduled tasks | Audit trail cleanup, health check intervals |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Drizzle | Prisma | Prisma has better DX for simple queries but adds binary dependency, proprietary DSL, heavier footprint. Drizzle is lighter, closer to SQL, better for this project's needs |
| Drizzle | TypeORM | TypeORM has spotty maintenance, critical bugs unresolved. Drizzle is actively maintained |
| grammY | Telegraf | Telegraf is older, grammY is TypeScript-first with better type safety |
| pino | winston | Winston is 5x slower. Pino is the standard for high-performance JSON logging |
| ioredis | redis (node-redis) | Both work well. ioredis has slightly better TypeScript support and API ergonomics |

### Installation
```bash
# Core runtime
npm install typescript @types/node tsx

# Application
npm install @anthropic-ai/sdk grammy pino ioredis @qdrant/js-client-rest pg zod uuid dotenv node-cron

# Database ORM
npm install drizzle-orm
npm install -D drizzle-kit

# Development
npm install -D pino-pretty @types/pg @types/uuid
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── bot/              # Telegram bot handlers and middleware
│   ├── index.ts      # Bot initialization and startup
│   ├── middleware/    # Logging, auth, error handling middleware
│   └── commands/     # Bot command handlers
├── worker/           # Background job processor
│   ├── index.ts      # Worker initialization
│   └── jobs/         # Individual job handlers
├── db/               # Database layer
│   ├── schema.ts     # Drizzle schema definitions (single source of truth)
│   ├── index.ts      # Database connection and Drizzle instance
│   ├── migrations/   # Generated SQL migrations
│   └── repositories/ # Data access layer
├── llm/              # LLM integration
│   ├── client.ts     # Anthropic SDK wrapper
│   └── types.ts      # LLM-related types
├── crypto/           # Encryption utilities
│   ├── encrypt.ts    # AES-256-GCM encrypt/decrypt functions
│   └── types.ts      # Crypto-related types
├── logging/          # Logging infrastructure
│   ├── logger.ts     # Pino logger factory
│   ├── audit.ts      # Audit trail writer (PostgreSQL)
│   └── correlation.ts # Correlation ID management
├── health/           # Health check and alerting
│   ├── checker.ts    # Service health check logic
│   └── alerter.ts    # Telegram alert sender
├── config/           # Configuration management
│   ├── env.ts        # Environment variable validation (Zod)
│   └── index.ts      # Config export
└── types/            # Shared types
    └── index.ts
```

### Pattern 1: Credential Encryption Service
**What:** Stateless encrypt/decrypt functions using Node.js built-in `crypto` module with AES-256-GCM
**When to use:** Whenever reading or writing API tokens to PostgreSQL

```typescript
// Source: Node.js crypto docs + verified GitHub patterns
import crypto from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12  // 96-bit IV recommended for GCM by NIST
const TAG_LENGTH = 16 // 128-bit auth tag

interface EncryptedPayload {
  ciphertext: string  // base64
  iv: string          // base64
  tag: string         // base64
}

export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  let ciphertext = cipher.update(plaintext, 'utf8', 'base64')
  ciphertext += cipher.final('base64')
  const tag = cipher.getAuthTag()

  return {
    ciphertext,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  }
}

export function decrypt(payload: EncryptedPayload, key: Buffer): string {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(payload.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
  let plaintext = decipher.update(payload.ciphertext, 'base64', 'utf8')
  plaintext += decipher.final('utf8')
  return plaintext
}
```

### Pattern 2: Pino Logger with Correlation ID
**What:** Create a base logger, then child loggers per-request with correlation ID
**When to use:** Every incoming request/action should get a child logger

```typescript
// Source: Pino official docs + production guides
import pino from 'pino'
import { randomUUID } from 'node:crypto'

// Base logger -- created once at startup
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level(label) {
      return { level: label }
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
})

// Create child logger for a specific action/request
export function createRequestLogger(context: {
  userId?: string
  action?: string
  source?: string
}) {
  return logger.child({
    correlationId: randomUUID(),
    ...context,
  })
}
```

### Pattern 3: Claude API Client with Error Handling
**What:** Thin wrapper around @anthropic-ai/sdk that handles errors and logs LLM interactions
**When to use:** All LLM calls go through this wrapper

```typescript
// Source: @anthropic-ai/sdk npm package + official docs
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

export async function callClaude(
  messages: Anthropic.MessageParam[],
  options?: { maxTokens?: number; system?: string },
  requestLogger?: pino.Logger,
): Promise<Anthropic.Message> {
  const log = requestLogger || logger

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: options?.maxTokens ?? 4096,
      system: options?.system,
      messages,
    })

    log.info({
      event: 'llm_response',
      model: message.model,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      stopReason: message.stop_reason,
    })

    return message
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      log.error({
        event: 'llm_error',
        status: error.status,
        message: error.message,
      })

      // Notify user via Telegram if service is unavailable
      if (error.status === 529 || error.status === 503 || error.status === 429) {
        // Trigger health alert
      }
    }
    throw error
  }
}
```

### Pattern 4: Docker Compose Health Checks
**What:** Each service defines its own healthcheck, app services use depends_on with service_healthy condition
**When to use:** docker-compose.yml for all environments

```yaml
# Source: Docker Compose official docs
services:
  postgres:
    image: postgres:16-alpine
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  qdrant:
    image: qdrant/qdrant:latest
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:6333/readyz || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
    volumes:
      - qdrant_data:/qdrant/storage

  bot:
    build: .
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      qdrant:
        condition: service_healthy
    restart: unless-stopped
```

### Pattern 5: Audit Trail Table
**What:** PostgreSQL table for storing structured audit entries with automatic cleanup
**When to use:** Every bot action produces an audit entry

```typescript
// Drizzle schema for audit trail
import { pgTable, serial, text, timestamp, jsonb, bigserial } from 'drizzle-orm/pg-core'

export const auditTrail = pgTable('audit_trail', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  correlationId: text('correlation_id').notNull(),
  userId: text('user_id'),
  action: text('action').notNull(),         // e.g., 'llm_request', 'task_create', 'email_draft'
  source: text('source'),                   // 'telegram', 'slack', 'scheduler'
  model: text('model'),                     // LLM model used, if applicable
  metadata: jsonb('metadata'),              // Additional context (JSON)
  status: text('status').notNull(),         // 'success', 'error', 'timeout'
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
```

### Anti-Patterns to Avoid
- **Encrypting everything:** Only encrypt API tokens and OAuth refresh tokens. Encrypting message content adds complexity and makes debugging impossible without the key. The user explicitly decided plaintext for content.
- **Synchronous logging in request path:** Always use Pino's async transport or write audit trail entries asynchronously (fire-and-forget or queue via Redis).
- **Shared mutable state between bot and worker:** Bot and worker are separate processes. Communicate only via Redis pub/sub or PostgreSQL.
- **Exposing all ports to host:** Only expose what's needed. PostgreSQL, Redis, and Qdrant should be Docker-internal only. Only the bot needs external network (for Telegram API polling).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Encryption | Custom crypto primitives | Node.js built-in `crypto` with AES-256-GCM | Crypto is easy to get wrong. Node's crypto module wraps OpenSSL, battle-tested |
| Database migrations | Manual SQL scripts | Drizzle Kit (`drizzle-kit generate` / `drizzle-kit migrate`) | Schema drift, missing migrations, ordering bugs |
| Telegram bot framework | Raw HTTP to Bot API | grammY | Polling management, update parsing, middleware chain, error handling |
| JSON logging | Custom JSON serializer | Pino | Performance (5x faster), proper stream handling, child logger support |
| UUID generation | Custom ID generators | `crypto.randomUUID()` (Node.js built-in) | RFC 4122 compliant, cryptographically secure |
| Env validation | Manual string checks | Zod schemas | Type-safe, descriptive errors, default values |
| Redis client | Custom TCP connection | ioredis | Connection pooling, reconnection, cluster support, Lua scripting |

**Key insight:** Every component in the infrastructure layer has battle-tested library solutions. The only custom code should be the glue between them (encryption service wrapping crypto, audit writer wrapping Drizzle, LLM client wrapping Anthropic SDK).

## Common Pitfalls

### Pitfall 1: IV Reuse in AES-256-GCM
**What goes wrong:** Reusing the same IV (initialization vector) with the same key completely breaks GCM security -- allows plaintext recovery via XOR of ciphertexts
**Why it happens:** Developers store a fixed IV or use a counter that resets
**How to avoid:** ALWAYS generate a fresh random IV via `crypto.randomBytes(12)` for every single encrypt call. Store IV alongside ciphertext.
**Warning signs:** If you see a constant IV value anywhere in the code, it's broken

### Pitfall 2: Missing Auth Tag Verification in GCM
**What goes wrong:** If you don't call `decipher.setAuthTag()` before `decipher.final()`, GCM provides no integrity guarantee -- data could be tampered with
**Why it happens:** Developers copy CBC patterns where there's no auth tag
**How to avoid:** Always store the auth tag from `cipher.getAuthTag()` and set it on the decipher. The encrypted payload must include: ciphertext + IV + auth tag.
**Warning signs:** Encrypted data that doesn't include a tag field

### Pitfall 3: Docker Compose Service Startup Order Without Health Checks
**What goes wrong:** Bot starts before PostgreSQL is ready to accept connections, causing connection errors
**Why it happens:** `depends_on` without `condition: service_healthy` only waits for the container to START, not for the service to be READY
**How to avoid:** Every service MUST have a `healthcheck` defined, and app services MUST use `depends_on` with `condition: service_healthy`
**Warning signs:** Intermittent "connection refused" errors on startup

### Pitfall 4: Logging Sensitive Data
**What goes wrong:** API tokens, encryption keys, or user credentials appear in log output
**Why it happens:** Logging entire request/response objects without redaction
**How to avoid:** Use Pino's `redact` option to mask sensitive fields. Never log the encryption key or raw tokens.
**Warning signs:** Seeing `token`, `key`, `password`, or `secret` fields in log output

```typescript
const logger = pino({
  redact: ['*.token', '*.apiKey', '*.password', '*.secret', '*.encryptionKey'],
})
```

### Pitfall 5: Anthropic API Error Handling -- 529 Overloaded
**What goes wrong:** Claude API returns 529 (overloaded) and the app crashes or retries infinitely
**Why it happens:** Not handling Anthropic-specific error codes. 529 is not a standard HTTP status code.
**How to avoid:** Catch `Anthropic.APIError`, check `error.status`. For 529 (overloaded) and 503 (service unavailable), alert user via Telegram. For 429 (rate limit), implement exponential backoff with jitter. For 401 (auth), log critical error.
**Warning signs:** Unhandled promise rejections with status 529

### Pitfall 6: Audit Trail Table Growing Unbounded
**What goes wrong:** PostgreSQL disk usage grows indefinitely, queries slow down
**Why it happens:** No cleanup mechanism, no partitioning
**How to avoid:** Implement 30-day retention via scheduled job (`node-cron`). Consider partitioning by month if volume is high. Create index on `created_at` for cleanup queries.
**Warning signs:** Audit table row count growing without bounds, slow audit queries

## Code Examples

### Environment Configuration with Zod Validation
```typescript
// Source: Zod official docs
import { z } from 'zod'
import 'dotenv/config'

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Encryption
  ENCRYPTION_KEY: z.string().length(64, 'Must be 32 bytes hex-encoded'),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ADMIN_CHAT_ID: z.string().min(1),

  // Claude API
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-'),

  // Optional
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
})

export const env = envSchema.parse(process.env)
export type Env = z.infer<typeof envSchema>
```

### Encrypted Credentials Repository
```typescript
// Repository pattern for storing/retrieving encrypted credentials
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { credentials } from '../db/schema'
import { encrypt, decrypt } from '../crypto/encrypt'

export class CredentialRepository {
  constructor(private encryptionKey: Buffer) {}

  async store(name: string, value: string): Promise<void> {
    const encrypted = encrypt(value, this.encryptionKey)
    await db.insert(credentials).values({
      name,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
    }).onConflictDoUpdate({
      target: credentials.name,
      set: {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        updatedAt: new Date(),
      },
    })
  }

  async retrieve(name: string): Promise<string | null> {
    const row = await db.select()
      .from(credentials)
      .where(eq(credentials.name, name))
      .limit(1)

    if (row.length === 0) return null

    return decrypt({
      ciphertext: row[0].ciphertext,
      iv: row[0].iv,
      tag: row[0].tag,
    }, this.encryptionKey)
  }
}
```

### Audit Trail Cleanup Job
```typescript
// Scheduled cleanup of audit entries older than 30 days
import cron from 'node-cron'
import { lt } from 'drizzle-orm'
import { db } from '../db'
import { auditTrail } from '../db/schema'
import { logger } from '../logging/logger'

export function startAuditCleanup() {
  // Run daily at 3 AM
  cron.schedule('0 3 * * *', async () => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 30)

    try {
      const result = await db.delete(auditTrail)
        .where(lt(auditTrail.createdAt, cutoff))

      logger.info({
        event: 'audit_cleanup',
        cutoffDate: cutoff.toISOString(),
        message: 'Audit trail cleanup completed',
      })
    } catch (error) {
      logger.error({
        event: 'audit_cleanup_error',
        error: String(error),
      })
    }
  })
}
```

### Health Check with Telegram Alert
```typescript
// Health checker that alerts via Telegram when services are down
import { Bot } from 'grammy'
import { logger } from '../logging/logger'

export class HealthChecker {
  private bot: Bot
  private adminChatId: string

  constructor(botToken: string, adminChatId: string) {
    this.bot = new Bot(botToken)
    this.adminChatId = adminChatId
  }

  async checkAll(): Promise<{ service: string; healthy: boolean }[]> {
    const results = await Promise.allSettled([
      this.checkPostgres(),
      this.checkRedis(),
      this.checkQdrant(),
      this.checkClaude(),
    ])

    const checks = results.map((result, i) => ({
      service: ['postgres', 'redis', 'qdrant', 'claude'][i],
      healthy: result.status === 'fulfilled' && result.value,
    }))

    const unhealthy = checks.filter(c => !c.healthy)
    if (unhealthy.length > 0) {
      await this.alertUser(unhealthy)
    }

    return checks
  }

  private async alertUser(unhealthy: { service: string; healthy: boolean }[]) {
    const services = unhealthy.map(s => s.service).join(', ')
    const message = `Service health alert: ${services} unavailable. Checking every 60s.`

    try {
      await this.bot.api.sendMessage(this.adminChatId, message)
    } catch (error) {
      logger.error({ event: 'alert_send_error', error: String(error) })
    }
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Claude Max OAuth for third-party apps | API key + usage-based billing ONLY | Jan-Feb 2026 | **BREAKING:** Cannot use Max subscription OAuth in custom applications. Must use API keys. |
| Prisma as default TypeScript ORM | Drizzle ORM gaining mainstream adoption | 2025 | Drizzle is lighter (7kb), no binary deps, closer to SQL |
| Winston for Node.js logging | Pino as standard for production JSON logging | 2023+ | Pino is 5x faster, JSON-native, better child logger support |
| Telegraf for Telegram bots | grammY as modern TypeScript-first alternative | 2024+ | grammY has better TypeScript types, active development |
| TypeORM for TypeScript DB | Drizzle or Prisma | 2024+ | TypeORM maintenance concerns, Drizzle/Prisma have better DX |

**Deprecated/outdated:**
- **Claude Max OAuth in third-party apps:** Banned by Anthropic in January 2026. Server-side blocks deployed, followed by explicit policy update on February 19, 2026. Using OAuth tokens from consumer plans (Free/Pro/Max) in any non-official product violates Anthropic's Consumer Terms of Service.
- **Prisma Rust query engine:** Prisma 7 (late 2025) removed the Rust engine. Architecture changed significantly.

## Critical Finding: Claude Max OAuth Ban

**Confidence: HIGH** -- Multiple authoritative sources confirm this (The Register, VentureBeat, Hacker News, GitHub issues)

### What Happened
- January 9, 2026: Anthropic deployed server-side blocks preventing subscription OAuth tokens from working outside official Claude Code CLI
- February 19, 2026: Documentation update officially clarified the policy
- Affected: All third-party tools (OpenCode, Cline, RooCode, etc.)

### Impact on This Project
The user's decision to use "Claude via Max subscription OAuth" is **no longer viable**. The system must use:

1. **Anthropic API key** (from console.anthropic.com)
2. **Usage-based billing** (not subscription)
3. **@anthropic-ai/sdk** with API key auth

### Pricing Impact (Claude Sonnet 4.x)
- Input: $3 per million tokens
- Output: $15 per million tokens
- For a personal assistant with moderate usage (~100K tokens/day): roughly $1-5/day

### Rate Limits (Starting at Tier 1, $5 deposit)
| Tier | Deposit | RPM | ITPM | OTPM |
|------|---------|-----|------|------|
| Tier 1 | $5 | 50 | 30,000 | 8,000 |
| Tier 2 | $40 | 1,000 | 450,000 | 90,000 |
| Tier 3 | $200 | 2,000 | 800,000 | 160,000 |
| Tier 4 | $400 | 4,000 | 2,000,000 | 400,000 |

Tier 1 is sufficient for a single-user personal assistant. Advance to Tier 2 if rate limits become a bottleneck.

### Recommendation
The user MUST be informed about this change before implementation begins. The plan should use API key authentication. The cost difference is significant: $0/month (Max sub covers all) vs $30-150/month depending on usage.

## Open Questions

1. **Claude Max OAuth ban -- user decision needed**
   - What we know: OAuth from consumer subscriptions is banned for third-party apps. API key with usage-based billing is required.
   - What's unclear: Whether the user wants to proceed with API billing or reconsider the LLM strategy (e.g., local models, different provider)
   - Recommendation: Proceed with Anthropic API key approach. Cost is manageable for a single-user assistant. Alert the user to this change in the plan.

2. **Qdrant in Phase 1 vs Phase 4**
   - What we know: Qdrant is in the Docker Compose stack (INFRA-01) but the actual knowledge base using it is Phase 4 (DRIVE-01, KB-01)
   - What's unclear: Whether Qdrant should be running idle in Phase 1 or added to docker-compose.yml now but left commented out
   - Recommendation: Include Qdrant in docker-compose.yml now with health check, but don't build any indexing/search code. It should start and be healthy -- that's the INFRA-01 requirement.

3. **Worker process scope in Phase 1**
   - What we know: The worker is listed as a service in Docker Compose
   - What's unclear: What jobs the worker handles in Phase 1 (before integrations exist)
   - Recommendation: Worker in Phase 1 should handle: audit trail cleanup (cron), health check polling. Minimal skeleton ready for Phase 2+ job types.

4. **Google OAuth setup script**
   - What we know: User wants a one-time script that opens a browser for Google OAuth
   - What's unclear: Whether this should be fully implemented in Phase 1 or stubbed (Google integrations are Phase 3-4)
   - Recommendation: Defer the actual Google OAuth script to Phase 3. In Phase 1, build the encrypted credential storage that will house the tokens, but don't implement the Google OAuth flow yet.

## Sources

### Primary (HIGH confidence)
- [Anthropic Claude API Pricing](https://platform.claude.com/docs/en/about-claude/pricing) - Full model pricing table, verified Feb 2026
- [Anthropic API Rate Limits](https://platform.claude.com/docs/en/api/rate-limits) - Tier structure, RPM/ITPM/OTPM limits
- [Node.js Crypto Documentation](https://nodejs.org/api/crypto.html) - AES-256-GCM cipher/decipher API (v25.6.1)
- [Docker Compose Startup Order](https://docs.docker.com/compose/how-tos/startup-order/) - depends_on with service_healthy
- [Qdrant Quickstart](https://qdrant.tech/documentation/quickstart/) - Docker setup, client initialization
- [Drizzle ORM PostgreSQL Setup](https://orm.drizzle.team/docs/get-started/postgresql-new) - Schema, migrations, config
- [@anthropic-ai/sdk npm](https://www.npmjs.com/package/@anthropic-ai/sdk) - Official TypeScript SDK
- [grammY Official Site](https://grammy.dev/) - Telegram bot framework docs

### Secondary (MEDIUM confidence)
- [The Register: Anthropic clarifies ban on third-party tool access](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/) - OAuth policy details
- [WinBuzzer: Anthropic Bans Claude Subscription OAuth](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/) - Timeline of ban
- [VentureBeat: Anthropic cracks down on unauthorized Claude usage](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses) - Policy rationale
- [Better Stack: Pino Logging Guide](https://betterstack.com/community/guides/logging/how-to-install-setup-and-use-pino-to-log-node-js-applications/) - Pino patterns and configuration
- [SigNoz: Pino Logger Guide 2026](https://signoz.io/guides/pino-logger/) - Child loggers, correlation IDs
- [Dash0: Production-Grade Logging with Pino](https://www.dash0.com/guides/logging-in-node-js-with-pino) - Production patterns
- [AES-256-GCM GitHub Gist (rjz)](https://gist.github.com/rjz/15baffeab434b8125ca4d783f4116d81) - Verified encrypt/decrypt pattern
- [Docker Compose Health Checks Guide](https://last9.io/blog/docker-compose-health-checks/) - Practical healthcheck examples
- [TheDataGuy: Node.js ORMs 2025](https://thedataguy.pro/blog/2025/12/nodejs-orm-comparison-2025/) - ORM comparison

### Tertiary (LOW confidence)
- None -- all findings verified with at least two sources

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries verified via official docs and npm
- Architecture: HIGH - Patterns verified from official documentation
- Pitfalls: HIGH - Common Node.js crypto and Docker Compose pitfalls are well-documented
- LLM access strategy: MEDIUM - OAuth ban is confirmed HIGH, but cost/rate limit implications for this specific use case need user validation

**Research date:** 2026-02-23
**Valid until:** 2026-03-23 (30 days -- stable infrastructure domain, but monitor Anthropic policy for further changes)
