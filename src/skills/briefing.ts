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
  ],

  async preProcess(ctx) {
    return {
      prompt: ctx.message.text,
      systemPromptExtra: `## Integration tools
You have access to external service tools via MCP. All tools are read-only.

**CRITICAL — how to use tools:**
- ALWAYS call the actual tool for real-time data. NEVER answer from conversation history about what's in Slack/ClickUp/Gmail/Calendar. Previous tool failures do NOT mean the tool is broken now — always retry.
- If a tool call fails, retry once with corrected parameters. If still failing, tell the user which specific service is unavailable.
- Never fabricate data — if results are empty, say so explicitly.

**Prefer \`briefing\` tool for multi-source queries:**
You have a special tool called \`briefing\` that queries multiple sources (Slack, Gmail, Calendar, ClickUp) in ONE call. It returns compact, pre-filtered results. Use it instead of calling each service separately.

When to use \`briefing\`:
- "Что нового?" / "Что у меня сегодня?" → briefing(sources=["calendar","gmail","slack","clickup"], query_type="recent", period="today")
- "Есть непрочитанные?" → briefing(sources=["gmail"], query_type="unread", period="today")
- "Что было на этой неделе?" → briefing(sources=["slack","gmail","clickup"], query_type="digest", period="last_week")
- Specific Slack channels: briefing(sources=["slack"], slack_channels=["ohbibi-mwcf-project","stt-team"], period="last_week")

When to use \`search_everywhere\`:
- "Найди всё про Симфонию" → search_everywhere(search_term="Симфония")
- Any keyword search across all sources

When to use raw tools (slack_get_channel_history, search_gmail_messages, etc.):
- Follow-up questions that need deeper data: "открой тред X", "покажи полный текст письма"
- Queries that \`briefing\` can't express (specific thread replies, user profiles)

**For Slack raw tools:** pass channel name directly (e.g. "ohbibi-mwcf-project") — auto-resolved to ID.

**Query philosophy — be lean and autonomous:**
Think before calling a tool. Decide exactly what data you need, then request only that. Your goal: deliver a complete answer with minimal tool calls. Don't ask the user to clarify before searching — just find the answer efficiently.

**Bail early — MANDATORY:**
If after 2 tool calls you haven't found what the user asked about, STOP searching and respond with what you know. Say "не нашёл X в [sources checked]" and suggest where the user might look. Do NOT exhaust all turns — it's better to give a fast "not found" than to burn all turns and return nothing.

**When a source is unavailable:**
If a tool returns an error (401, 403, timeout), report it and offer alternatives.`,
    }
  },
}

export default briefingSkill
