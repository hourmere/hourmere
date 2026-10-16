// Test support: a throwaway, fully migrated database per test file, so tests never touch
// the data in the development database.
import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import { createPool } from './index.ts'
import { runMigrations } from './migrate.ts'

export interface TestDatabase {
  /** Connection string of the throwaway database. */
  url: string
  pool: pg.Pool
  /** Closes the pool and drops the database. */
  drop: () => Promise<void>
}

/** Creates and migrates a new database on the server that `serverUrl` points to. */
export async function createTestDatabase(serverUrl: string): Promise<TestDatabase> {
  const name = `hourmere_test_${process.pid}_${randomBytes(4).toString('hex')}`
  const admin = createPool(serverUrl)
  try {
    await admin.query(`CREATE DATABASE ${name}`)
  } finally {
    await admin.end()
  }
  const u = new URL(serverUrl)
  u.pathname = `/${name}`
  const url = u.toString()
  const pool = createPool(url)
  await runMigrations(pool)
  return {
    url,
    pool,
    drop: async () => {
      await pool.end()
      const admin = createPool(serverUrl)
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      } finally {
        await admin.end()
      }
    },
  }
}
