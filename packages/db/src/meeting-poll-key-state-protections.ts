// Migration 0084 creates meeting_poll_key_state. These checks pass on the migration as written
// and fail when any object it creates is dropped (meeting-poll-key-state-coverage.test.ts) or
// lost by an upgrade (meeting-poll-key-state-migration.test.ts). Every check runs in a
// rolled-back transaction, so the singleton row it inserts never outlives it.
import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'
import { attempts } from './meeting-poll-protections.ts'

const FIRST_ROW = `INSERT INTO meeting_poll_key_state (secret_fingerprint)
  VALUES (decode(repeat('ab', 32), 'hex'))`

/** Throws when the key state admits a second row, a malformed fingerprint or a missing value. */
export async function assertMeetingPollKeyStateProtections(pool: pg.Pool): Promise<void> {
  // One row per installation, stamped by default.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await expect(
      client.query(`${FIRST_ROW} RETURNING singleton, updated_at = now() AS stamped`),
    ).resolves.toMatchObject({ rows: [{ singleton: true, stamped: true }] })
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }

  const [replaced, second, unpinned, short, long, missing, unstamped] = await attempts(
    pool,
    [
      {
        sql: 'UPDATE meeting_poll_key_state SET secret_fingerprint = $1, updated_at = now()',
        params: [randomBytes(32)],
      },
      {
        sql: 'INSERT INTO meeting_poll_key_state (singleton, secret_fingerprint) VALUES (true, $1)',
        params: [randomBytes(32)],
      },
      {
        sql: 'INSERT INTO meeting_poll_key_state (singleton, secret_fingerprint) VALUES (false, $1)',
        params: [randomBytes(32)],
      },
      {
        sql: 'UPDATE meeting_poll_key_state SET secret_fingerprint = $1',
        params: [randomBytes(31)],
      },
      {
        sql: 'UPDATE meeting_poll_key_state SET secret_fingerprint = $1',
        params: [randomBytes(33)],
      },
      { sql: 'UPDATE meeting_poll_key_state SET secret_fingerprint = NULL' },
      { sql: 'UPDATE meeting_poll_key_state SET updated_at = NULL' },
    ],
    FIRST_ROW,
  )
  // Plain values: a dropped object turns an expected rejection into an acceptance.
  const outcome = (error: pg.DatabaseError | undefined) =>
    error ? [error.code, error.code === '23502' ? error.column : error.constraint] : ['accepted']
  expect(
    Object.fromEntries(
      Object.entries({ replaced, second, unpinned, short, long, missing, unstamped }).map(
        ([name, error]) => [name, outcome(error)],
      ),
    ),
  ).toEqual({
    replaced: ['accepted'],
    second: ['23505', 'meeting_poll_key_state_pkey'],
    unpinned: ['23514', 'meeting_poll_key_state_singleton'],
    short: ['23514', 'meeting_poll_key_state_fingerprint_length'],
    long: ['23514', 'meeting_poll_key_state_fingerprint_length'],
    missing: ['23502', 'secret_fingerprint'],
    unstamped: ['23502', 'updated_at'],
  })
}
