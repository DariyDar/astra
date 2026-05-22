/**
 * Wiki Editor MCP tools — read/find/write Google Docs in the Company Wiki.
 *
 * Wraps the Drive API. All writes go through the same OAuth account that
 * already has scope `drive`. The tools intentionally mirror the contract
 * described in vault/instructions-for-llm/skill-wiki-editor.md.
 */

import { resolveGoogleTokens, GOOGLE_ACCOUNTS } from './google-auth.js'
import { log } from './utils.js'

const COMPANY_WIKI_ROOT_NAME = 'Company Wiki'

interface DriveFile {
  id: string
  name: string
  mimeType: string
  parents?: string[]
  webViewLink?: string
  modifiedTime?: string
}

async function getToken(): Promise<string> {
  const tokens = await resolveGoogleTokens()
  const token = tokens.get(GOOGLE_ACCOUNTS[0]) ?? [...tokens.values()][0]
  if (!token) throw new Error(`No Google access token available`)
  return token
}

async function driveRequest(
  url: string,
  init?: RequestInit,
  token?: string,
): Promise<Response> {
  const accessToken = token ?? (await getToken())
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(60_000),
  })
}

function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

async function findCompanyWikiRoot(token: string): Promise<string> {
  const q = `name = '${escape(COMPANY_WIKI_ROOT_NAME)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name)',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  })
  const resp = await driveRequest(`https://www.googleapis.com/drive/v3/files?${params}`, undefined, token)
  if (!resp.ok) throw new Error(`Drive findCompanyWikiRoot failed: ${resp.status}`)
  const data = await resp.json() as { files?: DriveFile[] }
  if (!data.files?.length) throw new Error(`Folder "${COMPANY_WIKI_ROOT_NAME}" not found in Drive`)
  return data.files[0].id
}

// ── wiki_find ──

export const wikiFindTool = {
  name: 'wiki_find',
  description: `Search for a Wiki article by name within Company Wiki folder tree on Google Drive. Returns up to 20 matches, each with id, title, full path, and mimeType. Use this BEFORE wiki_read or wiki_write to resolve ambiguity. Searches recursively (limited to Company Wiki and its descendants).`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string' as const,
        description: 'Article name or part of it (case-insensitive substring match).',
      },
    },
    required: ['query'],
  },
}

