/**
 * Entry point for the new single-call digest pipeline.
 * Wires collect → LLM → format and delivers to Telegram + vault.
 *
 * Toggled by the USE_NEW_DIGEST environment variable in scheduler.ts.
 */

import 'dotenv/config'
import { logger } from '../logging/logger.js'
import { sendTelegramMessage } from '../telegram/sender.js'
import { collectDigestData } from './collect.js'
import { compileDigestJson } from './llm-call.js'
import { formatDigestForTelegram, appendDigestToVault, saveDigestJson } from './format.js'
import { runVaultSynthFromCollected } from '../kb/vault-synthesizer.js'

export async function runNewDigestPipeline(): Promise<void> {
  const startedAt = Date.now()

  // Stage 1: Collect once for both synth and digest.
  logger.info('New digest pipeline: stage 1 — collecting data')

  const data = await collectDigestData()
  logger.info(
    {
      slackChannels: data.slack.length,
      gmail: data.gmail.length,
      calendar: data.calendar.length,
      clickup: data.clickup.length,
    },
    'New digest pipeline: data collected',
  )

  // Stage 2: Vault synthesis BEFORE digest LLM. Reuses the haul from stage 1
  // — no duplicate Slack/Gmail fetch. Updates vault/projects/<X> — Статусы.md
  // so the digest LLM (stage 3) reads fresh kbContext via vault-reader.
  // Failures are NON-FATAL: digest continues with whatever vault state exists.
  if (process.env.SKIP_SYNTH !== 'true' && process.env.SKIP_SYNTH !== '1') {
    try {
      logger.info('New digest pipeline: stage 2 — vault synth (multi-source)')
      const synthStats = await runVaultSynthFromCollected({
        slack: data.slack.map(ch => ({
          channel: ch.channelName,
          workspace: ch.workspace,
          messages: ch.messages.map(m => ({
            ts: m.ts ?? '',
            user: m.author ?? '',
            text: m.text ?? '',
          })),
        })),
        gmail: data.gmail as unknown as Array<Record<string, unknown>>,
        calendar: data.calendar as unknown as Array<Record<string, unknown>>,
        clickup: data.clickup as unknown as Array<Record<string, unknown>>,
      })
      logger.info(synthStats, 'Vault synth done, proceeding to digest')
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.warn({ error: msg }, 'Vault synth failed (non-fatal); digest continues with stale vault')
    }
  } else {
    logger.info('SKIP_SYNTH set — skipping vault synth')
  }

  // After synth (which may have updated vault YAML), re-read project statuses
  // so the digest LLM sees the fresh kbContext.
  const refreshedStatuses = (await import('../kb/vault-reader.js')).getAllStatuses()
  data.projectStatuses = refreshedStatuses

  // Stage 3: digest LLM
  logger.info('New digest pipeline: stage 3 — digest LLM')
  const result = await compileDigestJson(data)
  logger.info(
    {
      itemsTotal: result.meta.items_total,
      acProjects: result.companies.astrocat.projects.length,
      hgProjects: result.companies.highground.projects.length,
    },
    'New digest pipeline: LLM done, formatting',
  )

  saveDigestJson(result)

  const messages = formatDigestForTelegram(result)
  const dryRun = process.env.DIGEST_DRY_RUN === 'true' || process.env.DIGEST_DRY_RUN === '1'

  if (dryRun) {
    logger.info('DRY_RUN: skipping Telegram send and vault append. Messages would be:')
    for (const msg of messages.astrocat) logger.info({ company: 'ac', preview: msg.slice(0, 500) }, '— AC msg')
    for (const msg of messages.highground) logger.info({ company: 'hg', preview: msg.slice(0, 500) }, '— HG msg')
  } else {
    for (const msg of messages.astrocat) await sendTelegramMessage(msg)
    for (const msg of messages.highground) await sendTelegramMessage(msg)
    appendDigestToVault(result)
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
  logger.info(
    {
      elapsedSec,
      itemsTotal: result.meta.items_total,
      acMessages: messages.astrocat.length,
      hgMessages: messages.highground.length,
    },
    'New digest pipeline: complete',
  )
}

// --- CLI entry: npx tsx src/digest/new-pipeline.ts [--dry-run] ---
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  if (process.argv.includes('--dry-run')) {
    process.env.DIGEST_DRY_RUN = '1'
  }
  runNewDigestPipeline()
    .then(() => process.exit(0))
    .catch(err => {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ error: msg }, 'CLI digest run failed')
      process.exit(1)
    })
}
