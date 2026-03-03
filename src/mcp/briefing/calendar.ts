import type { Source, BriefingRequest, BriefingItem } from './types.js'
import { jsonOrThrow } from './utils.js'

export async function fetchCalendar(
  req: BriefingRequest,
  period: { after: Date; before: Date },
  googleTokens: Map<string, string>,
): Promise<BriefingItem[]> {
  if (googleTokens.size === 0) throw new Error('Calendar: no Google accounts authorized')

  const results = await Promise.allSettled(
    [...googleTokens.entries()].map(([account, token]) =>
      fetchCalendarAccount(req, period, token, account),
    ),
  )

  const items: BriefingItem[] = []
  for (const r of results) {
    if (r.status === 'fulfilled') items.push(...r.value)
  }
  const limit = req.limit_per_source ?? 10
  return items.slice(0, limit)
}

async function fetchCalendarAccount(
  req: BriefingRequest,
  period: { after: Date; before: Date },
  accessToken: string,
  account: string,
): Promise<BriefingItem[]> {
  const headers = { Authorization: `Bearer ${accessToken}` }

  const limit = req.limit_per_source ?? 10
  const params = new URLSearchParams({
    timeMin: period.after.toISOString(),
    timeMax: period.before.toISOString(),
    maxResults: String(limit),
    singleEvents: 'true',
    orderBy: 'startTime',
  })

  if (req.search_term) params.set('q', req.search_term)

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  )
  const data = await jsonOrThrow<{
    items?: Array<{
      summary?: string
      start?: { dateTime?: string; date?: string }
      end?: { dateTime?: string; date?: string }
      attendees?: Array<{ email: string; responseStatus?: string }>
      htmlLink?: string
      status?: string
    }>
  }>(resp, `Calendar (${account})`)

  return (data.items ?? []).map(event => ({
    source: 'calendar' as Source,
    account,
    subject: event.summary ?? '(no title)',
    date: event.start?.dateTime ?? event.start?.date ?? '',
    end_date: event.end?.dateTime ?? event.end?.date ?? '',
    attendees: event.attendees?.map(a => a.email).join(', ') ?? '',
    status: event.status ?? '',
    links: event.htmlLink ? [event.htmlLink] : [],
  }))
}
