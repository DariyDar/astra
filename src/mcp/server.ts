import http from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { env } from '../config/env.js'
import { db } from '../db/index.js'
import { embed, initEmbedder } from '../memory/embedder.js'
import { MediumTermMemory } from '../memory/medium-term.js'
import { LongTermMemory } from '../memory/long-term.js'
import { QdrantClient } from '@qdrant/js-client-rest'
import { logger } from '../logging/logger.js'

const MCP_PORT = 3100

// --- Tool input schemas ---
const MemorySearchArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).default(5),
})

const GetUserProfileArgs = z.object({
  limit: z.number().int().min(1).max(20).default(10),
})

const GetRecentMessagesArgs = z.object({
  channelId: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
  days: z.number().int().min(1).max(30).default(7),
})

/**
 * Create a fresh MCP Server instance with all memory tool handlers registered.
 * A new instance must be created per HTTP request (stateless pattern).
 * The MCP SDK's Server throws if you call connect() on an already-connected instance.
 */
function createMcpServer(
  mediumTerm: MediumTermMemory,
  longTerm: LongTermMemory,
): Server {
  const server = new Server(
    { name: 'astra-memory', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  // --- List tools ---
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: 'memory_search',
        description:
          'Semantic search across all past conversations (Telegram + Slack). Use when the user references something from the past, asks "do you remember", or needs facts about themselves.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query text' },
            limit: { type: 'number', description: 'Max results (1-20)', default: 5 },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_user_profile',
        description:
          "Retrieve messages where the user introduced themselves (name, company, role, preferences). Use when you don't know who you're talking to or need user facts.",
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max results (1-20)', default: 10 },
          },
        },
      },
      {
        name: 'get_recent_messages',
        description:
          'Get recent conversation history for a specific channel. Use to load context for the current chat session.',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Channel ID to fetch messages for' },
            limit: { type: 'number', description: 'Max messages to return (1-50)', default: 10 },
            days: { type: 'number', description: 'How many days back to look (1-30)', default: 7 },
          },
          required: ['channelId'],
        },
      },
    ],
  }))

  // --- Call tool ---
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    try {
      if (name === 'memory_search') {
        const { query, limit } = MemorySearchArgs.parse(args ?? {})
        const vector = await embed(query)
        const results = await longTerm.searchByVector(vector, limit)

        const text = results
          .map((r) => {
            const date = r.message.timestamp.toISOString().split('T')[0]
            const channel = r.message.channelType
            const score = ` (relevance: ${r.score.toFixed(2)})`
            return `[${date}] [${channel}] [${r.message.role}]: ${r.message.text}${score}`
          })
          .join('\n')

        return {
          content: [{ type: 'text', text: text || 'No matching memories found.' }],
        }
      }

      if (name === 'get_user_profile') {
        const { limit } = GetUserProfileArgs.parse(args ?? {})
        const messages = await mediumTerm.getUserProfileMessages(limit)

        const text = messages
          .reverse() // oldest first
          .map((m) => `[${m.channelType}] ${m.text}`)
          .join('\n')

        return {
          content: [{ type: 'text', text: text || 'No user profile information found.' }],
        }
      }

      if (name === 'get_recent_messages') {
        const { channelId, limit, days } = GetRecentMessagesArgs.parse(args ?? {})
        const messages = await mediumTerm.getRecent(channelId, days, limit)

        const text = messages
          .reverse() // oldest first
          .map((m) => {
            const date = m.timestamp.toISOString().split('T')[0]
            return `[${date}] [${m.role}]: ${m.text}`
          })
          .join('\n')

        return {
          content: [{ type: 'text', text: text || 'No recent messages found.' }],
        }
      }

      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error({ error: msg, tool: name }, 'MCP tool error')
      return {
        content: [{ type: 'text', text: `Tool error: ${msg}` }],
        isError: true,
      }
    }
  })

  return server
}

/**
 * Create and start the MCP memory server.
 * Returns the HTTP server instance so the caller can close it on shutdown.
 *
 * The server exposes three memory tools to Claude:
 * - memory_search: semantic search across all stored messages (Qdrant)
 * - get_user_profile: retrieve self-introduction messages (PostgreSQL keyword search)
 * - get_recent_messages: retrieve recent conversation history for a channel (PostgreSQL)
 *
 * Uses the stateless pattern: a fresh MCP Server is created per HTTP request so
 * the SDK's single-connection constraint is never violated.
 */
export async function startMcpServer(): Promise<http.Server> {
  logger.info({ port: MCP_PORT }, 'Initializing MCP memory server')

  // Initialize embedder (may already be initialized by bot startup — idempotent)
  await initEmbedder()

  // Shared memory layer instances (reused across requests, stateless)
  const mediumTerm = new MediumTermMemory(db)
  const qdrantClient = new QdrantClient({ url: env.QDRANT_URL })
  const longTerm = new LongTermMemory(qdrantClient)

  // --- HTTP server ---
  const httpServer = http.createServer(async (req, res) => {
    // Reject non-/mcp paths
    if (req.url !== '/mcp') {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    // Only POST is used in stateless mode; reject GET/DELETE
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null,
        }),
      )
      return
    }

    try {
      // Create a fresh MCP server per request (stateless pattern required by SDK)
      const mcpServer = createMcpServer(mediumTerm, longTerm)

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      })

      res.on('close', () => {
        transport.close().catch((err: unknown) => {
          logger.warn({ error: err }, 'MCP transport close error')
        })
        mcpServer.close().catch((err: unknown) => {
          logger.warn({ error: err }, 'MCP server close error')
        })
      })

      await mcpServer.connect(transport)
      await transport.handleRequest(req, res)
    } catch (error) {
      logger.error({ error }, 'MCP HTTP handler error')
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }),
        )
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(MCP_PORT, '127.0.0.1', () => resolve())
    httpServer.once('error', reject)
  })

  logger.info({ port: MCP_PORT }, 'MCP memory server ready')
  return httpServer
}
