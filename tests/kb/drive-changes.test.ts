import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { determineTier, findStaleDriveDocuments } from '../../src/kb/ingestion/drive.js'

describe('Drive Changes API integration', () => {
  it('findStaleDriveDocuments is exported as a function', () => {
    assert.equal(typeof findStaleDriveDocuments, 'function')
  })

  it('determineTier correctly classifies recently modified files as full', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000)
    assert.equal(determineTier(tenDaysAgo), 'full')
  })

  it('determineTier correctly classifies older files as metadata', () => {
    const halfYearAgo = new Date(Date.now() - 180 * 86_400_000)
    assert.equal(determineTier(halfYearAgo), 'metadata')
  })
})
