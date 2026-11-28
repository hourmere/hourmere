import { randomUUID } from 'node:crypto'
import { copyFile, readdir } from 'node:fs/promises'
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
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0204_departure_handoff_calendar_cleanup.sql'
const start = '2030-05-12T09:00:00.123456Z'
const cancelledAt = '2030-05-10T11:00:00.123456Z'

async function seed(pool: pg.Pool) {
  const teamId = randomUUID()
  const departingId = randomUUID()
  const successorId = randomUUID()
  const eventTypeId = randomUUID()
  const sourceId = randomUUID()
  const replacementId = randomUUID()
  const googleConnectionId = randomUUID()
  const microsoftConnectionId = randomUUID()
  const googleCalendarId = randomUUID()
  const microsoftCalendarId = randomUUID()
  await expect(
    pool.query(
      `WITH people AS (
        INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES
          ($2, 'Departing host', 'departing@example.test', true),
          ($3, 'Successor host', 'successor@example.test', true)
      ), team AS (
        INSERT INTO auth.organization (id, name, slug, "createdAt")
          VALUES ($1, 'Handoff team', 'handoff-team', now())
      ), members AS (
        INSERT INTO auth.member ("userId", "organizationId", role, "createdAt") VALUES
          ($2, $1, 'member', now()), ($3, $1, 'owner', now())
      ), event_type AS (
        INSERT INTO event_types (id, organization_id, slug, title, duration_minutes)
          VALUES ($4, $1, 'appointment', 'Appointment', 30)
      )
      INSERT INTO bookings (id, organization_id, event_type_id, source, title, start_at, end_at,
                            status, cancelled_at, required_host_user_ids, responses)
        VALUES ($5, $1, $4, 'web', 'Original appointment', $6::timestamptz,
                $6::timestamptz + interval '30 minutes', 'cancelled', $7, ARRAY[$2::uuid],
                '{"notes":"Retained booking answer"}')`,
      [teamId, departingId, successorId, eventTypeId, sourceId, start, cancelledAt],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query(
      `WITH replacement AS (
        INSERT INTO bookings (id, organization_id, event_type_id, source, title, start_at, end_at,
                              rescheduled_from_id, required_host_user_ids)
          VALUES ($2, $1, $4, 'web', 'Replacement appointment', $6::timestamptz,
                  $6::timestamptz + interval '30 minutes', $3, ARRAY[$5::uuid])
        RETURNING id
      )
      INSERT INTO booking_hosts (booking_id, user_id)
        SELECT id, $5::uuid FROM replacement UNION ALL SELECT $3::uuid, $7::uuid`,
      [teamId, replacementId, sourceId, eventTypeId, successorId, start, departingId],
    ),
  ).resolves.toMatchObject({ rowCount: 2 })
  await expect(
    pool.query(
      `WITH connections AS (
        INSERT INTO calendar_connections (id, user_id, provider, external_account_id, credentials)
          VALUES ($1, $3, 'google', 'departing-google', decode('00', 'hex')),
                 ($2, $4, 'microsoft', 'successor-microsoft', decode('01', 'hex'))
      )
      INSERT INTO calendars (id, connection_id, external_id, name, access_role)
        VALUES ($5, $1, 'original-calendar', 'Departing calendar', 'owner'),
               ($6, $2, 'replacement-calendar', 'Successor calendar', 'writer')`,
      [
        googleConnectionId,
        microsoftConnectionId,
        departingId,
        successorId,
        googleCalendarId,
        microsoftCalendarId,
      ],
    ),
  ).resolves.toMatchObject({ rowCount: 2 })
  await expect(
    pool.query(
      `WITH destination AS (
        INSERT INTO booking_calendar_targets (root_booking_id, user_id, calendar_id)
          VALUES ($1, $2, $3)
      )
      INSERT INTO booking_calendar_events (booking_id, calendar_id, external_event_id, etag)
        VALUES ($1, $3, 'old-event-id', 'old-etag')`,
      [sourceId, departingId, googleCalendarId],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  return { sourceId, replacementId, googleConnectionId, googleCalendarId }
}

function insertCleanup(pool: pg.Pool, values: Record<string, string | null>) {
  const columns = Object.keys(values)
  const parameters = columns.map((_, index) => `$${index + 1}`)
  return pool.query(
    `INSERT INTO departure_handoff_calendar_cleanup (${columns.join(', ')})
       VALUES (${parameters.join(', ')}) RETURNING *`,
    Object.values(values),
  )
}

async function assertCleanupProtections(pool: pg.Pool) {
  const { sourceId, replacementId, googleConnectionId, googleCalendarId } = await seed(pool)
  const cleanup = {
    source_booking_id: sourceId,
    calendar_id: googleCalendarId,
    connection_id: googleConnectionId,
    provider: 'google',
  }
  await expect(
    insertCleanup(pool, { ...cleanup, source_booking_id: randomUUID() }),
  ).rejects.toMatchObject({
    code: '23503',
    constraint: 'departure_handoff_calendar_cleanup_source_fk',
  })
  await expect(insertCleanup(pool, { ...cleanup, provider: 'caldav' })).rejects.toMatchObject({
    code: '23514',
    constraint: 'departure_handoff_calendar_cleanup_provider_check',
  })
  await expect(insertCleanup(pool, { ...cleanup, status: 'absent' })).rejects.toMatchObject({
    code: '23514',
    constraint: 'departure_handoff_calendar_cleanup_status_check',
  })
  for (const column of [
    'source_booking_id',
    'calendar_id',
    'connection_id',
    'provider',
    'status',
  ]) {
    await expect(insertCleanup(pool, { ...cleanup, [column]: null })).rejects.toMatchObject({
      code: '23502',
      column,
    })
  }
  await expect(insertCleanup(pool, cleanup)).resolves.toMatchObject({
    rows: [{ ...cleanup, status: 'pending' }],
  })
  await expect(insertCleanup(pool, { ...cleanup, status: 'unresolved' })).rejects.toMatchObject({
    code: '23505',
    constraint: 'departure_handoff_calendar_cleanup_pkey',
  })
  await expect(
    insertCleanup(pool, { ...cleanup, source_booking_id: replacementId, status: 'complete' }),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query(
      "UPDATE departure_handoff_calendar_cleanup SET status = 'unresolved' WHERE source_booking_id = $1",
      [sourceId],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query('DELETE FROM calendar_connections WHERE id = $1', [googleConnectionId]),
  ).resolves.toMatchObject({ rowCount: 1 })
  const read = (bookingId: string) =>
    pool.query('SELECT * FROM departure_handoff_calendar_cleanup WHERE source_booking_id = $1', [
      bookingId,
    ])
  await expect(read(sourceId)).resolves.toMatchObject({
    rows: [{ ...cleanup, status: 'unresolved' }],
  })
  await expect(pool.query('DELETE FROM bookings WHERE id = $1', [sourceId])).resolves.toMatchObject(
    {
      rowCount: 1,
    },
  )
  await expect(read(sourceId)).resolves.toMatchObject({ rows: [] })
  await expect(read(replacementId)).resolves.toMatchObject({
    rows: [{ ...cleanup, source_booking_id: replacementId, status: 'complete' }],
  })
}

async function snapshotPredecessor(pool: pg.Pool) {
  const tables = [
    'bookings',
    'booking_hosts',
    'calendar_connections',
    'calendars',
    'booking_calendar_targets',
    'booking_calendar_events',
  ]
  return Promise.all(
    tables.map(async (table) => {
      const { rows } = await pool.query(
        `SELECT to_jsonb(t)::text AS row, xmin::text, ctid::text FROM ${table} t ORDER BY row`,
      )
      return rows
    }),
  )
}

describe.skipIf(!serverUrl)('departure handoff calendar cleanup migration', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'detects a removed cleanup protection',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: assertCleanupProtections,
        concurrency: 2,
      })
      expect(report.problems).toEqual([])
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it(
    'preserves pinned provider events and matches a fresh install through a no-op rerun',
    async () => {
      const { directory, predecessor } = replay
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        upgraded = await predecessor.clone(undefined, { migrate: false })
        const { pool } = upgraded
        await seed(pool)
        const before = await snapshotPredecessor(pool)
        expect(before.map((rows) => rows.length)).toEqual([2, 2, 2, 2, 1, 1])

        await copyFile(join(migrationsDir, migration), join(directory, migration))
        expect(await runMigrations(pool, directory)).toEqual([migration])
        expect(await snapshotPredecessor(pool)).toEqual(before)
        await expect(
          pool.query('SELECT * FROM departure_handoff_calendar_cleanup'),
        ).resolves.toMatchObject({ rows: [] })

        fresh = await createTestDatabase(serverUrl as string, undefined, { migrate: false })
        expect(await runMigrations(fresh.pool, directory)).toEqual(
          (await readdir(directory)).sort(),
        )
        const schema = await snapshotSchema(pool)
        expect(await snapshotSchema(fresh.pool)).toEqual(schema)
        expect(await runMigrations(pool, directory)).toEqual([])
        expect(await runMigrations(fresh.pool, directory)).toEqual([])
        expect(await snapshotSchema(pool)).toEqual(schema)
        expect(await snapshotPredecessor(pool)).toEqual(before)
      } finally {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )
})
