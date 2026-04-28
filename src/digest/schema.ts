/**
 * JSON schema produced by the Sonnet single-call digest compiler.
 *
 * Keep this stable across both the prompt and the formatter — the prompt
 * tells Sonnet "produce exactly this shape" and the formatter assumes it.
 */

export type ItemType = 'slack' | 'email' | 'clickup' | 'calendar' | 'build' | 'milestone' | 'other'

export type ProjectStatus = 'ok' | 'attention' | 'blocked'

export type GeneralUpdateType = 'birthday' | 'absence' | 'announcement' | 'process' | 'other'

export interface DigestItem {
  /** Stable id used by future feedback. Format: `<company>-<projectId>-<seq>` or `<company>-general-<seq>`. */
  item_id: string
  type: ItemType
  /** 1 = trivia, 5 = critical / blocker. */
  importance: 1 | 2 | 3 | 4 | 5
  /** ≤ 120 chars, single line, the headline shown in Telegram. */
  one_line: string
  /** Optional 1–3 sentence elaboration. Written to vault, NOT shown in Telegram. */
  detail?: string
  /** Direct deep link if available (Slack message, ClickUp task, Gmail thread). */
  link?: string
  /** Raw source metadata for later analytics. */
  source_meta?: Record<string, string | number>
}

export interface DigestProject {
  /** Canonical project id (kebab-case from vault filename). */
  project_id: string
  /** Display name as in the vault project card. */
  project_name: string
  status: ProjectStatus
  items: DigestItem[]
}

export interface DigestGeneralUpdate {
  item_id: string
  type: GeneralUpdateType
  importance: 1 | 2 | 3 | 4 | 5
  one_line: string
  detail?: string
  link?: string
}

export interface DigestCompany {
  /** Projects with at least one update. Quiet projects go to `silent_projects`. */
  projects: DigestProject[]
  /** Names of projects that had no notable updates today. */
  silent_projects: string[]
  /** Updates not tied to a specific project (birthdays, absences, announcements). */
  general_updates: DigestGeneralUpdate[]
}

export interface DigestResult {
  digest_date: string  // ISO date, e.g. "2026-04-28"
  companies: {
    astrocat: DigestCompany
    highground: DigestCompany
  }
  meta: {
    items_total: number
    sources: Partial<Record<ItemType, number>>
  }
}
