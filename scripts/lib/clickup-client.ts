/**
 * ClickUp Docs API client (v3).
 * Used by wiki-audit and clickup-to-drive.
 */

export interface ClickUpDoc {
  id: string
  name: string
  workspace_id?: string
  parent?: { id: string; type: number } | null
  date_created?: number
  date_updated?: number
  /** Public URL like https://app.clickup.com/<team>/v/dc/<doc-id>/<page-id> */
  url?: string
}

export interface ClickUpDocPage {
  id: string
  name: string
  content?: string
  /** Markdown is the typical content format from ClickUp Docs. */
  date_updated?: number
  pages?: ClickUpDocPage[]
}

export class ClickUpClient {
  constructor(private token: string, private teamId: string) {
    if (!token) throw new Error('ClickUp token required')
    if (!teamId) throw new Error('ClickUp team ID required')
  }

  private async request(url: string): Promise<unknown> {
    const resp = await fetch(url, {
      headers: { Authorization: this.token },
      signal: AbortSignal.timeout(30_000),
    })
    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get('Retry-After') ?? '5', 10)
      await new Promise(r => setTimeout(r, retryAfter * 1000))
      return this.request(url)
    }
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`ClickUp API ${resp.status} on ${url}: ${text.slice(0, 300)}`)
    }
    return resp.json()
  }

  /** List all Docs in workspace. Paginated via `next_cursor`. */
  async listAllDocs(): Promise<ClickUpDoc[]> {
    const docs: ClickUpDoc[] = []
    let cursor: string | undefined
    do {
      const params = new URLSearchParams({ limit: '50', deleted: 'false', archived: 'false' })
      if (cursor) params.set('next_cursor', cursor)
      const data = await this.request(
        `https://api.clickup.com/api/v3/workspaces/${this.teamId}/docs?${params}`,
      ) as { docs?: ClickUpDoc[]; next_cursor?: string | null }
      if (data.docs) docs.push(...data.docs)
      cursor = data.next_cursor ?? undefined
    } while (cursor)
    return docs
  }

  /** Get all pages (with content) of a doc, including nested children. */
  async getDocPages(docId: string, options?: { includeContent?: boolean }): Promise<ClickUpDocPage[]> {
    const params = new URLSearchParams({ max_page_depth: '-1' })
    if (options?.includeContent !== false) params.set('content_format', 'text/md')
    const data = await this.request(
      `https://api.clickup.com/api/v3/workspaces/${this.teamId}/docs/${docId}/pages?${params}`,
    )
    return Array.isArray(data) ? (data as ClickUpDocPage[]) : []
  }
}

export interface PageContentStats {
  hasImages: boolean
  hasGifs: boolean
  hasTables: boolean
  hasCode: boolean
  hasNested: boolean
  textChars: number
}

export function statsFromMarkdown(md: string, hasNested: boolean): PageContentStats {
  const stats: PageContentStats = {
    hasImages: false,
    hasGifs: false,
    hasTables: false,
    hasCode: false,
    hasNested,
    textChars: md.length,
  }
  const imgRe = /!\[[^\]]*\]\(([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = imgRe.exec(md)) !== null) {
    stats.hasImages = true
    if (/\.gif(\?|$)/i.test(m[1])) stats.hasGifs = true
  }
  if (/^[ \t]*\|.+\|[ \t]*$/m.test(md) && /^[ \t]*\|[ \t-:]+\|[ \t]*$/m.test(md)) stats.hasTables = true
  if (/```/.test(md)) stats.hasCode = true
  return stats
}

export function flattenPages(pages: ClickUpDocPage[]): ClickUpDocPage[] {
  const out: ClickUpDocPage[] = []
  function walk(p: ClickUpDocPage[]): void {
    for (const page of p) {
      out.push(page)
      if (page.pages?.length) walk(page.pages)
    }
  }
  walk(pages)
  return out
}

export function pageHasNested(page: ClickUpDocPage): boolean {
  return !!page.pages?.length
}
