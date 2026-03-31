/**
 * Lisbon Talks report skill.
 * Triggers on Lisbon-specific phrases.
 * Compiles and sends AC project report via Telegram using the meeting-report compiler.
 */

import type { Skill } from './types.js'
import { compileMeetingReport } from '../digest/meeting-report.js'
import { logger } from '../logging/logger.js'
import { loadPromptCached } from '../kb/vault-loader.js'

const lisbonSkill: Skill = {
  name: 'pre-meeting',
  description: 'Generates Lisbon Talks project report for weekly AC sync',

  triggers: [
    'лиссабон', 'лисбон',
    'lisbon',
    'лисбон кол', 'лиссабон кол',
    'лиссабонский созвон', 'лиссабонский синк',
    'lisbon talks', 'lisbon call', 'lisbon sync',
    'отчёт к лиссабону', 'отчет к лиссабону',
    'подготовка к лиссабону',
  ],

  async preProcess(ctx) {
    return {
      prompt: ctx.message.text,
      systemPromptExtra: loadPromptCached('instructions-for-llm/skill-pre-meeting-trigger.md'),
    }
  },

  async postProcess(_response, _ctx) {
    try {
      logger.info('Lisbon skill: compiling report')
      await compileMeetingReport('lisbon')
      logger.info('Lisbon skill: report delivered')
      return 'Отчёт Lisbon Talks отправлен ✅'
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error({ error: msg }, 'Lisbon skill: report compilation failed')
      return `Не удалось скомпилировать отчёт: ${msg}`
    }
  },
}

export default lisbonSkill
