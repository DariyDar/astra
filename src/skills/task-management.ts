import type { Skill } from './types.js'
import { loadPromptCached } from '../kb/vault-loader.js'

/**
 * Task management skill — creating, editing and auditing ClickUp tasks.
 *
 * Covers:
 *  - Creating single task or a batch (with 5-task threshold for Sheet review)
 *  - Editing existing tasks (rename, reparent, retag, reassign, re-status)
 *  - Auditing task quality against the wiki's "ideal task" definition
 *  - Decomposing a GDD/spec into Milestone → Epics → Tasks (rare but covered)
 *
 * Enforces the company's task conventions and draft-confirm flow for writes.
 */
const taskManagementSkill: Skill = {
  name: 'task-management',
  description: 'Create / edit / audit ClickUp tasks, epics and milestones. Enforces company conventions and draft-confirm flow.',

  triggers: [
    // Creation
    'заведи задачу', 'заведи таск', 'заведи задачи',
    'создай задачу', 'создай таск', 'создай задачи',
    'добавь задачу', 'добавь таск',
    'заведи эпик', 'создай эпик',
    'заведи майлстоун', 'создай майлстоун',
    'заведи баг', 'создай баг',
    'create task', 'new task',
    // Editing
    'обнови задачу', 'поправь задачу', 'переименуй задачу',
    'измени задачу', 'отредактируй задачу',
    'обнови описание задачи', 'переназначь задачу',
    // Bulk / decomposition
    'заведи задачи по', 'создай задачи по',
    'разложи на задачи', 'декомпозируй',
    'разбей на эпики',
    // Audit / quality check
    'проверь задачи', 'проверь ведение задач',
    'оцени ведение задач', 'проверь качество задач',
    'правильно ли заведена задача', 'правильно ли заведены',
    'аудит задач', 'audit tasks',
    'насколько хорошо', 'насколько правильно',
    // Status / structure
    'переведи задачу в', 'закрой задачу', 'open task', 'close task',
  ],

  async preProcess(ctx) {
    return {
      prompt: ctx.message.text,
      systemPromptExtra: loadPromptCached('instructions-for-llm/skill-task-management.md'),
    }
  },
}

export default taskManagementSkill
