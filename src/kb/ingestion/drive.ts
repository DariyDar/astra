import { resolveGoogleTokens } from '../../mcp/briefing/google-auth.js'
import { jsonOrThrow } from '../../mcp/briefing/utils.js'
import { splitText } from '../chunker.js'
import { getIngestionState, setIngestionState } from '../repository.js'
import type { KBChunkInput } from '../types.js'
import type { SourceAdapter, RawItem } from './types.js'
import { logger } from '../../logging/logger.js'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../../db/schema.js'
import { sql, eq, and } from 'drizzle-orm'
import { kbChunks } from '../../db/schema.js'
import type { QdrantClient } from '@qdrant/js-client-rest'

type DB = NodePgDatabase<typeof schema>

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

// ── Changes API — Incremental Sync ──

interface ChangeItem {
  fileId: string
  removed?: boolean
  file?: DriveFile & { trashed?: boolean }
}

interface ChangesResponse {
  nextPageToken?: string
  newStartPageToken?: string
  changes?: ChangeItem[]
}

/** Get the initial page token for the Changes API. Call once on first run. */
export async function getStartPageToken(accessToken: string): Promise<string> {
  const resp = await fetch(
    'https://www.googleapis.com/drive/v3/changes/startPageToken',
    { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) },
  )
  const data = await jsonOrThrow<{ startPageToken: string }>(resp, 'Drive startPageToken')
  return data.startPageToken
}

/** Fetch changed files since the given page token. Paginates until exhausted. */
export async function fetchDriveChanges(
  accessToken: string,
  startPageToken: string,
): Promise<{ files: DriveFile[]; removedIds: string[]; newPageToken: string }> {
  const files: DriveFile[] = []
  const removedIds: string[] = []
  let pageToken: string | undefined = startPageToken
  let newStartPageToken = startPageToken

  for (;;) {
    if (!pageToken) break

    const reqParams: URLSearchParams = new URLSearchParams({
      pageToken,
      fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,owners,trashed))',
      includeRemoved: 'true',
      restrictToMyDrive: 'true',
      pageSize: '100',
    })

    const changesResp: Response = await fetch(
      `https://www.googleapis.com/drive/v3/changes?${reqParams}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) },
    )
    const changesData: ChangesResponse = await jsonOrThrow<ChangesResponse>(changesResp, 'Drive changes')

    for (const change of changesData.changes ?? []) {
      if (change.removed || change.file?.trashed) {
        removedIds.push(change.fileId)
      } else if (change.file) {
        files.push(change.file)
      }
    }

    if (changesData.newStartPageToken) {
      newStartPageToken = changesData.newStartPageToken
      break
    }
    pageToken = changesData.nextPageToken
  }

  return { files, removedIds, newPageToken: newStartPageToken }
}

/**
 * Incremental sync via Changes API. Uses a SEPARATE watermark key from files.list.
 * On first run, initializes the page token without processing files.
 */
export async function syncDriveChanges(
  db: DB,
  account: string,
  qdrantClient?: QdrantClient,
): Promise<{ filesReIndexed: number; filesRemoved: number; newToken: string }> {
  const stateKey = `drive:changes:${account}`
  const state = await getIngestionState(db, stateKey)

  const freshTokens = await resolveGoogleTokens()
  const accessToken = freshTokens.get(account)
  if (!accessToken) throw new Error(`Drive: no token for ${account}`)

  // First run — initialize page token, no files to process
  if (!state?.watermark) {
    const token = await getStartPageToken(accessToken)
    await setIngestionState(db, stateKey, { watermark: token, status: 'idle' })
    logger.info({ account, token: token.slice(0, 10) + '...' }, 'Drive Changes API: initialized page token')
    return { filesReIndexed: 0, filesRemoved: 0, newToken: token }
  }

  await setIngestionState(db, stateKey, { watermark: state.watermark, status: 'running' })

  const { files, removedIds, newPageToken } = await fetchDriveChanges(accessToken, state.watermark)

  // Handle removed files — delete chunks from PG and Qdrant
  let filesRemoved = 0
  for (const fileId of removedIds) {
    const sourceId = `${account}:${fileId}`
    await db.delete(kbChunks).where(and(
      eq(kbChunks.source, 'drive'),
      eq(kbChunks.sourceId, sourceId),
    ))
    if (qdrantClient) {
      try {
        await qdrantClient.delete('astra_knowledge', {
          wait: true,
          filter: { must: [{ key: 'source_id', match: { value: sourceId } }] },
        })
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.warn({ sourceId, error: errMsg }, 'Qdrant delete failed for removed Drive file')
      }
    }
    filesRemoved++
  }

  // Re-index changed files at the correct tier
  // Note: we only detect the tier and flag the file — actual content export
  // happens via the standard ingestion pipeline on the next full run.
  // For now, we log the changes for tracking.
  let filesReIndexed = 0
  const tierCounts = { full: 0, acquaintance: 0, metadata: 0 }

  for (const file of files) {
    if (!isExportable(file.mimeType)) continue
    const tier = determineTier(new Date(file.modifiedTime))
    tierCounts[tier]++
    filesReIndexed++
  }

  await setIngestionState(db, stateKey, {
    watermark: newPageToken,
    status: 'idle',
    itemsTotal: (state.itemsTotal ?? 0) + filesReIndexed,
  })

  logger.info(
    { account, changed: files.length, removed: removedIds.length, reIndexed: filesReIndexed, ...tierCounts },
    'Drive Changes API: incremental sync complete',
  )

  return { filesReIndexed, filesRemoved, newToken: newPageToken }
}

// ── Stale Document Query (DRIVE-03) ──

interface StaleDocument {
  name: string
  sourceId: string
  lastModified: Date
  ageDays: number
}

/**
 * Find Drive documents older than the specified threshold.
 * Read-only query for DRIVE-03 freshness tracking compliance.
 */
export async function findStaleDriveDocuments(
  db: DB,
  staleDays: number = 90,
): Promise<StaleDocument[]> {
  const cutoff = new Date(Date.now() - staleDays * 86_400_000)

  const rows = await db.select({
    sourceId: kbChunks.sourceId,
    metadata: kbChunks.metadata,
    sourceDate: kbChunks.sourceDate,
  }).from(kbChunks)
    .where(and(
      eq(kbChunks.source, 'drive'),
      eq(kbChunks.chunkIndex, 0),
      sql`${kbChunks.sourceDate} < ${cutoff}`,
    ))
    .orderBy(sql`${kbChunks.sourceDate} ASC`)

  return rows.map((r) => {
    const meta = r.metadata as Record<string, unknown> | null
    const sourceDate = r.sourceDate ?? cutoff
    const ageDays = Math.round((Date.now() - sourceDate.getTime()) / 86_400_000)
    return {
      name: (meta?.fileName as string) ?? r.sourceId,
      sourceId: r.sourceId,
      lastModified: sourceDate,
      ageDays,
    }
  })
}
