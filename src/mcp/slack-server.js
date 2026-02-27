#!/usr/bin/env node

/**
 * Slack MCP Server — local fork of @modelcontextprotocol/server-slack.
 *
 * Changes from upstream:
 *  - conversations.list includes private_channel (not just public_channel)
 *  - Write tools removed (post_message, reply_to_thread, add_reaction) — read-only mode
 *  - Responses stripped to essential fields only (saves ~90% tokens)
 *  - User ID → display name resolution in message history
 *  - Channel name → ID auto-resolution (handles both "C08xxx" and "general")
 *  - File-based debug logging (/tmp/slack-mcp.log)
 */

import { writeFileSync, appendFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

// ── Debug logging (file-based — stderr goes nowhere useful) ──

const LOG_PATH = '/tmp/slack-mcp.log'

function log(msg) {
  const ts = new Date().toISOString()
  try {
    appendFileSync(LOG_PATH, `${ts} ${msg}\n`)
  } catch { /* ignore write errors */ }
}

// ── Tool definitions (read-only) ──

const listChannelsTool = {
  name: 'slack_list_channels',
  description: 'List public and private channels in the workspace. Returns compact list: id, name, is_private, num_members, topic. Only use when the user asks to browse channels — other tools accept channel names directly.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of channels to return (default 1000)',
        default: 1000,
      },
      cursor: {
        type: 'string',
        description: 'Pagination cursor for next page of results',
      },
    },
  },
}

const getChannelHistoryTool = {
  name: 'slack_get_channel_history',
  description: 'Get recent messages from a channel. Accepts channel ID (like "C08XXXXXXXX") or channel name (like "general"). Returns user display names, text, timestamps, and thread info.',
  inputSchema: {
    type: 'object',
    properties: {
      channel_id: {
        type: 'string',
        description: 'Channel ID (e.g. "C08XXXXXXXX") or channel name (e.g. "general", "ohbibi-mwcf-project"). Both formats accepted.',
      },
      limit: {
        type: 'number',
        description: 'Number of messages to retrieve (default 10)',
        default: 10,
      },
    },
    required: ['channel_id'],
  },
}

const getThreadRepliesTool = {
  name: 'slack_get_thread_replies',
  description: 'Get all replies in a message thread. Accepts channel ID (like "C08XXXXXXXX") or channel name (like "general"). Returns user display names, text, and timestamps.',
  inputSchema: {
    type: 'object',
    properties: {
      channel_id: {
        type: 'string',
        description: 'Channel ID (e.g. "C08XXXXXXXX") or channel name (e.g. "general", "ohbibi-mwcf-project"). Both formats accepted.',
      },
      thread_ts: {
        type: 'string',
        description:
          "The timestamp of the parent message in the format '1234567890.123456'.",
      },
    },
    required: ['channel_id', 'thread_ts'],
  },
}

const getUsersTool = {
  name: 'slack_get_users',
  description: 'Get a list of all users in the workspace. Returns compact list: id, name, real_name, is_bot.',
  inputSchema: {
    type: 'object',
    properties: {
      cursor: { type: 'string', description: 'Pagination cursor for next page of results' },
      limit: {
        type: 'number',
        description: 'Maximum number of users to return (default 200)',
        default: 200,
      },
    },
  },
}

const getUserProfileTool = {
  name: 'slack_get_user_profile',
  description: 'Get detailed profile information for a specific user',
  inputSchema: {
    type: 'object',
    properties: {
      user_id: { type: 'string', description: 'The ID of the user' },
    },
    required: ['user_id'],
  },
}

// ── Slack API client ──

class SlackClient {
  /** In-memory user cache: userId → display name. Populated lazily. */
  #userCache = new Map()
  #userCacheLoaded = false

  /** In-memory channel cache: name → id. Populated lazily. */
  #channelCache = new Map()
  #channelCacheLoaded = false

  constructor(token) {
    this.headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
  }

