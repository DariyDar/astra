---
phase: 04-knowledge-base
plan: knowledge-map
type: execute
wave: 6
depends_on:
  - bulk-extraction
  - entity-review
files_modified:
  - src/kb/knowledge-map.ts
autonomous: false
requirements:
  - KB-02
  - KB-03

must_haves:
  truths:
    - "User can see a structured per-project report showing people, processes, tools, and source coverage"
    - "User can see a person-centric view showing which projects each person is involved in"
    - "Astra asks clarifying questions where entity data is ambiguous or incomplete"
    - "RAG search returns accurate answers with source citations when user asks knowledge questions"
    - "Knowledge map validates the entire KB entity graph quality before Phase 4 closes"
  artifacts:
    - path: "src/kb/knowledge-map.ts"
      provides: "Interactive knowledge map report generator"
  key_links:
    - from: "src/kb/knowledge-map.ts"
      to: "src/kb/repository.ts"
      via: "queries entity graph for project/person/process data"
      pattern: "kbEntities|kbEntityRelations|kbEntityAliases"
    - from: "src/kb/knowledge-map.ts"
      to: "src/db/schema.ts"
      via: "queries kb_chunks for source coverage stats"
      pattern: "kbChunks.*source"
---

<objective>
Generate a structured knowledge map report that validates the entire KB entity graph. For each project: show name + aliases, people by team/company, processes, tools/integrations, and source coverage. Include person-centric and process-centric views. Astra asks questions where data is unclear or ambiguous. User reviews and answers questions, validating the KB before Phase 4 closes.

Purpose: User requirement from CONTEXT.md: "I want to see what you found -- which people on which projects, which processes, etc. Where something is unclear, ask me." This report is the mandatory Phase 4 deliverable that validates the entire entity graph quality.

Output: Interactive knowledge map report that the user reviews and validates.
</objective>

<execution_context>
@C:/Users/dimsh/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/dimsh/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/04-knowledge-base/04-CONTEXT.md
@.planning/phases/04-knowledge-base/04-RESEARCH.md
@.planning/phases/04-knowledge-base/bulk-extraction-SUMMARY.md
@.planning/phases/04-knowledge-base/entity-review-SUMMARY.md
@src/kb/repository.ts
@src/kb/search.ts
@src/db/schema.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create knowledge map report generator</name>
  <files>src/kb/knowledge-map.ts</files>
  <action>
Create `src/kb/knowledge-map.ts` — a CLI script (runnable via `npx tsx`) that generates a comprehensive knowledge map report. The report has three views:

**View 1: Project-centric (primary)**

For each entity of type "project", generate a section:
```
## [Project Name]
Aliases: [list all aliases from kb_entity_aliases]
People ([count]): [group by relation type or connected company/team entity]
  - Internal (HG): [names with roles from relation types like "works_on", "manages", "leads"]
  - External ([company]): [names with their company affiliation]
  - Unknown affiliation: [names where company/team is unclear]
Processes ([count]): [entities of type "process" connected via relations]
Tools/Integrations: [entities of type "tool" or "integration" connected via relations]
Source coverage:
  - Slack: [count] chunks
  - Notion: [count] chunks
  - Gmail: [count] chunks
  - Calendar: [count] chunks
  - ClickUp: [count] chunks
  - Drive: [count] chunks

Questions:
  - [Generate questions where data is ambiguous]
```

To determine people on a project: find all "person" entities connected via `kb_entity_relations` (any relation type: works_on, manages, member_of, etc.) where one side is the project entity.

To determine person's company: check if the person entity has a relation to a "company" or "team" entity. If not, mark as "unknown affiliation".

To count source coverage: count `kb_chunks` where the project entity ID is in `entity_ids`, grouped by `source` column.

**View 2: Person-centric**

