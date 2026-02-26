import { writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { env } from '../config/env.js'
import { logger } from '../logging/logger.js'

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
