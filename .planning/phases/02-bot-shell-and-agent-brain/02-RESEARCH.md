# Phase 2: Bot Shell and Agent Brain - Research

**Researched:** 2026-02-24
**Domain:** Multi-platform conversational bot, memory architecture, notification system
**Confidence:** HIGH

## Summary

Phase 2 transforms the existing Telegram-only echo bot into a full conversational assistant across Telegram and Slack, backed by a three-tier memory system (Redis short-term, PostgreSQL medium-term, Qdrant long-term semantic) and a notification/digest infrastructure. The core architectural challenge is building a **unified message router** that abstracts platform differences (grammY for Telegram, Bolt for Slack) so the conversational brain (Claude via CLI) sees a single normalized message format. Language detection for Russian/English is trivially solvable without external APIs using character-range heuristics (Cyrillic detection). The embedding pipeline for Qdrant semantic search requires a local model since the project has no API keys -- `@huggingface/transformers` with a multilingual ONNX model (e.g., `Xenova/paraphrase-multilingual-MiniLM-L12-v2`) runs locally in Node.js with zero external dependencies.

**Key architectural insight:** Do NOT use grammY's conversations plugin for multi-step dialogs. The user's CONTEXT.md specifies that Astra understands natural language for everything, with no slash commands (except /start, /health, /settings). Multi-step context should be handled by feeding conversation history into Claude's system prompt, letting the LLM manage dialog state naturally. This is simpler, more flexible, and works identically across Telegram and Slack.

**Primary recommendation:** Build a platform-agnostic message router with channel adapters (Telegram, Slack), pipe all messages through a unified conversation engine that loads context from the three-tier memory, calls Claude CLI, and routes responses back through the originating adapter.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Tone: friendly colleague ("дружеский коллега"), not formal assistant
- Light persona: has character, can joke, express opinions on work topics
- Response length: depends on topic — short for simple questions, detailed for reports/analysis
- When doesn't know: honestly says so, doesn't make things up
- Language: auto-detect Russian/English, respond in same language
- **Three-tier memory model:**
  - **Long-term**: All messages from all channels stored permanently, searchable via Qdrant + full-text
  - **Medium-term (~1 week)**: Active context — recent conversations, ongoing topics, project states
  - **Short-term (today)**: Current day's conversations, immediate context
- Conversation context is persistent (never expires) — "you mentioned X this morning" always works
- **Initial context load**: Feed existing chat history from available channels at startup so Astra has context from day one
- **Smart context selection for LLM**: Each request loads last N messages + relevant facts from Qdrant (not fixed window)
- **Automatic memory search**: Astra decides when to search long-term memory — transparent to user
- Slack: Bot added as Slack bot (not user account), DM conversation with admin, can read channels accessible to admin
- Single user (admin only) for both Telegram and Slack
- Free text only, no slash commands (except /start, /health, /settings for digests)
- Clarifications: simple question, free text input (no buttons/options)
- Cancel: just write about something else — Astra understands topic change
- Timeout: infinite — context preserved, continue anytime
- **All external actions require confirmation** before execution
- **Batch approve**: Astra compiles action plan, user confirms entire plan with one "yes"
- 3 urgency levels: urgent (immediate), important (in digest), normal (on request)
- Configuration: natural language + /settings menu command
- Delivery channel: configurable per notification type (Telegram / Slack)
- No quiet hours (DND)
- Morning digest on schedule with accumulated non-urgent items
- Structured responses: lists, headers, emojis for readability
- Error handling: report and retry, transparent about failures
- All external actions require explicit confirmation
- Behavior identical across Telegram and Slack (same personality, same commands)

### Claude's Discretion
- Exact memory storage structure (Redis vs PostgreSQL for different tiers)
- Qdrant collection schema for semantic search
- Slack API approach (Socket Mode vs Events API)
- Conversation state machine implementation
- Digest scheduling mechanism

### Deferred Ideas (OUT OF SCOPE)
- **Self-learning system** (Phase 7) — but architecture must support it from Phase 2 (importance scoring, feedback storage, preference patterns)
- **Ghost-writing in Slack** (Phase 6) — respond from admin's identity after explicit approval
- **Autonomy settings** (Phase 7) — configurable level of independence
- **Clockify integration** — future milestone
- **Other service integrations** — future milestone
- **Email digests with auto-filtering** (Phase 3-5) — requires Gmail integration
- **ClickUp workflow compliance digest** (Phase 3) — requires ClickUp integration
- **Google Drive audit digest** (Phase 4) — requires Drive integration

