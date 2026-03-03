export type Source = 'slack' | 'gmail' | 'calendar' | 'clickup'
export type QueryType = 'recent' | 'digest' | 'search' | 'unread'
export type FieldName = 'author' | 'date' | 'text' | 'text_preview' | 'subject' | 'links' | 'thread_info' | 'status' | 'assignee' | 'due_date' | 'channel' | 'account' | 'list'

export interface BriefingRequest {
  sources: Source[]
  query_type: QueryType
  period?: string        // "today", "last_week", "last_3_days", or ISO date range "2026-01-01/2026-01-20"
  search_term?: string   // for query_type "search"
  slack_channels?: string[]  // specific channels (default: all active)
  clickup_list_names?: string[]  // specific ClickUp lists/projects by name (fuzzy matched)
  include_closed?: boolean       // include closed/completed tasks (default: false)
  limit_per_source?: number  // max items per source (default: 10)
  fields?: FieldName[]       // which fields to include (default: all)
}

export interface BriefingItem {
  source: Source
  [key: string]: unknown
}

export interface BriefingResult {
  query: BriefingRequest
  results: Record<Source, BriefingItem[] | { error: string }>
  meta: {
    sources_queried: Source[]
    sources_ok: Source[]
    sources_failed: Source[]
    total_items: number
    query_time_ms: number
  }
}
