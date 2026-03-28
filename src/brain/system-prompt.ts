import { env } from '../config/env.js'
import type { Language } from './language.js'
import { loadPromptCached } from '../kb/vault-loader.js'

const LANGUAGE_LABELS: Record<Language, string> = {
  ru: 'Russian',
  en: 'English',
}

/**
 * Build the Google accounts section dynamically from GOOGLE_ACCOUNTS env var.
 * Returns a string like:
 *   \nHis authorized Google accounts:
 *   \n- dariy@astrocat.co
 *   \n- dshatskikh@highground.games
 */
function buildGoogleAccountsSection(): string {
  const raw = env.GOOGLE_ACCOUNTS
  if (!raw) return '\nHis authorized Google accounts:\n- dariy@astrocat.co'

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return '\nHis authorized Google accounts:\n- dariy@astrocat.co'
    }
    const accounts = parsed.filter((a): a is string => typeof a === 'string' && a.length > 0)
    if (accounts.length === 0) return '\nHis authorized Google accounts:\n- dariy@astrocat.co'
    const lines = accounts.map((a) => `- ${a}`).join('\n')
    return `\nHis authorized Google accounts:\n${lines}`
  } catch {
    return '\nHis authorized Google accounts:\n- dariy@astrocat.co'
  }
}

/**
 * Build the system prompt for Claude with Astra's persona and instructions.
 * Language-aware: instructs Claude to respond in the same language as the user.
 * Includes channelId so Claude can pass it to get_recent_messages tool.
 *
 * The prompt is kept compact (~500 tokens) to leave room for context and response.
 */
export function buildSystemPrompt(language: Language, channelId: string, knowledgeMap?: string): string {
  const langLabel = LANGUAGE_LABELS[language]

  const knowledgeSection = knowledgeMap
    ? `\n\n${knowledgeMap}`
    : ''

  // Moved to vault/prompts/system-prompt.md
  const template = loadPromptCached('prompts/system-prompt.md')
  return template
    .replace(/\{\{languageLabel\}\}/g, langLabel)
    .replace(/\{\{language\}\}/g, language)
    .replace(/\{\{googleAccounts\}\}/g, buildGoogleAccountsSection())
    .replace(/\{\{channelId\}\}/g, channelId)
    + knowledgeSection
}
