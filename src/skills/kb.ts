import type { Skill } from './types.js'

const kbSkill: Skill = {
  name: 'kb',
  description: 'Knowledge Base: search indexed data and entity graph across all sources',

  triggers: [
    'найди в базе', 'поищи в базе', 'база знаний', 'knowledge base',
    'что знаешь о', 'что ты знаешь', 'who works on', 'кто работает над',
    'кто работает на', 'кто в команде', 'кто на проекте',
    'граф сущностей', 'entity graph', 'entities',
    'кто такой', 'кто такая', 'расскажи о', 'info about',
    'kb_search', 'kb_entities',
    'что говорил', 'что писал', 'что обсуждали раньше',
    'история', 'архив', 'прошлое', 'ранее',
    'в каких проектах', 'какие проекты',
  ],

  async preProcess(ctx) {
    return {
      prompt: ctx.message.text,
      systemPromptExtra: `## Knowledge Base tools
You have access to the Knowledge Base (KB) — a persistent store of indexed data from Slack, Gmail, Calendar, ClickUp, Drive, and Notion.

**Available KB tools:**
- \`kb_search(query, source?, person?, project?, period?, limit?)\` — hybrid semantic + keyword search across all indexed data. Returns matching text chunks with source citations.
- \`kb_entities(name?, type?)\` — look up entities (people, projects, clients, companies) and their relations.

**When to use KB tools vs briefing tools:**
- \`kb_search\` / \`kb_entities\` — for HISTORICAL questions: "what did X say about Y?", "who works on Z?", "find documents about W"
- \`briefing\` — for LIVE data: "what's new today?", "unread emails", "current task status"

**KB search tips:**
- Use \`person\` filter to narrow by person: kb_search(query="дедлайн", person="Семён")
- Use \`project\` filter to narrow by project: kb_search(query="баги", project="Oregon Trail")
- Use \`source\` filter for specific sources: kb_search(query="meeting notes", source="gmail")
- Use \`period\` for time ranges: "last_week", "last_month", "last_3_months", or ISO range "2026-01-01/2026-01-20"

**KB entities tips:**
- Find a person: kb_entities(name="Семён") — returns entity details + all relations (projects, roles)
- List all projects: kb_entities(type="project") — returns all known projects
- Find who works on a project: kb_entities(name="Star Trek Timelines") — shows all team members

**Strategy:**
1. For "who works on X?" → kb_entities(name="X")
2. For "what did X say about Y?" → kb_search(query="Y", person="X")
3. For "tell me about X" → kb_entities(name="X") THEN kb_search(query="X") for context
4. Always cite sources when presenting KB results`,
    }
  },
}

export default kbSkill
