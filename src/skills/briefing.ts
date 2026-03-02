import type { Skill } from './types.js'

const briefingSkill: Skill = {
  name: 'briefing',
  description: 'Multi-source digest: Slack, Gmail, Calendar, ClickUp summaries and search',

  triggers: [
    'что нового', 'что сегодня', 'что у меня', 'что по расписанию',
    'непрочитанные', 'дайджест', 'обзор', 'briefing',
    'по всем фронтам', 'что было', 'что обсуждали',
    'есть письма', 'есть письмо', 'unread',
    'найди', 'search', 'поиск', 'найти',
    'обнови контекст', 'обнови мой контекст',
    'дедлайн', 'deadline', 'горят',
    'кто писал', 'кто последний',
    'канал', 'channel',
    'задачи', 'задач', 'tasks', 'проект', 'project',
    'выполнены', 'сделано', 'статус', 'status',
    'кликап', 'clickup',
  ],

  async preProcess(ctx) {
    return {
      prompt: ctx.message.text,
      systemPromptExtra: `## Integration tools
You have access to external service tools via MCP. All tools are read-only.

**CRITICAL — how to use tools:**
- ALWAYS call the actual tool for real-time data. NEVER answer from conversation history about what's in Slack/ClickUp/Gmail/Calendar.
- If a tool call fails, retry once with corrected parameters. If still failing, tell the user which specific service is unavailable.
- Never fabricate data — if results are empty, say so explicitly.

**Prefer \`briefing\` tool for multi-source queries:**
The \`briefing\` tool queries multiple sources (Slack, Gmail, Calendar, ClickUp) in ONE call. Use it instead of calling each service separately.

Examples:
- "Что нового?" → briefing(sources=["calendar","gmail","slack","clickup"], query_type="recent", period="today")
- "Есть непрочитанные?" → briefing(sources=["gmail"], query_type="unread", period="today")
- "Что было на этой неделе?" → briefing(sources=["slack","gmail","clickup"], query_type="digest", period="last_week")
- Specific Slack channels: briefing(sources=["slack"], slack_channels=["ohbibi-mwcf-project"], period="last_week")

**Project-level queries (tasks, status, deadlines):**
When the user asks about a specific project (e.g. "задачи по Ohbibi Creatives", "статус проекта STT"):
1. Use \`briefing\` with BOTH sources=["slack","clickup"] in ONE call
2. Use \`clickup_list_names\` to target the project: briefing(sources=["slack","clickup"], clickup_list_names=["Ohbibi Creatives"], slack_channels=["ohbibi-creatives"], include_closed=true, period="last_week")
3. Set \`include_closed=true\` when checking completion status — otherwise completed tasks won't appear
4. The briefing tool fuzzy-matches list names against ClickUp lists, folders, AND spaces — so "Ohbibi" will match a list named "Ohbibi Creatives"
5. Combine Slack discussions + ClickUp task statuses to give a complete picture

**Keyword search:** \`search_everywhere(search_term="Симфония")\` — searches across all sources.

**Raw tools** (slack_get_channel_history, search_gmail_messages, etc.) — only for follow-up questions needing deeper data (thread replies, full email text).

**Query philosophy — be lean and autonomous:**
Think before calling a tool. Decide exactly what data you need, then request only that. Deliver a complete answer with minimal tool calls. Don't ask the user to clarify before searching — just find the answer.

**Bail early — MANDATORY:**
If after 3 tool calls you haven't found what the user asked about, STOP and respond with what you know. Say "не нашёл X в [sources checked]" and suggest where the user might look.

**When a source is unavailable:**
If a tool returns an error (401, 403, timeout), report it and offer alternatives.`,
    }
  },
}

export default briefingSkill
