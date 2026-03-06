import type { Skill } from './types.js'

const briefingSkill: Skill = {
  name: 'briefing',
  description: 'Universal data skill: live sources (Slack, Gmail, Calendar, ClickUp) + Knowledge Base (historical facts, entities, milestones)',

  triggers: [
    // Live data
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
    'знаешь', 'расскажи', 'инфо', 'info',
    // KB / historical data
    'найди в базе', 'поищи в базе', 'база знаний', 'knowledge base',
    'что знаешь о', 'что ты знаешь', 'who works on', 'кто работает над',
    'кто работает на', 'кто в команде', 'кто на проекте',
    'граф сущностей', 'entity graph', 'entities',
    'кто такой', 'кто такая', 'info about',
    'kb_search', 'kb_entities',
    'что говорил', 'что писал', 'что обсуждали раньше',
    'история', 'архив', 'прошлое', 'ранее',
    'в каких проектах', 'какие проекты',
    // Milestones, wiki, verification
    'майлстоун', 'milestone', 'вики', 'wiki',
    'проверь', 'правильно ли', 'корректно ли', 'по правилам',
  ],

  async preProcess(ctx) {
    return {
      prompt: ctx.message.text,
      systemPromptExtra: `## Data tools — live sources + Knowledge Base
You have TWO categories of tools: **live** (real-time from services) and **KB** (historical indexed data).

**CRITICAL:**
- ALWAYS call actual tools. NEVER answer from conversation history.
- Never fabricate data — if results are empty, say so.
- If a tool fails, retry once. If still failing, tell user which service is unavailable.

### Live tools (real-time data from services)

**\`briefing\` — multi-source queries in ONE call:**
- "Что нового?" → briefing(sources=["calendar","gmail","slack","clickup"], query_type="recent", period="today")
- "Есть непрочитанные?" → briefing(sources=["gmail"], query_type="unread", period="today")
- "Что было на этой неделе?" → briefing(sources=["slack","gmail","clickup"], query_type="digest", period="last_week")
- Specific channels: briefing(sources=["slack"], slack_channels=["ohbibi-mwcf-project"], period="last_week")

**Project tasks/status (live):**
1. briefing(sources=["slack","clickup"], clickup_list_names=["Project Name"], slack_channels=["project-channel"], include_closed=true, period="last_week")
2. Set include_closed=true when checking completion status
3. Fuzzy-matches list names against ClickUp lists, folders, AND spaces

**search_everywhere(search_term)** — keyword search across all live sources.

**Drill-down:**
- get_slack_thread(channel_name, thread_ts) — full Slack thread
- get_email_content(message_id, account?) — full email body

### KB tools (historical indexed data: facts, entities, milestones, wiki)

**\`kb_search(query, source?, person?, project?, period?, limit?)\`** — hybrid semantic + keyword search across all indexed data. Returns text chunks with source citations.
- kb_search(query="дедлайн M10") — find milestone deadlines
- kb_search(query="баги", project="Oregon Trail") — project-specific search
- kb_search(query="meeting notes", source="gmail") — source-filtered
- kb_search(query="правила оформления", project="Аквариум") — wiki/rules search
- period: "last_week", "last_month", "last_3_months", or ISO range "2026-01-01/2026-01-20"

**\`kb_entities(name?, type?)\`** — look up entities (people, projects, clients, companies) and their relations.
- kb_entities(name="Семён") — person details + relations
- kb_entities(type="project") — all known projects
- kb_entities(name="Star Trek Timelines") — project team members

### Decision strategy — which tools to use:

1. **Deadlines, milestones, historical facts** → kb_search FIRST (KB has indexed milestone data)
2. **Wiki rules, processes, how-to** → kb_search (KB has indexed wiki/Drive docs)
3. **Who works on X, team info** → kb_entities
4. **Current task status, today's updates** → briefing (live ClickUp/Slack)
5. **Verify tasks against rules** → kb_search for rules + briefing for live tasks, then compare
6. **General "что знаешь о X?"** → kb_entities + kb_search, then briefing if more detail needed

**Bail early — MANDATORY:**
If after 3 tool calls you haven't found what the user asked about, STOP and respond with what you know. Say "не нашёл X в [sources checked]" and suggest where the user might look.`,
    }
  },
}

export default briefingSkill
