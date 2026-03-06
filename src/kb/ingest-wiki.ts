#!/usr/bin/env node
/**
 * One-shot script to ingest ClickUp Wiki docs into KB.
 * Reads wiki content fetched by dump-wiki.ts (via ClickUp Docs API v3),
 * splits into logical sections, chunks, embeds, and stores.
 *
 * Usage:
 *   npx tsx src/kb/ingest-wiki.ts
 *
 * Prerequisites:
 *   - dump-wiki.ts must have been run first to create /tmp/wiki-dump.txt
 *   - DATABASE_URL must be set
 *   - Qdrant must be accessible
 */

import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { QdrantClient } from '@qdrant/js-client-rest'
import * as schema from '../db/schema.js'
import { upsertChunk } from './repository.js'
import { splitText, contentHash } from './chunker.js'
import { embed, initEmbedder } from '../memory/embedder.js'
import { KBVectorStore } from './vector-store.js'
import { logger } from '../logging/logger.js'

const WIKI_DUMP_PATH = '/tmp/wiki-dump.txt'

/** Minimum section length to be worth ingesting (chars). */
const MIN_SECTION_LENGTH = 100

/** Skip sections that are just template placeholders. */
const TEMPLATE_MARKERS = [
  '[process to be addressed]',
  '[Insert Project Name Here]',
  '[Link to resource]',
  '[Brief description]',
  '[MM/DD/YYYY]',
  'Process 1',
  'Process 2',
  'Process 3',
  'Tool 1',
  'Tool 2',
  'Tool 3',
]

interface WikiSection {
  /** Document group: "Company Wiki", "Departments Wiki", etc. */
  docGroup: string
  /** Section title. */
  title: string
  /** Nesting depth (0 = top, 1 = child, 2 = grandchild). */
  depth: number
  /** Parent section title for context. */
  parent?: string
  /** Raw text content. */
  content: string
}

/** Parse the wiki dump into logical sections. */
function parseWikiDump(raw: string): WikiSection[] {
  const lines = raw.split('\n')
  const sections: WikiSection[] = []

  let currentGroup = 'Unknown'
  // Stack tracks nesting: [depth0Title, depth1Title, ...]
  const parentStack: string[] = []
  let currentSection: WikiSection | null = null
  const contentLines: string[] = []

  function flushSection(): void {
    if (currentSection) {
      currentSection.content = contentLines.join('\n').trim()
      if (currentSection.content.length >= MIN_SECTION_LENGTH) {
        sections.push(currentSection)
      }
      contentLines.length = 0
    }
  }

  for (const line of lines) {
    // Document group header: "########## Company Wiki ##########"
    const groupMatch = line.match(/^#{10}\s+(.+?)\s+#{10}$/)
    if (groupMatch) {
      flushSection()
      currentGroup = groupMatch[1]
      currentSection = null
      parentStack.length = 0
      continue
    }

    // Section header: "=== Title ===" with leading whitespace indicating depth
    const sectionMatch = line.match(/^(\s*)=== (.+?) ===$/)
    if (sectionMatch) {
      flushSection()

      const indent = sectionMatch[1].length
      // Each 2 spaces of indent = 1 depth level
      const depth = Math.floor(indent / 2)
      const title = sectionMatch[2]

      // Update parent stack
      parentStack.length = depth
      const parent = depth > 0 ? parentStack[depth - 1] : undefined
      parentStack[depth] = title

      currentSection = { docGroup: currentGroup, title, depth, parent, content: '' }
      continue
    }

    // Skip "(empty)" markers
    if (line.trim() === '(empty)') continue

    // Accumulate content
    if (currentSection) {
      contentLines.push(line)
    }
  }

  flushSection()
  return sections
}

/** Check if a section is just a template placeholder. */
function isTemplate(section: WikiSection): boolean {
  return TEMPLATE_MARKERS.some((marker) => section.content.includes(marker))
}

/** Strip markdown image references and excess whitespace. */
function cleanContent(text: string): string {
  return text
    // Remove markdown image links
    .replace(/!\[.*?\]\(https?:\/\/[^\)]+\)/g, '')
    // Remove bare image URLs from ClickUp attachments
    .replace(/https:\/\/t\d+\.p\.clickup-attachments\.com\/[^\s]+/g, '')
    // Remove GIF URLs
    .replace(/https:\/\/media\d*\.giphy\.com\/[^\s\)]+/g, '')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Format a wiki section into chunk-ready text. */
