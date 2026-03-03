import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { determineTier, truncateContent, isExportable } from '../../src/kb/ingestion/drive.js'

describe('determineTier', () => {
  function daysAgo(n: number): Date {
    return new Date(Date.now() - n * 86_400_000)
  }

  it('returns "full" for file modified 5 days ago', () => {
    assert.equal(determineTier(daysAgo(5)), 'full')
  })

  it('returns "full" for file modified 29 days ago', () => {
    assert.equal(determineTier(daysAgo(29)), 'full')
  })

  it('returns "full" for file modified today (0 days)', () => {
    assert.equal(determineTier(daysAgo(0)), 'full')
  })

  it('returns "full" for file modified exactly 30 days ago (boundary: <=30)', () => {
    assert.equal(determineTier(daysAgo(30)), 'full')
  })

  it('returns "acquaintance" for file modified 31 days ago', () => {
    assert.equal(determineTier(daysAgo(31)), 'acquaintance')
  })

  it('returns "acquaintance" for file modified 89 days ago', () => {
    assert.equal(determineTier(daysAgo(89)), 'acquaintance')
  })

  it('returns "acquaintance" for file modified exactly 90 days ago (boundary: <=90)', () => {
    assert.equal(determineTier(daysAgo(90)), 'acquaintance')
  })

  it('returns "metadata" for file modified 91 days ago', () => {
    assert.equal(determineTier(daysAgo(91)), 'metadata')
  })

  it('returns "metadata" for file modified 365 days ago', () => {
    assert.equal(determineTier(daysAgo(365)), 'metadata')
  })
})

describe('truncateContent', () => {
  it('returns text unchanged when shorter than limit', () => {
    assert.equal(truncateContent('hello world', 100), 'hello world')
  })

  it('truncates and appends marker when text exceeds limit', () => {
    const text = 'a'.repeat(200)
    const result = truncateContent(text, 50)
    assert.equal(result, 'a'.repeat(50) + '\n[... truncated]')
  })

  it('returns empty string for empty input', () => {
    assert.equal(truncateContent('', 100), '')
  })

  it('returns text unchanged when exactly at limit', () => {
    const text = 'x'.repeat(100)
    assert.equal(truncateContent(text, 100), text)
  })
})

describe('isExportable', () => {
  it('returns true for Google Docs', () => {
    assert.equal(isExportable('application/vnd.google-apps.document'), true)
  })

  it('returns true for Google Sheets', () => {
    assert.equal(isExportable('application/vnd.google-apps.spreadsheet'), true)
  })

  it('returns true for Google Slides', () => {
    assert.equal(isExportable('application/vnd.google-apps.presentation'), true)
  })

  it('returns false for PDF', () => {
    assert.equal(isExportable('application/pdf'), false)
  })

  it('returns false for PNG images', () => {
    assert.equal(isExportable('image/png'), false)
  })

  it('returns false for Office documents', () => {
    assert.equal(
      isExportable('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      false,
    )
  })
})
