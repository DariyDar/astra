import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseKnowledgeExtraction, buildChunkHeader } from '../../src/kb/knowledge-extractor.js'

// --- Tests ---

describe('parseKnowledgeExtraction', () => {
  it('parses valid JSON with all 4 sections', () => {
    const input = JSON.stringify({
      entities: [{ name: 'Семён', type: 'person', aliases: ['Semyon'], company: 'hg' }],
      relations: [{ from: 'Семён', to: 'Oregon Trail', relation: 'works_on', role: 'developer' }],
      facts: [{ entity: 'Oregon Trail', date: '2026-02-28', type: 'milestone', text: 'Released v2.0' }],
      documents: [{ entity: 'Oregon Trail', title: 'OT Spec', url: 'https://notion.so/ot-spec', source: 'notion', type: 'spec' }],
    })
    const result = parseKnowledgeExtraction(input)
    assert.ok(result)
    assert.equal(result.entities.length, 1)
    assert.equal(result.relations.length, 1)
    assert.equal(result.facts.length, 1)
    assert.equal(result.documents.length, 1)
  })

  it('parses markdown-fenced JSON', () => {
    const input = '```json\n{"entities": [{"name": "Alice", "type": "person"}], "relations": [], "facts": [], "documents": []}\n```'
    const result = parseKnowledgeExtraction(input)
    assert.ok(result)
    assert.equal(result.entities.length, 1)
  })

  it('returns null for garbage text', () => {
    const result = parseKnowledgeExtraction('I could not extract anything.')
    assert.equal(result, null)
  })

  it('defaults missing arrays to empty', () => {
    const result = parseKnowledgeExtraction('{"entities": []}')
    assert.ok(result)
    assert.deepEqual(result.relations, [])
    assert.deepEqual(result.facts, [])
    assert.deepEqual(result.documents, [])
  })

  it('filters out entities with invalid type', () => {
    const input = JSON.stringify({
      entities: [
        { name: 'Valid', type: 'person' },
        { name: 'Bad', type: 'animal' },
      ],
      relations: [],
      facts: [],
      documents: [],
    })
    const result = parseKnowledgeExtraction(input)
    assert.ok(result)
    assert.equal(result.entities.length, 1)
    assert.equal(result.entities[0].name, 'Valid')
  })

  it('filters out entities with empty name', () => {
    const input = JSON.stringify({
      entities: [
        { name: '', type: 'person' },
        { name: '  ', type: 'person' },
        { name: 'Good', type: 'person' },
      ],
      relations: [],
      facts: [],
      documents: [],
    })
    const result = parseKnowledgeExtraction(input)
    assert.ok(result)
    assert.equal(result.entities.length, 1)
  })

  it('filters out entities with name too long', () => {
    const longName = 'A'.repeat(201)
    const input = JSON.stringify({
      entities: [{ name: longName, type: 'person' }],
      relations: [],
      facts: [],
      documents: [],
    })
    const result = parseKnowledgeExtraction(input)
    assert.ok(result)
    assert.equal(result.entities.length, 0)
  })

  it('filters out relations with invalid type', () => {
    const input = JSON.stringify({
      entities: [],
      relations: [
        { from: 'A', to: 'B', relation: 'works_on' },
        { from: 'A', to: 'B', relation: 'loves' },
      ],
      facts: [],
      documents: [],
    })
    const result = parseKnowledgeExtraction(input)
    assert.ok(result)
    assert.equal(result.relations.length, 1)
  })

  it('filters out facts with invalid type', () => {
    const input = JSON.stringify({
      entities: [],
      relations: [],
      facts: [
        { entity: 'X', text: 'done', type: 'milestone' },
        { entity: 'X', text: 'nope', type: 'rumor' },
      ],
      documents: [],
    })
    const result = parseKnowledgeExtraction(input)
    assert.ok(result)
    assert.equal(result.facts.length, 1)
  })

  it('filters out facts without entity or text', () => {
    const input = JSON.stringify({
      entities: [],
      relations: [],
      facts: [
        { entity: '', text: 'done', type: 'event' },
        { entity: 'X', text: '', type: 'event' },
        { entity: 'X', text: 'good', type: 'event' },
      ],
      documents: [],
    })
    const result = parseKnowledgeExtraction(input)
    assert.ok(result)
    assert.equal(result.facts.length, 1)
  })

  it('filters out documents without url', () => {
    const input = JSON.stringify({
      entities: [],
      relations: [],
      facts: [],
      documents: [
        { entity: 'X', title: 'Doc', url: '', source: 'notion', type: 'spec' },
        { entity: 'X', title: 'Doc2', url: 'https://notion.so/doc', source: 'notion', type: 'spec' },
      ],
    })
    const result = parseKnowledgeExtraction(input)
    assert.ok(result)
    assert.equal(result.documents.length, 1)
  })

  it('filters out documents with invalid source', () => {
    const input = JSON.stringify({
      entities: [],
      relations: [],
      facts: [],
      documents: [
        { entity: 'X', title: 'Doc', url: 'https://github.com/x', source: 'github', type: 'spec' },
        { entity: 'X', title: 'Doc2', url: 'https://notion.so/doc', source: 'notion', type: 'spec' },
      ],
    })
    const result = parseKnowledgeExtraction(input)
    assert.ok(result)
    assert.equal(result.documents.length, 1)
  })

  it('filters out documents with invalid type', () => {
    const input = JSON.stringify({
      entities: [],
      relations: [],
      facts: [],
      documents: [
        { entity: 'X', title: 'Doc', url: 'https://notion.so/x', source: 'notion', type: 'tutorial' },
        { entity: 'X', title: 'Doc2', url: 'https://notion.so/doc', source: 'notion', type: 'wiki' },
      ],
    })
    const result = parseKnowledgeExtraction(input)
    assert.ok(result)
    assert.equal(result.documents.length, 1)
  })

  it('filters out documents with invalid url', () => {
    const input = JSON.stringify({
      entities: [],
      relations: [],
      facts: [],
      documents: [
        { entity: 'X', title: 'Doc', url: 'not-a-url', source: 'notion', type: 'spec' },
        { entity: 'X', title: 'Doc2', url: 'https://notion.so/doc', source: 'notion', type: 'spec' },
      ],
    })
    const result = parseKnowledgeExtraction(input)
    assert.ok(result)
    assert.equal(result.documents.length, 1)
  })

  it('extracts JSON embedded in explanation text', () => {
    const input = 'Here is the extraction result:\n{"entities": [{"name": "Bob", "type": "person"}], "relations": [], "facts": [], "documents": []}\nDone.'
    const result = parseKnowledgeExtraction(input)
    assert.ok(result)
    assert.equal(result.entities.length, 1)
  })
})