function formatWikiSection(section: WikiSection): string {
  const parts: string[] = []
  parts.push(`[ClickUp Wiki: ${section.docGroup}]`)
  if (section.parent) {
    parts.push(`Section: ${section.parent} > ${section.title}`)
  } else {
    parts.push(`Section: ${section.title}`)
  }
  parts.push('')
  parts.push(cleanContent(section.content))
  return parts.join('\n')
}

async function main(): Promise<void> {
  logger.info('Starting ClickUp Wiki ingestion')

  // Read dump file
  let raw: string
  try {
    raw = readFileSync(WIKI_DUMP_PATH, 'utf-8')
  } catch {
    logger.error(`Wiki dump not found at ${WIKI_DUMP_PATH}. Run dump-wiki.ts first.`)
    process.exit(1)
  }

  // Parse into sections
  const allSections = parseWikiDump(raw)
  logger.info({ totalSections: allSections.length }, 'Parsed wiki sections')

  // Filter out templates and too-short sections
  const sections = allSections.filter((s) => !isTemplate(s))
  logger.info({ filteredSections: sections.length }, 'Sections after filtering templates')

  // Connect to DB
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const db = drizzle(pool, { schema })

  // Init embedder and vector store
  await initEmbedder()
  const qdrantClient = new QdrantClient({ url: process.env.QDRANT_URL ?? 'http://localhost:6333' })
  const vectorStore = new KBVectorStore(qdrantClient)
  await vectorStore.ensureCollection()

  let totalChunks = 0
  let newChunks = 0
  let skippedChunks = 0

  for (const section of sections) {
    const formatted = formatWikiSection(section)
    const chunks = splitText(formatted, 1000, 100)

    // Source ID: "wiki:{group}:{title}" — deterministic for dedup
    const baseSourceId = `wiki:${section.docGroup}:${section.title}`
      .toLowerCase()
      .replace(/[^a-zа-яё0-9:_-]/gi, '_')
      .replace(/_+/g, '_')

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i]
      const hash = contentHash(chunkText)

      try {
        const { isNew } = await upsertChunk(db, {
          source: 'clickup',
          sourceId: `${baseSourceId}:${i}`,
          chunkIndex: 0, // One chunk per sourceId since we include index in sourceId
          contentHash: hash,
          text: chunkText,
          metadata: {
            chunkType: 'document',
            docGroup: section.docGroup,
            title: section.title,
            parent: section.parent,
            wikiSource: true,
          },
        })

        totalChunks++

        if (!isNew) {
          skippedChunks++
          continue
        }

        // Embed and store in Qdrant
        const vector = await embed(chunkText)
        const qdrantId = crypto.randomUUID()

        await vectorStore.upsert([{
          id: qdrantId,
          vector,
          payload: {
            source: 'clickup',
            source_id: `${baseSourceId}:${i}`,
            chunk_type: 'document',
            entity_ids: [],
            source_date: Date.now(),
          },
        }])

        // Update chunk with qdrant_id
        await upsertChunk(db, {
          source: 'clickup',
          sourceId: `${baseSourceId}:${i}`,
          chunkIndex: 0,
          contentHash: hash,
          text: chunkText,
          qdrantId,
          metadata: {
            chunkType: 'document',
            docGroup: section.docGroup,
            title: section.title,
            parent: section.parent,
            wikiSource: true,
          },
        })

        newChunks++
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        logger.warn({ section: section.title, chunkIndex: i, error: errMsg }, 'Chunk processing failed')
      }
    }

    logger.info(
      { section: section.title, chunks: chunks.length },
      'Section ingested',
    )
  }

  logger.info(
    { totalChunks, newChunks, skippedChunks },
    'Wiki ingestion complete',
  )

  await pool.end()
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ error: msg }, 'Wiki ingestion failed')
    process.exit(1)
  })
