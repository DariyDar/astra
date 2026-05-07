/**
 * Download images/gifs/files from a source URL (Notion S3, ClickUp CDN, etc.)
 * and re-upload them to a Drive folder, returning a stable Drive URL.
 *
 * Notion S3 URLs expire (~1 hour); ClickUp t37xxx URLs are stable but tied to
 * the original Doc — copying to our Drive guarantees long-term availability
 * and removes dependency on the source system after migration.
 */

import { createHash } from 'node:crypto'

interface DriveUploadResp {
  id: string
  webViewLink?: string
  webContentLink?: string
}

const MIME_FROM_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
}

function extFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const m = u.pathname.match(/\.([a-zA-Z0-9]+)(?:$|\?|#)/)
    return m ? m[1].toLowerCase() : ''
  } catch {
    return ''
  }
}

function guessMime(url: string, contentType?: string): string {
  if (contentType && contentType !== 'application/octet-stream') return contentType.split(';')[0].trim()
  const ext = extFromUrl(url)
  return MIME_FROM_EXT[ext] ?? 'application/octet-stream'
}

function nameFromUrl(url: string, fallback = 'media'): string {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').pop() ?? ''
    if (last) return last.split('?')[0].slice(0, 80)
  } catch { /* */ }
  return fallback
}

function hashUrl(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 10)
}

export interface DownloadedMedia {
  /** Original source URL (key for caching). */
  sourceUrl: string
  /** Stable Drive URL to embed in HTML. */
  driveUrl: string
  /** Drive file ID (so caller can manage permissions). */
  fileId: string
  mimeType: string
  bytes: number
}

export class MediaDownloader {
  private cache = new Map<string, DownloadedMedia>()
  private failures = new Set<string>()

  constructor(
    private driveToken: string,
    private targetFolderId: string,
    private options: { skipLargerThanBytes?: number; concurrency?: number } = {},
  ) {}

  /** Maximum file size to copy. Default 25 MB. */
  get maxBytes(): number {
    return this.options.skipLargerThanBytes ?? 25 * 1024 * 1024
  }

  async downloadAndUpload(
    sourceUrl: string,
    articleSlug: string,
    options: { refreshUrl?: () => Promise<string | null> } = {},
  ): Promise<DownloadedMedia | null> {
    if (this.cache.has(sourceUrl)) return this.cache.get(sourceUrl)!
    if (this.failures.has(sourceUrl)) return null

    let activeUrl = sourceUrl
    let resp: Response | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        resp = await fetch(activeUrl, { signal: AbortSignal.timeout(60_000) })
      } catch (e) {
        console.log(`    media: fetch failed ${activeUrl.slice(0, 80)}: ${(e as Error).message.slice(0, 80)}`)
        return null
      }
      if (resp.ok) break
      // Common expiry/auth error codes — try refreshing URL once
      if (attempt === 0 && options.refreshUrl && (resp.status === 400 || resp.status === 403 || resp.status === 404)) {
        const fresh = await options.refreshUrl()
        if (fresh && fresh !== activeUrl) {
          console.log(`    media: ${resp.status} → refreshed URL`)
          activeUrl = fresh
          continue
        }
      }
      console.log(`    media: ${resp.status} ${activeUrl.slice(0, 80)}`)
      this.failures.add(sourceUrl)
      return null
    }
    if (!resp || !resp.ok) {
      this.failures.add(sourceUrl)
      return null
    }
    const sizeHeader = resp.headers.get('content-length')
    if (sizeHeader && parseInt(sizeHeader, 10) > this.maxBytes) {
      console.log(`    media: too large (${sizeHeader} bytes), skipping ${sourceUrl.slice(0, 80)}`)
      return null
    }

    const buf = await resp.arrayBuffer()
    if (buf.byteLength > this.maxBytes) {
      console.log(`    media: too large (${buf.byteLength} bytes), skipping`)
      return null
    }

    const mime = guessMime(sourceUrl, resp.headers.get('content-type') ?? undefined)
    const baseName = nameFromUrl(sourceUrl)
    // Prefix with slug + hash for uniqueness; preserves extension
    const ext = extFromUrl(sourceUrl) || (mime.split('/')[1] ?? 'bin')
    const fileName = `${articleSlug}_${hashUrl(sourceUrl)}.${ext}`

    const uploaded = await this.uploadToDrive(fileName, mime, new Uint8Array(buf))
    if (!uploaded) return null

    const driveUrl = `https://drive.google.com/uc?id=${uploaded.id}`
    const result: DownloadedMedia = {
      sourceUrl,
      driveUrl,
      fileId: uploaded.id,
      mimeType: mime,
      bytes: buf.byteLength,
    }
    this.cache.set(sourceUrl, result)
    return result
  }

  private async uploadToDrive(
    name: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<DriveUploadResp | null> {
    const boundary = '===media_upload_boundary==='
    const metadata = JSON.stringify({
      name,
      mimeType,
      parents: [this.targetFolderId],
    })
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    const tail = `\r\n--${boundary}--`

    const headBuf = new TextEncoder().encode(head)
    const tailBuf = new TextEncoder().encode(tail)
    const body = new Uint8Array(headBuf.byteLength + bytes.byteLength + tailBuf.byteLength)
    body.set(headBuf, 0)
    body.set(bytes, headBuf.byteLength)
    body.set(tailBuf, headBuf.byteLength + bytes.byteLength)

    const resp = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink,webContentLink',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.driveToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
        signal: AbortSignal.timeout(120_000),
      },
    )
    if (!resp.ok) {
      console.log(`    media upload failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`)
      return null
    }
    const data = await resp.json() as DriveUploadResp

    // Make publicly readable so embedded <img src> works without auth
    try {
      await fetch(`https://www.googleapis.com/drive/v3/files/${data.id}/permissions?supportsAllDrives=true`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.driveToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'reader', type: 'anyone' }),
      })
    } catch {
      // best effort — embed will still work for authed wiki users
    }
    return data
  }
}

/**
 * Walk an HTML string, find <img src="..."> URLs that look external, and
 * replace them with stable Drive URLs from the downloader.
 *
 * Returns the rewritten HTML and the count of replaced URLs.
 */
export interface UrlRefresher {
  /** Given the original media URL (S3-expiring), return a fresh URL or null. */
  (sourceUrl: string): Promise<string | null>
}

export async function rewriteImagesInHtml(
  html: string,
  downloader: MediaDownloader,
  articleSlug: string,
  refresher?: UrlRefresher,
): Promise<{ html: string; replaced: number; skipped: number }> {
  const urls: string[] = []
  const re = /<img[^>]+src="([^"]+)"/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (m[1].startsWith('http')) urls.push(m[1])
  }
  const unique = [...new Set(urls)]

  const replacements = new Map<string, string>()
  let skipped = 0
  for (const url of unique) {
    const result = await downloader.downloadAndUpload(url, articleSlug, {
      refreshUrl: refresher ? () => refresher(url) : undefined,
    })
    if (result) replacements.set(url, result.driveUrl)
    else skipped++
  }

  let out = html
  for (const [from, to] of replacements) {
    out = out.split(from).join(to)
  }
  return { html: out, replaced: replacements.size, skipped }
}

export function makeSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'article'
}
