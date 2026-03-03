#!/usr/bin/env node
import 'dotenv/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema.js'

const source = process.argv[2]

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const db = drizzle(pool, { schema })

  if (source) {
    await db.execute(sql`DELETE FROM kb_ingestion_state WHERE source LIKE ${source + '%'}`)
    await db.execute(sql`DELETE FROM kb_chunks WHERE source = ${source}`)
    console.log(`Reset watermarks and chunks for: ${source}*`)
  } else {
    await db.execute(sql`DELETE FROM kb_ingestion_state`)
    await db.execute(sql`DELETE FROM kb_chunks`)
    console.log('Reset ALL watermarks and chunks')
  }

  await pool.end()
}

main().catch(console.error)
