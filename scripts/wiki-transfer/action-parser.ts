/**
 * Parse the free-form Action column from the audit Sheet.
 *
 * Recognized values (case-insensitive):
 *   «переносим»                          → { kind: 'transfer', subpath: [] }
 *   «archive» / «архив»                  → { kind: 'archive' }
 *   «переносим в подраздел проекта X»    → { kind: 'transfer', subpath: ['X'] }  e.g. archive
 *   «переносим в отдел Депы / Аналитика» → { kind: 'department', path: ['Аналитика'] }
 *   «пропустить» / «skip»                → { kind: 'skip' }
 *   anything else                        → { kind: 'unknown' }
 */

export type ActionDecision =
  | { kind: 'transfer'; subpath: string[] }
  | { kind: 'archive' }
  | { kind: 'department'; path: string[] }
  | { kind: 'skip' }
  | { kind: 'unknown'; raw: string }

export function parseAction(raw: string): ActionDecision {
  const text = raw.trim().toLowerCase()
  if (!text) return { kind: 'unknown', raw }

  // Department: «переносим в отдел X / Y» or «отдел X / Y»
  const dept = text.match(/(?:переносим\s+в\s+отдел|в\s+отдел|departments?)\s+(.+)/i)
  if (dept) {
    const segments = dept[1]
      .split(/\s*\/\s*/)
      .map(s => s.trim())
      .filter(s => s && s !== 'департаменты' && s !== 'departments')
    return { kind: 'department', path: segments.length ? segments : [dept[1].trim()] }
  }

  // Archive variants
  if (/^(archive|архив)$/.test(text)) return { kind: 'archive' }

  // «переносим в подраздел проекта archive» — explicit subpath
  const subpath = text.match(/в\s+подраздел[ае]?\s+проекта\s+([^\(]+?)(?:\s*\(.*)?$/)
  if (subpath) {
    const segs = subpath[1].trim().split(/\s*\/\s*/).filter(Boolean)
    return { kind: 'transfer', subpath: segs }
  }

  // Plain «переносим»
  if (/^перенос/i.test(text)) {
    return { kind: 'transfer', subpath: [] }
  }

  // Skip
  if (/^(skip|пропустить|нет|не\s*перенос)/i.test(text)) {
    return { kind: 'skip' }
  }

  return { kind: 'unknown', raw }
}
