/**
 * Fix applier for self-improvement agent.
 * Applies safe YAML registry fixes and commits via git.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { load as yamlParse } from 'js-yaml'
import { logger } from '../logging/logger.js'
import type { AnalysisResult, SafeFix } from './types.js'

const execFileAsync = promisify(execFile)

/** Max auto-fixes per night (safety limit). */
const MAX_AUTO_FIXES = 5

/** Project root directory. */
const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..')

/** Allowed directory for auto-fixes (Obsidian vault). */
const ALLOWED_PREFIX = join(PROJECT_ROOT, 'vault')

/**
 * Validate that a fix targets an allowed file path.
 * Prevents path traversal attacks.
 */
function isPathAllowed(filePath: string): boolean {
  const absolutePath = resolve(PROJECT_ROOT, filePath)
  return absolutePath.startsWith(ALLOWED_PREFIX) && filePath.endsWith('.md')
}

/**
 * Validate YAML content is parseable.
 */
function isValidYaml(content: string): boolean {
  try {
    yamlParse(content)
    return true
  } catch {
    return false
  }
}

/** Max size of old/new content in a fix (chars). Larger diffs require manual review. */
const MAX_DIFF_CHARS = 500

/**
 * Apply a single safe fix to a YAML file.
 * Throws on failure (path not allowed, ambiguous match, invalid YAML, oversized diff).
 */
function applySingleFix(fix: SafeFix): void {
  const absolutePath = resolve(PROJECT_ROOT, fix.filePath)

  if (!isPathAllowed(fix.filePath)) {
    throw new Error(`Path not allowed: ${fix.filePath}`)
  }

  if (!existsSync(absolutePath)) {
    throw new Error(`File not found: ${fix.filePath}`)
  }

  // Guard: reject oversized diffs (prevents Claude from rewriting entire files)
  if (fix.oldContent.length > MAX_DIFF_CHARS || fix.newContent.length > MAX_DIFF_CHARS) {
    throw new Error(
      `Fix diff too large (${fix.oldContent.length} → ${fix.newContent.length} chars), requires manual review`,
    )
  }

  const originalContent = readFileSync(absolutePath, 'utf-8')

  // Verify oldContent exists and is unambiguous (exactly 1 occurrence)
  const occurrences = originalContent.split(fix.oldContent).length - 1
  if (occurrences === 0) {
    throw new Error(`oldContent not found in ${fix.filePath} — file may have changed`)
  }
  if (occurrences > 1) {
    throw new Error(
      `oldContent matches ${occurrences} times in ${fix.filePath} — ambiguous patch, skipping`,
    )
  }

  // Apply the fix
  const newContent = originalContent.replace(fix.oldContent, fix.newContent)

  // Validate the result is valid YAML
  if (!isValidYaml(newContent)) {
    throw new Error(`Fix would produce invalid YAML in ${fix.filePath}`)
  }

  // Atomic write: temp file + rename
  const tmpPath = absolutePath + '.tmp'
  writeFileSync(tmpPath, newContent, 'utf-8')
  renameSync(tmpPath, absolutePath)
}

/**
 * Apply safe fixes from analysis results.
 * Only applies registry_fix category with valid fix data.
 * Returns applied and failed results.
 */
export async function applySafeFixes(results: AnalysisResult[]): Promise<{
  applied: AnalysisResult[]
  failed: Array<{ result: AnalysisResult; error: string }>
}> {
  const safeResults = results
    .filter((r) => r.category === 'registry_fix' && r.fix)
    .slice(0, MAX_AUTO_FIXES)

  if (safeResults.length === 0) {
    return { applied: [], failed: [] }
  }

  const applied: AnalysisResult[] = []
  const failed: Array<{ result: AnalysisResult; error: string }> = []

  for (const result of safeResults) {
    try {
      applySingleFix(result.fix!)
      applied.push(result)
      logger.info(
        { file: result.fix!.filePath, description: result.fix!.description },
        'Self-improve: fix applied',
      )
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      failed.push({ result, error: msg })
      logger.warn(
        { file: result.fix?.filePath, error: msg },
        'Self-improve: fix failed',
      )
    }
  }

  // Git commit + push if any fixes were applied
  if (applied.length > 0) {
    try {
      await commitAndPush(applied)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error({ error: msg }, 'Self-improve: git commit/push failed')
    }
  }

  logger.info(
    { applied: applied.length, failed: failed.length },
    'Self-improve: fix application complete',
  )

  return { applied, failed }
}

async function commitAndPush(fixes: AnalysisResult[]): Promise<void> {
  // Verify we're on main branch before pushing
  const { stdout: branch } = await execFileAsync(
    'git', ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: PROJECT_ROOT },
  )
  if (branch.trim() !== 'main') {
    throw new Error(`Expected branch main, got ${branch.trim()} — aborting push`)
  }

  const descriptions = fixes
    .map((f) => f.fix?.description ?? f.summary)
    .join('; ')

  const commitMessage = `fix(vault): self-improve auto-fix — ${descriptions}`

  // Stage only vault files
  await execFileAsync('git', ['add', 'vault/'], { cwd: PROJECT_ROOT })

  // Check if there are staged changes
  const { stdout: diffOutput } = await execFileAsync(
    'git', ['diff', '--cached', '--name-only'],
    { cwd: PROJECT_ROOT },
  )

  if (!diffOutput.trim()) {
    logger.info('Self-improve: no staged changes to commit')
    return
  }

  await execFileAsync('git', ['commit', '-m', commitMessage], { cwd: PROJECT_ROOT })
  await execFileAsync('git', ['push'], { cwd: PROJECT_ROOT })

  logger.info(
    { filesChanged: diffOutput.trim().split('\n').length, message: commitMessage },
    'Self-improve: changes committed and pushed',
  )
}
