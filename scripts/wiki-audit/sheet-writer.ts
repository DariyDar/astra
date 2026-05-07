/**
 * Convert audit rows to CSV and upload to Google Drive as a Sheet.
 * Drive auto-converts CSV→Sheets when mimeType=spreadsheet on import.
 */

import { writeFileSync } from 'node:fs'
import { DriveClient, rowsToCsv } from '../lib/drive-client.js'
import type { AuditRow } from './types.js'

const HEADER = [
  'Источник',
  'Проект',
  'Название',
  'Ссылка',
  'Размер',
  'Обновлено',
  'Картинки',
  'Гифки',
  'Таблицы',
  'Код',
  'Вложенные',
  'Action',
  'AI-summary',
]

function rowToCsvCells(row: AuditRow): Array<unknown> {
  return [
    row.source,
    row.project,
    row.title,
    row.url,
    row.size,
    row.updatedAt,
    row.hasImages ? 'да' : '',
    row.hasGifs ? 'да' : '',
    row.hasTables ? 'да' : '',
    row.hasCode ? 'да' : '',
    row.hasNested ? 'да' : '',
    row.action,
    row.summary,
  ]
}

export function rowsToCsvString(rows: AuditRow[]): string {
  const cells: Array<Array<unknown>> = [HEADER, ...rows.map(rowToCsvCells)]
  return rowsToCsv(cells)
}

export async function writeSheet(
  drive: DriveClient,
  rows: AuditRow[],
  parentFolderId: string,
  sheetName: string,
): Promise<{ sheetId: string; link: string }> {
  const csv = rowsToCsvString(rows)
  const sheetId = await drive.uploadAsGoogleSheet(sheetName, csv, parentFolderId)
  const link = await drive.getFileLink(sheetId)
  return { sheetId, link }
}

export function writeCsvToFile(rows: AuditRow[], path: string): void {
  writeFileSync(path, rowsToCsvString(rows), 'utf-8')
}
