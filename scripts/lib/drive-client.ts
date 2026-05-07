/**
 * Google Drive helpers — folder lookup/create, Doc upload, Sheet creation.
 * Reuses OAuth tokens resolved by src/mcp/briefing/google-auth.ts.
 *
 * Note: scope `https://www.googleapis.com/auth/drive` is granted, but
 * `https://www.googleapis.com/auth/spreadsheets` is NOT. So we cannot use
 * Sheets API v4 directly for cell writes — we create a Spreadsheet via
 * Drive API by uploading CSV and letting Drive convert it.
 */

export interface DriveFile {
  id: string
  name: string
  mimeType?: string
  parents?: string[]
  webViewLink?: string
}

export class DriveClient {
  constructor(private token: string) {
    if (!token) throw new Error('Google access token required')
  }

  private async request(url: string, init?: RequestInit): Promise<Response> {
    const resp = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(60_000),
    })
    return resp
  }

  async findFolder(name: string, parentId?: string): Promise<string | null> {
    let q = `name = '${escape(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    if (parentId) q += ` and '${parentId}' in parents`
    const params = new URLSearchParams({
      q,
      fields: 'files(id,name)',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    })
    const resp = await this.request(`https://www.googleapis.com/drive/v3/files?${params}`)
    if (!resp.ok) throw new Error(`Drive findFolder: ${resp.status} ${await resp.text()}`)
    const data = await resp.json() as { files?: DriveFile[] }
    return data.files?.[0]?.id ?? null
  }

  async findOrCreateFolder(name: string, parentId: string): Promise<string> {
    const existing = await this.findFolder(name, parentId)
    if (existing) return existing
    const resp = await this.request('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      }),
    })
    if (!resp.ok) throw new Error(`Drive createFolder: ${resp.status} ${await resp.text()}`)
    const data = await resp.json() as DriveFile
    return data.id
  }

  /** Find a Doc/Sheet/Folder by name within a parent. */
  async findFile(name: string, parentId: string, mimeType?: string): Promise<string | null> {
    let q = `name = '${escape(name)}' and '${parentId}' in parents and trashed = false`
    if (mimeType) q += ` and mimeType = '${mimeType}'`
    const params = new URLSearchParams({
      q,
      fields: 'files(id,name,mimeType)',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    })
    const resp = await this.request(`https://www.googleapis.com/drive/v3/files?${params}`)
    if (!resp.ok) throw new Error(`Drive findFile: ${resp.status} ${await resp.text()}`)
    const data = await resp.json() as { files?: DriveFile[] }
    return data.files?.[0]?.id ?? null
  }

  /**
   * Create or update a Google Doc from HTML.
   * If a Doc with the same name exists in the parent — updates it (PATCH).
   */
  async uploadAsGoogleDoc(name: string, htmlContent: string, parentId: string): Promise<string> {
    const existing = await this.findFile(name, parentId, 'application/vnd.google-apps.document')

    if (existing) {
      const resp = await this.request(
        `https://www.googleapis.com/upload/drive/v3/files/${existing}?uploadType=media&supportsAllDrives=true`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'text/html' },
          body: htmlContent,
        },
      )
      if (!resp.ok) throw new Error(`Drive uploadAsGoogleDoc update: ${resp.status} ${await resp.text()}`)
      return existing
    }

    const boundary = '===drive_upload_boundary==='
    const metadata = JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.document',
      parents: [parentId],
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

    const resp = await this.request(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      },
    )
    if (!resp.ok) throw new Error(`Drive uploadAsGoogleDoc create: ${resp.status} ${await resp.text()}`)
    const data = await resp.json() as DriveFile
    return data.id
  }

  /**
   * Create a Google Sheet from CSV. Drive auto-converts to Sheets when
   * we set mimeType=application/vnd.google-apps.spreadsheet on import.
   * If a Sheet with same name exists — updates content (PATCH).
   */
  async uploadAsGoogleSheet(name: string, csvContent: string, parentId: string): Promise<string> {
    const existing = await this.findFile(name, parentId, 'application/vnd.google-apps.spreadsheet')

    if (existing) {
      const resp = await this.request(
        `https://www.googleapis.com/upload/drive/v3/files/${existing}?uploadType=media&supportsAllDrives=true`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'text/csv' },
          body: csvContent,
        },
      )
      if (!resp.ok) throw new Error(`Drive uploadAsGoogleSheet update: ${resp.status} ${await resp.text()}`)
      return existing
    }

    const boundary = '===sheet_upload_boundary==='
    const metadata = JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [parentId],
    })
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      metadata,
      `--${boundary}`,
      'Content-Type: text/csv',
      '',
      csvContent,
      `--${boundary}--`,
    ].join('\r\n')

    const resp = await this.request(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      },
    )
    if (!resp.ok) throw new Error(`Drive uploadAsGoogleSheet create: ${resp.status} ${await resp.text()}`)
    const data = await resp.json() as DriveFile
    return data.id
  }

  async getFileLink(fileId: string): Promise<string> {
    const resp = await this.request(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=webViewLink&supportsAllDrives=true`,
    )
    if (!resp.ok) throw new Error(`Drive getFileLink: ${resp.status}`)
    const data = await resp.json() as DriveFile
    return data.webViewLink ?? `https://drive.google.com/file/d/${fileId}/view`
  }
}

function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export function rowsToCsv(rows: Array<Array<unknown>>): string {
  return rows.map(row => row.map(csvEscape).join(',')).join('\r\n')
}