describe('buildChunkHeader', () => {
  it('builds minimal header with source and id', () => {
    const header = buildChunkHeader({ source: 'slack', sourceId: 'msg123' })
    assert.equal(header, '[source=slack, id=msg123]')
  })

  it('includes metadata fields when present', () => {
    const header = buildChunkHeader({
      source: 'slack',
      sourceId: 'msg123',
      metadata: { channel: 'ac/general', userName: 'Dariy' },
      sourceDate: new Date('2026-03-01T00:00:00Z'),
    })
    assert.ok(header.includes('channel=ac/general'))
    assert.ok(header.includes('user=Dariy'))
    assert.ok(header.includes('date=2026-03-01'))
  })

  it('includes subject for email chunks', () => {
    const header = buildChunkHeader({
      source: 'gmail',
      sourceId: 'email456',
      metadata: { subject: 'Daily QA Report' },
    })
    assert.ok(header.includes('subject=Daily QA Report'))
  })

  it('includes fileName for drive chunks', () => {
    const header = buildChunkHeader({
      source: 'drive',
      sourceId: 'file789',
      metadata: { fileName: 'Design Spec.docx' },
    })
    assert.ok(header.includes('file=Design Spec.docx'))
  })
})

describe('budget logic', () => {
  function shouldStop(
    budget: { maxBatches: number; maxTimeMinutes: number },
    batchesDone: number,
    elapsedMin: number,
  ): 'continue' | 'budget_time' | 'budget_batches' {
    if (elapsedMin > budget.maxTimeMinutes) return 'budget_time'
    if (batchesDone >= budget.maxBatches) return 'budget_batches'
    return 'continue'
  }

  it('continues when within limits', () => {
    assert.equal(shouldStop({ maxBatches: 100, maxTimeMinutes: 60 }, 5, 3), 'continue')
  })

  it('stops on time limit', () => {
    assert.equal(shouldStop({ maxBatches: 100, maxTimeMinutes: 60 }, 5, 61), 'budget_time')
  })

  it('stops on batch limit', () => {
    assert.equal(shouldStop({ maxBatches: 100, maxTimeMinutes: 60 }, 100, 3), 'budget_batches')
  })

  it('time takes priority over batches', () => {
    assert.equal(shouldStop({ maxBatches: 100, maxTimeMinutes: 60 }, 100, 61), 'budget_time')
  })
})
