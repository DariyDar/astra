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

  // Slack MCP servers — one per workspace (AC, HG).
  // Prefer user token (xoxp-) — sees private channels. Falls back to bot token (xoxb-).
  const nodePath = resolveCommand('node', ['/usr/local/bin/node', '/usr/bin/node'])
  const slackWorkspaces = [
    { label: 'ac', token: env.SLACK_AC_USER_TOKEN ?? env.SLACK_AC_BOT_TOKEN, teamId: env.SLACK_AC_TEAM_ID },
    { label: 'hg', token: env.SLACK_HG_USER_TOKEN ?? env.SLACK_HG_BOT_TOKEN, teamId: env.SLACK_HG_TEAM_ID },
  ]
  for (const ws of slackWorkspaces) {
    if (ws.token && ws.teamId) {
      servers[`slack-${ws.label}`] = {
        type: 'stdio',
        command: nodePath,
        args: [SLACK_SERVER_PATH],
        env: {
          SLACK_BOT_TOKEN: ws.token,
          SLACK_TEAM_ID: ws.teamId,
        },
      }
      logger.info({ workspace: ws.label }, `MCP: slack-${ws.label} server configured`)
    }
  }
  if (!slackWorkspaces.some(ws => ws.token && ws.teamId)) {
    logger.info('MCP: no slack workspaces configured')
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

  // Conditionally add notion stdio server (read-only archive)
  if (env.NOTION_TOKEN) {
    servers['notion'] = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      env: {
        NOTION_TOKEN: env.NOTION_TOKEN,
      },
    }
    logger.info('MCP: notion server configured')
  } else {
    logger.info('MCP: notion server skipped (NOTION_TOKEN not set)')
  }

  // Always add astra-briefing server (aggregated multi-source queries).
  // It reads Google tokens from disk and uses Slack/ClickUp tokens from env.
  // Needs tsx to run .ts file directly.
  // tsx is a devDependency — check node_modules/.bin first, then global
  const localTsx = resolve(fileURLToPath(import.meta.url), '../../../node_modules/.bin/tsx')
  const tsxPath = resolveCommand('tsx', [localTsx, '/usr/local/bin/tsx', '/usr/bin/tsx'])
  const briefingEnv: Record<string, string> = {}
  for (const ws of slackWorkspaces) {
    if (ws.token && ws.teamId) {
      briefingEnv[`SLACK_${ws.label.toUpperCase()}_USER_TOKEN`] = ws.token
      briefingEnv[`SLACK_${ws.label.toUpperCase()}_TEAM_ID`] = ws.teamId
    }
  }
  if (env.CLICKUP_API_KEY && env.CLICKUP_TEAM_ID) {
    briefingEnv.CLICKUP_API_KEY = env.CLICKUP_API_KEY
    briefingEnv.CLICKUP_TEAM_ID = env.CLICKUP_TEAM_ID
  }
  if (env.GOOGLE_ACCOUNTS) {
    briefingEnv.GOOGLE_ACCOUNTS = env.GOOGLE_ACCOUNTS
  }
  if (env.CLOCKIFY_API_KEY) {
    briefingEnv.CLOCKIFY_API_KEY = env.CLOCKIFY_API_KEY
  }
  if (env.CLOCKIFY_WORKSPACE_ID) {
    briefingEnv.CLOCKIFY_WORKSPACE_ID = env.CLOCKIFY_WORKSPACE_ID
  }
  // KB tools need database and Qdrant access
  briefingEnv.DATABASE_URL = env.DATABASE_URL
  briefingEnv.QDRANT_URL = env.QDRANT_URL
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