For each entity of type "person" (sorted by chunk reference count descending, top 30):
```
[Person Name] ([company/team if known])
  Projects: [list projects they're connected to via relations]
  Roles: [relation types to projects — manages, works_on, leads, etc.]
  Activity: [total chunks referencing them, by source]
  Aliases: [if any]
```

**View 3: Process-centric**

For each entity of type "process":
```
[Process Name]
  Projects: [which projects use this process]
  People: [who is involved in this process]
  Source coverage: [chunk counts by source]
```

**Question generation:**

For each project, generate questions where the data is ambiguous:
- Person entities connected to the project but with unknown company/team affiliation: "Is [name] internal (HG/AC) or external? Which team?"
- Two person entities with similar names: "Is [name A] the same person as [name B]?"
- Processes found in Slack but not in Calendar: "Is [process] still active? No calendar events found."
- Projects with very few chunk references (<5 total): "Is [project] a real project or a misidentification?"
- Entities that appear as both person and something else: "Is [name] a person or a [type]?"

**Output:** Print the full report to stdout. Also accept `--json` flag to output as JSON for programmatic use. Accept `--project [name]` to show only one project's section.

Import DB from `src/db/index.ts`, schema from `src/db/schema.ts`. Use drizzle queries with joins across `kbEntities`, `kbEntityAliases`, `kbEntityRelations`, `kbChunks`.
  </action>
  <verify>
    <automated>npx tsx -e "import './src/kb/knowledge-map.js'" 2>&1 | head -5</automated>
    <manual>Run on server: `npx tsx src/kb/knowledge-map.ts` — verify it produces project-centric, person-centric, and process-centric views with questions</manual>
  </verify>
  <done>Knowledge map report generator produces three views (project, person, process) with source coverage, relationship details, and generated questions for ambiguous data</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 2: Interactive knowledge map review and RAG quality test</name>
  <files>src/kb/knowledge-map.ts</files>
  <action>
Run knowledge map report on server: `npx tsx src/kb/knowledge-map.ts`
For a specific project: `npx tsx src/kb/knowledge-map.ts --project "Level One"`

Present the full report to the user for review in three parts:

Part 1 — Knowledge map review:
1. Review the project list — are all ~13 known projects represented?
2. For each major project: verify people count, team breakdown, process list, source coverage
3. Answer the generated questions — confirm or correct entity affiliations
4. Check person-centric view — are key people correctly linked to their projects?
5. Check process-centric view — are processes like daily standups, sprint reviews, QA cycles correctly identified?

Part 2 — RAG quality test (user asks questions via the bot):
1. "Who works on [project]?" — should return accurate person list with roles
2. "What did [person] discuss about [topic] last month?" — should find relevant Slack/email content
3. "What processes does [project] use?" — should return process entities
4. "Tell me about [project]" — should give a comprehensive summary from multiple sources
5. Verify answers include source citations (Slack channel, Notion page, Gmail thread, etc.)

Part 3 — Final validation: confirm KB quality is sufficient to close Phase 4.
  </action>
  <verify>User reviews knowledge map, tests RAG search quality, and explicitly approves Phase 4 closure</verify>
  <done>User typed "phase 4 approved" confirming knowledge base quality is sufficient to close Phase 4</done>
</task>

</tasks>

<verification>
1. Knowledge map shows all known projects with correct people, processes, and tools
2. Person-centric view correctly links people to their projects with roles
3. Process-centric view identifies company processes
4. Generated questions surface genuine ambiguities in the data
5. RAG search returns accurate answers with source citations
6. User explicitly approves the knowledge base quality for Phase 4 closure
</verification>

<success_criteria>
- Knowledge map report generates successfully with all three views
- User reviews and validates entity graph accuracy
- Generated questions are answered and ambiguities resolved
- RAG search quality test passes (5+ knowledge questions answered correctly)
- User explicitly approves Phase 4 closure
</success_criteria>

<output>
After completion, create `.planning/phases/04-knowledge-base/knowledge-map-SUMMARY.md`
</output>