  /**
   * Resolve a channel_id argument. If it looks like a Slack channel ID
   * (starts with C or G), return it as-is. Otherwise treat it as a channel
   * name and look up the ID from the cache.
   */
  async resolveChannelId(channelIdOrName) {
    if (!channelIdOrName) return channelIdOrName

    // Slack channel IDs start with C (public) or G (private/group)
    if (/^[CG][A-Z0-9]+$/.test(channelIdOrName)) {
      return channelIdOrName
    }

    // Strip leading # if present (Claude might pass "#general")
    const name = channelIdOrName.replace(/^#/, '').toLowerCase()

    await this.#ensureChannelCache()
    const resolved = this.#channelCache.get(name)

    if (resolved) {
      log(`resolved channel name "${name}" → ${resolved}`)
    } else {
      log(`WARN: could not resolve channel name "${name}" — passing as-is`)
    }

    return resolved ?? channelIdOrName
  }

  async getChannels(limit = 1000, cursor) {
    const params = new URLSearchParams({
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: Math.min(limit, 1000).toString(),
      team_id: process.env.SLACK_TEAM_ID,
    })
    if (cursor) {
      params.append('cursor', cursor)
    }
    const response = await fetch(
      `https://slack.com/api/conversations.list?${params}`,
      { headers: this.headers },
    )
    const data = await response.json()
    if (!data.ok) return data

    // Strip to essential fields only (~95% token reduction)
    const channels = (data.channels ?? []).map((ch) => ({
      id: ch.id,
      name: ch.name,
      is_private: ch.is_private ?? false,
      num_members: ch.num_members ?? 0,
      topic: ch.topic?.value || '',
    }))

    return {
      ok: true,
      channels,
      next_cursor: data.response_metadata?.next_cursor || '',
    }
  }

  async getChannelHistory(channel_id, limit = 10) {
    const resolved = await this.resolveChannelId(channel_id)
    const params = new URLSearchParams({
      channel: resolved,
      limit: limit.toString(),
    })
    const response = await fetch(
      `https://slack.com/api/conversations.history?${params}`,
      { headers: this.headers },
    )
    const data = await response.json()
    if (!data.ok) return data

    // Resolve user IDs to names
    await this.#ensureUserCache()

    const messages = (data.messages ?? []).map((msg) => ({
      user: this.#resolveUser(msg.user),
      text: msg.text ?? '',
      ts: msg.ts,
      time: new Date(parseFloat(msg.ts) * 1000).toISOString(),
      thread_ts: msg.thread_ts || undefined,
      reply_count: msg.reply_count || undefined,
    }))

    return { ok: true, channel_id: resolved, messages }
  }

  async getThreadReplies(channel_id, thread_ts) {
    const resolved = await this.resolveChannelId(channel_id)
    const params = new URLSearchParams({
      channel: resolved,
      ts: thread_ts,
    })
    const response = await fetch(
      `https://slack.com/api/conversations.replies?${params}`,
      { headers: this.headers },
    )
    const data = await response.json()
    if (!data.ok) return data

    await this.#ensureUserCache()

    const messages = (data.messages ?? []).map((msg) => ({
      user: this.#resolveUser(msg.user),
      text: msg.text ?? '',
      ts: msg.ts,
      time: new Date(parseFloat(msg.ts) * 1000).toISOString(),
    }))

    return { ok: true, channel_id: resolved, thread_ts, messages }
  }

  async getUsers(limit = 200, cursor) {
    const params = new URLSearchParams({
      limit: Math.min(limit, 200).toString(),
      team_id: process.env.SLACK_TEAM_ID,
    })
    if (cursor) {
      params.append('cursor', cursor)
    }
    const response = await fetch(
      `https://slack.com/api/users.list?${params}`,
      { headers: this.headers },
    )
    const data = await response.json()
    if (!data.ok) return data

    // Strip to essential fields
    const members = (data.members ?? []).map((u) => ({
      id: u.id,
      name: u.name,
      real_name: u.real_name || u.profile?.real_name || '',
      is_bot: u.is_bot ?? false,
    }))

    return {
      ok: true,
      members,
      next_cursor: data.response_metadata?.next_cursor || '',
    }
  }

  async getUserProfile(user_id) {
    const params = new URLSearchParams({
      user: user_id,
      include_labels: 'true',
    })
    const response = await fetch(
      `https://slack.com/api/users.profile.get?${params}`,
      { headers: this.headers },
    )
    return response.json()
  }

  /** Load all workspace channels into cache (once per server lifetime). */
  async #ensureChannelCache() {
    if (this.#channelCacheLoaded) return

    let cursor = ''
    do {
      const params = new URLSearchParams({
        types: 'public_channel,private_channel',
        exclude_archived: 'true',
        limit: '1000',
        team_id: process.env.SLACK_TEAM_ID,
      })
      if (cursor) params.append('cursor', cursor)

      const response = await fetch(
        `https://slack.com/api/conversations.list?${params}`,
        { headers: this.headers },
      )
      const data = await response.json()
      if (!data.ok) break

      for (const ch of data.channels ?? []) {
        this.#channelCache.set(ch.name.toLowerCase(), ch.id)
      }

      cursor = data.response_metadata?.next_cursor || ''
    } while (cursor)

    this.#channelCacheLoaded = true
    log(`channel cache loaded: ${this.#channelCache.size} channels`)
  }

  /** Load all workspace users into cache (once per server lifetime). */
  async #ensureUserCache() {
    if (this.#userCacheLoaded) return

    let cursor = ''
    do {
      const params = new URLSearchParams({
        limit: '200',
        team_id: process.env.SLACK_TEAM_ID,
      })
      if (cursor) params.append('cursor', cursor)

      const response = await fetch(
        `https://slack.com/api/users.list?${params}`,
        { headers: this.headers },
      )
      const data = await response.json()
      if (!data.ok) break

      for (const u of data.members ?? []) {
        const displayName = u.profile?.display_name || u.real_name || u.name || u.id
        this.#userCache.set(u.id, displayName)
      }

      cursor = data.response_metadata?.next_cursor || ''
    } while (cursor)

    this.#userCacheLoaded = true
    log(`user cache loaded: ${this.#userCache.size} users`)
  }

  /** Resolve user ID to display name, or return the raw ID if unknown. */
  #resolveUser(userId) {
    if (!userId) return 'unknown'
    return this.#userCache.get(userId) ?? userId
  }
}

