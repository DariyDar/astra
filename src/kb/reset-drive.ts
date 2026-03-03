import 'dotenv/config'
import { Pool } from 'pg'
import { QdrantClient } from '@qdrant/js-client-rest'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    // Delete all Drive chunks from PostgreSQL
    const del = await pool.query(`DELETE FROM kb_chunks WHERE source = 'drive'`)
    console.log(`Deleted ${del.rowCount} Drive chunks`)

    // Reset Drive watermarks
    const reset = await pool.query(`DELETE FROM kb_ingestion_state WHERE source LIKE 'drive:%'`)
    console.log(`Reset ${reset.rowCount} Drive ingestion states`)
  } finally {
    await pool.end()
  }

  // Delete Drive vectors from Qdrant
  const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333'
  const qdrant = new QdrantClient({ url: qdrantUrl })

  try {
    const deleteResult = await qdrant.delete('astra_knowledge', {
      wait: true,
      filter: {
        must: [{ key: 'source', match: { value: 'drive' } }],
      },
    })
    console.log('Deleted Drive vectors from Qdrant:', JSON.stringify(deleteResult))
  } catch (err) {
    console.warn('Qdrant cleanup failed (may not be running):', err instanceof Error ? err.message : err)
  }
}

main().catch(console.error)
