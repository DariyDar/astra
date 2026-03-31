/**
 * Meeting report compiler for Lisbon Talks (weekly) and Board Meeting (biweekly).
 *
 * Reads vault project statuses, loads the appropriate LLM prompt,
 * calls Claude with MCP access (Drive, Slack, ClickUp), and delivers
 * the compiled report via Telegram.
 *
 * Can be triggered:
 * - Automatically via cron (see worker/index.ts)
 * - CLI: npx tsx src/digest/meeting-report.ts --lisbon | --board
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callClaude } from '../llm/client.js'
import { loadPromptCached } from '../kb/vault-loader.js'
import { getAllProjects, loadProjectCard } from '../kb/vault-reader.js'
import { sendTelegramMessage } from '../telegram/sender.js'
import { logger } from '../logging/logger.js'

const MCP_CONFIG_PATH = resolve(
  fileURLToPath(import.meta.url),
  '../../mcp/mcp-config.json',
)

export type MeetingType = 'lisbon' | 'board'

const PROMPT_FILES: Record<MeetingType, string> = {
  lisbon: 'instructions-for-llm/agent-lisbon-talks-compiler.md',
  board: 'instructions-for-llm/agent-board-meeting-compiler.md',
}

const MEETING_LABELS: Record<MeetingType, string> = {
  lisbon: 'Lisbon Talks',
  board: 'Board Meeting',
}

/** Collect vault project data for the given meeting type. */
function collectProjectData(type: MeetingType): string {
  const projects = getAllProjects()

  const companyFilter = type === 'lisbon'
    ? (p: { company: string }) => p.company === 'ac'
    : () => true // board = all projects

  const relevantProjects = projects
    .filter((p) => p.status === 'active')
    .filter(companyFilter)

  const sections: string[] = []

  for (const p of relevantProjects) {
    const card = loadProjectCard(p.name)
    if (!card) continue

    const status = card.current_status
    const lines: string[] = [
      `=== ${p.name} (${p.company.toUpperCase()}) ===`,
      `Status: ${p.status}`,
    ]

    if (status?.current_focus) {
      lines.push(`Focus: ${status.current_focus}`)
    }
    if (status?.updated_at) {
      lines.push(`Last updated: ${status.updated_at}`)
    }
    if (status?.milestones?.length) {
      lines.push(`Recent milestones:\n${status.milestones.map((m) => `- ${m}`).join('\n')}`)
    }
    if (status?.open_tasks !== undefined) {
      lines.push(`Open tasks: ${status.open_tasks}`)
    }
    if (status?.overdue_tasks !== undefined && status.overdue_tasks > 0) {
      lines.push(`Overdue tasks: ${status.overdue_tasks}`)
    }

    sections.push(lines.join('\n'))
  }

  if (sections.length === 0) {
    return 'No active projects found in vault.'
  }

  return sections.join('\n\n')
}

/**
 * Compile and deliver a meeting report via Telegram.
 *
 * Flow:
 * 1. Load the system prompt from vault
 * 2. Collect vault project statuses as user context
 * 3. Call Claude with MCP config for live data access (Slack, Drive, ClickUp)
 * 4. Send the compiled report to Telegram
 */
export async function compileMeetingReport(type: MeetingType): Promise<void> {
  const label = MEETING_LABELS[type]
  const startTime = Date.now()

  logger.info({ type }, `Starting ${label} report compilation`)

  const systemPrompt = loadPromptCached(PROMPT_FILES[type])

  // Collect vault project data
  let projectData: string
  try {
    projectData = collectProjectData(type)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.warn({ type, error: msg }, 'Failed to collect vault project data, using empty context')
    projectData = 'Vault project data unavailable.'
  }

  const userPrompt = [
    `Compile the ${label} report.`,
    '',
    '--- VAULT PROJECT STATUSES ---',
    projectData,
  ].join('\n')

  try {
    const response = await callClaude(userPrompt, {
      system: systemPrompt,
      mcpConfigPath: MCP_CONFIG_PATH,
      timeoutMs: 300_000,
    })

    if (!response.text || response.text.trim().length === 0) {
      throw new Error(`Claude returned empty response for ${label} report`)
    }

    await sendTelegramMessage(response.text)

    const elapsed = Math.round((Date.now() - startTime) / 1000)
    logger.info(
      { type, elapsedSec: elapsed, len: response.text.length, usage: response.usage },
      `${label} report delivered`,
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error({ type, error: msg }, `${label} report compilation failed`)

    try {
      const errorHint = msg ? `\n\nPричина: <code>${msg.slice(0, 200)}</code>` : ''
      await sendTelegramMessage(
        `\u26a0\ufe0f Failed to compile ${label} report. Check logs.${errorHint}`,
      )
    } catch (notifyErr) {
      logger.error({ error: notifyErr }, `Failed to send ${label} error notification`)
    }
  }
}

// --- CLI entry point ---
const cliArg = process.argv.find((a) => a === '--lisbon' || a === '--board')
if (cliArg) {
  const type: MeetingType = cliArg === '--lisbon' ? 'lisbon' : 'board'
  compileMeetingReport(type)
    .then(() => {
      logger.info({ type }, 'Manual meeting report complete')
      process.exit(0)
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ type, error: msg }, 'Manual meeting report failed')
      process.exit(1)
    })
}
