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
      systemPromptExtra: `## Data tools — live sources + Knowledge Base + Registry

**CRITICAL:**
- ALWAYS call actual tools. NEVER answer from conversation history.
- Never fabricate data — if results are empty, say so.
- If a tool fails, retry once. If still failing, tell user which service is unavailable.

### Navigation pattern (recommended workflow):
1. Check **Knowledge Map** in system prompt → identify project and relevant sources
2. **kb_registry(project=X)** → get full project card: team, Slack channels, Drive doc URLs, ClickUp lists, current status
3. Use specific names from the card to make targeted calls:
   - briefing(slack_channels=[...], clickup_list_names=[...]) for live data
   - kb_search(project="...") for historical/wiki data
   - audit_tasks(list_name="...") for compliance checks
4. Drill down: get_slack_thread(), get_email_content() for details

### Registry tool (start here for project/org questions)

**\`kb_registry(project?, section?)\`** — navigate the organizational Knowledge Registry.
- kb_registry(project="Aquarium") → full project card with team, channels, docs (URLs!), tasks, status
- kb_registry(section="people") → all internal + external people
- kb_registry(section="processes") → all processes across projects
- kb_registry(section="drive") → Google Drive document catalog index
- kb_registry(section="channels") → Slack channel directory
- kb_registry() → full knowledge map (table of contents)

### Live tools (real-time data from services)

**\`briefing\` — multi-source queries in ONE call:**
- briefing(sources=["calendar","gmail","slack","clickup"], query_type="recent", period="today")
- Specific channels: briefing(sources=["slack"], slack_channels=["ohbibi-mwcf-project"], period="last_week")
- Set include_closed=true when checking task completion status
- Fuzzy-matches list names against ClickUp lists, folders, AND spaces

**search_everywhere(search_term)** — keyword search across all live sources.

**Drill-down:**
- get_slack_thread(channel_name, thread_ts) — full Slack thread
- get_email_content(message_id, account?) — full email body

### KB tools (historical indexed data: facts, entities, milestones, wiki)

**\`kb_search(query, source?, person?, project?, period?, limit?)\`** — hybrid semantic + keyword search.
- kb_search(query="правила оформления", project="Аквариум") — wiki/rules search
- kb_search(query="дедлайн M10") — find milestone deadlines
- period: "last_week", "last_month", "last_3_months", or ISO range

**\`kb_entities(name?, type?)\`** — entity graph lookup (people, projects, relations).

### Task audit tool

**\`audit_tasks(list_name, include_closed?)\`** — checks ALL tasks in a ClickUp list against wiki rules. Returns ONLY violations.

### Decision strategy:

1. **Project info, team, docs** → kb_registry(project=X) FIRST
2. **Deadlines, milestones, historical facts** → kb_search
3. **Wiki rules, processes** → kb_search + kb_registry(section="processes")
4. **Current task status, today's updates** → briefing (live data)
5. **Verify tasks against rules** → audit_tasks
6. **People info** → kb_registry(section="people") + kb_entities
7. **Documents with URLs** → kb_registry(project=X) has Drive doc URLs

**Bail early — MANDATORY:**
If after 3 tool calls you haven't found what the user asked about, STOP and respond with what you know. Say "не нашёл X в [sources checked]" and suggest where the user might look.`,
    }
  },
}

export default briefingSkill
