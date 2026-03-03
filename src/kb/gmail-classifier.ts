/**
 * Gmail email classifier — determines if an email is system-generated or human.
 *
 * System emails: TestFlight, App Store, Clockify, Google notifications, etc.
 * Keep-senders: Indium QA (Nisha, Jijo), Tilting Point EOD (Andrianne) — tagged human.
 *
 * Patterns validated against real data (2026-03-04):
 *   TestFlight/AppStore: no_reply@email.apple.com (underscore, not hyphen)
 *   Clockify: clockify@mail.cake.com
 *   Google Play: noreply-play-developer-console@google.com
 *   Atlassian: info@e.atlassian.com, confluence@tiltingpoint.atlassian.net
 *   Indium QA: nisha.ubaid@indium.tech, jijo.m@indium.tech
 *   Tilting Point EOD: agamulo@tiltingpoint.com (Andrianne Gamulo)
 */

/** Case-insensitive partial-match patterns on From header for system senders. */
export const SYSTEM_PATTERNS: string[] = [
  // Generic noreply variations: noreply@, no-reply@, no_reply@, noreply-*@
  'noreply',
  'no-reply',
  'no_reply',
  // Apple
  'testflight',
  'appstoreconnect',
  'developer@insideapple.apple.com',
  'developer@email.apple.com',
  // Clockify
  'clockify@',
  '@clockify.',
  // Google system
  'noreply-analytics@google',
  'comments-noreply@docs.google.com',
  'spaces-noreply@google.com',
  'mailer-daemon@',
  // Atlassian (covers both .com and .net domains)
  'atlassian',
  'confluence@',
  // Service notifications
  'clickup.com',
  'pagerduty.com',
  'feedback@slack.com',
  'feedback@mail.slack.com',
  '@email.slackhq.com',
  // Marketing/system misc
  'usercentrics.com',
  'hidemy.name',
]

/**
 * Senders that MUST be classified as human even if they match system patterns.
 * Matched against the full From header (display name + email address).
 */
export const KEEP_SENDERS: string[] = [
  // Indium QA reports — nisha.ubaid@indium.tech, jijo.m@indium.tech
  '@indium.tech',
  // Tilting Point EOD reports — agamulo@tiltingpoint.com (Andrianne Gamulo)
  'agamulo@tiltingpoint',
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
