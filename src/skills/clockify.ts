import type { Skill } from './types.js'
import { loadPromptCached } from '../kb/vault-loader.js'

const clockifySkill: Skill = {
  name: 'clockify',
  description: 'Time tracking reports: hours per person/project, who tracked, who missing',

  triggers: [
    'время', 'часы', 'часов', 'трекинг', 'трекал', 'затрачено',
    'clockify', 'timesheet', 'выгрузка', 'выгрузку',
    'кто работал', 'кто трекал', 'не трекал', 'не залогировал',
    'сколько часов', 'отработал', 'отработали',
  ],

  async preProcess(ctx) {
    // Moved to vault/instructions-for-llm/skill-clockify.md
    return {
      prompt: ctx.message.text,
      systemPromptExtra: loadPromptCached('instructions-for-llm/skill-clockify.md'),
    }
  },
}

export default clockifySkill