**Critical note:** Self-learning and iterative importance training are the user's TOP priority. Phase 2 must lay the architectural foundation (feedback storage, importance scoring, preference model) even though the full learning loop is Phase 7.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| MSG-01 | User can interact with Astra via Telegram personal chat in Russian and English | grammY already in place (v1.40.0), extend with message router and Claude conversational brain; language detection via Cyrillic character heuristic |
| MSG-02 | User can interact with Astra via Slack DM in Russian and English | @slack/bolt v4.x with Socket Mode (no public URL needed), same unified router as Telegram |
| MSG-03 | Bot detects message language automatically and responds in the same language | Cyrillic range detection (U+0400-U+04FF) for Russian, instruct Claude in system prompt to respond in detected language |
| MSG-04 | Bot supports multi-step conversations with context retention within a session | Three-tier memory (Redis/PostgreSQL/Qdrant) feeds conversation history into Claude's prompt; no state machine needed — LLM handles dialog flow naturally |
| MSG-05 | User can configure notification preferences (what types of proactive alerts to receive) | PostgreSQL notification_preferences table + /settings command + natural language configuration via Claude interpretation |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| grammy | ^1.40.0 | Telegram bot framework | Already in project; best-in-class TypeScript Telegram framework |
| @slack/bolt | ^4.6.0 | Slack bot framework | Official Slack SDK; Socket Mode support; TypeScript-native; actively maintained |
| @huggingface/transformers | ^3.x | Local ONNX embedding model | Zero API keys; runs multilingual models locally in Node.js; ESM compatible |
| @qdrant/js-client-rest | ^1.17.0 | Vector database client | Already in project; needed for long-term semantic memory |
| ioredis | ^5.9.3 | Redis client | Already in project; needed for short-term memory cache |
| drizzle-orm | ^0.45.1 | PostgreSQL ORM | Already in project; needed for medium-term memory and preferences tables |
| node-cron | ^4.2.1 | Job scheduling | Already in project; needed for digest scheduling |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @grammyjs/storage-redis | latest | grammY session storage on Redis | If grammY sessions are needed for /settings menu state |
| uuid | ^13.0.0 | ID generation | Already in project; for message IDs and correlation |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| @slack/bolt Socket Mode | Events API (HTTP) | Events API requires public URL + SSL; Socket Mode is simpler for single-server deployment, no webhooks needed |
| @huggingface/transformers | Voyage AI API | Voyage requires API key + network calls; local model has no dependency, works offline, ~50ms per embedding |
| grammY conversations plugin | Claude-driven dialog | Conversations plugin uses replay-based state machine — complex, fragile, platform-specific; Claude naturally handles multi-step context via prompt history |
| Custom language detection lib | Character range heuristic | For only Russian/English, a 5-line function checking Cyrillic chars is faster and more reliable than any NLP library |

**Installation:**
```bash
npm install @slack/bolt @huggingface/transformers
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── channels/              # Platform adapters
│   ├── types.ts           # Unified message types (InboundMessage, OutboundMessage, Channel)
│   ├── telegram/          # grammY adapter
│   │   └── adapter.ts     # Converts Telegram updates → InboundMessage
│   └── slack/             # Bolt adapter
│       └── adapter.ts     # Converts Slack events → InboundMessage
├── brain/                 # Conversational engine
│   ├── router.ts          # Message router: receives InboundMessage, returns OutboundMessage
│   ├── context-builder.ts # Assembles conversation context from memory tiers
│   ├── language.ts        # Language detection (Cyrillic heuristic)
│   └── system-prompt.ts   # Claude system prompt templates
├── memory/                # Three-tier memory
│   ├── short-term.ts      # Redis: today's messages (TTL 24h)
│   ├── medium-term.ts     # PostgreSQL: last ~7 days of context
│   ├── long-term.ts       # Qdrant: all messages embedded, semantic search
│   └── embedder.ts        # @huggingface/transformers pipeline
├── notifications/         # Notification system
│   ├── preferences.ts     # CRUD for notification_preferences table
│   ├── urgency.ts         # Urgency classification (urgent/important/normal)
│   ├── dispatcher.ts      # Routes notifications to correct channel
│   └── digest.ts          # Scheduled digest compilation and delivery
├── db/                    # Database (existing)
│   ├── schema.ts          # Extended with messages, preferences, feedback tables
│   └── migrations/        # Drizzle migrations
├── config/                # Configuration (existing)
├── logging/               # Logging (existing)
├── llm/                   # LLM client (existing, extended)
├── health/                # Health checks (existing, extended)
├── bot/                   # Telegram entry point (existing, refactored)
└── worker/                # Worker process (existing, extended with digest jobs)
```

