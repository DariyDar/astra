import type { Source, BriefingRequest, BriefingItem } from './types.js'
import { truncate, jsonOrThrow } from './utils.js'
import { toGmailDate } from './period.js'
import { resolveGoogleTokens } from './google-auth.js'

// ── Briefing fetcher ──

export async function fetchGmail(
  req: BriefingRequest,
  period: { after: Date; before: Date },
  googleTokens: Map<string, string>,
): Promise<BriefingItem[]> {
  if (googleTokens.size === 0) throw new Error('Gmail: no Google accounts authorized')

  const results = await Promise.allSettled(
    [...googleTokens.entries()].map(([account, token]) =>
      fetchGmailAccount(req, period, token, account),
    ),
  )

  const items: BriefingItem[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') items.push(...r.value)
  }
  const limit = req.limit_per_source ?? 10
  return items.slice(0, limit)
}

async function fetchGmailAccount(
  req: BriefingRequest,
  period: { after: Date; before: Date },
  accessToken: string,
  account: string,
): Promise<BriefingItem[]> {
  const headers = { Authorization: `Bearer ${accessToken}` }

  const queryParts: string[] = []
  if (req.query_type === 'unread') queryParts.push('is:unread')
  if (req.search_term) queryParts.push(req.search_term)
  queryParts.push(`after:${toGmailDate(period.after)}`)
  queryParts.push(`before:${toGmailDate(period.before)}`)

  const limit = req.limit_per_source ?? 10
  const params = new URLSearchParams({
    q: queryParts.join(' '),
    maxResults: String(limit),
  })

  const listResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  )
  const listData = await jsonOrThrow<{ messages?: Array<{ id: string }> }>(listResp, `Gmail list (${account})`)
  if (!listData.messages || listData.messages.length === 0) return []

  const msgResults = await Promise.allSettled(
    listData.messages.slice(0, limit).map(async (msg) => {
      const msgResp = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers, signal: AbortSignal.timeout(10_000) },
      )
      const msgData = await jsonOrThrow<{
        id: string
        snippet?: string
        payload?: { headers?: Array<{ name: string; value: string }> }
        labelIds?: string[]
      }>(msgResp, `Gmail message ${msg.id}`)

      const getHeader = (name: string) =>
        msgData.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''

      return {
        source: 'gmail' as Source,
        gmail_id: msgData.id,
        account,
        author: getHeader('From'),
        subject: getHeader('Subject'),
        date: getHeader('Date'),
        text_preview: truncate(msgData.snippet ?? '', 200),
        is_unread: msgData.labelIds?.includes('UNREAD') ?? false,
        link: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account)}#inbox/${msgData.id}`,
      }
    }),
  )

  const items: BriefingItem[] = []
  for (const r of msgResults) {
    if (r.status === 'fulfilled') items.push(r.value)
  }
  return items
}

// ── Full email content reader ──

export async function fetchEmailContent(
  messageId: string,
  account?: string,
): Promise<{ id: string; account: string; subject: string; from: string; date: string; body: string }> {
  if (!/^[a-zA-Z0-9]+$/.test(messageId)) throw new Error(`Invalid message ID format: "${messageId}"`)
  const googleTokens = await resolveGoogleTokens()
  if (googleTokens.size === 0) throw new Error('No Google accounts authorized')

  // If account specified, use it; otherwise try all accounts
  const accounts: Array<[string, string]> = account
    ? (googleTokens.has(account) ? [[account, googleTokens.get(account)!]] : [])
    : [...googleTokens.entries()]

  if (accounts.length === 0) {
    throw new Error(account ? `Account "${account}" not found or not authorized` : 'No Google accounts available')
  }

  for (const [acct, token] of accounts) {
    const headers = { Authorization: `Bearer ${token}` }
    const resp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
      { headers, signal: AbortSignal.timeout(15_000) },
    )
    if (resp.status === 404) continue
    const data = await jsonOrThrow<{
      id: string
      payload?: {
        headers?: Array<{ name: string; value: string }>
        body?: { data?: string }
        parts?: Array<{ mimeType?: string; body?: { data?: string }; parts?: Array<{ mimeType?: string; body?: { data?: string } }> }>
      }
    }>(resp, `Gmail message ${messageId}`)

    const getHeader = (name: string) =>
      data.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''

    // Extract body: try plain text first, then html
    let body = ''
    const payload = data.payload
    if (payload?.body?.data) {
      body = Buffer.from(payload.body.data, 'base64url').toString('utf-8')
    } else if (payload?.parts) {
      const textPart = findPart(payload.parts, 'text/plain') ?? findPart(payload.parts, 'text/html')
      if (textPart?.body?.data) {
        body = Buffer.from(textPart.body.data, 'base64url').toString('utf-8')
      }
    }

    // Strip HTML tags if we got text/html
    if (/<[a-zA-Z][^>]*>/.test(body)) {
      body = body.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/\s+/g, ' ')
        .trim()
    }

    return {
      id: data.id,
      account: acct,
      subject: getHeader('Subject'),
      from: getHeader('From'),
      date: getHeader('Date'),
      body: truncate(body, 5000),
    }
  }

  throw new Error(`Message "${messageId}" not found in any account`)
}

function findPart(
  parts: Array<{ mimeType?: string; body?: { data?: string }; parts?: Array<{ mimeType?: string; body?: { data?: string } }> }>,
  mimeType: string,
): { body?: { data?: string } } | undefined {
  for (const part of parts) {
    if (part.mimeType === mimeType && part.body?.data) return part
    if (part.parts) {
      const nested = findPart(part.parts, mimeType)
      if (nested) return nested
    }
  }
  return undefined
}

// ── Tool definition ──

export const getEmailContentTool = {
  name: 'get_email_content',
  description: `Get full email content by Gmail message ID. Returns subject, from, date, and body text.

Use this when briefing results show an email snippet and you need the full text.
The message ID comes from Gmail list results (the "id" field in briefing gmail results).`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      message_id: {
        type: 'string' as const,
        description: 'Gmail message ID',
      },
      account: {
        type: 'string' as const,
        description: 'Google account email (e.g. "dariy@astrocat.co"). If omitted, tries all accounts.',
      },
    },
    required: ['message_id'],
  },
}
