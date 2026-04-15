import type { Skill } from './types.js'
import { loadPromptCached } from '../kb/vault-loader.js'

/**
 * GDD decomposition skill — breaks down a Game Design Document (or similar
 * product spec) into a ClickUp hierarchy Milestone → Epics → Tasks.
 *
 * Key flow (enforced by systemPromptExtra):
 *  1. Clarify scope and conventions with the user BEFORE generating anything
 *  2. Produce an intermediate Google Sheet for review — never create ClickUp
 *     tasks straight from the LLM's first pass
 *  3. After user approval, create a pilot (1 epic + its tasks) and wait for
 *     confirmation of format before batching the rest
 *  4. Integrate existing tasks (keep history/attachments) rather than duplicating
 *  5. Use ClickUp's native custom_item_id (milestone=1, epic=1001) and
 *     markdown_description for rich formatting
 *  6. Relations go through linked_tasks in a second pass, after IDs exist
 *
 * This skill enriches the system prompt and lets Claude orchestrate the work
 * via MCP tools (ClickUp, google-workspace/Docs+Sheets, briefing).
 */
const gddDecompositionSkill: Skill = {
  name: 'gdd-decomposition',
  description: 'Decompose a GDD (or product spec) into ClickUp Milestone → Epics → Tasks with clarification dialog and Sheet review',

  triggers: [
    // Explicit intent
    'декомпозируй', 'декомпозиция', 'разложи на задачи', 'разложи gdd',
    'decompose gdd', 'break down spec', 'break down gdd',
    'заведи задачи по гдд', 'заведи задачи по документу', 'заведи задачи по спеке',
    'заведи задачи по проекту',
    'создай задачи по гдд', 'создай задачи по документу',
    'создай майлстоун и эпики', 'создать майлстоун',
    'план задач по', 'план работ по',
    // Implicit
    'разбей на эпики', 'разбей на майлстоуны', 'разбить на эпики',
    'по гдд на кликап', 'по гдд в кликап',
    // English
    'milestone and epics', 'milestone + epics',
    'epics from gdd', 'tasks from gdd',
  ],

  async preProcess(ctx) {
    return {
      prompt: ctx.message.text,
      systemPromptExtra: loadPromptCached('instructions-for-llm/skill-gdd-decomposition.md'),
    }
  },
}

export default gddDecompositionSkill
