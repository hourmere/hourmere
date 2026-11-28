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

const migration = '0203_departure_handoff_runs.sql'
const serverUrl = process.env.DATABASE_URL
const runs = 'departure_handoff_runs'
const items = 'departure_handoff_run_items'
const created = '2030-05-10T09:00:00Z'
const expires = '2030-05-10T09:30:00Z'

function insert(pool: pg.Pool, table: string, values: Record<string, unknown>) {
  const columns = Object.keys(values)
  const parameters = columns.map((_, index) => `$${index + 1}`)
  return pool.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${parameters.join(', ')})`,
    Object.values(values),
  )
}

async function seedTeam(pool: pg.Pool, slug: string) {
  const id = randomUUID()
  await expect(
    insert(pool, 'auth.organization', { id, name: 'Handoff team', slug, '"createdAt"': created }),
  ).resolves.toMatchObject({ rowCount: 1 })
  return id
}

async function assertQueueProtections(pool: pg.Pool) {
  const teamId = await seedTeam(pool, 'handoff-run')
  const otherTeamId = await seedTeam(pool, 'handoff-run-other')
  const run = {
    organization_id: teamId,
    id: randomUUID(),
    departing_user_id: randomUUID(),
    actor_user_id: randomUUID(),
    session_id: randomUUID(),
    created_at: created,
    next_item_at: created,
    expires_at: expires,
  }
  const item = {
    organization_id: teamId,
    run_id: run.id,
    ordinal: 1,
    source_booking_id: randomUUID(),
    offer_id: randomUUID(),
    offer_version: 1,
  }
  for (const column of [
    'departing_user_id',
    'actor_user_id',
    'session_id',
    'state',
    'created_at',
    'next_item_at',
    'expires_at',
  ]) {
    await expect(insert(pool, runs, { ...run, [column]: null })).rejects.toMatchObject({
      code: '23502',
      column,
    })
  }
  await expect(insert(pool, runs, { ...run, organization_id: randomUUID() })).rejects.toMatchObject(
    {
      code: '23503',
      constraint: 'departure_handoff_runs_organization_id_fkey',
    },
  )

  for (const invalid of [
    { state: 'unknown' },
    { state: 'paused', finished_at: expires },
    { state: 'running', failure_code: 'authorization_lost' },
    { state: 'stopped' },
    { state: 'completed', finished_at: expires, failure_code: 'run_expired' },
    { state: 'failed', finished_at: expires },
    { state: 'failed', finished_at: expires, failure_code: 'private error details' },
  ]) {
    await expect(insert(pool, runs, { ...run, ...invalid })).rejects.toMatchObject({
      code: '23514',
      constraint: 'departure_handoff_runs_state_check',
    })
  }
  for (const invalid of [
    { expires_at: created },
    { expires_at: 'infinity' },
    { next_item_at: '2030-05-10T08:59:59Z' },
    { next_item_at: 'infinity' },
    { state: 'stopped', finished_at: '2030-05-10T08:59:59Z' },
    { state: 'completed', finished_at: 'infinity' },
  ]) {
    await expect(insert(pool, runs, { ...run, ...invalid })).rejects.toMatchObject({
      code: '23514',
      constraint: 'departure_handoff_runs_time_check',
    })
  }
  await expect(insert(pool, runs, run)).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query(
      'SELECT state, failure_code, finished_at FROM departure_handoff_runs WHERE id = $1',
      [run.id],
    ),
  ).resolves.toMatchObject({ rows: [{ state: 'running', failure_code: null, finished_at: null }] })
  await expect(
    insert(pool, runs, { ...run, state: 'paused', id: randomUUID() }),
  ).rejects.toMatchObject({
    code: '23505',
    constraint: 'departure_handoff_runs_one_active',
  })
  await expect(
    insert(pool, items, { ...item, organization_id: otherTeamId }),
  ).rejects.toMatchObject({
    code: '23503',
    constraint: 'departure_handoff_run_items_run_fk',
  })
  await expect(insert(pool, runs, { ...run, organization_id: otherTeamId })).resolves.toMatchObject(
    {
      rowCount: 1,
    },
  )
  await expect(
    insert(pool, runs, { ...run, state: 'stopped', finished_at: expires }),
  ).rejects.toMatchObject({
    code: '23505',
    constraint: 'departure_handoff_runs_pkey',
  })
  await expect(
    insert(pool, runs, {
      ...run,
      id: randomUUID(),
      state: 'failed',
      finished_at: expires,
      failure_code: 'departed_member_returned',
    }),
  ).resolves.toMatchObject({ rowCount: 1 })

  for (const column of ['source_booking_id', 'offer_id', 'offer_version', 'outcome']) {
    await expect(insert(pool, items, { ...item, [column]: null })).rejects.toMatchObject({
      code: '23502',
      column,
    })
  }
  for (const ordinal of [0, 11]) {
    await expect(insert(pool, items, { ...item, ordinal })).rejects.toMatchObject({
      code: '23514',
      constraint: 'departure_handoff_run_items_ordinal_check',
    })
  }
  await expect(insert(pool, items, { ...item, offer_version: 0 })).rejects.toMatchObject({
    code: '23514',
    constraint: 'departure_handoff_run_items_offer_version_check',
  })
  for (const invalid of [
    { outcome: 'unknown' },
    { outcome: 'applied' },
    { outcome: 'applied', replacement_booking_id: item.source_booking_id },
    { outcome: 'stopped', replacement_booking_id: randomUUID() },
  ]) {
    await expect(insert(pool, items, { ...item, ...invalid })).rejects.toMatchObject({
      code: '23514',
      constraint: 'departure_handoff_run_items_outcome_check',
    })
  }
  await expect(insert(pool, items, item)).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query('SELECT outcome, replacement_booking_id FROM departure_handoff_run_items'),
  ).resolves.toMatchObject({ rows: [{ outcome: 'pending', replacement_booking_id: null }] })
  await expect(insert(pool, items, { ...item, ordinal: 2 })).rejects.toMatchObject({
    code: '23505',
    constraint: 'departure_handoff_run_items_source_key',
  })
  await expect(
    insert(pool, items, { ...item, source_booking_id: randomUUID() }),
  ).rejects.toMatchObject({
    code: '23505',
    constraint: 'departure_handoff_run_items_pkey',
  })
  await expect(
    insert(pool, items, {
      ...item,
      ordinal: 10,
      source_booking_id: randomUUID(),
      outcome: 'applied',
      replacement_booking_id: randomUUID(),
    }),
  ).resolves.toMatchObject({ rowCount: 1 })

  const operationalIndexes = [
    'departure_handoff_offers_run_candidates_idx',
    'departure_handoff_runs_due_idx',
    'departure_handoff_runs_expiry_idx',
    'departure_handoff_runs_retention_idx',
    'departure_handoff_runs_team_created_idx',
  ]
  await expect(
    pool.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1) ORDER BY indexname",
      [operationalIndexes],
    ),
  ).resolves.toMatchObject({ rows: operationalIndexes.map((indexname) => ({ indexname })) })

  await expect(
    pool.query('DELETE FROM auth.organization WHERE id = $1', [teamId]),
  ).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(
    pool.query('SELECT organization_id FROM departure_handoff_runs'),
  ).resolves.toMatchObject({
    rows: [{ organization_id: otherTeamId }],
  })
  await expect(pool.query('SELECT run_id FROM departure_handoff_run_items')).resolves.toMatchObject(
    {
      rows: [],
    },
  )
}

async function seedPredecessor(pool: pg.Pool) {
  const teamId = await seedTeam(pool, 'handoff-upgrade')
  const hostId = randomUUID()
  const bookingId = randomUUID()
  const offerId = randomUUID()
  const start = '2030-05-11T11:00:00Z'
  await expect(
    pool.query(
      `WITH host AS (
         INSERT INTO auth."user" (id, name, email, "emailVerified")
           VALUES ($1, 'Original host', 'queue-upgrade-host@example.test', true)
       ), booked AS (
         INSERT INTO bookings (id, organization_id, source, title, start_at, end_at, required_host_user_ids)
           VALUES ($2, $3, 'web', 'Appointment', $4, $4::timestamptz + interval '30 minutes', ARRAY[$1::uuid])
         RETURNING id
       ), booked_host AS (
         INSERT INTO booking_hosts (booking_id, user_id) SELECT id, $1 FROM booked
       )
       INSERT INTO booking_attendees (booking_id, name, email, time_zone, locale, is_booker)
         SELECT id, 'Booker', 'queue-upgrade-booker@example.test', 'Asia/Shanghai', 'zh-CN', true FROM booked`,
      [hostId, bookingId, teamId, start],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    insert(pool, 'departure_handoff_offers', {
      id: offerId,
      organization_id: teamId,
      source_booking_id: bookingId,
      version: 1,
      proposer_user_id: hostId,
      departing_user_id: hostId,
      target_start_at: start,
      duration_minutes: 30,
      terms_digest: 'a'.repeat(64),
      issued_at: created,
      expires_at: expires,
    }),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    insert(pool, 'departure_handoff_recipients', {
      organization_id: teamId,
      source_booking_id: bookingId,
      offer_id: offerId,
      offer_version: 1,
      recipient_key: 'queue-upgrade-booker@example.test',
      decision: 'approved',
      decided_at: '2030-05-10T09:10:00Z',
    }),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    insert(pool, 'audit_events', {
      organization_id: teamId,
      actor_type: 'user',
      actor_id: hostId,
      credential_type: 'session',
      action: 'booking.created',
      target_type: 'booking',
      target_id: bookingId,
    }),
  ).resolves.toMatchObject({ rowCount: 1 })
}

async function snapshotPredecessor(pool: pg.Pool) {
  return Promise.all(
    [
      'bookings',
      'booking_hosts',
      'booking_attendees',
      'departure_handoff_offers',
      'departure_handoff_recipients',
      'audit_events',
    ].map(
      async (table) =>
        (
          await pool.query(
            `SELECT to_jsonb(t)::text AS row, xmin::text, ctid::text FROM ${table} t ORDER BY row`,
          )
        ).rows,
    ),
  )
}

describe.skipIf(!serverUrl)('departure handoff queue migration', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'detects removed queue protections',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: assertQueueProtections,
        allowList: {
          'constraint public.departure_handoff_runs.departure_handoff_runs_pkey':
            'The item foreign key requires the run primary key, which PostgreSQL cannot drop in isolation.',
        },
        concurrency: 2,
      })
      expect(report.problems).toEqual([])
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it(
    'preserves populated bookings, consent and audit rows, matches fresh install and replays as a no-op',
    async () => {
      const { directory, predecessor } = replay
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        upgraded = await predecessor.clone(undefined, { migrate: false })
        await seedPredecessor(upgraded.pool)
        const before = await snapshotPredecessor(upgraded.pool)
        expect(before.map((rows) => rows.length)).toEqual([1, 1, 1, 1, 1, 1])

        await copyFile(join(migrationsDir, migration), join(directory, migration))
        expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
        expect(await snapshotPredecessor(upgraded.pool)).toEqual(before)
        await expect(
          upgraded.pool.query('SELECT id FROM departure_handoff_runs'),
        ).resolves.toMatchObject({
          rows: [],
        })

        fresh = await createTestDatabase(serverUrl as string, undefined, { migrate: false })
        expect(await runMigrations(fresh.pool, directory)).toEqual(
          (await readdir(directory)).sort(),
        )
        const schema = await snapshotSchema(upgraded.pool)
        expect(await snapshotSchema(fresh.pool)).toEqual(schema)
        expect(await runMigrations(upgraded.pool, directory)).toEqual([])
        expect(await runMigrations(fresh.pool, directory)).toEqual([])
        expect(await snapshotSchema(upgraded.pool)).toEqual(schema)
        expect(await snapshotPredecessor(upgraded.pool)).toEqual(before)
      } finally {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )
})
