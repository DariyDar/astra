/**
 * Notion API client + block→HTML converter.
 * Extracted from scripts/notion-to-drive.ts for reuse across wiki-audit, notion-to-drive, etc.
 */

const NOTION_VERSION = '2022-06-28'

export interface NotionBlock {
  id: string
  type: string
  has_children: boolean
  [key: string]: unknown
}

export interface RichText {
  type: string
  plain_text: string
  href?: string | null
  annotations: {
    bold: boolean
    italic: boolean
    strikethrough: boolean
    underline: boolean
    code: boolean
    color: string
  }
  text?: { content: string; link?: { url: string } | null }
}

export interface NotionPageMeta {
  id: string
  title: string
  url: string
  parent: { type: string; database_id?: string; page_id?: string; workspace?: boolean }
  created_time: string
  last_edited_time: string
  icon?: { emoji?: string } | null
  archived: boolean
}

export class NotionClient {
  constructor(private token: string) {
    if (!token) throw new Error('Notion token required')
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const resp = await fetch(`https://api.notion.com/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get('Retry-After') ?? '2', 10)
      await new Promise(r => setTimeout(r, retryAfter * 1000))
      return this.request(path, init)
    }
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`Notion API ${resp.status} on ${path}: ${text.slice(0, 300)}`)
    }
    return resp.json()
  }

  async get(path: string): Promise<unknown> {
    return this.request(path)
  }

  async post(path: string, body: unknown): Promise<unknown> {
    return this.request(path, { method: 'POST', body: JSON.stringify(body) })
  }

  async getAllChildren(blockId: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = []
    let cursor: string | undefined
    do {
      const params = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100'
      const data = await this.get(`/blocks/${blockId}/children${params}`) as {
        results: NotionBlock[]
        next_cursor?: string | null
        has_more: boolean
      }
      blocks.push(...data.results)
      cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined
    } while (cursor)
    return blocks
  }

  async searchPages(query?: string): Promise<NotionPageMeta[]> {
    const pages: NotionPageMeta[] = []
    let cursor: string | undefined
    do {
      const body: Record<string, unknown> = {
        page_size: 100,
        filter: { value: 'page', property: 'object' },
      }
      if (query) body.query = query
      if (cursor) body.start_cursor = cursor
      const data = await this.post('/search', body) as {
        results: Array<{
          id: string
          url: string
          parent: NotionPageMeta['parent']
          created_time: string
          last_edited_time: string
          icon?: { emoji?: string } | null
          archived: boolean
          properties?: Record<string, { type: string; title?: Array<{ plain_text: string }> }>
        }>
        next_cursor?: string | null
        has_more: boolean
      }
      for (const r of data.results) {
        pages.push({
          id: r.id,
          title: extractTitle(r.properties),
          url: r.url,
          parent: r.parent,
          created_time: r.created_time,
          last_edited_time: r.last_edited_time,
          icon: r.icon ?? null,
          archived: r.archived,
        })
      }
      cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined
    } while (cursor)
    return pages
  }

  async queryDatabase(databaseId: string): Promise<NotionPageMeta[]> {
    const pages: NotionPageMeta[] = []
    let cursor: string | undefined
    do {
      const body: Record<string, unknown> = { page_size: 100 }
      if (cursor) body.start_cursor = cursor
      const data = await this.post(`/databases/${databaseId}/query`, body) as {
        results: Array<{
          id: string
          url: string
          parent: NotionPageMeta['parent']
          created_time: string
          last_edited_time: string
          icon?: { emoji?: string } | null
          archived: boolean
          properties?: Record<string, { type: string; title?: Array<{ plain_text: string }> }>
        }>
        next_cursor?: string | null
        has_more: boolean
      }
      for (const r of data.results) {
        pages.push({
          id: r.id,
          title: extractTitle(r.properties),
          url: r.url,
          parent: r.parent,
          created_time: r.created_time,
          last_edited_time: r.last_edited_time,
          icon: r.icon ?? null,
          archived: r.archived,
        })
      }
      cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined
    } while (cursor)
    return pages
  }

  async getPage(pageId: string): Promise<NotionPageMeta> {
    const data = await this.get(`/pages/${pageId}`) as {
      id: string
      url: string
      parent: NotionPageMeta['parent']
      created_time: string
      last_edited_time: string
      icon?: { emoji?: string } | null
      archived: boolean
      properties?: Record<string, { type: string; title?: Array<{ plain_text: string }> }>
    }
    return {
      id: data.id,
      title: extractTitle(data.properties),
      url: data.url,
      parent: data.parent,
      created_time: data.created_time,
      last_edited_time: data.last_edited_time,
      icon: data.icon ?? null,
      archived: data.archived,
    }
  }
}

function extractTitle(properties?: Record<string, { type: string; title?: Array<{ plain_text: string }> }>): string {
  if (!properties) return 'Untitled'
  for (const v of Object.values(properties)) {
    if (v.type === 'title' && v.title) {
      const text = v.title.map(t => t.plain_text).join('').trim()
      if (text) return text
    }
  }
  return 'Untitled'
}

// ── HTML conversion ──

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function richTextToHtml(richTexts: RichText[]): string {
  return richTexts.map(rt => {
    let text = escapeHtml(rt.plain_text)
    if (rt.annotations.code) text = `<code>${text}</code>`
    if (rt.annotations.bold) text = `<b>${text}</b>`
    if (rt.annotations.italic) text = `<i>${text}</i>`
    if (rt.annotations.strikethrough) text = `<s>${text}</s>`
    if (rt.annotations.underline) text = `<u>${text}</u>`
    const link = rt.href || rt.text?.link?.url
    if (link) text = `<a href="${escapeHtml(link)}">${text}</a>`
    return text
  }).join('')
}

export function richTextToPlain(richTexts: RichText[]): string {
  return richTexts.map(rt => rt.plain_text).join('')
}

export interface BlockStats {
  hasImages: boolean
  hasGifs: boolean
  hasTables: boolean
  hasCode: boolean
  hasNested: boolean
  textChars: number
}

export function emptyStats(): BlockStats {
  return { hasImages: false, hasGifs: false, hasTables: false, hasCode: false, hasNested: false, textChars: 0 }
}

export function mergeStats(a: BlockStats, b: BlockStats): void {
  a.hasImages ||= b.hasImages
  a.hasGifs ||= b.hasGifs
  a.hasTables ||= b.hasTables
  a.hasCode ||= b.hasCode
  a.hasNested ||= b.hasNested
  a.textChars += b.textChars
}

/**
 * Walk Notion blocks (recursively) collecting stats and a plain-text snapshot.
 * Used by wiki-audit. Note: media URLs from Notion S3 expire, but we only need
 * the URL string here for content flags — no downloads.
 */
export async function collectStats(
  client: NotionClient,
  blocks: NotionBlock[],
  stats: BlockStats,
  textOut: string[],
  depth = 0,
  maxDepth = 6,
): Promise<void> {
  for (const block of blocks) {
    const type = block.type
    const data = block[type] as Record<string, unknown> | undefined
    if (!data) continue

    const richText = (data.rich_text ?? []) as RichText[]
    if (richText.length) {
      const plain = richTextToPlain(richText)
      stats.textChars += plain.length
      textOut.push(plain)
    }

    switch (type) {
      case 'image': {
        stats.hasImages = true
        const url = ((data.file as { url?: string })?.url ?? (data.external as { url?: string })?.url) ?? ''
        if (/\.gif(\?|$)/i.test(url)) stats.hasGifs = true
        break
      }
      case 'code':
        stats.hasCode = true
        break
      case 'table':
        stats.hasTables = true
        break
      case 'child_page':
      case 'child_database':
        stats.hasNested = true
        break
    }

    if (block.has_children && depth < maxDepth) {
      try {
        const children = await client.getAllChildren(block.id)
        await collectStats(client, children, stats, textOut, depth + 1, maxDepth)
      } catch {
        // ignore — partial stats are fine for audit
      }
    }
  }
}
