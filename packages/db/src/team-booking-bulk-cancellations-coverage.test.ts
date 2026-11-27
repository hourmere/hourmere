import { randomUUID } from 'node:crypto'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import {
  MIGRATION_COVERAGE_TIMEOUT,
  MIGRATION_REPLAY_TIMEOUT,
  useMigrationReplay,
} from './testing/migration-replay.ts'
import type { TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0196_team_booking_bulk_cancellations.sql'

async function assertReceiptProtections(pool: pg.Pool) {
  const organizationId = randomUUID()
  const actorId = randomUUID()
  const sessionId = randomUUID()
  const bookingId = randomUUID()
  const insertHeader = `INSERT INTO team_booking_bulk_cancellations
    (organization_id, actor_user_id, session_id, expires_at)
    VALUES ($1, $2, $3, clock_timestamp() + interval '9 minutes') RETURNING id`
  const insertItem = `INSERT INTO team_booking_bulk_cancellation_items
    (batch_id, ordinal, booking_id, preview_outcome) VALUES ($1, $2, $3, $4)`
  await expect(
    pool.query(
      `INSERT INTO auth.organization (id, name, slug, "createdAt")
       VALUES ($1, 'Bulk preview team', 'bulk-preview-team', clock_timestamp())`,
      [organizationId],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  const created = pool.query<{ id: string }>(insertHeader, [organizationId, actorId, sessionId])
  await expect(created).resolves.toMatchObject({ rowCount: 1 })
  const first = (await created).rows[0]?.id
  const another = pool.query<{ id: string }>(insertHeader, [organizationId, actorId, sessionId])
  await expect(another).resolves.toMatchObject({ rowCount: 1 })
  const second = (await another).rows[0]?.id
  expect(first).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
  expect(second).toBeDefined()
  expect(first).not.toBe(second)

  await expect(
    pool.query(
      `INSERT INTO team_booking_bulk_cancellations
       (id, organization_id, actor_user_id, session_id, expires_at)
       VALUES ($1, $2, $3, $4, clock_timestamp() + interval '9 minutes')`,
      [first, organizationId, actorId, sessionId],
    ),
  ).rejects.toMatchObject({ code: '23505', constraint: 'team_booking_bulk_cancellations_pkey' })
  await expect(pool.query(insertHeader, [randomUUID(), actorId, sessionId])).rejects.toMatchObject({
    code: '23503',
    constraint: 'team_booking_bulk_cancellations_organization_id_fkey',
  })
  for (const column of [
    'organization_id',
    'actor_user_id',
    'session_id',
    'created_at',
    'expires_at',
  ]) {
    await expect(
      pool.query(`UPDATE team_booking_bulk_cancellations SET ${column} = NULL WHERE id = $1`, [
        first,
      ]),
    ).rejects.toMatchObject({ code: '23502', column })
  }
  for (const expiry of ['created_at', "created_at + interval '10 minutes 1 second'"]) {
    await expect(
      pool.query(
        `UPDATE team_booking_bulk_cancellations SET expires_at = ${expiry} WHERE id = $1`,
        [first],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'team_booking_bulk_cancellations_expiry_check',
    })
  }
  await expect(
    pool.query(`SELECT pg_get_indexdef(
      to_regclass('public.team_booking_bulk_cancellations_organization_idx')) AS definition`),
  ).resolves.toMatchObject({
    rows: [{ definition: expect.stringMatching(/USING btree \(organization_id\)$/) }],
  })

  await expect(pool.query(insertItem, [first, 1, bookingId, 'eligible'])).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(
    pool.query(insertItem, [first, 25, randomUUID(), 'booking_unavailable']),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(pool.query(insertItem, [second, 1, bookingId, 'eligible'])).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(
    pool.query(insertItem, [randomUUID(), 1, bookingId, 'eligible']),
  ).rejects.toMatchObject({
    code: '23503',
    constraint: 'team_booking_bulk_cancellation_items_batch_id_fkey',
  })
  await expect(pool.query(insertItem, [first, 1, randomUUID(), 'eligible'])).rejects.toMatchObject({
    code: '23505',
    constraint: 'team_booking_bulk_cancellation_items_pkey',
  })
  await expect(pool.query(insertItem, [first, 2, bookingId, 'eligible'])).rejects.toMatchObject({
    code: '23505',
    constraint: 'team_booking_bulk_cancellation_items_batch_id_booking_id_key',
  })
  for (const ordinal of [0, 26]) {
    await expect(
      pool.query(insertItem, [first, ordinal, randomUUID(), 'eligible']),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'team_booking_bulk_cancellation_items_ordinal_check',
    })
  }
  await expect(pool.query(insertItem, [first, 2, randomUUID(), 'pending'])).rejects.toMatchObject({
    code: '23514',
    constraint: 'team_booking_bulk_cancellation_items_preview_outcome_check',
  })
  await expect(pool.query(insertItem, [first, 2, null, 'eligible'])).rejects.toMatchObject({
    code: '23502',
    column: 'booking_id',
  })
  await expect(pool.query(insertItem, [first, 2, randomUUID(), null])).rejects.toMatchObject({
    code: '23502',
    column: 'preview_outcome',
  })

  await expect(
    pool.query('DELETE FROM auth.organization WHERE id = $1', [organizationId]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(pool.query('SELECT id FROM team_booking_bulk_cancellations')).resolves.toMatchObject(
    {
      rows: [],
    },
  )
  await expect(
    pool.query('SELECT batch_id FROM team_booking_bulk_cancellation_items'),
  ).resolves.toMatchObject({
    rows: [],
  })
}

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

describe.skipIf(!serverUrl)('team booking bulk cancellation preview migration', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'detects a missing constraint for each independently droppable object',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: assertReceiptProtections,
        concurrency: 2,
        allowList: {
          'constraint public.team_booking_bulk_cancellations.team_booking_bulk_cancellations_pkey':
            'The item foreign key needs this target primary key, which PostgreSQL cannot drop in isolation.',
        },
      })
      expect(report.problems).toEqual([])
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it(
    'preserves a predecessor booking and session, matches fresh install and reruns as a no-op',
    async () => {
      const { directory, predecessor } = replay
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        upgraded = await predecessor.clone(undefined, { migrate: false })
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

        fresh = await predecessor.clone(directory)
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
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )
})
