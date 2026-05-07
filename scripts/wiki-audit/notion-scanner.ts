/**
 * Scan Notion for all pages accessible to the integration token,
 * collect content stats, and map each to a project from vault matchers.
 */

import { NotionClient, collectStats, emptyStats, type NotionPageMeta } from '../lib/notion-client.js'
import { matchProjectByText, type ProjectMatcher } from './project-matcher.js'
import type { AuditRow } from './types.js'

const TEXT_SNAPSHOT_MAX = 8000

export async function scanNotion(
  client: NotionClient,
  matchers: ProjectMatcher[],
  options: { limit?: number } = {},
): Promise<AuditRow[]> {
  console.log('[notion] searching workspace...')
  const pages = await client.searchPages()
  console.log(`[notion] found ${pages.length} pages`)

  // Build parent index for fuzzy matching by parent-page title
  const pageById = new Map<string, NotionPageMeta>()
  for (const p of pages) pageById.set(p.id, p)

  // Pre-resolve project mapping by explicit ID lists
  const explicitProjectMap = new Map<string, string>()
  for (const m of matchers) {
    for (const id of m.notionPageIds) explicitProjectMap.set(id.replace(/-/g, ''), m.name)
    for (const id of m.notionDatabaseIds) explicitProjectMap.set(id.replace(/-/g, ''), m.name)
  }

  const limit = options.limit ?? pages.length
  const slice = pages.slice(0, limit)
  const rows: AuditRow[] = []

  for (let i = 0; i < slice.length; i++) {
    const page = slice[i]
    if (page.archived) continue

    process.stdout.write(`\r[notion] ${i + 1}/${slice.length}: ${page.title.slice(0, 50)}                `)

    const project = resolveProject(page, pageById, explicitProjectMap, matchers)

    let stats = emptyStats()
    const textParts: string[] = []
    try {
      const blocks = await client.getAllChildren(page.id)
      await collectStats(client, blocks, stats, textParts)
    } catch (e) {
      console.log(`\n[notion] failed to read blocks for ${page.title}: ${(e as Error).message.slice(0, 100)}`)
      stats = emptyStats()
    }

    rows.push({
      source: 'Notion',
      project,
      title: page.title,
      url: page.url,
      size: stats.textChars,
      updatedAt: page.last_edited_time.slice(0, 10),
      hasImages: stats.hasImages,
      hasGifs: stats.hasGifs,
      hasTables: stats.hasTables,
      hasCode: stats.hasCode,
      hasNested: stats.hasNested,
      action: '',
      summary: '',
      textSnapshot: textParts.join('\n').slice(0, TEXT_SNAPSHOT_MAX),
    })
  }

  process.stdout.write('\n')
  return rows
}

function resolveProject(
  page: NotionPageMeta,
  pageById: Map<string, NotionPageMeta>,
  explicitMap: Map<string, string>,
  matchers: ProjectMatcher[],
): string {
  const pageIdNorm = page.id.replace(/-/g, '')
  if (explicitMap.has(pageIdNorm)) return explicitMap.get(pageIdNorm)!

  const parentDb = page.parent.database_id?.replace(/-/g, '')
  if (parentDb && explicitMap.has(parentDb)) return explicitMap.get(parentDb)!

  // Walk parent chain looking for known project name in titles
  let cursor: NotionPageMeta | undefined = page
  const titles: string[] = []
  for (let i = 0; i < 6 && cursor; i++) {
    titles.push(cursor.title)
    if (cursor.parent.type === 'page_id' && cursor.parent.page_id) {
      cursor = pageById.get(cursor.parent.page_id)
    } else {
      break
    }
  }
  const combined = titles.join(' / ')
  return matchProjectByText(combined, matchers)
}
