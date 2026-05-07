export type AuditSource = 'Notion' | 'ClickUp'

export interface AuditRow {
  source: AuditSource
  project: string
  title: string
  url: string
  size: number
  updatedAt: string
  hasImages: boolean
  hasGifs: boolean
  hasTables: boolean
  hasCode: boolean
  hasNested: boolean
  /** Filled by the user in the Sheet (always empty on write). */
  action: string
  summary: string
  /** Internal — used by summarizer; stripped before CSV write. */
  textSnapshot: string
}

export interface ProjectMatcher {
  name: string
  aliases: string[]
  /** Lowercased name + aliases for fuzzy matching. */
  searchTerms: string[]
  clickupSpaceId?: string
  notionDatabaseIds: string[]
  notionPageIds: string[]
  clickupDocIds: string[]
}