### Pattern 1: Unified Message Router
**What:** All incoming messages from any platform are normalized to `InboundMessage`, processed by a single brain, and responses are sent back as `OutboundMessage` through the originating adapter.
**When to use:** Always — this is the core routing pattern.
**Example:**
```typescript
// Source: architectural pattern from LettaBot + project-specific design
interface InboundMessage {
  id: string
  channelType: 'telegram' | 'slack'
  channelId: string        // Telegram chat ID or Slack channel ID
  userId: string           // admin user ID on each platform
  text: string
  timestamp: Date
  replyToMessageId?: string
  metadata?: Record<string, unknown>
}

interface OutboundMessage {
  channelType: 'telegram' | 'slack'
  channelId: string
  text: string
  parseMode?: 'HTML' | 'Markdown'
}

interface ChannelAdapter {
  readonly channelType: 'telegram' | 'slack'
  start(): Promise<void>
  stop(): Promise<void>
  send(message: OutboundMessage): Promise<void>
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void
}
```

### Pattern 2: Context Assembly Pipeline
**What:** For each incoming message, build a Claude prompt by layering short-term (today's chat), medium-term (recent facts), and long-term (semantic search results) context.
**When to use:** Every message processing cycle.
**Example:**
```typescript
// Source: project-specific design informed by context window management research
async function buildContext(message: InboundMessage): Promise<string> {
  // 1. Short-term: Last N messages from today (Redis)
  const recentMessages = await shortTermMemory.getRecent(message.channelId, 20)

  // 2. Medium-term: Relevant facts from last 7 days (PostgreSQL)
  const recentFacts = await mediumTermMemory.getRelevantContext(
    message.channelId,
    message.text,
    7 // days
  )

  // 3. Long-term: Semantic search for related past conversations (Qdrant)
  const semanticResults = await longTermMemory.search(message.text, 5)

  // 4. Assemble into structured context
  return formatContextForClaude(recentMessages, recentFacts, semanticResults)
}
```

### Pattern 3: LLM-Driven Dialog (No State Machine)
**What:** Instead of implementing a conversation state machine, pass conversation history to Claude and let the LLM manage dialog flow naturally. The LLM determines when to ask clarifying questions, when a topic has changed, and when to execute actions.
**When to use:** All multi-step conversations.
**Why:** The user explicitly wants free-text interaction with no buttons/menus. Claude naturally handles "create a task" -> "in which project?" -> "Project Alpha" -> "done" by seeing the full conversation history. Topic changes are handled implicitly — no explicit cancel needed.

### Pattern 4: Admin-Only Guard
**What:** Single middleware that checks if the message sender is the configured admin. All other users are silently ignored.
**When to use:** First middleware in both Telegram and Slack pipelines.
**Example:**
```typescript
// Telegram
function isAdmin(ctx: Context): boolean {
  return ctx.from?.id.toString() === env.TELEGRAM_ADMIN_CHAT_ID
}

// Slack
function isSlackAdmin(userId: string): boolean {
  return userId === env.SLACK_ADMIN_USER_ID
}
```

### Anti-Patterns to Avoid
- **Platform-specific logic in the brain:** Never put Telegram or Slack API calls in the conversation engine. All platform interaction goes through adapters.
- **Fixed context window:** Don't send a fixed number of messages to Claude. Use smart context selection — recent messages plus semantically relevant older ones.
- **grammY conversations plugin for LLM-driven chat:** The conversations plugin is designed for deterministic state machines, not LLM-driven free-form dialog. It uses a replay mechanism that conflicts with external side effects (Claude calls, database writes).
- **Storing conversation state in memory:** All state must persist in Redis/PostgreSQL. The bot process may restart at any time.
- **Blocking embedding calls in the message handler:** Embedding for long-term storage should be async (fire-and-forget or queued), not blocking the response.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Language detection (RU/EN) | NLP library or ML classifier | 5-line Cyrillic character check | Only 2 languages; Cyrillic U+0400-U+04FF range is definitive; zero dependencies |
| Text embeddings | Custom embedding model | @huggingface/transformers with ONNX model | Runs locally, no API key, battle-tested models, ~50ms latency |
| Slack bot framework | Custom WebSocket client | @slack/bolt with Socket Mode | Official SDK handles reconnection, rate limiting, event parsing |
| Cron scheduling | Custom setInterval logic | node-cron (already in project) | Handles cron syntax, timezone edge cases, already proven in worker |
| Session/state persistence | Custom Redis serialization | ioredis with JSON.stringify/parse | Simple key-value; no need for complex ORM on Redis |

**Key insight:** The hard part of this phase is NOT any individual library integration — it's the unified abstraction layer that makes Telegram and Slack feel like a single channel to the brain. Invest design time in the message router and context assembly, not in individual platform features.

## Common Pitfalls

### Pitfall 1: Claude CLI Cold Start in Message Handler
**What goes wrong:** First Claude call after process start takes ~7 seconds. User sends a message and waits 7+ seconds for a response.
**Why it happens:** Claude CLI loads the model on first invocation.
**How to avoid:** Send a warmup prompt (`"Reply with OK"`) during bot startup (non-blocking). Already have this pattern in health checker — reuse it.
**Warning signs:** First response after deploy is slow, subsequent responses are normal.

### Pitfall 2: Embedding Pipeline Blocking Message Processing
**What goes wrong:** Generating embeddings for each message adds 50-200ms to response time. For messages with long text, it can be worse.
**How to avoid:** Store messages immediately in Redis (short-term) and PostgreSQL (medium-term), then queue embedding generation asynchronously. The long-term memory update happens after the response is sent.
**Warning signs:** Response latency grows with message length.

### Pitfall 3: Slack Socket Mode Reconnection
**What goes wrong:** WebSocket connection drops and bot stops receiving Slack messages silently.
**Why it happens:** Network interruptions, Slack server maintenance, or process pauses.
**How to avoid:** Bolt's SocketModeReceiver handles reconnection automatically. But add health monitoring — track last-received-event timestamp and alert if no events for N minutes.
**Warning signs:** Slack messages go unanswered while Telegram still works.

### Pitfall 4: Context Window Overflow
**What goes wrong:** Sending too much conversation history to Claude causes the CLI to hang, timeout, or truncate the response.
**Why it happens:** Accumulating all messages without trimming.
**How to avoid:** Budget context carefully: system prompt (~500 tokens) + recent messages (~2000 tokens) + semantic search results (~1000 tokens) + user message. Total should stay under ~4000 tokens for fast responses. Claude Sonnet handles 200K context, but shorter = faster.
**Warning signs:** Claude responses become slow or truncated.

### Pitfall 5: Qdrant Collection Not Initialized
**What goes wrong:** First message attempt fails because the Qdrant collection doesn't exist yet.
**Why it happens:** Collection creation is forgotten or happens after first message.
**How to avoid:** Create/ensure collection exists during startup (idempotent operation). Qdrant's `getCollections()` + conditional `createCollection()`.
**Warning signs:** First message after fresh deploy fails with Qdrant error.

### Pitfall 6: Slack App Token vs Bot Token Confusion
**What goes wrong:** Using the wrong token type causes authentication failures.
**Why it happens:** Slack has 3 token types: Bot Token (xoxb-), User Token (xoxp-), App-Level Token (xapp-). Socket Mode needs BOTH Bot Token and App-Level Token.
**How to avoid:** Document clearly in .env.example. App-Level Token has `connections:write` scope. Bot Token has `chat:write`, `im:history`, `im:write`, etc.
**Warning signs:** "invalid_auth" or "not_authed" errors on Slack startup.

### Pitfall 7: Drizzle Migration Conflicts
**What goes wrong:** New schema tables (messages, preferences, feedback) conflict with existing migration history.
**Why it happens:** Running `drizzle-kit generate` produces a migration that assumes a clean schema.
**How to avoid:** Always run `drizzle-kit generate` incrementally. Never edit existing migration files. Test migrations on a fresh database copy.
**Warning signs:** `drizzle-kit migrate` fails with "relation already exists" or "column already exists".

## Code Examples

Verified patterns from official sources:

### Language Detection (Cyrillic Heuristic)
```typescript
// Source: Unicode standard — Cyrillic block U+0400-U+04FF
const CYRILLIC_REGEX = /[\u0400-\u04FF]/

export function detectLanguage(text: string): 'ru' | 'en' {
  const cyrillicCount = (text.match(/[\u0400-\u04FF]/g) || []).length
  const latinCount = (text.match(/[a-zA-Z]/g) || []).length
  return cyrillicCount > latinCount ? 'ru' : 'en'
}
```

### Slack Bolt Socket Mode Setup
```typescript
// Source: https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/
import { App } from '@slack/bolt'

const slackApp = new App({
  token: env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: env.SLACK_APP_TOKEN,
})

// Listen to DM messages
slackApp.message(async ({ message, say }) => {
  if (message.subtype) return // ignore edits, joins, etc.
  if (!isSlackAdmin(message.user)) return

  const inbound: InboundMessage = {
    id: message.ts,
    channelType: 'slack',
    channelId: message.channel,
    userId: message.user,
    text: message.text ?? '',
    timestamp: new Date(parseFloat(message.ts) * 1000),
  }

  const response = await brain.process(inbound)
  await say(response.text)
})

await slackApp.start()
```

### Local Embedding with @huggingface/transformers
```typescript
// Source: https://huggingface.co/docs/transformers.js/en/pipelines
import { pipeline } from '@huggingface/transformers'

let embedder: Awaited<ReturnType<typeof pipeline>> | null = null

export async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline(
      'feature-extraction',
      'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
      { dtype: 'fp32' }
    )
  }
  return embedder
}

export async function embed(text: string): Promise<number[]> {
  const extractor = await getEmbedder()
  const output = await extractor(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data as Float32Array)
}
```

### Qdrant Collection Setup
```typescript
// Source: https://qdrant.tech/documentation/concepts/collections/
import { QdrantClient } from '@qdrant/js-client-rest'

const COLLECTION_NAME = 'astra_messages'
const VECTOR_SIZE = 384  // paraphrase-multilingual-MiniLM-L12-v2 output dimension

export async function ensureCollection(client: QdrantClient): Promise<void> {
  const { collections } = await client.getCollections()
  const exists = collections.some(c => c.name === COLLECTION_NAME)

  if (!exists) {
    await client.createCollection(COLLECTION_NAME, {
      vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
    })

    // Create payload indexes for filtering
    await client.createPayloadIndex(COLLECTION_NAME, {
      field_name: 'channel_type',
      field_schema: 'keyword',
    })
    await client.createPayloadIndex(COLLECTION_NAME, {
      field_name: 'timestamp',
      field_schema: 'integer',
    })
  }
}
```

### Redis Short-Term Memory
```typescript
// Source: ioredis docs + project pattern
import { Redis } from 'ioredis'

const MESSAGES_TTL = 86400 // 24 hours

export class ShortTermMemory {
  constructor(private redis: Redis) {}

  async store(channelId: string, message: StoredMessage): Promise<void> {
    const key = `chat:${channelId}:messages`
    await this.redis.lpush(key, JSON.stringify(message))
    await this.redis.ltrim(key, 0, 99)  // Keep last 100 messages
    await this.redis.expire(key, MESSAGES_TTL)
  }

  async getRecent(channelId: string, count: number): Promise<StoredMessage[]> {
    const key = `chat:${channelId}:messages`
    const raw = await this.redis.lrange(key, 0, count - 1)
    return raw.map(r => JSON.parse(r) as StoredMessage)
  }
}
```

### Notification Preferences Schema
```typescript
// Source: project-specific design informed by CONTEXT.md decisions
// Drizzle ORM schema extension
export const notificationPreferences = pgTable('notification_preferences', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull(),
  category: text('category').notNull(),         // e.g., 'task_deadline', 'email_urgent'
  urgencyLevel: text('urgency_level').notNull(), // 'urgent', 'important', 'normal'
  deliveryChannel: text('delivery_channel').notNull(), // 'telegram', 'slack'
  enabled: boolean('enabled').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const userFeedback = pgTable('user_feedback', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull(),
  context: text('context').notNull(),           // what the feedback is about
  feedbackText: text('feedback_text').notNull(), // natural language feedback
  category: text('category'),                   // auto-classified category
  importanceScore: real('importance_score'),     // -1.0 to 1.0
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| @xenova/transformers (v1/v2) | @huggingface/transformers (v3) | 2024 | Official HuggingFace package; WebGPU support; ESM-first |
| Slack Events API (HTTP) | Socket Mode (WebSocket) | 2020+ | No public URL needed; simpler deployment for single-server bots |
| State machine chatbots | LLM-driven dialog | 2023+ | LLM handles context, clarifications, topic changes naturally |
| @slack/bolt v3 | @slack/bolt v4 | 2024 | Requires Node 18+; improved TypeScript types; updated dependencies |
| grammY conversations v1 | grammY conversations v2 | 2024 | Improved persistence, parallel conversations; but still state-machine paradigm |

**Deprecated/outdated:**
- `@xenova/transformers`: Replaced by `@huggingface/transformers` v3. Same models, new package name.
- Slack Events API with HTTP for single-server bots: Socket Mode is strictly better when you don't need to expose a public URL.
- `@slack/bolt` v3: v4 is current; v3 still works but lacks TypeScript improvements and updated sub-dependencies.

## Discretion Recommendations

For areas marked as "Claude's Discretion" in CONTEXT.md:

### Memory Storage Structure
**Recommendation: Redis for short-term, PostgreSQL for medium-term, Qdrant for long-term.**
- **Redis (short-term, today):** Store last N messages per channel as JSON list with 24h TTL. Fast reads for assembling recent context. Key pattern: `chat:{channelId}:messages`.
- **PostgreSQL (medium-term, ~1 week):** Store all messages in a `messages` table with full-text search index. Query by channel, date range, keyword. Also stores notification preferences and user feedback.
- **Qdrant (long-term, all time):** Store vector embeddings of all messages for semantic search. Payload includes channel_type, timestamp, user_id, original text. Enables "you mentioned X weeks ago" queries.

### Qdrant Collection Schema
**Recommendation: Single collection `astra_messages` with Cosine distance, 384-dim vectors.**
- Model: `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384 dimensions, multilingual including Russian)
- Payload fields: `channel_type` (keyword index), `channel_id` (keyword index), `user_id` (keyword index), `timestamp` (integer index), `text` (stored but not indexed), `message_id` (keyword index)
- Why 384 dimensions: Smallest multilingual model with good quality; larger models (768-dim) offer marginal improvement but double storage/compute cost.

