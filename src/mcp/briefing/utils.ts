import { appendFileSync } from 'node:fs'
import type { FieldName } from './types.js'

const LOG_PATH = '/tmp/astra-briefing.log'

export function log(msg: string): void {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`)
  } catch { /* ignore */ }
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '…'
}

export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s>|)]+/g
  return [...text.matchAll(urlRegex)].map(m => m[0])
}

/** Parse JSON from a fetch response, throwing a clear error on non-OK status. */
export async function jsonOrThrow<T>(resp: Response, label: string): Promise<T> {
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`${label} HTTP ${resp.status}: ${body.slice(0, 200)}`)
  }
  return resp.json() as Promise<T>
}

export function filterFields(item: Record<string, unknown>, fields?: FieldName[]): Record<string, unknown> {
  if (!fields || fields.length === 0) return item
  const result: Record<string, unknown> = {}
  for (const f of fields) {
    if (f in item) result[f] = item[f]
  }
  // Always include source
  if ('source' in item) result.source = item.source
  return result
}
