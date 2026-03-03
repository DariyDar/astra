import { resolveGoogleTokens } from '../../mcp/briefing/google-auth.js'
import { toGmailDate } from '../../mcp/briefing/period.js'
import { jsonOrThrow } from '../../mcp/briefing/utils.js'
import { formatEmail, splitText } from '../chunker.js'
import type { KBChunkInput } from '../types.js'
import type { SourceAdapter, RawItem } from './types.js'
import { logger } from '../../logging/logger.js'

const INITIAL_LOOKBACK_DAYS = 90
const MESSAGES_PER_PAGE = 100

interface GmailPart {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailPart[]
}

interface GmailMessage {
  id: string
  payload?: {
    headers?: Array<{ name: string; value: string }>
    body?: { data?: string }
    parts?: GmailPart[]
  }
  internalDate?: string
}

function getHeader(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function extractBody(msg: GmailMessage): string {
  // Try top-level body first
  if (msg.payload?.body?.data) {
    return decodeBase64Url(msg.payload.body.data)
  }
  // Search parts for text/plain
  const plain = findPart(msg.payload?.parts, 'text/plain')
  if (plain) return decodeBase64Url(plain)
  // Fallback to text/html, strip tags
  const html = findPart(msg.payload?.parts, 'text/html')
  if (html) return stripHtml(decodeBase64Url(html))
  return ''
}

function findPart(parts: GmailPart[] | undefined, mimeType: string): string | null {
  if (!parts) return null
  for (const part of parts) {
    if (part.mimeType === mimeType && part.body?.data) return part.body.data
    if (part.parts) {
      const nested = findPart(part.parts, mimeType)
      if (nested) return nested
    }
  }
  return null
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64, 'base64').toString('utf-8')
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#?\w+;/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Creates one GmailIngestionAdapter per Google account. */
export async function createGmailAdapters(): Promise<SourceAdapter[]> {
  const tokens = await resolveGoogleTokens()
  if (tokens.size === 0) return []

  return [...tokens.entries()].map(([account, token]) => ({
    name: `gmail:${account}`,
    source: 'gmail' as const,

    async fetchSince(watermark: string): Promise<{ items: RawItem[]; nextWatermark: string }> {
      // Re-resolve token (might have expired)
      const freshTokens = await resolveGoogleTokens()
      const accessToken = freshTokens.get(account)
      if (!accessToken) throw new Error(`Gmail: no token for ${account}`)

      const headers = { Authorization: `Bearer ${accessToken}` }

      const afterDate = watermark
        ? new Date(watermark)
        : new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 86400_000)

      const q = `after:${toGmailDate(afterDate)}`
      const items: RawItem[] = []
      let pageToken: string | undefined
      let maxDate = afterDate.toISOString()

      do {
        const params = new URLSearchParams({ q, maxResults: String(MESSAGES_PER_PAGE) })
        if (pageToken) params.set('pageToken', pageToken)

        const listResp = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
          { headers, signal: AbortSignal.timeout(15_000) },
        )
        const listData = await jsonOrThrow<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(listResp, 'Gmail list')

        if (!listData.messages || listData.messages.length === 0) break

        // Fetch message details in batches of 10
        for (let i = 0; i < listData.messages.length; i += 10) {
          const batch = listData.messages.slice(i, i + 10)
          const msgResults = await Promise.allSettled(
            batch.map(async (m) => {
              const resp = await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
                { headers, signal: AbortSignal.timeout(15_000) },
              )
              return jsonOrThrow<GmailMessage>(resp, `Gmail message ${m.id}`)
            }),
          )

          for (const r of msgResults) {
            if (r.status !== 'fulfilled') continue
            const msg = r.value

            const body = extractBody(msg)
            if (!body || body.trim().length === 0) continue

            const date = msg.internalDate
              ? new Date(Number(msg.internalDate))
              : new Date()

            if (date.toISOString() > maxDate) maxDate = date.toISOString()

            items.push({
              id: `${account}:${msg.id}`,
              text: body,
              metadata: {
                account,
                gmail_id: msg.id,
                from: getHeader(msg, 'from'),
                to: getHeader(msg, 'to'),
                subject: getHeader(msg, 'subject'),
              },
              date,
            })
          }
        }

        pageToken = listData.nextPageToken
      } while (pageToken)

      logger.info({ account, messages: items.length }, 'Gmail ingestion complete')
      return { items, nextWatermark: maxDate }
    },

    toChunks(item: RawItem): KBChunkInput[] {
      const text = formatEmail({
        from: item.metadata.from as string,
        to: item.metadata.to as string,
        subject: item.metadata.subject as string,
        body: item.text,
        date: item.date?.toISOString(),
      })

      const chunks = splitText(text)
      return chunks.map((chunkText, i) => ({
        source: 'gmail' as const,
        sourceId: item.id,
        chunkIndex: i,
        text: chunkText,
        chunkType: 'email' as const,
        metadata: item.metadata,
        sourceDate: item.date,
      }))
    },
  }))
}
