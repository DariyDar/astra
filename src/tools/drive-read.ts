/**
 * Google Drive document reader — fetches doc content without LLM.
 * Extracts text from Google Docs for pre-fetch before Claude analysis.
 */

import { resolveGoogleTokens } from '../mcp/briefing/google-auth.js'
import { logger } from '../logging/logger.js'
import { getCached, setCache, TTL } from './cache.js'

export interface DriveReadOpts {
  fileId?: string
  url?: string
  format?: 'text' | 'html'
}

export interface DriveReadResult {
  found: boolean
  title: string
  content: string
  fileId: string
}

/** Extract Google Doc/Sheet file ID from a URL */
function extractFileId(url: string): string | null {
  // Google Docs: /document/d/{id}/
  // Google Sheets: /spreadsheets/d/{id}/
  // Google Drive: /file/d/{id}/
  const match = url.match(/\/(?:document|spreadsheets|file|presentation)\/d\/([a-zA-Z0-9_-]+)/)
  return match?.[1] ?? null
}

export async function readDriveDoc(opts: DriveReadOpts): Promise<DriveReadResult> {
  const fileId = opts.fileId || (opts.url ? extractFileId(opts.url) : null)
  if (!fileId) return { found: false, title: '', content: 'Не удалось определить ID документа из URL', fileId: '' }

  const cached = getCached<DriveReadResult>('drive-read', { fileId })
  if (cached) return cached

  const tokens = await resolveGoogleTokens()
  const token = [...tokens.values()][0]
  if (!token) return { found: false, title: '', content: 'Google токен недоступен', fileId }

  try {
    // Get file metadata
    const metaResp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!metaResp.ok) return { found: false, title: '', content: `Документ недоступен (${metaResp.status})`, fileId }

    const meta = await metaResp.json() as { name: string; mimeType: string }
    const mimeType = opts.format === 'html' ? 'text/html' : 'text/plain'

    // Export content
    const exportResp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(mimeType)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    })
    if (!exportResp.ok) return { found: false, title: meta.name, content: `Не удалось экспортировать (${exportResp.status})`, fileId }

    let content = await exportResp.text()
    // Cap content to avoid token explosion
    if (content.length > 10_000) {
      content = content.slice(0, 10_000) + '\n\n[... документ обрезан, показаны первые 10000 символов ...]'
    }

    const result: DriveReadResult = { found: true, title: meta.name, content, fileId }
    setCache('drive-read', { fileId }, result, TTL.drive)
    return result
  } catch (error) {
    logger.warn({ fileId, error }, 'drive-read: failed')
    return { found: false, title: '', content: `Ошибка чтения: ${(error as Error).message}`, fileId }
  }
}

/** Format as text for LLM */
export function formatDriveResult(result: DriveReadResult): string {
  if (!result.found) return `--- Google Doc: ${result.content} ---`
  return `--- Документ: ${result.title} ---\n${result.content}`
}

/** Extract Google Doc/Sheet URLs from text */
export function extractDriveUrls(text: string): string[] {
  const regex = /https:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/[a-zA-Z0-9_-]+/g
  return [...new Set(text.match(regex) || [])]
}
