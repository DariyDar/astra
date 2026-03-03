import { jsonOrThrow } from '../../mcp/briefing/utils.js'
import { splitText } from '../chunker.js'
import type { KBChunkInput } from '../types.js'
import type { SourceAdapter, RawItem } from './types.js'
import { logger } from '../../logging/logger.js'

const NOTION_API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const RATE_LIMIT_MS = 350  // Notion: 3 req/sec → ~333ms between requests

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface NotionPage {
  id: string
  properties: Record<string, { title?: Array<{ plain_text: string }> }>
  last_edited_time: string
  url: string
}

interface NotionBlock {
  type: string
  [key: string]: unknown
}

function extractBlockText(block: NotionBlock): string {
  const type = block.type
  const content = block[type] as { rich_text?: Array<{ plain_text: string }> } | undefined
  if (!content?.rich_text) return ''
  return content.rich_text.map((rt) => rt.plain_text).join('')
}

export function createNotionAdapter(): SourceAdapter | null {
  const token = process.env.NOTION_TOKEN
  if (!token) return null

  const headers = {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  }

  return {
    name: 'notion',
    source: 'notion' as const,

    async fetchSince(watermark: string): Promise<{ items: RawItem[]; nextWatermark: string }> {
      const filter: Record<string, unknown> = {}
      if (watermark) {
        filter.filter = {
          timestamp: 'last_edited_time',
          last_edited_time: { after: watermark },
        }
      }

      const items: RawItem[] = []
      let cursor: string | undefined
      let maxDate = watermark || ''

      // Search all pages
      do {
        await sleep(RATE_LIMIT_MS)

        const body: Record<string, unknown> = { ...filter, page_size: 100 }
        if (cursor) body.start_cursor = cursor

        const resp = await fetch(`${NOTION_API}/search`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        })
        const data = await jsonOrThrow<{
          results: Array<NotionPage & { object: string }>
          next_cursor?: string | null
          has_more: boolean
        }>(resp, 'Notion search')

        for (const page of data.results) {
          if (page.object !== 'page') continue

          try {
            await sleep(RATE_LIMIT_MS)

            // Fetch page blocks (content)
            const blocksResp = await fetch(
              `${NOTION_API}/blocks/${page.id}/children?page_size=100`,
              { headers, signal: AbortSignal.timeout(15_000) },
            )
            const blocksData = await jsonOrThrow<{ results: NotionBlock[] }>(blocksResp, `Notion blocks ${page.id}`)

            const blockTexts = blocksData.results.map(extractBlockText).filter((t) => t.length > 0)
            const text = blockTexts.join('\n')
            if (text.trim().length === 0) continue

            // Extract title
            const titleProp = Object.values(page.properties).find((p) => p.title)
            const title = titleProp?.title?.map((t) => t.plain_text).join('') ?? 'Untitled'

            const editedAt = new Date(page.last_edited_time)
            if (page.last_edited_time > maxDate) maxDate = page.last_edited_time

            items.push({
              id: `notion:${page.id}`,
              text,
              metadata: {
                title,
                url: page.url,
                lastEdited: page.last_edited_time,
              },
              date: editedAt,
            })
          } catch (error) {
            logger.warn({ pageId: page.id, error }, 'Notion page ingestion failed, continuing')
          }
        }

        cursor = data.next_cursor ?? undefined
      } while (cursor)

      logger.info({ pages: items.length }, 'Notion ingestion complete')
      return { items, nextWatermark: maxDate || new Date().toISOString() }
    },

    toChunks(item: RawItem): KBChunkInput[] {
      const header = `Page: ${item.metadata.title as string}\n`
      const chunks = splitText(header + item.text)

      return chunks.map((chunkText, i) => ({
        source: 'notion' as const,
        sourceId: item.id,
        chunkIndex: i,
        text: chunkText,
        chunkType: 'document' as const,
        metadata: item.metadata,
        sourceDate: item.date,
      }))
    },
  }
}
