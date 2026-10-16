// Runs the real migrations in a throwaway database and checks the guarantees the
// application relies on (see docs/data-model.md).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPool } from './index.ts'
import { runMigrations } from './migrate.ts'

const url = process.env.DATABASE_URL

describe.skipIf(!url)('schema', () => {
  const dbName = `hourmere_test_${process.pid}_${Date.now()}`
  let admin: ReturnType<typeof createPool>
  let pool: ReturnType<typeof createPool>
  let userA: string
  let userB: string
  let org: string
  let tokenSeq = 0

  beforeAll(async () => {
    admin = createPool(url as string)
    await admin.query(`CREATE DATABASE ${dbName}`)
    const testUrl = new URL(url as string)
    testUrl.pathname = `/${dbName}`
    pool = createPool(testUrl.toString())
    await runMigrations(pool)

    const users = await pool.query<{ id: string }>(
      `INSERT INTO auth."user" (name, email, "emailVerified")
       VALUES ('A', 'a@example.com', true), ('B', 'b@example.com', true) RETURNING id`,
    )
    userA = users.rows[0]?.id as string
    userB = users.rows[1]?.id as string
    const orgs = await pool.query<{ id: string }>(
      `INSERT INTO auth.organization (name, slug, "createdAt") VALUES ('Org', 'org', now()) RETURNING id`,
    )
    org = orgs.rows[0]?.id as string
  })

  afterAll(async () => {
    await pool?.end()
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin?.end()
  })

  async function book(host: string, start: string, end: string, idempotencyKey?: string) {
    const b = await pool.query<{ id: string }>(
      `INSERT INTO bookings (organization_id, start_at, end_at, title, manage_token_hash, source, idempotency_key)
       VALUES ($1, $2, $3, 'Meeting', sha256($4::bytea), 'web', $5) RETURNING id`,
      [org, start, end, `token-${++tokenSeq}`, idempotencyKey ?? null],
    )
    const id = b.rows[0]?.id as string
    await pool.query(
      `INSERT INTO booking_hosts (booking_id, user_id, period) VALUES ($1, $2, tstzrange($3, $4))`,
      [id, host, start, end],
    )
    return id
  }

  it('is fully applied and a second run does nothing', async () => {
    expect(await runMigrations(pool)).toEqual([])
  })

  it('rejects an overlapping booking for the same host', async () => {
    await book(userA, '2026-11-02T10:00Z', '2026-11-02T10:30Z')
    await expect(book(userA, '2026-11-02T10:15Z', '2026-11-02T10:45Z')).rejects.toMatchObject({
      code: '23P01',
    })
  })

  it('allows back-to-back bookings and overlaps across different hosts', async () => {
    await expect(book(userA, '2026-11-02T10:30Z', '2026-11-02T11:00Z')).resolves.toBeTypeOf('string')
    await expect(book(userB, '2026-11-02T10:00Z', '2026-11-02T10:30Z')).resolves.toBeTypeOf('string')
  })

  it('frees the slot when a booking is cancelled', async () => {
    const id = await book(userA, '2026-11-03T09:00Z', '2026-11-03T09:30Z')
    await pool.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [
      id,
    ])
    await expect(book(userA, '2026-11-03T09:00Z', '2026-11-03T09:30Z')).resolves.toBeTypeOf('string')
  })

  it('moves the host period with the booking when it is rescheduled', async () => {
    const id = await book(userA, '2026-11-04T09:00Z', '2026-11-04T09:30Z')
    await pool.query(
      `UPDATE bookings SET start_at = '2026-11-04T14:00Z', end_at = '2026-11-04T14:30Z' WHERE id = $1`,
      [id],
    )
    const host = await pool.query(
      `SELECT lower(period) AS start FROM booking_hosts WHERE booking_id = $1`,
      [id],
    )
    expect(new Date(host.rows[0].start).toISOString()).toBe('2026-11-04T14:00:00.000Z')
    // The old time is free again; the new one is taken.
    await expect(book(userA, '2026-11-04T09:00Z', '2026-11-04T09:30Z')).resolves.toBeTypeOf('string')
    await expect(book(userA, '2026-11-04T14:00Z', '2026-11-04T14:30Z')).rejects.toMatchObject({
      code: '23P01',
    })
  })

  it('refuses a second booking with the same idempotency key in an organization', async () => {
    await book(userA, '2026-11-05T09:00Z', '2026-11-05T09:30Z', 'agent-retry-1')
    await expect(
      book(userB, '2026-11-05T11:00Z', '2026-11-05T11:30Z', 'agent-retry-1'),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('requires cancelled_at exactly when a booking is cancelled', async () => {
    const id = await book(userB, '2026-11-06T09:00Z', '2026-11-06T09:30Z')
    await expect(
      pool.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('accepts only lowercase URL-safe handles', async () => {
    const insert = (handle: string) =>
      pool.query(`INSERT INTO profiles (user_id, handle, time_zone) VALUES ($1, $2, 'UTC')`, [
        userB,
        handle,
      ])
    await expect(insert('Adrian')).rejects.toMatchObject({ code: '23514' })
    await expect(insert('-adrian')).rejects.toMatchObject({ code: '23514' })
    await expect(insert('adrian-lee')).resolves.toBeDefined()
  })
})