### Slack API Approach
**Recommendation: Socket Mode.**
- No public URL needed — the server is a VPS with no domain/SSL for Slack callbacks.
- Bolt's `socketMode: true` handles WebSocket lifecycle, reconnection, heartbeats.
- Simpler to configure and deploy than Events API + HTTP endpoint.
- App-Level Token with `connections:write` scope + Bot Token with `chat:write`, `im:history`, `im:write`, `im:read`.

### Conversation State Machine Implementation
**Recommendation: No state machine. LLM-driven dialog.**
- Feed conversation history (from three-tier memory) into Claude's system prompt.
- Claude naturally handles multi-step flows: asks clarifying questions, understands topic changes, maintains context.
- The system prompt instructs Claude about its persona, available capabilities, and confirmation protocol.
- For /settings, use a simple menu handler (not a conversation state machine) that interprets natural language preferences.

### Digest Scheduling Mechanism
**Recommendation: node-cron in the worker process.**
- Already using node-cron for audit cleanup.
- Add digest compilation jobs: morning digest (configurable time), and periodic checks for urgent items.
- Store digest schedule configuration in PostgreSQL `notification_preferences` table.
- Digest jobs query the messages table, compile summary, and send via notification dispatcher.

## Open Questions

1. **Embedding model first-run download**
   - What we know: `@huggingface/transformers` downloads ONNX model files on first use (~90MB for MiniLM-L12-v2). Cached locally after first download.
   - What's unclear: Download behavior on the VPS server (network speed, disk space). Whether to pre-download during deployment or let it happen on first message.
   - Recommendation: Add a startup task that initializes the embedder (triggers download). Log progress. Fail fast if download fails.

