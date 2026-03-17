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
    // Financial, HR, documents
    'зарплата', 'salary', 'заработал', 'бюджет', 'budget', 'P&L',
    'документ', 'document', 'таблица', 'spreadsheet', 'планнинг', 'planning',
    'отпуск', 'vacation', 'больничн', 'sick',
    'посмотри в', 'открой', 'посчитай', 'сколько стоит', 'сколько денег',
  ],

  async preProcess(ctx) {
    return {
      prompt: ctx.message.text,
      systemPromptExtra: `## Data tools

**LIVE data (real-time, always fresh):**
- **briefing(sources, query_type, period, slack_channels?, clickup_list_names?)** — LIVE data from Slack, Gmail, Calendar, ClickUp. Always prefer this for recent/today's data. Fuzzy-matches list names. Set include_closed=true for completion checks.
- **Drive tools** (via google-workspace MCP): search_drive, read_drive_file — can read Google Docs/Sheets content.
- **Drill-down:** get_slack_thread(channel_name, thread_ts), get_email_content(message_id, account?)

**INDEXED data (nightly sync, may be 12-24h behind):**
- **kb_search(query, source?, person?, project?, period?, limit?)** — historical indexed data. Good for: old conversations, past decisions, long-term context. NOT good for today's data.
- **kb_entities(name?, type?)** — entity graph lookup (people, projects, relations).

**Registry & audit:**
- **kb_registry(project?, section?)** — org registry with team, channels, docs, status. Returns Drive doc URLs!
- **audit_tasks(list_name, include_closed?)** — checks ALL tasks in a ClickUp list against wiki rules.

## CRITICAL: briefing() vs kb_search()
- For TODAY's or YESTERDAY's data → use **briefing()** (live)
- For data older than 2 days → use **kb_search()** (indexed)
- For investigation → use BOTH: briefing() first (fresh), then kb_search() (historical context)
- NEVER rely only on kb_search() for recent events — it may be 24h behind!

## How to handle requests:

### Quick questions (project list, team, structure):
Answer from Knowledge Map / Quick Reference in system prompt above. 0 tool calls.

### Today's updates / daily digest:
1. briefing(sources=["slack","clickup","calendar","gmail"], period="today") → ALL today's data in one call
2. Group by project. Highlight: blockers, expiring deadlines, decisions.
3. Include: Slack discussions, ClickUp task changes, calendar meetings, important emails.

### Project details / document lookup:
1. kb_registry(project=X) → full card with team, docs (with URLs!), channels, status
2. If user asks about a specific document: find it in registry, then use Drive tools to read content

### Financial / HR / salary questions:
Financial data lives in Google Drive spreadsheets. Navigate:
1. kb_registry(section="drive") → find Staff Reports, P&L, Staff Forecast with URLs
2. Use **Drive tools** (search_drive or read_drive_file) to read actual spreadsheet content
3. If needed: kb_search(query="salary/budget/cost") for indexed historical data

### Document analysis / calculations:
1. Find the document: check Key Documents in system prompt, or kb_registry(section="drive"), or kb_registry(project=X)
2. **Read the document content** using Drive tools
3. Extract data, calculate, present results
4. If Drive tool fails: provide the document URL so user can open it manually

### Investigation / ticket creation / deep research:
Be THOROUGH — quality over speed. Max 8 tool calls. Use ALL phases.

**Phase 1 — Project context:**
Use Quick Reference from system prompt for channels/lists. If not there → kb_registry(project=X).

**Phase 2 — Live internal sources (ALWAYS do this first):**
- briefing(sources=["slack"], slack_channels=[...from Quick Ref...], query_type="search", query="problem keywords") → LIVE recent Slack
- briefing(sources=["clickup"], clickup_list_names=[...]) → task data
- Try alternative keywords (English AND Russian) if results are sparse

**Phase 3 — Historical context (after live data):**
- kb_search(query="problem keywords", project="X") → older indexed data, past discussions
- This supplements Phase 2 — do NOT skip Phase 2 even if Phase 3 returns nothing!

**Phase 4 — External web search (for investigation only):**
Search the web for: user reviews, community wikis, forum posts, public bug reports.
Only do this for investigation/research tasks, NOT for daily updates.

**Phase 5 — Compile:**
Internal evidence (Slack + dates) + external evidence (URLs). Structured format.

### Process / rules lookup:
kb_registry(section="processes") + kb_search(query="правила/rules")

**RULES:**
- Knowledge Map + Quick Reference → 0 tool calls for project lists
- Simple questions: max 3 calls
- Investigation: max 8 calls, use ALL phases before giving up
- Daily updates: 1-2 calls (include all sources in one briefing call)
- Financial/document: max 4 calls
- NEVER call kb_registry() without arguments
- Web search: ONLY for investigation tasks
- Try both Russian AND English search terms
- **BAIL OUT (simple questions only):** If after 3 calls on a simple question you found nothing, stop and ask user. For investigation — exhaust all phases first.`,
    }
  },
}

export default briefingSkill
