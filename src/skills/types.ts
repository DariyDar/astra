import type { InboundMessage } from '../channels/types.js'
import type { Language } from '../brain/language.js'

export interface SkillContext {
  message: InboundMessage
  language: Language
  channelId: string
}

export interface SkillResult {
  /** Enriched prompt to send to Claude (replaces original message text) */
  prompt: string
  /** Extra instructions appended to the system prompt for this skill */
  systemPromptExtra?: string
}

export interface Skill {
  /** Unique skill identifier */
  name: string
  /** One-line description for the system prompt catalog */
  description: string
  /** Lowercase keywords that activate this skill */
  triggers: string[]

  /** Enrich the prompt before sending to Claude */
  preProcess(ctx: SkillContext): Promise<SkillResult>

  /** Optional: transform or act on Claude's response */
  postProcess?(response: string, ctx: SkillContext): Promise<string>
}
