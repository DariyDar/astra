import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChannelAdapter, InboundMessage, OutboundMessage } from '../channels/types.js'
import { callClaude } from '../llm/client.js'
import { createRequestLogger } from '../logging/correlation.js'
import { writeAuditEntry } from '../logging/audit.js'
import { logger } from '../logging/logger.js'
import type { MediumTermMemory } from '../memory/medium-term.js'
import type { ShortTermMemory } from '../memory/short-term.js'
import type { StoredMessage } from '../memory/types.js'
import type { NotificationPreferences } from '../notifications/preferences.js'
import type { UrgencyLevel } from '../notifications/urgency.js'
import { SkillEngine } from '../skills/engine.js'
import type { SkillEngineResult } from '../skills/engine.js'
import type { SkillRegistry } from '../skills/registry.js'
import { buildRecentContext } from './context-builder.js'
import { detectLanguage } from './language.js'
import { buildSystemPrompt } from './system-prompt.js'
import { getKnowledgeMap } from '../kb/vault-reader.js'
import { runInvestigation } from './investigation.js'

/** Regex to match <preference_update>...</preference_update> tags in Claude responses */
const PREFERENCE_UPDATE_RE = /<preference_update>\s*([\s\S]*?)\s*<\/preference_update>/g

// Path to the static MCP config file (relative to this file's location)
const MCP_CONFIG_PATH = resolve(
  fileURLToPath(import.meta.url),
  '../../mcp/mcp-config.json',
)

interface PreferenceUpdateAction {
  action: 'set' | 'setEnabled'
  category: string
  urgencyLevel?: UrgencyLevel
  deliveryChannel?: 'telegram' | 'slack'
  enabled?: boolean
}

interface MessageRouterConfig {
  shortTerm: ShortTermMemory
  mediumTerm: MediumTermMemory
  adapters: ChannelAdapter[]
  preferences?: NotificationPreferences
  /** Whether to enable MCP memory tools for Claude (requires MCP server running on port 3100) */
  mcpEnabled?: boolean
  /** Skill registry for dynamic skill matching and execution */
  skillRegistry?: SkillRegistry
}

/**
 * Central message processing engine.
 * Connects channel adapters to the Claude brain through the three-tier memory system.
 * Handles language detection, context assembly, LLM invocation, and memory storage.
 *
 * When mcpEnabled is true, Claude gets access to memory tools via MCP and
 * fetches what it needs on demand instead of receiving a pre-loaded context dump.
 */
export class MessageRouter {
  private readonly shortTerm: ShortTermMemory
  private readonly mediumTerm: MediumTermMemory
  private readonly adapters: ChannelAdapter[]
  private readonly preferences?: NotificationPreferences
  private readonly mcpEnabled: boolean
  private readonly skillEngine?: SkillEngine
  private inFlightCount = 0
  private shuttingDown = false

  constructor(config: MessageRouterConfig) {
    this.shortTerm = config.shortTerm
    this.mediumTerm = config.mediumTerm
    this.adapters = config.adapters
    this.preferences = config.preferences
    this.mcpEnabled = config.mcpEnabled ?? false
    this.skillEngine = config.skillRegistry ? new SkillEngine(config.skillRegistry) : undefined
  }

  /**
   * Process an incoming message through the full pipeline:
   * 1. Detect language
   * 2. Build compact recent context (short-term only)
   * 3. Build language-aware system prompt with channelId and tool guidance
   * 4. Call Claude with MCP config (tools available on demand)
   * 5. Store user message and assistant response in all memory tiers
   * 6. Return outbound message
   */
  async process(message: InboundMessage): Promise<OutboundMessage> {
    if (this.shuttingDown) {
      const language = detectLanguage(message.text)
      throw new Error(language === 'ru'
        ? 'Перезагрузка, подожди пару секунд.'
        : 'Restarting, please wait a few seconds.')
    }

    this.inFlightCount++
    try {
      return await this.processInternal(message)
    } finally {
      this.inFlightCount--
    }
  }

