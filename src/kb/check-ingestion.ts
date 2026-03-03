import { Pool } from 'pg'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    // Chunks by source
    const chunks = await pool.query(`SELECT source, COUNT(*) as cnt FROM kb_chunks GROUP BY source ORDER BY cnt DESC`)
    console.log('\n=== Chunks by source ===')
    let total = 0
    for (const row of chunks.rows) {
      console.log(`  ${row.source}: ${row.cnt}`)
      total += Number(row.cnt)
    }
    console.log(`  TOTAL: ${total}`)

    // Ingestion state
    const state = await pool.query(`SELECT source, watermark, last_run, items_total, status, error FROM kb_ingestion_state ORDER BY source`)
    console.log('\n=== Ingestion state ===')
    for (const row of state.rows) {
      console.log(`  ${row.source}: status=${row.status}, items=${row.items_total}, last_run=${row.last_run?.toISOString() ?? 'never'}`)
      if (row.error) console.log(`    ERROR: ${row.error}`)
    }

    // Drive chunks specifically
    const driveChunks = await pool.query(`SELECT source_id, COUNT(*) as cnt FROM kb_chunks WHERE source = 'drive' GROUP BY source_id ORDER BY cnt DESC LIMIT 10`)
    if (driveChunks.rows.length > 0) {
      console.log('\n=== Top 10 Drive documents by chunk count ===')
      for (const row of driveChunks.rows) {
        console.log(`  ${row.source_id}: ${row.cnt} chunks`)
      }
    }
  } finally {
    await pool.end()
  }
}

main().catch(console.error)
