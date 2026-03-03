import { resolveGoogleTokens } from '../../mcp/briefing/google-auth.js'
import { jsonOrThrow } from '../../mcp/briefing/utils.js'
import { splitText } from '../chunker.js'
import type { KBChunkInput } from '../types.js'
import type { SourceAdapter, RawItem } from './types.js'
import { logger } from '../../logging/logger.js'

const FILES_PER_PAGE = 100
const MAX_EXPORT_CHARS = 50_000       // Tier 1 content cap
const MAX_ACQUAINTANCE_CHARS = 3_000  // Tier 2 content cap
const EXPORT_TIMEOUT_MS = 30_000      // 30s per export
const EXPORT_DELAY_MS = 100           // rate limiting between exports
const TOKEN_REFRESH_INTERVAL = 50     // refresh token every N files

const TIER_1_DAYS = 30
const TIER_2_DAYS = 90

const MIME_LABELS: Record<string, string> = {
  'application/vnd.google-apps.document': 'Google Doc',
  'application/vnd.google-apps.spreadsheet': 'Google Sheet',
  'application/vnd.google-apps.presentation': 'Google Slides',
}

const EXPORT_MIMES: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
}

interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  owners?: Array<{ displayName: string; emailAddress: string }>
  size?: number
}

// ── Exported pure functions (testable) ──

export type IndexTier = 'full' | 'acquaintance' | 'metadata'

/** Determine indexing tier based on file modification age. */
export function determineTier(modifiedTime: Date): IndexTier {
  const ageDays = (Date.now() - modifiedTime.getTime()) / 86_400_000
  if (ageDays <= TIER_1_DAYS) return 'full'
  if (ageDays <= TIER_2_DAYS) return 'acquaintance'
  return 'metadata'
}

/** Truncate text to maxChars, appending a marker if truncated. */
export function truncateContent(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n[... truncated]'
}

/** Check if a MIME type supports Google Drive export (Google Workspace native types). */
export function isExportable(mimeType: string): boolean {
  return mimeType in EXPORT_MIMES
}

// ── Internal helpers ──

/** Export file content from Google Drive via files.export API.
 *  Returns null for non-exportable MIME types or on any error. */
async function exportFileContent(
  fileId: string,
  mimeType: string,
  accessToken: string,
): Promise<string | null> {
  const exportMime = EXPORT_MIMES[mimeType]
  if (!exportMime) return null

  try {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    })

    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      logger.warn({ fileId, mimeType, status: resp.status, body: body.slice(0, 200) }, 'Drive export failed')
      return null
    }

    const text = await resp.text()
    logger.debug({ fileId, mimeType, chars: text.length }, 'Drive file exported')
    return text
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.warn({ fileId, mimeType, error: errMsg }, 'Drive export error')
    return null
  }
}

/** Creates one DriveIngestionAdapter per Google account.
 *  Indexes files in 3 tiers: full (<=30d), acquaintance (31-90d), metadata (>90d). */