2. **Slack workspace and app creation**
   - What we know: Need a Slack app with Socket Mode enabled, App-Level Token, and Bot Token with correct scopes.
   - What's unclear: Whether the user has already created a Slack app. Whether the user's Slack workspace allows app installation.
   - Recommendation: Document the Slack app creation steps in a setup guide. Require `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in .env. Make Slack adapter optional — bot should work with Telegram-only if Slack tokens are not configured.

3. **Claude system prompt size budget**
   - What we know: System prompt must include persona, capabilities, language instructions, and confirmation protocol. Plus assembled context.
   - What's unclear: Exact token budget that balances response quality vs speed with Claude CLI.
   - Recommendation: Start with ~500 token system prompt + ~2000 tokens of context. Measure response times and adjust. The existing CLAUDE_TIMEOUT_MS of 120s is generous.

4. **Foundation for self-learning (Phase 7)**
   - What we know: CONTEXT.md says Phase 2 must lay architectural foundation for importance scoring, feedback storage, preference patterns.
   - What's unclear: Exact schema for learning feedback that will satisfy Phase 7's needs.
   - Recommendation: Create `user_feedback` table with flexible schema (context text, feedback text, importance score, category). Store all natural language feedback. Phase 7 will add ML layers on top.

## New Environment Variables Required

```bash
# --- Slack (optional — bot works without these) ---
SLACK_BOT_TOKEN=         # xoxb-... Bot token from OAuth & Permissions
SLACK_APP_TOKEN=         # xapp-... App-Level token from Basic Information
SLACK_ADMIN_USER_ID=     # Slack user ID of the admin

