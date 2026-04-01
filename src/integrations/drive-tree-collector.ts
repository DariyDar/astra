/**
 * Google Drive tree collector.
 * Builds a folder/file tree and saves it to vault/_drive-tree.md
 * for Astra to use as context when working with Drive.
 *
 * Run: npx tsx scripts/drive-tree-collector.ts
 * Cron: Mon/Wed/Fri via worker
 */

import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveGoogleTokens } from '../mcp/briefing/google-auth.js'
import { logger } from '../logging/logger.js'

const GOOGLE_ACCOUNT = 'dariy@astrocat.co'
const VAULT_PATH = join(process.cwd(), 'vault')

interface DriveFile {
  id: string
  name: string
  mimeType: string
  parents?: string[]
}

async function listAllFiles(token: string, query: string): Promise<DriveFile[]> {
  const all: DriveFile[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({
      q: query,
      fields: 'nextPageToken,files(id,name,mimeType,parents)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const resp = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!resp.ok) throw new Error(`Drive API ${resp.status}`)
    const data = await resp.json() as { files: DriveFile[]; nextPageToken?: string }
    all.push(...(data.files || []))
    pageToken = data.nextPageToken
  } while (pageToken)
  return all
}

export async function collectDriveTree(): Promise<{ folderCount: number; fileCount: number }> {
  const tokens = await resolveGoogleTokens()
  const token = tokens.get(GOOGLE_ACCOUNT)
  if (!token) throw new Error(`No token for ${GOOGLE_ACCOUNT}`)

  // Fetch all folders and files
  const folders = await listAllFiles(token, "mimeType = 'application/vnd.google-apps.folder' and trashed = false")
  const files = await listAllFiles(token, "mimeType != 'application/vnd.google-apps.folder' and trashed = false")

  // Build maps
  const folderMap = new Map<string, DriveFile>()
  const childFolders = new Map<string, DriveFile[]>()
  const childFiles = new Map<string, DriveFile[]>()

  for (const f of folders) {
    folderMap.set(f.id, f)
    const pid = f.parents?.[0] ?? 'root'
    if (!childFolders.has(pid)) childFolders.set(pid, [])
    childFolders.get(pid)!.push(f)
  }

  for (const f of files) {
    const pid = f.parents?.[0] ?? 'root'
    if (!childFiles.has(pid)) childFiles.set(pid, [])
    childFiles.get(pid)!.push(f)
  }

  // Find roots
  const rootIds = new Set<string>()
  for (const f of folders) {
    const pid = f.parents?.[0]
    if (!pid || !folderMap.has(pid)) rootIds.add(f.id)
  }

  // Build tree (folders only for top 3 levels, files only for top 2 levels to keep size manageable)
  const lines: string[] = [
    `---`,
    `type: drive-tree`,
    `account: ${GOOGLE_ACCOUNT}`,
    `updated: ${new Date().toISOString()}`,
    `folders: ${folders.length}`,
    `files: ${files.length}`,
    `---`,
    '',
    `# Google Drive Tree — ${GOOGLE_ACCOUNT}`,
    '',
  ]

  function addFolder(folderId: string, depth: number, prefix: string, isLast: boolean) {
    const f = folderMap.get(folderId)!
    const connector = isLast ? '└── ' : '├── '
    lines.push(`${prefix}${connector}📁 ${f.name}`)

    const newPrefix = prefix + (isLast ? '    ' : '│   ')
    const subFolders = (childFolders.get(folderId) ?? []).sort((a, b) => a.name.localeCompare(b.name))
    const subFiles = (childFiles.get(folderId) ?? []).sort((a, b) => a.name.localeCompare(b.name))

    // Only show files at depth 0-1, folders at depth 0-2
    const showFiles = depth < 2
    const showSubFolders = depth < 3

    const items = showSubFolders ? subFolders : []
    const fileItems = showFiles ? subFiles : []
    const total = items.length + fileItems.length

    if (!showSubFolders && subFolders.length > 0) {
      lines.push(`${newPrefix}    (${subFolders.length} subfolders, ${subFiles.length} files)`)
      return
    }

    let idx = 0
    for (const sf of items) {
      idx++
      addFolder(sf.id, depth + 1, newPrefix, idx === total)
    }
    for (const sf of fileItems) {
      idx++
      const c = idx === total ? '└── ' : '├── '
      lines.push(`${newPrefix}${c}${sf.name}`)
    }

    if (!showFiles && subFiles.length > 0 && items.length > 0) {
      // Already shown folders, just note file count
    } else if (!showFiles && subFiles.length > 0) {
      lines.push(`${newPrefix}    (${subFiles.length} files)`)
    }
  }

  const roots = [...rootIds].map(id => folderMap.get(id)!).sort((a, b) => a.name.localeCompare(b.name))
  const rootFiles = files.filter(f => {
    const pid = f.parents?.[0]
    return !pid || !folderMap.has(pid)
  })

  for (let i = 0; i < roots.length; i++) {
    addFolder(roots[i].id, 0, '', i === roots.length - 1 && rootFiles.length === 0)
  }

  if (rootFiles.length > 0) {
    lines.push('')
    lines.push('## Root-level files')
    lines.push('')
    for (const f of rootFiles.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`- ${f.name}`)
    }
  }

  // Save to vault
  const output = lines.join('\n')
  const outPath = join(VAULT_PATH, '_drive-tree.md')
  writeFileSync(outPath, output, 'utf-8')

  return { folderCount: folders.length, fileCount: files.length }
}

// CLI entry point
if (process.argv[1]?.includes('drive-tree-collector')) {
  collectDriveTree()
    .then(stats => {
      logger.info(stats, 'Drive tree collected')
      console.log(`Done: ${stats.folderCount} folders, ${stats.fileCount} files`)
    })
    .catch(err => {
      console.error(err)
      process.exit(1)
    })
}