export async function createDriveAdapters(): Promise<SourceAdapter[]> {
  const tokens = await resolveGoogleTokens()
  if (tokens.size === 0) return []

  return [...tokens.entries()].map(([account]) => ({
    name: `drive:${account}`,
    source: 'drive' as const,

    async fetchSince(watermark: string): Promise<{ items: RawItem[]; nextWatermark: string }> {
      const freshTokens = await resolveGoogleTokens()
      let accessToken = freshTokens.get(account)
      if (!accessToken) throw new Error(`Drive: no token for ${account}`)

      // Phase 1 only — Phase 2 exports use accessToken directly (which may be refreshed)
      const headers = { Authorization: `Bearer ${accessToken}` }

      const mimeTypes = Object.keys(MIME_LABELS)
      const qParts = [
        `(${mimeTypes.map((m) => `mimeType='${m}'`).join(' or ')})`,
        'trashed=false',
      ]
      if (watermark) {
        qParts.push(`modifiedTime>'${new Date(watermark).toISOString()}'`)
      }

      // Phase 1: Collect all files from paginated API calls
      const allFiles: DriveFile[] = []
      let pageToken: string | undefined
      let maxModified = watermark || ''

      do {
        const params = new URLSearchParams({
          q: qParts.join(' and '),
          fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,owners,size)',
          pageSize: String(FILES_PER_PAGE),
          orderBy: 'modifiedTime desc',
        })
        if (pageToken) params.set('pageToken', pageToken)

        const resp = await fetch(
          `https://www.googleapis.com/drive/v3/files?${params}`,
          { headers, signal: AbortSignal.timeout(15_000) },
        )
        const data = await jsonOrThrow<{ files?: DriveFile[]; nextPageToken?: string }>(resp, 'Drive files')

        for (const file of data.files ?? []) {
          if (file.modifiedTime > maxModified) maxModified = file.modifiedTime
          allFiles.push(file)
        }

        pageToken = data.nextPageToken
      } while (pageToken)

      // Phase 2: Process each file — determine tier, export if needed, build RawItem
      const items: RawItem[] = []
      let exportCount = 0
      const tierCounts = { full: 0, acquaintance: 0, metadata: 0 }

      for (const file of allFiles) {
        const typeLabel = MIME_LABELS[file.mimeType] ?? file.mimeType
        const owner = file.owners?.[0]?.displayName ?? file.owners?.[0]?.emailAddress ?? ''
        const modDate = new Date(file.modifiedTime)
        const tier = determineTier(modDate)
        tierCounts[tier]++

        let text = `${typeLabel}: ${file.name}`
        let indexDepth: IndexTier = 'metadata'

        if (tier === 'full' || tier === 'acquaintance') {
          exportCount++

          // Periodic token refresh to avoid expiry during long runs
          if (exportCount % TOKEN_REFRESH_INTERVAL === 0) {
            const refreshed = await resolveGoogleTokens()
            const newToken = refreshed.get(account)
            if (newToken) accessToken = newToken
          }

          const content = await exportFileContent(file.id, file.mimeType, accessToken)

          if (content !== null) {
            const maxChars = tier === 'full' ? MAX_EXPORT_CHARS : MAX_ACQUAINTANCE_CHARS
            text = truncateContent(content, maxChars)
            indexDepth = tier
          }
          // If export failed, fall back to metadata-only (text stays as typeLabel: name)

          await new Promise((r) => setTimeout(r, EXPORT_DELAY_MS))
        }

        items.push({
          id: `${account}:${file.id}`,
          text,
          metadata: {
            account,
            fileName: file.name,
            mimeType: file.mimeType,
            owner,
            indexDepth,
            typeLabel,
          },
          date: modDate,
        })
      }

      logger.info(
        { account, total: allFiles.length, ...tierCounts },
        'Drive ingestion complete',
      )
      return { items, nextWatermark: maxModified || new Date().toISOString() }
    },

    toChunks(item: RawItem): KBChunkInput[] {
      const indexDepth = (item.metadata.indexDepth as IndexTier) ?? 'metadata'
      const owner = item.metadata.owner as string
      const fileName = item.metadata.fileName as string
      const date = item.date?.toISOString().slice(0, 10) ?? ''

      const typeLabel = (item.metadata.typeLabel as string) ?? 'Google Doc'

      if (indexDepth === 'full') {
        const header = `${typeLabel}: ${fileName}\nOwner: ${owner}\nModified: ${date}\n\n`
        const fullText = header + item.text
        const chunks = splitText(fullText)
        return chunks.map((chunkText, i) => ({
          source: 'drive' as const,
          sourceId: item.id,
          chunkIndex: i,
          text: chunkText,
          chunkType: 'document' as const,
          metadata: item.metadata,
          sourceDate: item.date,
        }))
      }

      if (indexDepth === 'acquaintance') {
        const header = `${typeLabel}: ${fileName}\nOwner: ${owner}\nModified: ${date}\n\n`
        const fullText = header + item.text
        return [{
          source: 'drive' as const,
          sourceId: item.id,
          chunkIndex: 0,
          text: fullText,
          chunkType: 'document' as const,
          metadata: item.metadata,
          sourceDate: item.date,
        }]
      }

      // metadata tier — single chunk with type label + owner + date
      const text = `${item.text}\nOwner: ${owner}\nModified: ${date}`
      return [{
        source: 'drive' as const,
        sourceId: item.id,
        chunkIndex: 0,
        text,
        chunkType: 'document' as const,
        metadata: item.metadata,
        sourceDate: item.date,
      }]
    },
  }))
}
