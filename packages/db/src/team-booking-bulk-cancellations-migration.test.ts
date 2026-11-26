import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const migration = '0196_team_booking_bulk_cancellations.sql'

async function seedTeamBooking(pool: pg.Pool) {
  const { rows } = await pool.query<{
    organization_id: string
    actor_user_id: string
    session_id: string
    booking_id: string
  }>(`
    WITH users AS (
      INSERT INTO auth."user" (name, email, "emailVerified") VALUES
        ('Preview manager', 'manager@example.test', true),
        ('Preview host', 'host@example.test', true)
      RETURNING id, email
    ), team AS (
      INSERT INTO auth.organization (name, slug, "createdAt")
      VALUES ('Migration fixture team', 'fixture-team', clock_timestamp()) RETURNING id
    ), membership AS (
      INSERT INTO auth.member ("userId", "organizationId", role, "createdAt")
      SELECT users.id, team.id, CASE WHEN email = 'manager@example.test' THEN 'owner' ELSE 'member' END,
             clock_timestamp()
      FROM users, team
    ), session AS (
      INSERT INTO auth.session ("userId", "activeOrganizationId", token, "expiresAt", "updatedAt")
      SELECT users.id, team.id::text, 'synthetic-preview-session',
             clock_timestamp() + interval '1 hour', clock_timestamp()
      FROM users, team WHERE email = 'manager@example.test'
      RETURNING id, "userId"
    ), booking AS (
      INSERT INTO bookings (organization_id, start_at, end_at, title, source, required_host_user_ids)
      SELECT team.id, '2030-05-10T09:00:00.123456Z', '2030-05-10T09:30:00.654321Z',
             'Team meeting 東京', 'web', ARRAY[users.id]
      FROM team, users WHERE email = 'host@example.test'
      RETURNING id, organization_id, required_host_user_ids
    ), host AS (
      INSERT INTO booking_hosts (booking_id, user_id)
      SELECT id, required_host_user_ids[1] FROM booking
    ), attendee AS (
      INSERT INTO booking_attendees (booking_id, name, email, time_zone, locale, is_booker)
      SELECT id, 'Preview invitee', 'invitee@example.test', 'Asia/Tokyo', 'ja', true FROM booking
    )
    SELECT organization_id, "userId" AS actor_user_id, session.id AS session_id, booking.id AS booking_id
    FROM booking CROSS JOIN session
  `)
  expect(rows).toHaveLength(1)
  const [fixture] = rows
  if (!fixture) throw new Error('Migration fixture was not created')
  return fixture
}

async function bookingData(pool: pg.Pool) {
  const tables = [
    'auth."user"',
    'auth.organization',
    'auth.member',
    'auth.session',
    'bookings',
    'booking_hosts',
    'booking_attendees',
  ]
  // JSON in SQL retains the original timestamps, including sub-millisecond precision.
  return Promise.all(
    tables.map(
      async (table) =>
        (await pool.query(`SELECT to_jsonb(t)::text AS contents FROM ${table} t ORDER BY contents`))
          .rows,
    ),
  )
}

describe.skipIf(!process.env.DATABASE_URL)(
  'team booking bulk cancellation preview migration',
  () => {
    it('preserves a predecessor booking and session, matches fresh install and reruns as a no-op', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-bulk-preview-upgrade-'))
      const serverUrl = process.env.DATABASE_URL as string
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        for (const file of await readdir(migrationsDir)) {
          if (file.endsWith('.sql') && file < migration)
            await copyFile(join(migrationsDir, file), join(directory, file))
        }
        upgraded = await createTestDatabase(serverUrl, directory)
        const { organization_id, actor_user_id, session_id, booking_id } = await seedTeamBooking(
          upgraded.pool,
        )
        const before = await bookingData(upgraded.pool)

        await copyFile(join(migrationsDir, migration), join(directory, migration))
        expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
        expect(await bookingData(upgraded.pool)).toEqual(before)
        await expect(
          upgraded.pool.query('SELECT id FROM team_booking_bulk_cancellations'),
        ).resolves.toMatchObject({ rows: [] })
        await expect(
          upgraded.pool.query('SELECT batch_id FROM team_booking_bulk_cancellation_items'),
        ).resolves.toMatchObject({ rows: [] })

        fresh = await createTestDatabase(serverUrl, directory)
        const schema = await snapshotSchema(upgraded.pool)
        expect(await snapshotSchema(fresh.pool)).toEqual(schema)
        await upgraded.pool.query(
          `WITH header AS (
           INSERT INTO team_booking_bulk_cancellations
             (organization_id, actor_user_id, session_id, expires_at)
           VALUES ($1, $2, $3, clock_timestamp() + interval '9 minutes') RETURNING id
         )
         INSERT INTO team_booking_bulk_cancellation_items (batch_id, ordinal, booking_id, preview_outcome)
         SELECT id, 1, $4::uuid, 'eligible' FROM header`,
          [organization_id, actor_user_id, session_id, booking_id],
        )
        expect(await runMigrations(upgraded.pool, directory)).toEqual([])
        expect(await runMigrations(fresh.pool, directory)).toEqual([])
        expect(await snapshotSchema(upgraded.pool)).toEqual(schema)
        expect(await bookingData(upgraded.pool)).toEqual(before)

        await upgraded.pool.query('DELETE FROM auth.session WHERE id = $1', [session_id])
        await upgraded.pool.query('DELETE FROM bookings WHERE id = $1', [booking_id])
        await expect(
          upgraded.pool.query(
            'SELECT organization_id, actor_user_id, session_id FROM team_booking_bulk_cancellations',
          ),
        ).resolves.toMatchObject({ rows: [{ organization_id, actor_user_id, session_id }] })
        await expect(
          upgraded.pool.query(
            'SELECT ordinal, booking_id, preview_outcome FROM team_booking_bulk_cancellation_items',
          ),
        ).resolves.toMatchObject({
          rows: [{ ordinal: 1, booking_id, preview_outcome: 'eligible' }],
        })
      } finally {
        try {
          await Promise.all([fresh?.drop(), upgraded?.drop()])
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
    }, 120_000)
  },
)
