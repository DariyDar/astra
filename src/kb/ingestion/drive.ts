import { resolveGoogleTokens } from '../../mcp/briefing/google-auth.js'
import { jsonOrThrow } from '../../mcp/briefing/utils.js'
import type { KBChunkInput } from '../types.js'
import type { SourceAdapter, RawItem } from './types.js'
import { logger } from '../../logging/logger.js'

const FILES_PER_PAGE = 100

const MIME_LABELS: Record<string, string> = {
  'application/vnd.google-apps.document': 'Google Doc',
  'application/vnd.google-apps.spreadsheet': 'Google Sheet',
  'application/vnd.google-apps.presentation': 'Google Slides',
}

interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  owners?: Array<{ displayName: string; emailAddress: string }>
}

/** Creates one DriveIngestionAdapter per Google account.
 *  Indexes file metadata only (name, type, owner, date) — one chunk per file.
 *  Full content is fetched on-demand when the user asks to "go deeper". */
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

      const mimeTypes = Object.keys(MIME_LABELS)
      const qParts = [
        `(${mimeTypes.map((m) => `mimeType='${m}'`).join(' or ')})`,
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
          const typeLabel = MIME_LABELS[file.mimeType] ?? file.mimeType
          const owner = file.owners?.[0]?.displayName ?? file.owners?.[0]?.emailAddress ?? ''

          const modDate = new Date(file.modifiedTime)
          if (file.modifiedTime > maxModified) maxModified = file.modifiedTime

          // Store only metadata — no content export
          items.push({
            id: `${account}:${file.id}`,
            text: `${typeLabel}: ${file.name}`,
            metadata: {
              account,
              fileName: file.name,
              mimeType: file.mimeType,
              owner,
            },
            date: modDate,
          })
        }

        pageToken = data.nextPageToken
      } while (pageToken)

      logger.info({ account, files: items.length }, 'Drive ingestion complete')
      return { items, nextWatermark: maxModified || new Date().toISOString() }
    },

    toChunks(item: RawItem): KBChunkInput[] {
      // One chunk per file — just the metadata summary
      const owner = item.metadata.owner as string
      const date = item.date?.toISOString().slice(0, 10) ?? ''
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
