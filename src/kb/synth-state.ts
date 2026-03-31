/**
 * Synth State — watermark tracking for vault synthesizer resilience.
 * When the synthesizer misses runs (rate limits, downtime), it remembers
 * the last successful run and catches up with extended lookback on the next run.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const STATE_FILE = join(process.cwd(), 'vault', '_synth-state.json')

interface SynthState {
  lastSuccessfulRun: string  // ISO timestamp
  pendingLookbackHours?: number  // if > normal, means we're catching up
}

export function loadSynthState(): SynthState {
  if (!existsSync(STATE_FILE)) return { lastSuccessfulRun: new Date().toISOString() }
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
  } catch {
    return { lastSuccessfulRun: new Date().toISOString() }
  }
}

export function saveSynthState(state: SynthState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
}

/**
 * Calculate lookback hours based on last successful run.
 * If we missed runs, use more lookback to catch up.
 */
export function calculateLookback(defaultHours: number): number {
  const state = loadSynthState()
  const hoursSinceLastRun = (Date.now() - new Date(state.lastSuccessfulRun).getTime()) / (3600 * 1000)
  // If more than 2x default has passed, we missed runs — catch up
  if (hoursSinceLastRun > defaultHours * 2) {
    return Math.min(Math.ceil(hoursSinceLastRun), 48) // cap at 48h
  }
  return defaultHours
}
