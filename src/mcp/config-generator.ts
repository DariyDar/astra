import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { env } from '../config/env.js'
import { logger } from '../logging/logger.js'

/** Absolute path to the local Slack MCP server (forked for private channel support). */
const SLACK_SERVER_PATH = resolve(
  fileURLToPath(import.meta.url),
  '../slack-server.js',
)

/** Absolute path to the Astra Briefing MCP server (aggregated multi-source queries). */
const BRIEFING_SERVER_PATH = resolve(
  fileURLToPath(import.meta.url),
  '../briefing-server.ts',
)

interface McpServerConfig {
  type: 'http' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>
}

/**
 * Generate MCP config JSON dynamically based on available env vars.
 * Always includes astra-memory. Conditionally adds google-workspace and clickup
 * servers when their respective credentials are configured.
 *
 * Writes the config to the specified outputPath so Claude CLI can read it at runtime.
 */
export function generateMcpConfig(outputPath: string): void {
  const servers: Record<string, McpServerConfig> = {}

  // Always include astra-memory HTTP server
  servers['astra-memory'] = {
    type: 'http',
    url: 'http://127.0.0.1:3100/mcp',
  }

  // Conditionally add google-workspace stdio server
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) {
    // Resolve full path to uvx — PM2/SSH sessions may not have ~/.local/bin in PATH
    const uvxPath = resolveCommand('uvx', ['/home/clawdbot/.local/bin/uvx'])
    servers['google-workspace'] = {
      type: 'stdio',
      command: uvxPath,
      args: ['workspace-mcp', '--read-only', '--tools', 'gmail', 'drive', 'calendar'],
      env: {
        GOOGLE_OAUTH_CLIENT_ID: env.GOOGLE_OAUTH_CLIENT_ID,
        GOOGLE_OAUTH_CLIENT_SECRET: env.GOOGLE_OAUTH_CLIENT_SECRET,
      },
    }
    logger.info({ command: uvxPath }, 'MCP: google-workspace server configured')
  } else {
    logger.info('MCP: google-workspace server skipped (GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET not set)')
  }

  // Conditionally add slack stdio server (read-only channel history)
  // Prefer SLACK_USER_TOKEN (xoxp-) — sees all channels the user belongs to, including private.
  // Falls back to SLACK_BOT_TOKEN (xoxb-) — only sees channels where the bot is invited.
  const slackToken = env.SLACK_USER_TOKEN ?? env.SLACK_BOT_TOKEN
  if (slackToken && env.SLACK_TEAM_ID) {
    const nodePath = resolveCommand('node', ['/usr/local/bin/node', '/usr/bin/node'])
    servers['slack'] = {
      type: 'stdio',
      command: nodePath,
      args: [SLACK_SERVER_PATH],
      env: {
        SLACK_BOT_TOKEN: slackToken,
        SLACK_TEAM_ID: env.SLACK_TEAM_ID,
      },
    }
    const tokenType = env.SLACK_USER_TOKEN ? 'user token' : 'bot token'
    logger.info({ tokenType }, 'MCP: slack server configured')
  } else {
    logger.info('MCP: slack server skipped (SLACK_BOT_TOKEN/SLACK_USER_TOKEN or SLACK_TEAM_ID not set)')
  }

  // Conditionally add clickup stdio server
  if (env.CLICKUP_API_KEY && env.CLICKUP_TEAM_ID) {
    servers['clickup'] = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@hauptsache.net/clickup-mcp@latest'],
      env: {
        CLICKUP_API_KEY: env.CLICKUP_API_KEY,
        CLICKUP_TEAM_ID: env.CLICKUP_TEAM_ID,
        CLICKUP_MCP_MODE: 'read',
      },
    }
    logger.info('MCP: clickup server configured')
  } else {
    logger.info('MCP: clickup server skipped (CLICKUP_API_KEY or CLICKUP_TEAM_ID not set)')
  }

  // Always add astra-briefing server (aggregated multi-source queries).
  // It reads Google tokens from disk and uses Slack/ClickUp tokens from env.
  // Needs tsx to run .ts file directly.
  const tsxPath = resolveCommand('tsx', ['/usr/local/bin/tsx', '/usr/bin/tsx'])
  const briefingEnv: Record<string, string> = {}
  if (slackToken && env.SLACK_TEAM_ID) {
    briefingEnv.SLACK_USER_TOKEN = slackToken
    briefingEnv.SLACK_TEAM_ID = env.SLACK_TEAM_ID
  }
  if (env.CLICKUP_API_KEY && env.CLICKUP_TEAM_ID) {
    briefingEnv.CLICKUP_API_KEY = env.CLICKUP_API_KEY
    briefingEnv.CLICKUP_TEAM_ID = env.CLICKUP_TEAM_ID
  }
  servers['astra-briefing'] = {
    type: 'stdio',
    command: tsxPath,
    args: [BRIEFING_SERVER_PATH],
    env: briefingEnv,
  }
  logger.info('MCP: astra-briefing server configured')

  const config: McpConfig = { mcpServers: servers }
  const serverNames = Object.keys(servers)

  writeFileSync(outputPath, JSON.stringify(config, null, 2), 'utf-8')
  logger.info({ servers: serverNames, outputPath }, 'MCP config generated')
}

/**
 * Resolve a command to its full path. Tries `which` first, then falls back
 * to known locations. Returns the bare command name if nothing found
 * (lets the OS try PATH at runtime).
 */
function resolveCommand(name: string, fallbacks: string[]): string {
  try {
    const resolved = execSync(`which ${name} 2>/dev/null`, { encoding: 'utf-8' }).trim()
    if (resolved) return resolved
  } catch { /* which failed, try fallbacks */ }

  for (const path of fallbacks) {
    try {
      execSync(`test -x ${path}`, { encoding: 'utf-8' })
      return path
    } catch { /* not found at this path */ }
  }

  return name
}
