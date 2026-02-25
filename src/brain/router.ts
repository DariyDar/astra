import type { ChannelAdapter, InboundMessage, OutboundMessage } from '../channels/types.js'
import { callClaude } from '../llm/client.js'
import { createRequestLogger } from '../logging/correlation.js'
import { writeAuditEntry } from '../logging/audit.js'
import { logger } from '../logging/logger.js'
import { embed } from '../memory/embedder.js'
import type { LongTermMemory } from '../memory/long-term.js'
import type { MediumTermMemory } from '../memory/medium-term.js'
import type { ShortTermMemory } from '../memory/short-term.js'
import type { StoredMessage } from '../memory/types.js'
import type { NotificationPreferences } from '../notifications/preferences.js'
import type { UrgencyLevel } from '../notifications/urgency.js'
import { buildContext, type CrossChannelConfig } from './context-builder.js'
import { detectLanguage } from './language.js'
import { buildSystemPrompt } from './system-prompt.js'

/** Regex to match <preference_update>...</preference_update> tags in Claude responses */
const PREFERENCE_UPDATE_RE = /<preference_update>\s*([\s\S]*?)\s*<\/preference_update>/g

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
  longTerm: LongTermMemory
  adapters: ChannelAdapter[]
  preferences?: NotificationPreferences
  /**
   * Cross-channel context map: for each channel type, the other platform's config.
   * Enables Astra to remember conversations across Telegram and Slack.
   * Key: 'telegram' | 'slack', Value: CrossChannelConfig for the other platform.
   */
  crossChannelMap?: Map<'telegram' | 'slack', CrossChannelConfig>
}

/**
 * Central message processing engine.
 * Connects channel adapters to the Claude brain through the three-tier memory system.
 * Handles language detection, context assembly, LLM invocation, and memory storage.
 */
export class MessageRouter {
  private readonly shortTerm: ShortTermMemory
  private readonly mediumTerm: MediumTermMemory
  private readonly longTerm: LongTermMemory
  private readonly adapters: ChannelAdapter[]
  private readonly preferences?: NotificationPreferences
  private readonly crossChannelMap?: Map<'telegram' | 'slack', CrossChannelConfig>

  constructor(config: MessageRouterConfig) {
    this.shortTerm = config.shortTerm
    this.mediumTerm = config.mediumTerm
    this.longTerm = config.longTerm
    this.adapters = config.adapters
    this.preferences = config.preferences
    this.crossChannelMap = config.crossChannelMap
  }

  /**
   * Process an incoming message through the full pipeline:
   * 1. Detect language
   * 2. Build context from three-tier memory
   * 3. Build language-aware system prompt
   * 4. Call Claude with context
   * 5. Store user message and assistant response in all memory tiers
   * 6. Return outbound message
   */
  async process(message: InboundMessage): Promise<OutboundMessage> {
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

    // 2. Build context from memory (with cross-platform context if configured)
    const crossChannel = this.crossChannelMap?.get(message.channelType)
    const context = await buildContext(
      message,
      this.shortTerm,
      this.mediumTerm,
      this.longTerm,
      crossChannel,
    )

    // 3. Build system prompt
    const systemPrompt = buildSystemPrompt(language)
    const systemWithContext = context
      ? `${systemPrompt}\n\n---\n\n${context}`
      : systemPrompt

    // 4. Call Claude
    const response = await callClaude(
      message.text,
      { system: systemWithContext },
      requestLogger,
    )

    requestLogger.info(
      { responseLength: response.text.length },
      'Claude response received',
    )

    // 4b. Process preference updates from Claude's response (if preferences wired)
    let responseText = response.text
    if (this.preferences) {
      responseText = await this.processPreferenceUpdates(
        responseText,
        message.userId,
        requestLogger,
      )
    }

    // 5. Store user message in all three tiers
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

    // 6. Store assistant response in all three tiers
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

    // 7. Write audit entry for the exchange
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
      },
      status: 'success',
    })

    // 8. Return outbound message
    // Pass through inbound metadata (e.g. Slack placeholderTs for typing indicator update)
    return {
      channelType: message.channelType,
      channelId: message.channelId,
      text: responseText,
      replyToMessageId: message.id,
      ...(message.metadata ? { metadata: message.metadata } : {}),
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
      { adapterCount: this.adapters.length },
      'Message router started',
    )
  }

  /**
   * Stop all adapters.
   */
  async stop(): Promise<void> {
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
              : 'Sorry, something went wrong. I\'ll try again.'

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

    // Long-term (Qdrant) - fire-and-forget
    this.storeLongTerm(message, requestLogger).catch((error) => {
      requestLogger.warn(
        { error, role: message.role },
        'Failed to store message in long-term memory',
      )
    })
  }

  /**
   * Embed and store a message in long-term (Qdrant) memory.
   * Separated for fire-and-forget error handling.
   */
  private async storeLongTerm(
    message: StoredMessage,
    requestLogger: ReturnType<typeof createRequestLogger>,
  ): Promise<void> {
    const vector = await embed(message.text)
    await this.longTerm.store(message, vector)
    requestLogger.debug(
      { role: message.role },
      'Message stored in long-term memory',
    )
  }
}