// ── Server ──

async function main() {
  const token = process.env.SLACK_BOT_TOKEN
  const teamId = process.env.SLACK_TEAM_ID

  if (!token || !teamId) {
    console.error('Please set SLACK_BOT_TOKEN and SLACK_TEAM_ID environment variables')
    process.exit(1)
  }

  // Append separator on startup (don't clear — multiple sessions share this log)
  log(`\n--- slack-mcp starting (teamId=${teamId}, tokenPrefix=${token.slice(0, 8)}...) ---`)

  const server = new Server(
    { name: 'Slack MCP Server (read-only, optimized)', version: '1.2.0' },
    { capabilities: { tools: {} } },
  )

  const client = new SlackClient(token)

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = request.params.arguments ?? {}
      const toolName = request.params.name
      log(`tool=${toolName} args=${JSON.stringify(args)}`)

      let result
      switch (toolName) {
        case 'slack_list_channels': {
          result = await client.getChannels(args.limit, args.cursor)
          break
        }
        case 'slack_get_channel_history': {
          if (!args.channel_id) throw new Error('Missing required argument: channel_id')
          result = await client.getChannelHistory(args.channel_id, args.limit)
          break
        }
        case 'slack_get_thread_replies': {
          if (!args.channel_id || !args.thread_ts)
            throw new Error('Missing required arguments: channel_id and thread_ts')
          result = await client.getThreadReplies(args.channel_id, args.thread_ts)
          break
        }
        case 'slack_get_users': {
          result = await client.getUsers(args.limit, args.cursor)
          break
        }
        case 'slack_get_user_profile': {
          if (!args.user_id) throw new Error('Missing required argument: user_id')
          result = await client.getUserProfile(args.user_id)
          break
        }
        default:
          throw new Error(`Unknown tool: ${toolName}`)
      }

      const text = JSON.stringify(result)
      const ok = result?.ok ?? 'n/a'
      const errField = result?.error ?? ''
      log(`tool=${toolName} ok=${ok} error=${errField} size=${text.length}`)
      return { content: [{ type: 'text', text }] }
    } catch (error) {
      log(`tool=${request.params.name} EXCEPTION: ${error}`)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
      }
    }
  })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      listChannelsTool,
      getChannelHistoryTool,
      getThreadRepliesTool,
      getUsersTool,
      getUserProfileTool,
    ],
  }))

  const transport = new StdioServerTransport()
  await server.connect(transport)
  log('server connected via stdio')
}

main().catch((error) => {
  log(`FATAL: ${error}`)
  console.error('Fatal error in main():', error)
  process.exit(1)
})
