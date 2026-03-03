import { resolveGoogleTokens } from '../../mcp/briefing/google-auth.js'
import { jsonOrThrow } from '../../mcp/briefing/utils.js'
import { formatCalendarEvent, splitText } from '../chunker.js'
import type { KBChunkInput } from '../types.js'
import type { SourceAdapter, RawItem } from './types.js'
import { logger } from '../../logging/logger.js'

const INITIAL_LOOKBACK_DAYS = 90

interface CalendarEvent {
  id: string
  summary?: string
  description?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  attendees?: Array<{ email: string; displayName?: string }>
  updated?: string
}

/** Creates one CalendarIngestionAdapter per Google account. */
export async function createCalendarAdapters(): Promise<SourceAdapter[]> {
  const tokens = await resolveGoogleTokens()
  if (tokens.size === 0) return []

  return [...tokens.entries()].map(([account, token]) => ({
    name: `calendar:${account}`,
    source: 'calendar' as const,

    async fetchSince(watermark: string): Promise<{ items: RawItem[]; nextWatermark: string }> {
      const freshTokens = await resolveGoogleTokens()
      const accessToken = freshTokens.get(account)
      if (!accessToken) throw new Error(`Calendar: no token for ${account}`)

      const headers = { Authorization: `Bearer ${accessToken}` }

      const timeMin = watermark
        ? new Date(watermark).toISOString()
        : new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 86400_000).toISOString()

      const params = new URLSearchParams({
        timeMin,
        maxResults: '250',
        singleEvents: 'true',
        orderBy: 'startTime',
      })

      const resp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
        { headers, signal: AbortSignal.timeout(15_000) },
      )
      const data = await jsonOrThrow<{ items?: CalendarEvent[] }>(resp, 'Calendar events')

      const items: RawItem[] = []
      let maxDate = watermark || timeMin

      for (const event of data.items ?? []) {
        if (!event.summary) continue

        const startStr = event.start?.dateTime ?? event.start?.date ?? ''
        const eventDate = startStr ? new Date(startStr) : new Date()

        if (eventDate.toISOString() > maxDate) maxDate = eventDate.toISOString()

        items.push({
          id: `${account}:${event.id}`,
          text: event.description ?? '',
          metadata: {
            account,
            summary: event.summary,
            start: startStr,
            end: event.end?.dateTime ?? event.end?.date ?? '',
            attendees: (event.attendees ?? []).map((a) => a.displayName ?? a.email),
          },
          date: eventDate,
        })
      }

      logger.info({ account, events: items.length }, 'Calendar ingestion complete')
      return { items, nextWatermark: maxDate }
    },

    toChunks(item: RawItem): KBChunkInput[] {
      const text = formatCalendarEvent({
        summary: item.metadata.summary as string,
        description: item.text || undefined,
        start: item.metadata.start as string,
        end: item.metadata.end as string,
        attendees: item.metadata.attendees as string[],
      })

      if (text.trim().length === 0) return []

      const chunks = splitText(text)
      return chunks.map((chunkText, i) => ({
        source: 'calendar' as const,
        sourceId: item.id,
        chunkIndex: i,
        text: chunkText,
        chunkType: 'event' as const,
        metadata: item.metadata,
        sourceDate: item.date,
      }))
    },
  }))
}