  private async processInternal(message: InboundMessage): Promise<OutboundMessage> {
    const requestLogger = createRequestLogger({
      userId: message.userId,
      action: 'message_processing',
      source: message.channelType,
    })

    const correlationId =
      (requestLogger.bindings() as { correlationId: string }).correlationId

    requestLogger.info(
      {
        channelId: message.channelId,
        textLength: message.text.length,
      },
      'Processing incoming message',
    )

    // 1. Detect language
    const language = detectLanguage(message.text)
    requestLogger.debug({ language }, 'Language detected')

    // 2. Build compact recent context from Redis (current session only)
    const recentContext = await buildRecentContext(message, this.shortTerm)

    // 3. Run through skill engine (match + preProcess)
    const skillResult: SkillEngineResult = this.skillEngine
      ? await this.skillEngine.process(message, language)
      : { prompt: message.text }

    if (skillResult.skill) {
      requestLogger.info({ skill: skillResult.skill.name }, 'Skill matched for message')
    }

    // 4. Build system prompt with channelId, knowledge map, and skill-specific extra
    const knowledgeMap = this.mcpEnabled ? getKnowledgeMap() : undefined
    const systemPrompt = buildSystemPrompt(language, message.channelId, knowledgeMap)
    let fullSystem = systemPrompt
    if (skillResult.systemPromptExtra) {
      fullSystem += `\n\n${skillResult.systemPromptExtra}`
    }
    if (recentContext) {
      fullSystem += `\n\n---\n\n${recentContext}`
    }

    // 5. Call Claude — investigation (parallel subagents) or single call
    let response
    if (skillResult.investigation && this.mcpEnabled && knowledgeMap) {
      requestLogger.info('Using investigation subagents')
      response = await runInvestigation(
        skillResult.prompt,
        {
          mcpConfigPath: MCP_CONFIG_PATH,
          knowledgeMap,
          language,
          channelId: message.channelId,
          recentContext,
        },
        requestLogger,
      )
    } else {
      const useMcp = this.mcpEnabled && !skillResult.skipMcp
      response = await callClaude(
        skillResult.prompt,
        {
          system: fullSystem,
          ...(useMcp ? { mcpConfigPath: MCP_CONFIG_PATH, maxTurns: 15 } : {}),
        },
        requestLogger,
      )
    }

    requestLogger.info(
      { responseLength: response.text.length, investigation: !!skillResult.investigation },
      'Claude response received',
    )

    // 5b. Run skill post-processing if skill was matched
    let responseText = response.text
    if (this.skillEngine && skillResult.skill) {
      responseText = await this.skillEngine.postProcess(
        responseText,
        skillResult.skill,
        { message, language, channelId: message.channelId },
      )
    }

    // 5c. Process preference updates from Claude's response (if preferences wired)
    if (this.preferences) {
      responseText = await this.processPreferenceUpdates(
        responseText,
        message.userId,
        requestLogger,
      )
    }

    // 6. Store user message in all three tiers
    const userStored: StoredMessage = {
      id: message.id,
      channelType: message.channelType,
      channelId: message.channelId,
      userId: message.userId,
      role: 'user',
      text: message.text,
      language,
      timestamp: message.timestamp,
    }

    await this.storeMessage(userStored, requestLogger)

    // 7. Store assistant response in all three tiers
    const assistantStored: StoredMessage = {
      id: `${message.id}-response`,
      channelType: message.channelType,
      channelId: message.channelId,
      userId: 'assistant',
      role: 'assistant',
      text: responseText,
      language,
      timestamp: new Date(),
    }

    await this.storeMessage(assistantStored, requestLogger)

    // 8. Write audit entry for the exchange
    await writeAuditEntry({
      correlationId,
      userId: message.userId,
      action: 'message_exchange',
      source: message.channelType,
      metadata: {
        language,
        userTextLength: message.text.length,
        responseTextLength: responseText.length,
        channelId: message.channelId,
        mcpEnabled: this.mcpEnabled,
        ...(skillResult.skill ? { skill: skillResult.skill.name } : {}),
      },
      status: 'success',
    })

    // 9. Return outbound message
    // Pass through inbound metadata (e.g. Slack placeholderTs for typing indicator update)
    return {
      channelType: message.channelType,
      channelId: message.channelId,
      text: responseText,
      replyToMessageId: message.id,
      ...(message.metadata ? { metadata: message.metadata } : {}),
      usage: response.usage,
    }
  }

  /**
   * Register message handlers on all adapters and start them.
   */
  async start(): Promise<void> {
    this.registerAdapters()

    for (const adapter of this.adapters) {
      await adapter.start()
    }

    logger.info(
      { adapterCount: this.adapters.length, mcpEnabled: this.mcpEnabled },
      'Message router started',
    )
  }

