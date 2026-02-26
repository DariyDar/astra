import { spawn } from 'node:child_process'
import type pino from 'pino'
import { logger } from '../logging/logger.js'
import { writeAuditEntry } from '../logging/audit.js'
import { sendHealthAlert } from '../health/alerter.js'

const MODEL = 'sonnet'
const CLAUDE_TIMEOUT_MS = 120_000

export interface ClaudeResponse {
  text: string
  model: string
}

/**
 * Call Claude via the CLI (`claude --print`).
 * Uses the OAuth token from the Max subscription configured on the host.
 */
export async function callClaude(
  prompt: string,
  options?: { system?: string; mcpConfigPath?: string },
  requestLogger?: pino.Logger,
): Promise<ClaudeResponse> {
  const log = requestLogger ?? logger

  const args = ['--print', '--no-session-persistence', '--model', MODEL, '--output-format', 'json']

  if (options?.system) {
    args.push('--system-prompt', options.system)
  }

  if (options?.mcpConfigPath) {
    args.push('--mcp-config', options.mcpConfigPath)
    // Bypass permission checks for MCP tools — --print mode cannot prompt interactively.
    // Wildcard --allowedTools 'mcp__*' is not supported by Claude CLI,
    // and we can't enumerate tool names without querying each MCP server first.
    // bypassPermissions is safe here: --print mode has no interactive tools,
    // and MCP servers are configured as read-only.
    args.push('--permission-mode', 'bypassPermissions')
  }

  // Prompt is always passed via stdin (not as CLI argument).
  // When --mcp-config is present, Claude CLI requires stdin input and ignores
  // a trailing positional argument — so we use stdin consistently for both cases.

  try {
    const result = await execClaude(args, prompt)

    log.info(
      {
        event: 'llm_response',
        model: MODEL,
        responseLength: result.text.length,
      },
      'Claude CLI response received',
    )

    await writeAuditEntry({
      correlationId:
        (log.bindings() as { correlationId?: string }).correlationId ??
        'unknown',
      action: 'llm_request',
      model: MODEL,
      metadata: {
        responseLength: result.text.length,
      },
      status: 'success',
    })

    return result
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error)

    log.error({ error: errorMessage }, 'Claude CLI error')

    if (
      errorMessage.includes('overloaded') ||
      errorMessage.includes('503') ||
      errorMessage.includes('529')
    ) {
      await sendHealthAlert(
        "Claude is temporarily unavailable. I'll keep trying and let you know when it's back.",
      )
    }

    await writeAuditEntry({
      correlationId:
        (log.bindings() as { correlationId?: string }).correlationId ??
        'unknown',
      action: 'llm_request',
      model: MODEL,
      metadata: { errorType: 'cli_error' },
      status: 'error',
      errorMessage,
    })

    throw error
  }
}

function execClaude(args: string[], prompt: string): Promise<ClaudeResponse> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    proc.stdin.write(prompt)
    proc.stdin.end()

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    const timer = setTimeout(() => { proc.kill(); reject(new Error('Claude CLI timed out')) }, CLAUDE_TIMEOUT_MS)

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`))
        return
      }

      try {
        const parsed = JSON.parse(stdout) as { result?: string; content?: string; response?: string; is_error?: boolean }

        // CLI may exit 0 but return is_error: true for auth failures
        if (parsed.is_error) {
          reject(new Error(parsed.result ?? 'Claude CLI returned is_error'))
          return
        }

        const text = parsed.result ?? parsed.content ?? parsed.response ?? stdout.trim()
        resolve({ text: typeof text === 'string' ? text : JSON.stringify(text), model: MODEL })
      } catch {
        resolve({ text: stdout.trim(), model: MODEL })
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}
