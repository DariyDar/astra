/**
 * Gmail email classifier — determines if an email is system-generated or human.
 *
 * System emails: TestFlight, App Store, Clockify, Google notifications, etc.
 * Keep-senders: Indium QA (Nisha, Jijo), Tilting Point EOD (Andrianne) — tagged human.
 */

/** Case-insensitive partial-match patterns on From header for system senders. */
export const SYSTEM_PATTERNS: string[] = [
  'noreply@',
  'no-reply@',
  'testflight@apple.com',
  'appstoreconnect@apple.com',
  'clockify',
  'noreply@google',
  'atlassian',
  'clickup',
  'pagerduty',
  'comments-noreply@docs.google.com',
  'spaces-noreply@google.com',
  'feedback@mail.slack.com',
]

/**
 * Senders that match system patterns but MUST be classified as human.
 * Partial matches on From header (case-insensitive).
 */
export const KEEP_SENDERS: string[] = [
  'nisha',
  'jijo',
  'andrianne',
]

/**
 * Classify an email as system or human based on the From header.
 *
 * Priority:
 * 1. KEEP_SENDERS override — always human
 * 2. SYSTEM_PATTERNS — system
 * 3. Slack weekly digest special case — system
 * 4. Default — human
 */
export function classifyEmail(from: string, subject?: string): 'system' | 'human' {
  const fromLower = from.toLowerCase()

  // Keep-senders take priority (Indium QA, Tilting Point reports)
  if (KEEP_SENDERS.some((k) => fromLower.includes(k))) return 'human'

  // Check system sender patterns
  if (SYSTEM_PATTERNS.some((p) => fromLower.includes(p))) return 'system'

  // Special case: Slack weekly digest (from contains slack + subject contains weekly)
  if (fromLower.includes('slack') && subject && subject.toLowerCase().includes('weekly')) {
    return 'system'
  }

  return 'human'
}
