/**
 * Pre-meeting report skill.
 * Triggers on sync/meeting prep phrases.
 * Compiles and sends AC project report directly via Telegram.
 */

import type { Skill } from './types.js'
import { compilePreMeetingReport } from '../digest/pre-meeting-report.js'
import { sendTelegramMessage } from '../telegram/sender.js'
import { logger } from '../logging/logger.js'
import { loadPromptCached } from '../kb/vault-loader.js'

const preMeetingSkill: Skill = {
  name: 'pre-meeting',
  description: 'Generates a comprehensive AstroCat project report for sync preparation',

  triggers: [
    'отчёт перед синком', 'отчет перед синком',
    'подготовка к синку', 'подготовка к созвону',
    'отчёт по проектам ac', 'отчет по проектам ac',
    'отчёт по проектам astrocat', 'отчет по проектам astrocat',
    'отчёт по проектам астрокат', 'отчет по проектам астрокат',
    'pre-meeting report', 'pre meeting report',
    'перед синком', 'перед созвоном',
    'статус проектов ac', 'статус проектов astrocat',
    'ac report', 'astrocat report',
  ],

  async preProcess(ctx) {
    // This skill handles the full response itself (compile + send)
    // Return a prompt that tells Claude to wait while we compile
    // Moved to vault/instructions-for-llm/skill-pre-meeting-trigger.md
    return {
      prompt: ctx.message.text,
      systemPromptExtra: loadPromptCached('instructions-for-llm/skill-pre-meeting-trigger.md'),
    }
  },

  async postProcess(_response, _ctx) {
    // After Claude responds with the placeholder, compile and send the actual report
    try {
      logger.info('Pre-meeting skill: compiling report')
      const report = await compilePreMeetingReport()
      await sendTelegramMessage(report)
      logger.info({ len: report.length }, 'Pre-meeting skill: report delivered')
      return 'Отчёт по проектам AstroCat отправлен ✅'
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error({ error: msg }, 'Pre-meeting skill: report compilation failed')
      return `Не удалось скомпилировать отчёт: ${msg}`
    }
  },
}

export default preMeetingSkill
