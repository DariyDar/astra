import { Pool } from 'pg'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    // Delete all Drive chunks
    const del = await pool.query(`DELETE FROM kb_chunks WHERE source = 'drive'`)
    console.log(`Deleted ${del.rowCount} Drive chunks`)

    // Reset Drive watermarks
    const reset = await pool.query(`DELETE FROM kb_ingestion_state WHERE source LIKE 'drive:%'`)
    console.log(`Reset ${reset.rowCount} Drive ingestion states`)
  } finally {
    await pool.end()
  }
}

main().catch(console.error)
