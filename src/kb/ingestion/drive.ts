import { resolveGoogleTokens } from '../../mcp/briefing/google-auth.js'
import { jsonOrThrow } from '../../mcp/briefing/utils.js'
import { splitText } from '../chunker.js'
import type { KBChunkInput } from '../types.js'
import type { SourceAdapter, RawItem } from './types.js'
import { logger } from '../../logging/logger.js'

const FILES_PER_PAGE = 100

// Google MIME types that can be exported as text
const EXPORTABLE_MIME_TYPES: Record<string, string> = {
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
}

/** Creates one DriveIngestionAdapter per Google account. */
export async function createDriveAdapters(): Promise<SourceAdapter[]> {
  const tokens = await resolveGoogleTokens()
  if (tokens.size === 0) return []

  return [...tokens.entries()].map(([account]) => ({
    name: `drive:${account}`,
    source: 'drive' as const,

    async fetchSince(watermark: string): Promise<{ items: RawItem[]; nextWatermark: string }> {
      const freshTokens = await resolveGoogleTokens()
      const accessToken = freshTokens.get(account)
      if (!accessToken) throw new Error(`Drive: no token for ${account}`)

      const headers = { Authorization: `Bearer ${accessToken}` }

      // Query: Google Docs/Sheets/Presentations modified since watermark
      const qParts = [
        `(${Object.keys(EXPORTABLE_MIME_TYPES).map((m) => `mimeType='${m}'`).join(' or ')})`,
        'trashed=false',
      ]
      if (watermark) {
        qParts.push(`modifiedTime>'${new Date(watermark).toISOString()}'`)
      }

      const items: RawItem[] = []
      let pageToken: string | undefined
      let maxModified = watermark || ''

      do {
        const params = new URLSearchParams({
          q: qParts.join(' and '),
          fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,owners)',
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
          try {
            const exportMime = EXPORTABLE_MIME_TYPES[file.mimeType]
            if (!exportMime) continue

            const exportResp = await fetch(
              `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent(exportMime)}`,
              { headers, signal: AbortSignal.timeout(30_000) },
            )

            if (!exportResp.ok) {
              logger.warn({ file: file.name, status: exportResp.status }, 'Drive export failed')
              continue
            }

            const text = await exportResp.text()
            if (text.trim().length === 0) continue

            const modDate = new Date(file.modifiedTime)
            if (file.modifiedTime > maxModified) maxModified = file.modifiedTime

            items.push({
              id: `${account}:${file.id}`,
              text,
              metadata: {
                account,
                fileName: file.name,
                mimeType: file.mimeType,
                owner: file.owners?.[0]?.displayName ?? file.owners?.[0]?.emailAddress ?? '',
              },
              date: modDate,
            })
          } catch (error) {
            logger.warn({ file: file.name, error }, 'Drive file ingestion failed, continuing')
          }
        }

        pageToken = data.nextPageToken
      } while (pageToken)

      logger.info({ account, files: items.length }, 'Drive ingestion complete')
      return { items, nextWatermark: maxModified || new Date().toISOString() }
    },

    toChunks(item: RawItem): KBChunkInput[] {
      const header = `Document: ${item.metadata.fileName as string}\n`
      const chunks = splitText(header + item.text)

      return chunks.map((chunkText, i) => ({
        source: 'drive' as const,
        sourceId: item.id,
        chunkIndex: i,
        text: chunkText,
        chunkType: 'document' as const,
        metadata: item.metadata,
        sourceDate: item.date,
      }))
    },
  }))
}