export async function handleWikiFind(args: Record<string, unknown>): Promise<{ matches: Array<{ fileId: string; title: string; path: string; mimeType: string; webViewLink?: string }> }> {
  const query = String(args.query ?? '').trim()
  if (!query) throw new Error('query is required')

  const token = await getToken()
  const wikiRoot = await findCompanyWikiRoot(token)

  // Drive query: name contains query, restrict to descendants of wikiRoot via fullText is not ideal,
  // so we use 'name contains' with a search within all of Drive then post-filter by parent chain.
  const params = new URLSearchParams({
    q: `name contains '${escape(query)}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
    fields: 'files(id,name,mimeType,parents,webViewLink)',
    pageSize: '50',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  })
  const resp = await driveRequest(`https://www.googleapis.com/drive/v3/files?${params}`, undefined, token)
  if (!resp.ok) throw new Error(`Drive search failed: ${resp.status}`)
  const data = await resp.json() as { files?: DriveFile[] }
  const candidates = data.files ?? []

  // Filter to only those whose parent chain includes wikiRoot
  const matches: Array<{ fileId: string; title: string; path: string; mimeType: string; webViewLink?: string }> = []
  for (const file of candidates) {
    const path = await resolvePath(file, wikiRoot, token)
    if (!path) continue
    matches.push({
      fileId: file.id,
      title: file.name,
      path,
      mimeType: file.mimeType,
      webViewLink: file.webViewLink,
    })
    if (matches.length >= 20) break
  }
  return { matches }
}

const folderNameCache = new Map<string, { name: string; parents?: string[] }>()

async function resolvePath(file: DriveFile, wikiRoot: string, token: string): Promise<string | null> {
  const segments: string[] = [file.name]
  let parents = file.parents ?? []
  for (let i = 0; i < 10; i++) {
    if (parents.length === 0) return null
    const parentId = parents[0]
    if (parentId === wikiRoot) {
      return [COMPANY_WIKI_ROOT_NAME, ...segments].join(' / ')
    }
    let info = folderNameCache.get(parentId)
    if (!info) {
      const resp = await driveRequest(
        `https://www.googleapis.com/drive/v3/files/${parentId}?fields=id,name,parents&supportsAllDrives=true`,
        undefined,
        token,
      )
      if (!resp.ok) return null
      const data = await resp.json() as DriveFile
      info = { name: data.name, parents: data.parents }
      folderNameCache.set(parentId, info)
    }
    segments.unshift(info.name)
    parents = info.parents ?? []
  }
  return null
}

// ── wiki_read ──

export const wikiReadTool = {
  name: 'wiki_read',
  description: `Read the current content of a Wiki article (Google Doc) by file ID. Returns the article as HTML by default (suitable for diffing/editing). Use wiki_find first if you only have the title.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      fileId: {
        type: 'string' as const,
        description: 'Google Drive file ID of the article.',
      },
      format: {
        type: 'string' as const,
        enum: ['html', 'text'],
        description: 'Output format. Default: html.',
        default: 'html',
      },
    },
    required: ['fileId'],
  },
}

export async function handleWikiRead(args: Record<string, unknown>): Promise<{ fileId: string; title: string; content: string; modifiedTime: string }> {
  const fileId = String(args.fileId ?? '').trim()
  if (!fileId) throw new Error('fileId is required')
  const format = (args.format as string) === 'text' ? 'text/plain' : 'text/html'

  const token = await getToken()
  const metaResp = await driveRequest(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,modifiedTime&supportsAllDrives=true`,
    undefined,
    token,
  )
  if (!metaResp.ok) throw new Error(`Drive metadata failed: ${metaResp.status}`)
  const meta = await metaResp.json() as DriveFile

  if (meta.mimeType !== 'application/vnd.google-apps.document') {
    throw new Error(`File is not a Google Doc (mimeType=${meta.mimeType})`)
  }

  const exportResp = await driveRequest(
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(format)}`,
    undefined,
    token,
  )
  if (!exportResp.ok) throw new Error(`Drive export failed: ${exportResp.status}`)
  const content = await exportResp.text()

  return {
    fileId,
    title: meta.name,
    content,
    modifiedTime: meta.modifiedTime ?? '',
  }
}

// ── wiki_write ──

export const wikiWriteTool = {
  name: 'wiki_write',
  description: `Create or update a Wiki article (Google Doc) from HTML content. ALWAYS confirm with the user before calling this tool — Wiki articles are visible to the entire company.

Use one of:
  - {fileId, htmlContent} — update existing article (overwrite content).
  - {parentFolderId, name, htmlContent} — create new article in given folder.

The HTML must follow the wiki styleguide (see skill-wiki-editor.md): only allowed tags, no inline styles or classes. Drive will convert HTML to Google Docs format on import.

If updating, the optional ifModifiedTimeBefore parameter (ISO timestamp) lets you guard against concurrent edits — the call fails if the document was modified after that time.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      fileId: {
        type: 'string' as const,
        description: 'File ID of existing Doc to update. Omit when creating a new article.',
      },
      parentFolderId: {
        type: 'string' as const,
        description: 'Drive folder ID where to create the new Doc. Required when fileId is omitted.',
      },
      name: {
        type: 'string' as const,
        description: 'Article title (also the Doc filename). Required when creating new.',
      },
      htmlContent: {
        type: 'string' as const,
        description: 'Full HTML content of the article. Must comply with the wiki styleguide.',
      },
      ifModifiedTimeBefore: {
        type: 'string' as const,
        description: 'Optional ISO timestamp guard for updates — abort if Doc was modified after this time.',
      },
    },
    required: ['htmlContent'],
  },
}

export async function handleWikiWrite(args: Record<string, unknown>): Promise<{ fileId: string; webViewLink: string; created: boolean }> {
  const htmlContent = String(args.htmlContent ?? '')
  if (!htmlContent) throw new Error('htmlContent is required')
  const fileId = (args.fileId as string | undefined)?.trim() || undefined
  const parentFolderId = (args.parentFolderId as string | undefined)?.trim() || undefined
  const name = (args.name as string | undefined)?.trim() || undefined
  const ifModifiedTimeBefore = args.ifModifiedTimeBefore as string | undefined

  if (!fileId && !(parentFolderId && name)) {
    throw new Error('Either fileId, or parentFolderId+name must be provided')
  }

  const token = await getToken()

  if (fileId) {
    if (ifModifiedTimeBefore) {
      const metaResp = await driveRequest(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=modifiedTime&supportsAllDrives=true`,
        undefined,
        token,
      )
      if (metaResp.ok) {
        const meta = await metaResp.json() as DriveFile
        if (meta.modifiedTime && meta.modifiedTime > ifModifiedTimeBefore) {
          throw new Error(`Doc was modified at ${meta.modifiedTime} after guard ${ifModifiedTimeBefore} — aborting to avoid overwriting concurrent edit`)
        }
      }
    }

    const resp = await driveRequest(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&supportsAllDrives=true`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'text/html' },
        body: htmlContent,
      },
      token,
    )
    if (!resp.ok) throw new Error(`Drive update failed: ${resp.status} ${await resp.text()}`)
    const linkResp = await driveRequest(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=webViewLink&supportsAllDrives=true`,
      undefined,
      token,
    )
    const linkData = linkResp.ok ? (await linkResp.json() as DriveFile) : { webViewLink: '' }
    log(`wiki_write: updated fileId=${fileId}`)
    return {
      fileId,
      webViewLink: linkData.webViewLink ?? `https://docs.google.com/document/d/${fileId}/edit`,
      created: false,
    }
  }

  // Create new
  const boundary = '===wiki_create_boundary==='
  const metadata = JSON.stringify({
    name,
    mimeType: 'application/vnd.google-apps.document',
    parents: [parentFolderId],
  })
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    'Content-Type: text/html',
    '',
    htmlContent,
    `--${boundary}--`,
  ].join('\r\n')

  const resp = await driveRequest(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink',
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    },
    token,
  )
  if (!resp.ok) throw new Error(`Drive create failed: ${resp.status} ${await resp.text()}`)
  const data = await resp.json() as DriveFile
  log(`wiki_write: created fileId=${data.id} name=${name}`)
  return {
    fileId: data.id,
    webViewLink: data.webViewLink ?? `https://docs.google.com/document/d/${data.id}/edit`,
    created: true,
  }
}

