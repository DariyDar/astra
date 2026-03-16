#!/usr/bin/env node
/**
 * Self-improvement agent runner.
 * Orchestrates: collect → analyze → fix → report.
 *
 * Runs nightly at 23:30 UTC (after KB ingestion completes).
 * Can also be run manually: npx tsx src/self-improve/runner.ts --now
 */

import 'dotenv/config'
import { logger } from '../logging/logger.js'
import { writeAuditEntry } from '../logging/audit.js'
import { collectTodayInteractions, identifyProblems } from './collector.js'
import { analyzeCases } from './analyzer.js'
import { applySafeFixes } from './applier.js'
import { sendReport } from './reporter.js'
import type { SelfImproveReport } from './types.js'

/**
 * Run the full self-improvement pipeline.
 */
export async function runSelfImprovement(): Promise<void> {
  const startTime = Date.now()
  const today = new Date().toISOString().slice(0, 10)

  logger.info({ date: today }, 'Self-improve: starting nightly analysis')

  const report: SelfImproveReport = {
    date: today,
    totalInteractions: 0,
    errorCount: 0,
    timeoutCount: 0,
    avgResponseTimeMs: 0,
    maxResponseTimeMs: 0,
    totalCostUsd: 0,
    problematicCases: [],
    analysisResults: [],
    appliedFixes: [],
    failedFixes: [],
    proposedFixes: [],
  }

  try {
    // Phase 1: Collect interactions
    const interactions = await collectTodayInteractions()
    report.totalInteractions = interactions.length

    if (interactions.length === 0) {
      logger.info('Self-improve: no interactions today, sending minimal report')
      await sendReport(report)
      return
    }

    // Compute stats
    report.errorCount = interactions.filter((i) => i.status === 'error').length
    report.timeoutCount = interactions.filter(
      (i) => i.status === 'timeout' || i.errorMessage?.includes('timed out'),
    ).length

    const responseTimes = interactions
      .filter((i) => i.responseTimeMs > 0)
      .map((i) => i.responseTimeMs)
    if (responseTimes.length > 0) {
      report.avgResponseTimeMs = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      report.maxResponseTimeMs = responseTimes.reduce((max, t) => Math.max(max, t), 0)
    }

    report.totalCostUsd = interactions
      .filter((i) => i.costUsd != null)
      .reduce((sum, i) => sum + (i.costUsd ?? 0), 0)

    // Phase 2: Identify problems
    const problematicCases = identifyProblems(interactions)
    report.problematicCases = problematicCases

    if (problematicCases.length === 0) {
      logger.info('Self-improve: no problems detected, sending clean report')
      await sendReport(report)
      await writeAuditLog(startTime, report)
      return
    }

    // Phase 3: Analyze with Claude
    try {
      const analysisResults = await analyzeCases(problematicCases)
      report.analysisResults = analysisResults

      // Split into safe (auto-apply) and unsafe (report only)
      const safeResults = analysisResults.filter((r) => r.category === 'registry_fix' && r.fix)
      const unsafeResults = analysisResults.filter((r) => r.category !== 'registry_fix' || !r.fix)
      report.proposedFixes = unsafeResults

      // Phase 4: Apply safe fixes
      if (safeResults.length > 0) {
        const { applied, failed } = await applySafeFixes(safeResults)
        report.appliedFixes = applied
        report.failedFixes = failed
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error({ error: msg }, 'Self-improve: analysis phase failed')
      // Still send report with whatever data we have
    }

    // Phase 5: Send report
    await sendReport(report)
    await writeAuditLog(startTime, report)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error({ error: msg }, 'Self-improve: pipeline failed')

    // Try to send error notification
    try {
      await sendReport({
        ...report,
        problematicCases: [{
          interaction: {
            correlationId: 'self-improve-error',
            userId: 'system',
            channelId: '',
            userText: '',
            assistantText: msg,
            status: 'error',
            responseTimeMs: 0,
            createdAt: new Date(),
          },
          problems: ['error'],
        }],
      })
    } catch {
      logger.error('Self-improve: failed to send error report')
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000)
  logger.info({ elapsedSec: elapsed }, 'Self-improve: pipeline complete')
}

async function writeAuditLog(startTime: number, report: SelfImproveReport): Promise<void> {
  await writeAuditEntry({
    correlationId: `self-improve-${report.date}`,
    action: 'self_improvement',
    metadata: {
      totalInteractions: report.totalInteractions,
      problemsFound: report.problematicCases.length,
      fixesApplied: report.appliedFixes.length,
      fixesFailed: report.failedFixes.length,
      fixesProposed: report.proposedFixes.length,
      elapsedMs: Date.now() - startTime,
    },
    status: 'success',
  })
}

// --- CLI entry point: npx tsx src/self-improve/runner.ts --now ---
if (process.argv.includes('--now')) {
  runSelfImprovement()
    .then(() => {
      logger.info('Self-improve: manual run complete')
      process.exit(0)
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ error: msg }, 'Self-improve: manual run failed')
      process.exit(1)
    })
}
