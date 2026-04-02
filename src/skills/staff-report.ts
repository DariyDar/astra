/**
 * Staff R&D Report Preparation skill.
 *
 * Monthly process: extracts Clockify time tracking data, calculates
 * per-person project allocation percentages, and generates a Google Sheet
 * ready for copy-paste into the Staff spreadsheet.
 *
 * Triggers: "готовим staff", "staff report", "клокифай отчёт", etc.
 *
 * Process overview:
 * 1. Pull Clockify data for the target month
 * 2. Calculate % allocation per person per project
 * 3. Handle part-timers, manual people, founders (using vault KB + previous month)
 * 4. Distribute time-off proportionally
 * 5. Generate Google Sheet with allocations
 * 6. Send link to user for review
 *
 * See also: vault/processes/Staff R&D Report.md
 */

import type { Skill } from './types.js'
import { logger } from '../logging/logger.js'
import { loadPromptCached } from '../kb/vault-loader.js'

const staffReportSkill: Skill = {
  name: 'staff-rnd-report-preparation',
  description: 'Monthly Staff R&D report — extracts Clockify data, generates allocation sheet for copy-paste into Staff spreadsheet',

  triggers: [
    'готовим staff', 'готовим стафф',
    'staff report', 'staff отчёт', 'staff отчет',
    'клокифай отчёт', 'клокифай отчет', 'clockify отчёт', 'clockify report',
    'отчёт по часам', 'отчет по часам',
    'распределение времени', 'аллокация',
    'подготовка staff', 'заполняем staff',
  ],

  async preProcess(ctx) {
    return {
      prompt: ctx.message.text,
      systemPromptExtra: loadPromptCached('instructions-for-llm/skill-staff-report.md'),
    }
  },
}

export default staffReportSkill
