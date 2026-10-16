// A connection the server drops while it is checked out must not take the process down.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPool } from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('createPool', () => {
  let testDb: TestDatabase

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  it('survives a connection terminated in the middle of a transaction', async () => {
    const pool = createPool(testDb.url)
    const logged: string[] = []
    const error = console.error
    console.error = (line: string) => logged.push(line)
    try {
      const client = await pool.connect()
      await client.query('BEGIN')
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      // As a Postgres restart, failover or idle_in_transaction_session_timeout would.
      await testDb.pool.query('SELECT pg_terminate_backend($1)', [rows[0]?.pid])
      await new Promise((r) => setTimeout(r, 200))
      // Without a listener, the 'error' event would have ended the process by now.
      await expect(client.query('COMMIT')).rejects.toThrow()
      client.release(true)
      // The server's message, then the closed socket: one line each.
      expect(logged[0]).toBe(
        'Postgres client error while in use: terminating connection due to administrator command',
      )
      expect(logged.every((l) => l.startsWith('Postgres client error while in use: '))).toBe(true)
      // The pool opens a fresh connection for the next query.
      expect((await pool.query<{ one: number }>('SELECT 1 AS one')).rows).toEqual([{ one: 1 }])
    } finally {
      console.error = error
      await pool.end()
    }
  })
})
