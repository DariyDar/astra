import { createHash } from 'node:crypto'

const DEFAULT_MAX_CHARS = 1000
const DEFAULT_OVERLAP = 100

/**
 * Split text into overlapping chunks for embedding.
 * Tries to break at sentence boundaries when possible.
 */
export function splitText(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS,
  overlap: number = DEFAULT_OVERLAP,
): string[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  if (trimmed.length <= maxChars) return [trimmed]

  const chunks: string[] = []
  let start = 0

  while (start < trimmed.length) {
    let end = Math.min(start + maxChars, trimmed.length)

    // Try to break at a sentence boundary (. ! ? \n) within last 20% of chunk
    if (end < trimmed.length) {
      const lookbackStart = Math.max(start + Math.floor(maxChars * 0.8), start)
      const segment = trimmed.slice(lookbackStart, end)
      const sentenceEnd = findLastSentenceBreak(segment)
      if (sentenceEnd >= 0) {
        end = lookbackStart + sentenceEnd + 1
      }
    }

    chunks.push(trimmed.slice(start, end).trim())
    start = Math.max(start + 1, end - overlap)
  }

  return chunks.filter((c) => c.length > 0)
}

function findLastSentenceBreak(text: string): number {
  // Look for sentence-ending punctuation followed by space or end
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]
    if ((ch === '.' || ch === '!' || ch === '?' || ch === '\n') && (i === text.length - 1 || text[i + 1] === ' ' || text[i + 1] === '\n')) {
      return i
    }
  }
  return -1
}

/** SHA-256 hash of text content for deduplication. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

// ── Source-specific formatters ──

/** Format a Slack message into a chunk-ready text. */
export function formatSlackMessage(msg: {
  user?: string
  text: string
  channel?: string
  ts?: string
}): string {
  const parts: string[] = []
  if (msg.channel) parts.push(`[#${msg.channel}]`)
  if (msg.user) parts.push(`${msg.user}:`)
  parts.push(msg.text)
  return parts.join(' ')
}

/** Format an email into chunk-ready text. */
export function formatEmail(email: {
  from?: string
  to?: string
  subject?: string
  body: string
  date?: string
}): string {
  const parts: string[] = []
  if (email.subject) parts.push(`Subject: ${email.subject}`)
  if (email.from) parts.push(`From: ${email.from}`)
  if (email.to) parts.push(`To: ${email.to}`)
  if (email.date) parts.push(`Date: ${email.date}`)
  parts.push('')
  parts.push(email.body)
  return parts.join('\n')
}

/** Format a ClickUp task into chunk-ready text. */
export function formatClickUpTask(task: {
  name: string
  description?: string
  status?: string
  assignees?: string[]
  list?: string
  comments?: string[]
}): string {
  const parts: string[] = []
  parts.push(`Task: ${task.name}`)
  if (task.list) parts.push(`List: ${task.list}`)
  if (task.status) parts.push(`Status: ${task.status}`)
  if (task.assignees?.length) parts.push(`Assignees: ${task.assignees.join(', ')}`)
  if (task.description) {
    parts.push('')
    parts.push(task.description)
  }
  if (task.comments?.length) {
    parts.push('')
    parts.push('Comments:')
    parts.push(...task.comments)
  }
  return parts.join('\n')
}

/** Format a calendar event into chunk-ready text. */
export function formatCalendarEvent(event: {
  summary: string
  description?: string
  start?: string
  end?: string
  attendees?: string[]
}): string {
  const parts: string[] = []
  parts.push(`Event: ${event.summary}`)
  if (event.start) parts.push(`Start: ${event.start}`)
  if (event.end) parts.push(`End: ${event.end}`)
  if (event.attendees?.length) parts.push(`Attendees: ${event.attendees.join(', ')}`)
  if (event.description) {
    parts.push('')
    parts.push(event.description)
  }
  return parts.join('\n')
}
