/**
 * Scan ClickUp Docs in workspace, collect content stats, map to project.
 *
 * Strategy:
 *  1. List all Docs in workspace via /v3/workspaces/{teamId}/docs
 *  2. For each Doc — fetch all pages with content_format=text/md
 *  3. Each page becomes a row (top-level Doc + every nested page).
 *  4. Map by clickup_doc_ids from vault frontmatter, falling back to title match.
 */

import {
  ClickUpClient,
  flattenPages,
  pageHasNested,
  statsFromMarkdown,
  type ClickUpDoc,
  type ClickUpDocPage,
} from '../lib/clickup-client.js'
import { matchProjectByText, type ProjectMatcher } from './project-matcher.js'
import type { AuditRow } from './types.js'

const TEXT_SNAPSHOT_MAX = 8000

export async function scanClickUp(
  client: ClickUpClient,
  matchers: ProjectMatcher[],
  options: { limit?: number } = {},
): Promise<AuditRow[]> {
  console.log('[clickup] listing all docs in workspace...')
  const docs = await client.listAllDocs()
  console.log(`[clickup] found ${docs.length} docs`)

  const docToProject = new Map<string, string>()
  for (const m of matchers) {
    for (const id of m.clickupDocIds) docToProject.set(id, m.name)
  }

  const rows: AuditRow[] = []
  const sliced = options.limit ? docs.slice(0, options.limit) : docs

  for (let i = 0; i < sliced.length; i++) {
    const doc = sliced[i]
    process.stdout.write(`\r[clickup] doc ${i + 1}/${sliced.length}: ${doc.name?.slice(0, 50) ?? '<no name>'}              `)

    let pages: ClickUpDocPage[] = []
    try {
      pages = await client.getDocPages(doc.id)
    } catch (e) {
      console.log(`\n[clickup] failed to read pages for ${doc.name}: ${(e as Error).message.slice(0, 100)}`)
      continue
    }

    const project = docToProject.get(doc.id) ?? matchProjectByText(doc.name ?? '', matchers)

    const flat = flattenPages(pages)
    for (const page of flat) {
      const md = page.content ?? ''
      const stats = statsFromMarkdown(md, pageHasNested(page))
      rows.push({
        source: 'ClickUp',
        project,
        title: page.name,
        url: buildPageUrl(doc, page),
        size: stats.textChars,
        updatedAt: page.date_updated ? new Date(page.date_updated).toISOString().slice(0, 10) : '',
        hasImages: stats.hasImages,
        hasGifs: stats.hasGifs,
        hasTables: stats.hasTables,
        hasCode: stats.hasCode,
        hasNested: stats.hasNested,
        action: '',
        summary: '',
        textSnapshot: md.slice(0, TEXT_SNAPSHOT_MAX),
      })
    }
  }

  process.stdout.write('\n')
  return rows
}

function buildPageUrl(doc: ClickUpDoc, page: ClickUpDocPage): string {
  // ClickUp page URLs follow https://app.clickup.com/<team>/v/dc/<docId>/<pageId>
  // We don't always know the team, but the URL still resolves through ClickUp redirect.
  if (doc.url) {
    return `${doc.url.replace(/\/$/, '')}/${page.id}`
  }
  return `https://app.clickup.com/v/dc/${doc.id}/${page.id}`
}
