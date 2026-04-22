import { logger } from '../logging/logger.js'
import type { InboundMessage } from '../channels/types.js'
import type { Language } from '../brain/language.js'
import type { SkillRegistry } from './registry.js'
import type { Skill, SkillContext } from './types.js'

export interface SkillEngineResult {
  /** Prompt to send to Claude (original or enriched by skill) */
  prompt: string
  /** Extra instructions to append to the system prompt */
  systemPromptExtra?: string
  /** Matched skill (for post-processing after Claude responds) */
  skill?: Skill
  /** If true, router uses parallel subagent orchestration for deep research */
  investigation?: boolean
  /** If true, skip MCP tools — all needed data is already in the prompt */
  skipMcp?: boolean
}

export class SkillEngine {
  constructor(private readonly registry: SkillRegistry) {}

  /**
   * Process an inbound message through the skill pipeline.
   * 1. Match message to a skill by triggers
   * 2. If matched, run preProcess to enrich prompt + get extra system instructions
   * 3. Return result for the router to use
   */
  async process(message: InboundMessage, language: Language): Promise<SkillEngineResult> {
    const skill = this.registry.match(message.text)

    if (!skill) {
      logger.debug({ text: message.text.slice(0, 50) }, 'No skill matched, using default')
      return { prompt: message.text }
    }

    logger.info({ skill: skill.name }, 'Skill matched')

    const ctx: SkillContext = {
      message,
      language,
      channelId: message.channelId,
    }

    try {
      const result = await skill.preProcess(ctx)
      return {
        prompt: result.prompt,
        systemPromptExtra: result.systemPromptExtra,
        skill,
        investigation: result.investigation,
        skipMcp: result.skipMcp,
      }
    } catch (error) {
      logger.warn({ skill: skill.name, error }, 'Skill preProcess failed, falling back to default')
      return { prompt: message.text }
    }
  }

  /**
   * Run post-processing on Claude's response if the skill defines it.
   */
  async postProcess(response: string, skill: Skill | undefined, ctx: SkillContext): Promise<string> {
    if (!skill?.postProcess) return response

    try {
      return await skill.postProcess(response, ctx)
    } catch (error) {
      logger.warn({ skill: skill.name, error }, 'Skill postProcess failed, returning raw response')
      return response
    }
  }
}
