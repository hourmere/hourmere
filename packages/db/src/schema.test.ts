// Runs the real migrations in a throwaway database and checks the guarantees the
// application relies on (see docs/data-model.md).
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPool } from './index.ts'
import { runMigrations } from './migrate.ts'

const url = process.env.DATABASE_URL

describe.skipIf(!url)('schema', () => {
  const dbName = `hourmere_test_${process.pid}_${Date.now()}`
  let admin: pg.Pool
  let pool: pg.Pool
  let seq = 0

  beforeAll(async () => {
    admin = createPool(url as string)
    await admin.query(`CREATE DATABASE ${dbName}`)
    const testUrl = new URL(url as string)
    testUrl.pathname = `/${dbName}`
    pool = createPool(testUrl.toString())
    await runMigrations(pool)
  })

  afterAll(async () => {
    await pool?.end()
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin?.end()
  })

  const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    (await pool.query<T>(sql, params)).rows[0] as T

  async function user() {
    const n = ++seq
    return (
      await one<{ id: string }>(
        `INSERT INTO auth."user" (name, email, "emailVerified") VALUES ($1, $2, true) RETURNING id`,
        [`User ${n}`, `user${n}@example.com`],
      )
    ).id
  }

  async function org(slug = `org-${++seq}`) {
    return (
      await one<{ id: string }>(
        `INSERT INTO auth.organization (name, slug, "createdAt") VALUES ($1, $1, now()) RETURNING id`,
        [slug],
      )
    ).id
  }

  let orgId: string
  let hostA: string
  let hostB: string

  beforeAll(async () => {
    orgId = await org()
    hostA = await user()
    hostB = await user()
  })

  interface BookOptions {
    organization?: string
    status?: 'confirmed' | 'cancelled'
    apiKeyId?: string | null
    idempotencyKey?: string
    eventTypeId?: string
    rescheduledFrom?: string
  }

  /** Inserts a booking and its host rows in one transaction, like the application will. */
  async function book(hosts: string[], start: string, end: string, o: BookOptions = {}) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const cancelled = o.status === 'cancelled'
      const b = await client.query<{ id: string }>(
        `INSERT INTO bookings (organization_id, event_type_id, status, cancelled_at, start_at, end_at,
           title, manage_token_hash, source, api_key_id, idempotency_key, idempotency_fingerprint,
           rescheduled_from_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'Meeting', sha256($7::bytea), 'api', $8, $9::text,
           CASE WHEN $9::text IS NULL THEN NULL ELSE sha256('request'::bytea) END, $10)
         RETURNING id`,
        [
          o.organization ?? orgId,
          o.eventTypeId ?? null,
          o.status ?? 'confirmed',
          cancelled ? new Date() : null,
          start,
          end,
          `token-${++seq}`,
          o.apiKeyId ?? null,
          o.idempotencyKey ?? null,
          o.rescheduledFrom ?? null,
        ],
      )
      const id = b.rows[0]?.id as string
      for (const h of hosts) {
        await client.query(`INSERT INTO booking_hosts (booking_id, user_id) VALUES ($1, $2)`, [
          id,
          h,
        ])
      }
      await client.query('COMMIT')
      return id
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  const hostRow = (bookingId: string, userId: string) =>
    one<{ start: Date; end: Date; active: boolean }>(
      `SELECT lower(period) AS start, upper(period) AS end, active FROM booking_hosts
        WHERE booking_id = $1 AND user_id = $2`,
      [bookingId, userId],
    )

  it('is fully applied and a second run does nothing', async () => {
    expect(await runMigrations(pool)).toEqual([])
  })

  describe('double-booking', () => {
    it('rejects an overlapping booking for the same host', async () => {
      await book([hostA], '2026-11-02T10:00Z', '2026-11-02T10:30Z')
      await expect(book([hostA], '2026-11-02T10:15Z', '2026-11-02T10:45Z')).rejects.toMatchObject({
        code: '23P01',
      })
    })

    it('allows back-to-back bookings and overlaps across different hosts', async () => {
      await book([hostA], '2026-11-02T10:30Z', '2026-11-02T11:00Z')
      await book([hostB], '2026-11-02T10:00Z', '2026-11-02T10:30Z')
    })

    it('rolls back a multi-host booking when one host is taken', async () => {
      const before = await one<{ n: number }>('SELECT count(*)::int AS n FROM bookings')
      await expect(
        book([hostB, hostA], '2026-11-02T10:45Z', '2026-11-02T11:15Z'),
      ).rejects.toMatchObject({ code: '23P01' })
      const after = await one<{ n: number }>('SELECT count(*)::int AS n FROM bookings')
      expect(after.n).toBe(before.n)
    })
  })

  describe('host rows are derived from the booking', () => {
    it('replaces a wrong period written by the application', async () => {
      const id = await book([], '2026-11-09T10:00Z', '2026-11-09T10:30Z')
      await pool.query(
        `INSERT INTO booking_hosts (booking_id, user_id, period, active)
         VALUES ($1, $2, tstzrange('2026-11-10T10:00Z', '2026-11-10T10:30Z'), true)`,
        [id, hostA],
      )
      expect((await hostRow(id, hostA)).start.toISOString()).toBe('2026-11-09T10:00:00.000Z')
      await expect(book([hostA], '2026-11-09T10:00Z', '2026-11-09T10:30Z')).rejects.toMatchObject({
        code: '23P01',
      })
    })

    it('replaces empty and unbounded periods', async () => {
      const id = await book([], '2026-11-09T12:00Z', '2026-11-09T12:30Z')
      await pool.query(
        `INSERT INTO booking_hosts (booking_id, user_id, period, active) VALUES ($1, $2, 'empty', true)`,
        [id, hostA],
      )
      expect((await hostRow(id, hostA)).end.toISOString()).toBe('2026-11-09T12:30:00.000Z')
      await pool.query(
        `UPDATE booking_hosts SET period = tstzrange('2026-11-09T12:00Z', NULL) WHERE booking_id = $1`,
        [id],
      )
      expect((await hostRow(id, hostA)).end.toISOString()).toBe('2026-11-09T12:30:00.000Z')
    })

    it('does not let a host row of a cancelled booking hold the slot', async () => {
      const id = await book([], '2026-11-09T14:00Z', '2026-11-09T14:30Z', { status: 'cancelled' })
      await pool.query(`INSERT INTO booking_hosts (booking_id, user_id) VALUES ($1, $2)`, [
        id,
        hostA,
      ])
      expect((await hostRow(id, hostA)).active).toBe(false)
      await book([hostA], '2026-11-09T14:00Z', '2026-11-09T14:30Z')
    })

    it('ignores an attempt to free a slot by switching the host row off', async () => {
      const id = await book([hostA], '2026-11-09T16:00Z', '2026-11-09T16:30Z')
      await pool.query(`UPDATE booking_hosts SET active = false WHERE booking_id = $1`, [id])
      expect((await hostRow(id, hostA)).active).toBe(true)
    })
  })

  describe('cancelling and rescheduling', () => {
    it('frees the slot when a booking is cancelled', async () => {
      const id = await book([hostA], '2026-11-03T09:00Z', '2026-11-03T09:30Z')
      await pool.query(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
        [id],
      )
      await book([hostA], '2026-11-03T09:00Z', '2026-11-03T09:30Z')
    })

    it('refuses to restore a cancelled booking whose slot was taken', async () => {
      const id = await book([hostB], '2026-11-03T11:00Z', '2026-11-03T11:30Z')
      await pool.query(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
        [id],
      )
      await book([hostB], '2026-11-03T11:00Z', '2026-11-03T11:30Z')
      await expect(
        pool.query(`UPDATE bookings SET status = 'confirmed', cancelled_at = NULL WHERE id = $1`, [
          id,
        ]),
      ).rejects.toMatchObject({ code: '23P01' })
    })

    it('reschedules by cancelling and re-booking in one transaction, even onto overlapping time', async () => {
      const old = await book([hostA], '2026-11-04T09:00Z', '2026-11-04T10:00Z')
      const client = await pool.connect()
      let moved: string
      try {
        await client.query('BEGIN')
        await client.query(
          `UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
          [old],
        )
        const b = await client.query<{ id: string }>(
          `INSERT INTO bookings (organization_id, start_at, end_at, title, manage_token_hash, source, rescheduled_from_id)
           VALUES ($1, '2026-11-04T09:30Z', '2026-11-04T10:30Z', 'Meeting', sha256('moved'::bytea), 'web', $2)
           RETURNING id`,
          [orgId, old],
        )
        moved = b.rows[0]?.id as string
        await client.query(`INSERT INTO booking_hosts (booking_id, user_id) VALUES ($1, $2)`, [
          moved,
          hostA,
        ])
        await client.query('COMMIT')
      } finally {
        client.release()
      }
      expect((await hostRow(moved, hostA)).start.toISOString()).toBe('2026-11-04T09:30:00.000Z')
      expect((await hostRow(old, hostA)).active).toBe(false)
    })

    it('moves the host period when a booking time is updated in place', async () => {
      const id = await book([hostB], '2026-11-04T13:00Z', '2026-11-04T13:30Z')
      await pool.query(
        `UPDATE bookings SET start_at = '2026-11-04T15:00Z', end_at = '2026-11-04T15:30Z' WHERE id = $1`,
        [id],
      )
      expect((await hostRow(id, hostB)).start.toISOString()).toBe('2026-11-04T15:00:00.000Z')
      await book([hostB], '2026-11-04T13:00Z', '2026-11-04T13:30Z')
    })

    it('requires cancelled_at exactly when a booking is cancelled', async () => {
      const id = await book([hostB], '2026-11-06T09:00Z', '2026-11-06T09:30Z')
      await expect(
        pool.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [id]),
      ).rejects.toMatchObject({ code: '23514' })
    })
  })

  describe('idempotency', () => {
    const keyA = '00000000-0000-7000-8000-00000000000a'
    const keyB = '00000000-0000-7000-8000-00000000000b'

    it('refuses the same key twice from the same caller', async () => {
      await book([hostA], '2026-11-05T09:00Z', '2026-11-05T09:30Z', {
        apiKeyId: keyA,
        idempotencyKey: 'retry-1',
      })
      await expect(
        book([hostB], '2026-11-05T11:00Z', '2026-11-05T11:30Z', {
          apiKeyId: keyA,
          idempotencyKey: 'retry-1',
        }),
      ).rejects.toMatchObject({ code: '23505' })
    })

    it('scopes keys to the caller, so unrelated callers cannot collide', async () => {
      await book([hostB], '2026-11-05T13:00Z', '2026-11-05T13:30Z', {
        apiKeyId: keyB,
        idempotencyKey: 'retry-1',
      })
    })

    it('treats anonymous callers as one caller per organization', async () => {
      await book([hostA], '2026-11-05T15:00Z', '2026-11-05T15:30Z', { idempotencyKey: 'anon-1' })
      await expect(
        book([hostB], '2026-11-05T15:00Z', '2026-11-05T15:30Z', { idempotencyKey: 'anon-1' }),
      ).rejects.toMatchObject({ code: '23505' })
    })

    it('requires a request fingerprint with every key', async () => {
      await expect(
        pool.query(
          `INSERT INTO bookings (organization_id, start_at, end_at, title, manage_token_hash, source, idempotency_key)
           VALUES ($1, '2026-11-05T17:00Z', '2026-11-05T17:30Z', 'M', sha256('fp'::bytea), 'api', 'no-fingerprint')`,
          [orgId],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    })
  })

  describe('ownership', () => {
    it('keeps a booking in the organization of its event type', async () => {
      const otherOrg = await org()
      const et = await one<{ id: string }>(
        `INSERT INTO event_types (organization_id, slug, title, duration_minutes)
         VALUES ($1, 'intro', 'Intro', 30) RETURNING id`,
        [otherOrg],
      )
      await expect(
        book([hostA], '2026-11-07T09:00Z', '2026-11-07T09:30Z', { eventTypeId: et.id }),
      ).rejects.toMatchObject({ code: '23503' })
    })

    it('only lets a host use one of their own schedules', async () => {
      const schedule = await one<{ id: string }>(
        `INSERT INTO schedules (user_id, name, time_zone, weekly_hours) VALUES ($1, 'Work', 'UTC', '{}')
         RETURNING id`,
        [hostB],
      )
      const et = await one<{ id: string }>(
        `INSERT INTO event_types (organization_id, slug, title, duration_minutes)
         VALUES ($1, 'consult', 'Consult', 30) RETURNING id`,
        [orgId],
      )
      await expect(
        pool.query(
          `INSERT INTO event_type_hosts (event_type_id, user_id, schedule_id) VALUES ($1, $2, $3)`,
          [et.id, hostA, schedule.id],
        ),
      ).rejects.toMatchObject({ code: '23503' })
      await pool.query(
        `INSERT INTO event_type_hosts (event_type_id, user_id, schedule_id) VALUES ($1, $2, $3)`,
        [et.id, hostB, schedule.id],
      )
    })

    it('rejects event type values the availability engine would refuse', async () => {
      const insert = (column: string, value: number) =>
        pool.query(
          `INSERT INTO event_types (organization_id, slug, title, duration_minutes, ${column})
           VALUES ($1, $2, 'T', 30, $3)`,
          [orgId, `bounds-${++seq}`, value],
        )
      for (const [column, max] of [
        ['slot_step_minutes', 1440],
        ['buffer_before_minutes', 1440],
        ['buffer_after_minutes', 1440],
        ['minimum_notice_minutes', 525600],
        ['booking_window_days', 3650],
        ['max_bookings_per_day', 1000],
      ] as const) {
        await insert(column, max)
        await expect(insert(column, max + 1)).rejects.toMatchObject({ code: '23514' })
      }
    })

    it('accepts only lowercase URL-safe handles', async () => {
      const insert = (handle: string) =>
        pool.query(`INSERT INTO profiles (user_id, handle, time_zone) VALUES ($1, $2, 'UTC')`, [
          hostB,
          handle,
        ])
      await expect(insert('Adrian')).rejects.toMatchObject({ code: '23514' })
      await expect(insert('-adrian')).rejects.toMatchObject({ code: '23514' })
      await insert('adrian-lee')
    })
  })

  describe('deletion', () => {
    it('erases a deleted user: personal organization, its bookings and invitee data, API keys', async () => {
      const u = await user()
      const personal = await org()
      await pool.query(
        `INSERT INTO personal_organizations (user_id, organization_id) VALUES ($1, $2)`,
        [u, personal],
      )
      const b = await book([u], '2026-11-08T09:00Z', '2026-11-08T09:30Z', {
        organization: personal,
      })
      await pool.query(
        `INSERT INTO booking_attendees (booking_id, name, email, time_zone, is_booker)
         VALUES ($1, 'Invitee', 'invitee@example.com', 'UTC', true)`,
        [b],
      )
      await pool.query(
        `INSERT INTO auth.apikey ("configId", "referenceId", key, "createdAt", "updatedAt")
         VALUES ('default', $1, 'hashed-key', now(), now())`,
        [u],
      )

      // Through a connection that sees only the auth schema, as Better Auth's pool does.
      const authUrl = new URL(url as string)
      authUrl.pathname = `/${dbName}`
      const betterAuthLike = createPool(`${authUrl}?options=-c%20search_path%3Dauth`)
      try {
        await betterAuthLike.query(`DELETE FROM "user" WHERE id = $1`, [u])
      } finally {
        await betterAuthLike.end()
      }

      const counts = await one<Record<string, number>>(
        `SELECT
           (SELECT count(*)::int FROM auth.organization WHERE id = $1) AS orgs,
           (SELECT count(*)::int FROM bookings WHERE id = $2) AS bookings,
           (SELECT count(*)::int FROM booking_attendees WHERE booking_id = $2) AS attendees,
           (SELECT count(*)::int FROM auth.apikey WHERE "referenceId" = $3) AS keys`,
        [personal, b, u],
      )
      expect(counts).toEqual({ orgs: 0, bookings: 0, attendees: 0, keys: 0 })
    })

    it('keeps the organization when only the personal marker is removed', async () => {
      const u = await user()
      const o = await org()
      await pool.query(
        `INSERT INTO personal_organizations (user_id, organization_id) VALUES ($1, $2)`,
        [u, o],
      )
      const b = await book([u], '2026-11-08T13:00Z', '2026-11-08T13:30Z', { organization: o })
      await pool.query(`DELETE FROM personal_organizations WHERE user_id = $1`, [u])
      const left = await one<{ orgs: number; bookings: number }>(
        `SELECT (SELECT count(*)::int FROM auth.organization WHERE id = $1) AS orgs,
                (SELECT count(*)::int FROM bookings WHERE id = $2) AS bookings`,
        [o, b],
      )
      expect(left).toEqual({ orgs: 1, bookings: 1 })
    })

    it('removes event types and bookings with their organization', async () => {
      const o = await org()
      const u = await user()
      await pool.query(
        `INSERT INTO event_types (organization_id, slug, title, duration_minutes) VALUES ($1, 'x', 'X', 15)`,
        [o],
      )
      await book([u], '2026-11-08T11:00Z', '2026-11-08T11:30Z', { organization: o })
      await pool.query(`DELETE FROM auth.organization WHERE id = $1`, [o])
      const left = await one<{ n: number }>(
        `SELECT (SELECT count(*) FROM event_types WHERE organization_id = $1)
              + (SELECT count(*) FROM bookings WHERE organization_id = $1) AS n`,
        [o],
      )
      expect(Number(left.n)).toBe(0)
    })
  })

  it('reports a host row for a missing booking as a foreign-key violation', async () => {
    await expect(
      pool.query(`INSERT INTO booking_hosts (booking_id, user_id) VALUES (uuidv7(), $1)`, [hostA]),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('returns DATE columns as plain YYYY-MM-DD strings, independent of the time zone', async () => {
    const row = await one<{ d: unknown }>(`SELECT '2026-11-02'::date AS d`)
    expect(row.d).toBe('2026-11-02')
  })
})