// ── wiki_list_folder ──

export const wikiListFolderTool = {
  name: 'wiki_list_folder',
  description: `List articles and subfolders inside a Wiki folder. Use to explore the structure (e.g., to find the right place for a new article). Either pass folderId, or path like "Проектная документация / [01] Pong" — relative to Company Wiki root.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      folderId: {
        type: 'string' as const,
        description: 'Drive folder ID. Omit if using path.',
      },
      path: {
        type: 'string' as const,
        description: 'Path under Company Wiki, segments separated by " / ". Example: "Проектная документация / [01] Pong"',
      },
    },
  },
}

export async function handleWikiListFolder(args: Record<string, unknown>): Promise<{ folderId: string; items: Array<{ id: string; name: string; mimeType: string }> }> {
  const token = await getToken()
  let folderId = (args.folderId as string | undefined) ?? ''

  if (!folderId) {
    const path = String(args.path ?? '').trim()
    folderId = await resolveFolderByPath(path, token)
  }

  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType)',
    pageSize: '200',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    orderBy: 'name',
  })
  const resp = await driveRequest(`https://www.googleapis.com/drive/v3/files?${params}`, undefined, token)
  if (!resp.ok) throw new Error(`Drive list folder failed: ${resp.status}`)
  const data = await resp.json() as { files?: DriveFile[] }
  return { folderId, items: (data.files ?? []).map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType })) }
}

// ── docs_edit ──

export const docsEditTool = {
  name: 'docs_edit',
  description: `Make targeted text replacements in any Google Doc without touching its formatting. Use this for non-wiki documents (Board Meeting notes, trackers, reports, etc.) — unlike wiki_write, it does NOT overwrite the whole document.

Each replacement finds all occurrences of a string and replaces them. Formatting, styles, and untouched content are preserved.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      fileId: {
        type: 'string' as const,
        description: 'Google Doc file ID.',
      },
      replacements: {
        type: 'array' as const,
        description: 'List of find/replace operations to apply in order.',
        items: {
          type: 'object' as const,
          properties: {
            find: { type: 'string' as const, description: 'Exact text to search for.' },
            replace: { type: 'string' as const, description: 'Text to replace with.' },
            matchCase: { type: 'boolean' as const, description: 'Case-sensitive match (default: true).' },
          },
          required: ['find', 'replace'],
        },
      },
    },
    required: ['fileId', 'replacements'],
  },
}

export async function handleDocsEdit(args: Record<string, unknown>): Promise<{ fileId: string; occurrencesChanged: number }> {
  const fileId = String(args.fileId ?? '').trim()
  if (!fileId) throw new Error('fileId is required')

  const replacements = args.replacements as Array<{ find: string; replace: string; matchCase?: boolean }>
  if (!replacements?.length) throw new Error('replacements must be a non-empty array')

  const token = await getToken()

  const requests = replacements.map(r => ({
    replaceAllText: {
      containsText: { text: r.find, matchCase: r.matchCase !== false },
      replaceText: r.replace,
    },
  }))

  const resp = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) throw new Error(`Docs batchUpdate failed: ${resp.status} ${await resp.text()}`)

  const data = await resp.json() as { replies?: Array<{ replaceAllText?: { occurrencesChanged?: number } }> }
  const total = (data.replies ?? []).reduce((sum, r) => sum + (r.replaceAllText?.occurrencesChanged ?? 0), 0)
  log(`docs_edit: fileId=${fileId} replacements=${replacements.length} occurrencesChanged=${total}`)

  return { fileId, occurrencesChanged: total }
}

async function resolveFolderByPath(path: string, token: string): Promise<string> {
  const wikiRoot = await findCompanyWikiRoot(token)
  if (!path) return wikiRoot
  const segments = path.split(/\s*\/\s*/).filter(Boolean).filter(s => s !== COMPANY_WIKI_ROOT_NAME)
  let parentId = wikiRoot
  for (const segment of segments) {
    const params = new URLSearchParams({
      q: `name = '${escape(segment)}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name)',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    })
    const resp = await driveRequest(`https://www.googleapis.com/drive/v3/files?${params}`, undefined, token)
    if (!resp.ok) throw new Error(`Drive resolveFolderByPath failed: ${resp.status}`)
    const data = await resp.json() as { files?: DriveFile[] }
    if (!data.files?.length) throw new Error(`Folder "${segment}" not found under "${parentId}"`)
    parentId = data.files[0].id
  }
  return parentId
}
