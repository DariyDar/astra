import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.js'

const { Pool } = pg

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

export const db = drizzle(pool, { schema })

/**
 * Close the database connection pool.
 * Call during graceful shutdown.
 */
export async function closeDb(): Promise<void> {
  await pool.end()
}
