/**
 * Language detection for Russian/English text.
 * Uses Cyrillic character ratio heuristic -- simple and sufficient
 * for the two-language use case without external dependencies.
 */

const CYRILLIC_REGEX = /[\u0400-\u04FF]/g
const LATIN_REGEX = /[a-zA-Z]/g

export type Language = 'ru' | 'en'

export function detectLanguage(text: string): Language {
  const cyrillicCount = (text.match(CYRILLIC_REGEX) || []).length
  const latinCount = (text.match(LATIN_REGEX) || []).length
  return cyrillicCount > latinCount ? 'ru' : 'en'
}