# --- Qdrant ---
QDRANT_URL=http://localhost:6333  # Already used in health checker, formalize in env schema
```

## Sources

### Primary (HIGH confidence)
- [grammY conversations plugin docs](https://grammy.dev/plugins/conversations) — full API, setup, limitations, persistence
- [grammY sessions plugin docs](https://grammy.dev/plugins/session) — storage adapters, lazy sessions, multi sessions
- [Slack Bolt for JavaScript docs](https://docs.slack.dev/tools/bolt-js/) — setup, Socket Mode, event handling
- [Slack Socket Mode docs](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/) — SocketModeReceiver configuration
- [Qdrant collections docs](https://qdrant.tech/documentation/concepts/collections/) — collection creation, named vectors, distance metrics
- [Anthropic embeddings guide](https://platform.claude.com/docs/en/build-with-claude/embeddings) — Voyage AI recommendation, no native embedding model
- [HuggingFace Transformers.js](https://huggingface.co/docs/transformers.js/en/pipelines) — pipeline API, feature extraction, ESM support
- [@slack/bolt v3->v4 migration](https://github.com/slackapi/bolt-js/wiki/Bolt-v3-%E2%80%90--v4-Migration-Guide) — breaking changes, Node 18+ requirement

### Secondary (MEDIUM confidence)
- [Bolt v4.6.0 on npm](https://www.npmjs.com/package/@slack/bolt) — current version confirmed
- [Xenova/paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) — model availability on HuggingFace
- [LettaBot architecture](https://deepwiki.com/letta-ai/lettabot) — unified message router pattern across Telegram/Slack/Discord
- [Slack scopes reference](https://docs.slack.dev/reference/scopes/) — permission scopes for bot tokens

### Tertiary (LOW confidence)
- Local embedding performance (~50ms per embedding) — based on community reports, needs validation on target VPS hardware
- `paraphrase-multilingual-MiniLM-L12-v2` Russian quality — model claims multilingual support including Russian, but quality for Russian specifically needs validation with test data

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries are established, well-documented, and version-pinned
- Architecture: HIGH — unified router pattern is proven in production systems (LettaBot, OpenClaw); three-tier memory is a standard pattern for LLM assistants
- Pitfalls: HIGH — based on official documentation warnings and known deployment patterns
- Embedding approach: MEDIUM — local ONNX embedding is well-documented for English; Russian multilingual quality needs validation
- Slack integration: HIGH — Socket Mode is the official recommended approach for server-side bots

**Research date:** 2026-02-24
**Valid until:** 2026-03-24 (30 days — stable libraries, no fast-moving changes expected)
