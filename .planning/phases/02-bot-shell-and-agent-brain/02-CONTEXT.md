# Phase 2: Bot Shell and Agent Brain - Context

**Gathered:** 2026-02-24
**Status:** Ready for planning

<domain>
## Phase Boundary

User can talk to Astra in Telegram and Slack, hold multi-step conversations with context, and configure how proactive alerts reach them. Language auto-detection (Russian/English). This phase delivers the conversational brain, memory architecture, Slack integration, notification system, and digest infrastructure.

</domain>

<decisions>
## Implementation Decisions

### Conversation Style
- Tone: friendly colleague ("дружеский коллега"), not formal assistant
- Light persona: has character, can joke, express opinions on work topics
- Response length: depends on topic — short for simple questions, detailed for reports/analysis
- When doesn't know: honestly says so, doesn't make things up
- Language: auto-detect Russian/English, respond in same language

### Memory Architecture (KEY PRIORITY)
- **Three-tier memory model:**
  - **Long-term**: All messages from all channels stored permanently, searchable via Qdrant + full-text
  - **Medium-term (~1 week)**: Active context — recent conversations, ongoing topics, project states
  - **Short-term (today)**: Current day's conversations, immediate context
- Conversation context is persistent (never expires) — "you mentioned X this morning" always works
- **Initial context load**: Feed existing chat history from available channels at startup so Astra has context from day one
- **Smart context selection for LLM**: Each request loads last N messages + relevant facts from Qdrant (not fixed window)
- **Automatic memory search**: Astra decides when to search long-term memory — transparent to user
- Optimal storage structure to be determined by research (Redis for short-term, PostgreSQL for medium-term, Qdrant for long-term semantic search)

### Slack Integration
- Bot added as Slack bot (not user account)
- DM conversation with admin
- Can read channels accessible to admin
- Responding on behalf of admin (ghost-writing) — deferred to Phase 6
- Exact Slack API setup needs research — user open to proposals
- Behavior identical to Telegram (same personality, same commands)

### User Model
- Single user (admin only) for both Telegram and Slack
- Others are ignored by the bot

### Input Style
- Free text only, no slash commands (except /start, /health, /settings for digests)
- Astra understands natural language for everything

### Multi-Step Dialogs
- Clarifications: simple question, free text input (no buttons/options)
- Cancel: just write about something else — Astra understands topic change
- Timeout: infinite — context preserved, continue anytime
- **All external actions require confirmation** before execution
- **Batch approve**: Astra compiles action plan, user confirms entire plan with one "yes"

### Notifications
- 3 urgency levels: urgent (immediate), important (in digest), normal (on request)
- Configuration: natural language + /settings menu command
- Delivery channel: configurable per notification type (Telegram / Slack)
- No quiet hours (DND)
- Morning digest on schedule with accumulated non-urgent items

### Proactivity & Monitoring
- Astra constantly monitors chats and calendars, highlights important things
- Initially highlights everything, then learns what's important through feedback
- Unimportant channels: info stored but not shown, unless something truly important happens
- **Iterative learning** of importance — user gives feedback in natural language with context ("this isn't important because X, show me things like this in Y format")
- Feedback mechanism: natural language only (not buttons) — nuanced degrees of importance

### Digests (Infrastructure in Phase 2, Full Implementation in Phase 3-5)
- 5 digest types planned:
  1. **Project digests** — updates per project for a period, configurable format
  2. **Action-required digest** — unanswered questions from last N hours (implementable in Phase 2 from Slack/Telegram)
  3. **ClickUp workflow digest** — task compliance (Phase 3)
  4. **Google Drive audit digest** — document health (Phase 4)
  5. **Email + Calendar digest** — complex:
     - Email: bulk filtering report + unusual items highlighted. Example: "142 task movement emails received and marked read, activity looks typical. One unusual email from X, possibly spam but worth checking."
     - Calendar: obligatory meetings for "today" (workday extends to ~2:00 AM Bali time). Highlight unacknowledged meetings, especially same-day ones.
- Digest creation via Telegram commands: set criteria, frequency, style (user will provide format examples)
- Astra generates digests automatically from all available information

### Calendar Specifics
- Workday extends to approximately 2:00 AM Bali time
- Meetings after midnight still count as "today" ("today at 1 AM")
- Astra learns which meetings are obligatory vs optional
- Unacknowledged calendar events need highlighting, especially same-day

### Response Format
- Structured: lists, headers, emojis for readability
- Emojis: moderate use (status indicators like checkmarks, warnings)
- Adapt structure to content: simple answers = simple text, complex = structured

### Error Handling
- Report and retry: "Can't reach ClickUp, will try again"
- Transparent about failures

### Security & Action Approval
- All external actions require explicit confirmation
- Batch approve supported: Astra presents action plan, user confirms with single "yes"
- Format: numbered list of planned actions → user approves entire batch

### Integration Priority (for subsequent phases)
1. Slack (Phase 2 — this phase)
2. Gmail (Phase 3)
3. Calendar (Phase 3)
4. Google Drive (Phase 4)
5. ClickUp (Phase 3, lower priority than Gmail/Calendar)

### Claude's Discretion
- Exact memory storage structure (Redis vs PostgreSQL for different tiers)
- Qdrant collection schema for semantic search
- Slack API approach (Socket Mode vs Events API)
- Conversation state machine implementation
- Digest scheduling mechanism

</decisions>

<specifics>
## Specific Ideas

- "I want Astra to constantly watch chats and calendars and highlight everything important to me"
- "Initially she'll show me everything, but I'll teach her what's important through iterative feedback"
- Email digest example: "142 task movement emails received and marked as read, among them activity on projects X and Y, all activity looks typical, nothing to pay attention to. There's an unusual email from (name), possibly spam but you should look at it. Company X is asking again if we're ready to continue collaboration, I could prepare a polite reply that not yet. There are two subscription expiry notices in 3 and 5 days, you should look at those."
- Calendar: "obligatory meetings today are X, Y, Z" — Astra knows which meetings I actually attend
- Batch approve: "Astra sends a list of 15 tasks to create, 5 to delete, 1 message to send — I approve the whole plan with one 'yes'"
- Feedback on importance is nuanced: not just "important/not", but context about WHY and in what form to present

</specifics>

<deferred>
## Deferred Ideas

- **Self-learning system** (Phase 7) — but architecture must support it from Phase 2 (importance scoring, feedback storage, preference patterns)
- **Ghost-writing in Slack** (Phase 6) — respond from admin's identity after explicit approval
- **Autonomy settings** (Phase 7) — configurable level of independence
- **Clockify integration** — future milestone
- **Other service integrations** — future milestone
- **Email digests with auto-filtering** (Phase 3-5) — requires Gmail integration
- **ClickUp workflow compliance digest** (Phase 3) — requires ClickUp integration
- **Google Drive audit digest** (Phase 4) — requires Drive integration

**Critical note:** Self-learning and iterative importance training are the user's TOP priority. Phase 2 must lay the architectural foundation (feedback storage, importance scoring, preference model) even though the full learning loop is Phase 7.

</deferred>

---

*Phase: 02-bot-shell-and-agent-brain*
*Context gathered: 2026-02-24*
