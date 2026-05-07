/**
 * Build a list of active-project matchers from vault frontmatter + body.
 *
 * Each matcher has:
 *  - canonical name + aliases (for fuzzy matching titles/parents)
 *  - explicit notion_database_ids / notion_page_ids / clickup_doc_ids if
 *    declared in `## Ресурсы` section (parsed via regex on URLs)
 *  - clickup_space_id from URL like https://app.clickup.com/<spaceOrTeam>/...
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import type { ProjectMatcher } from './types.js'

const VAULT_DIR = join(process.cwd(), 'vault')

export function loadProjectMatchers(): ProjectMatcher[] {
  const projectsDir = join(VAULT_DIR, 'projects')
  if (!existsSync(projectsDir)) return []

  const matchers: ProjectMatcher[] = []
  for (const file of readdirSync(projectsDir)) {
    if (!file.endsWith('.md')) continue
    if (file.startsWith('_')) continue
    if (file.includes(' — Статусы')) continue

    const raw = readFileSync(join(projectsDir, file), 'utf-8')
    const { data: fm, content } = matter(raw)
    const status = (fm.status as string) ?? 'active'
    if (status !== 'active') continue

    const name = file.replace(/\.md$/, '')
    const displayName = String(fm.display_name ?? name).trim()
    const aliasesRaw = Array.isArray(fm.aliases) ? fm.aliases : []
    const aliases = aliasesRaw.map((a: unknown) => String(a).replace(/\[\[|\]\]/g, '').trim()).filter(Boolean)

    const allTerms = [name, displayName, ...aliases].filter(Boolean)
    const searchTerms = [...new Set(allTerms.map(t => t.toLowerCase()))]

    const notionDatabaseIds = new Set<string>()
    const notionPageIds = new Set<string>()
    const clickupDocIds = new Set<string>()
    let clickupSpaceId: string | undefined

    // Parse `## Ресурсы` and `## Документация` sections
    const sections = ['## Ресурсы', '## Документация']
    for (const heading of sections) {
      const re = new RegExp(`${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n$|$)`)
      const match = content.match(re)
      if (!match) continue
      const section = match[1]

      // ClickUp: https://app.clickup.com/<team>/v/dc/<docId>
      // ClickUp Doc IDs look like 8cp776q-16515 (alphanumeric+digits)
      const clickupRe = /https:\/\/app\.clickup\.com\/(\d+)\/v\/dc\/([a-z0-9]+-\d+)/gi
      let cm: RegExpExecArray | null
      while ((cm = clickupRe.exec(section)) !== null) {
        clickupDocIds.add(cm[2])
      }

      // ClickUp space: https://app.clickup.com/<team>/v/.../?pr=<spaceId>
      const spaceRe = /https:\/\/app\.clickup\.com\/\d+\/[^\s)]*?(?:pr=|space\/)(\d+)/gi
      let sm: RegExpExecArray | null
      while ((sm = spaceRe.exec(section)) !== null) {
        clickupSpaceId ??= sm[1]
      }

      // Notion: https://www.notion.so/<title>-<id>?... or .../<id>
      // Page ID: 32 hex chars (with or without dashes)
      const notionRe = /https:\/\/(?:www\.)?notion\.so\/[^\s)]*?([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi
      let nm: RegExpExecArray | null
      while ((nm = notionRe.exec(section)) !== null) {
        const id = nm[1].replace(/-/g, '')
        notionPageIds.add(id)
      }
    }

    // Frontmatter override (preferred when present)
    const wikiSources = fm.wiki_sources as Record<string, unknown> | undefined
    if (wikiSources) {
      for (const id of (wikiSources.notion_database_ids as string[] | undefined) ?? []) notionDatabaseIds.add(id.replace(/-/g, ''))
      for (const id of (wikiSources.notion_page_ids as string[] | undefined) ?? []) notionPageIds.add(id.replace(/-/g, ''))
      for (const id of (wikiSources.clickup_doc_ids as string[] | undefined) ?? []) clickupDocIds.add(id)
      if (typeof wikiSources.clickup_space_id === 'string') clickupSpaceId = wikiSources.clickup_space_id
    }

    matchers.push({
      name,
      aliases,
      searchTerms,
      clickupSpaceId,
      notionDatabaseIds: [...notionDatabaseIds],
      notionPageIds: [...notionPageIds],
      clickupDocIds: [...clickupDocIds],
    })
  }

  return matchers
}

/** Match a free-form title (or parent path) to the most likely project. */
export function matchProjectByText(text: string, matchers: ProjectMatcher[]): string {
  const lower = text.toLowerCase()
  for (const m of matchers) {
    for (const term of m.searchTerms) {
      if (term.length < 3) continue
      if (lower.includes(term)) return m.name
    }
  }
  return ''
}