  /**
   * Stop all adapters, waiting for in-flight requests to complete.
   * New messages received during shutdown get a "restarting" error.
   * Waits up to 30s for in-flight Claude requests, then force-stops.
   */
  async stop(): Promise<void> {
    this.shuttingDown = true

    // Stop adapters first — no new messages will arrive
    for (const adapter of this.adapters) {
      try {
        await adapter.stop()
      } catch (error) {
        logger.error(
          { error, channelType: adapter.channelType },
          'Error stopping adapter',
        )
      }
    }

    logger.info({ inFlightCount: this.inFlightCount }, 'Adapters stopped, waiting for in-flight requests')

    // Wait for in-flight requests to complete (poll every 500ms, max 30s)
    const maxWaitMs = 30_000
    const pollMs = 500
    let waited = 0
    while (this.inFlightCount > 0 && waited < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollMs))
      waited += pollMs
      if (waited % 5000 === 0) {
        logger.info({ inFlightCount: this.inFlightCount, waitedMs: waited }, 'Still waiting for in-flight requests')
      }
    }

    if (this.inFlightCount > 0) {
      logger.warn({ inFlightCount: this.inFlightCount }, 'Force-stopping with in-flight requests still pending')
    }

    logger.info('Message router stopped')
  }

  /**
   * Register onMessage handlers on each adapter.
   * The handler processes the message and sends the response back.
   */
  private registerAdapters(): void {
    for (const adapter of this.adapters) {
      adapter.onMessage(async (message: InboundMessage) => {
        try {
          const response = await this.process(message)
          await adapter.send(response)
        } catch (error) {
          logger.error(
            {
              error,
              channelType: message.channelType,
              channelId: message.channelId,
            },
            'Error processing message',
          )

          // Send user-friendly error message
          const language = detectLanguage(message.text)
          const errorText =
            language === 'ru'
              ? 'Извини, что-то пошло не так. Попробую ещё раз.'
              : "Sorry, something went wrong. I'll try again."

          try {
            await adapter.send({
              channelType: message.channelType,
              channelId: message.channelId,
              text: errorText,
            })
          } catch (sendError) {
            logger.error(
              { error: sendError, channelId: message.channelId },
              'Failed to send error message to user',
            )
          }
        }
      })
    }
  }

  /**
   * Scan Claude's response for <preference_update> tags and execute them.
   * Strips the tags from the response so the user only sees the natural language confirmation.
   */
  private async processPreferenceUpdates(
    responseText: string,
    userId: string,
    requestLogger: ReturnType<typeof createRequestLogger>,
  ): Promise<string> {
    if (!this.preferences) return responseText

    let cleaned = responseText
    const matches = [...responseText.matchAll(PREFERENCE_UPDATE_RE)]

    for (const match of matches) {
      try {
        const json = match[1].trim()
        const parsed = JSON.parse(json) as PreferenceUpdateAction

        if (parsed.action === 'set' && parsed.category && parsed.urgencyLevel && parsed.deliveryChannel) {
          await this.preferences.set(userId, parsed.category, parsed.urgencyLevel, parsed.deliveryChannel)
          requestLogger.info(
            { action: 'set', category: parsed.category, urgencyLevel: parsed.urgencyLevel, deliveryChannel: parsed.deliveryChannel },
            'Preference updated via natural language',
          )
        } else if (parsed.action === 'setEnabled' && parsed.category && parsed.enabled !== undefined) {
          await this.preferences.setEnabled(userId, parsed.category, parsed.enabled)
          requestLogger.info(
            { action: 'setEnabled', category: parsed.category, enabled: parsed.enabled },
            'Preference enabled/disabled via natural language',
          )
        } else {
          requestLogger.warn({ parsed }, 'Unknown preference update action format')
        }
      } catch (error) {
        requestLogger.warn(
          { error, rawTag: match[0] },
          'Failed to parse preference_update tag',
        )
      }

      // Strip the tag from the response
      cleaned = cleaned.replace(match[0], '')
    }

    // Clean up extra whitespace from tag removal
    return cleaned.replace(/\n{3,}/g, '\n\n').trim()
  }

  /**
   * Store a message in all three memory tiers.
   * Short-term and medium-term are synchronous (awaited).
   * Long-term is fire-and-forget (embed + store, don't block response).
   */
  private async storeMessage(
    message: StoredMessage,
    requestLogger: ReturnType<typeof createRequestLogger>,
  ): Promise<void> {
    // Short-term (Redis) - synchronous
    try {
      await this.shortTerm.store(message.channelId, message)
    } catch (error) {
      requestLogger.warn(
        { error, role: message.role },
        'Failed to store message in short-term memory',
      )
    }

    // Medium-term (PostgreSQL) - synchronous
    try {
      await this.mediumTerm.store(message)
    } catch (error) {
      requestLogger.warn(
        { error, role: message.role },
        'Failed to store message in medium-term memory',
      )
    }

  }
}
