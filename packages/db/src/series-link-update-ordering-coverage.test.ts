import { copyFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { insertRecord } from './group-seats-fixtures.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createSeries, createTenant } from './recurring-series-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import {
  MIGRATION_COVERAGE_TIMEOUT,
  MIGRATION_REPLAY_TIMEOUT,
  useMigrationReplay,
} from './testing/migration-replay.ts'
import type { TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0157_series_link_update_ordering.sql'
const sentAt = '2031-12-01T10:00:00Z'
const nextAttempt = '2031-12-01T10:01:00Z'

async function seedSeriesOutbox(pool: pg.Pool) {
  const tenant = await createTenant(pool)
  const { series, first } = await createSeries(pool, tenant)
  const attendee = await insertRecord(pool, 'booking_attendees', {
    booking_id: first.root,
    name: 'Series booker',
    email: 'series-booker@example.test',
    time_zone: 'UTC',
    is_booker: true,
  })
  const guest = await insertRecord(pool, 'booking_attendees', {
    booking_id: first.root,
    name: 'Series guest',
    email: 'series-guest@example.test',
    time_zone: 'UTC',
  })
  const notification = (values: Record<string, unknown>) =>
    insertRecord(pool, 'booking_series_notifications', {
      organization_id: tenant.organization,
      series_id: series,
      kind: 'confirmation',
      sequence: 1,
      ...values,
    })
  const confirmation = await notification({
    row_type: 'outbox',
    due_at: nextAttempt,
    attempts: 1,
    outbox_state: 'pending',
  })
  const receipt = await notification({
    row_type: 'receipt',
    outcome: 'delivered',
    recipient_role: 'guest',
    recipient_id: guest,
    sent_at: sentAt,
    reported_ordinals: [1, 2],
    reported_link_states: ['pending', 'ready'],
    calendar_ordinals: [1, 2],
  })
  const link = await notification({
    row_type: 'outbox',
    kind: 'link_update',
    recipient_role: 'booker',
    recipient_id: attendee,
    due_at: sentAt,
    attempts: 0,
    outbox_state: 'pending',
  })
  return { tenant, confirmation, receipt, link }
}

async function seedOrdinaryOutbox(pool: pg.Pool, tenant: Awaited<ReturnType<typeof createTenant>>) {
  const booking = await insertRecord(pool, 'bookings', {
    organization_id: tenant.organization,
    event_type_id: tenant.event,
    start_at: '2032-02-02T09:00:00Z',
    end_at: '2032-02-02T09:30:00Z',
    title: 'One-off consultation',
    source: 'web',
  })
  await pool.query(
    `INSERT INTO booking_conference_notifications
       (booking_id, kind, due_at, delivered, attempts, last_error)
     VALUES ($1, 'confirmed', $2, true, 1, NULL), ($1, 'reminder', $3, false, 1, 'recipient_retry')`,
    [booking, sentAt, nextAttempt],
  )
}

async function assertOrderingProtections(pool: pg.Pool) {
  const { confirmation, receipt, link } = await seedSeriesOutbox(pool)
  const setRevision = (id: string, revision: number) =>
    pool.query('UPDATE booking_series_notifications SET after_action_revision = $2 WHERE id = $1', [
      id,
      revision,
    ])
  const revisionViolation = {
    code: '23514',
    constraint: 'booking_series_notifications_after_action_revision_check',
  }
  await expect(setRevision(confirmation, 1)).rejects.toMatchObject(revisionViolation)
  await expect(setRevision(receipt, 1)).rejects.toMatchObject(revisionViolation)
  await expect(setRevision(link, 0)).rejects.toMatchObject(revisionViolation)

  const setWaiting = (waiting: true | null) =>
    pool.query('UPDATE booking_series_notifications SET waiting_for_earlier = $2 WHERE id = $1', [
      link,
      waiting,
    ])
  const waitingViolation = {
    code: '23514',
    constraint: 'booking_series_notifications_waiting_for_earlier_check',
  }
  await expect(setWaiting(true)).rejects.toMatchObject(waitingViolation)
  await expect(setRevision(link, 1)).resolves.toMatchObject({ rowCount: 1 })
  await expect(setWaiting(true)).resolves.toMatchObject({ rowCount: 1 })
  await expect(setWaiting(null)).rejects.toMatchObject({
    code: '23502',
    column: 'waiting_for_earlier',
  })
  await expect(
    pool.query("UPDATE booking_series_notifications SET outbox_state = 'done' WHERE id = $1", [
      link,
    ]),
  ).rejects.toMatchObject(waitingViolation)
  await expect(
    pool.query(
      'UPDATE booking_series_notifications SET lease_id = uuidv7(), lease_until = $2 WHERE id = $1',
      [link, nextAttempt],
    ),
  ).rejects.toMatchObject(waitingViolation)
}

async function outboxSnapshot(pool: pg.Pool) {
  const ordinary = await pool.query(`
    SELECT to_jsonb(n) AS notification, xmin::text, ctid::text
    FROM booking_conference_notifications n ORDER BY booking_id, kind`)
  const series = await pool.query(`
    SELECT to_jsonb(n) - 'after_action_revision' - 'waiting_for_earlier' AS notification,
      xmin::text, ctid::text FROM booking_series_notifications n ORDER BY id`)
  return { ordinary: ordinary.rows, series: series.rows }
}

const ledger = (pool: pg.Pool) =>
  pool.query('SELECT name, checksum, applied_at, xmin::text FROM schema_migrations ORDER BY name')

describe.skipIf(!serverUrl)('series link-update ordering migration', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'preserves populated predecessor outboxes, matches a fresh install and reruns as a no-op',
    async () => {
      const { directory, predecessor } = replay
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        const predecessors = (await readdir(migrationsDir))
          .filter((file) => file.endsWith('.sql') && file < migration)
          .sort()
        upgraded = await predecessor.clone(undefined, { migrate: false, tag: 'link_upgrade' })
        const { pool } = upgraded
        const { tenant } = await seedSeriesOutbox(pool)
        await seedOrdinaryOutbox(pool, tenant)
        const before = await outboxSnapshot(pool)
        expect(before.ordinary).toHaveLength(2)
        expect(before.series).toHaveLength(3)
        const beforeLedger = (await ledger(pool)).rows

        await copyFile(join(migrationsDir, migration), join(directory, migration))
        expect(await runMigrations(pool, directory)).toEqual([migration])
        expect(await outboxSnapshot(pool)).toEqual(before)
        await expect(
          pool.query(`SELECT DISTINCT after_action_revision, waiting_for_earlier
          FROM booking_series_notifications`),
        ).resolves.toMatchObject({
          rows: [{ after_action_revision: null, waiting_for_earlier: false }],
        })
        const appliedLedger = (await ledger(pool)).rows
        expect(appliedLedger.slice(0, -1)).toEqual(beforeLedger)

        fresh = await predecessor.clone(undefined, { migrate: false })
        expect(await runMigrations(fresh.pool, directory)).toEqual([migration])
        const schema = await snapshotSchema(pool)
        expect(await snapshotSchema(fresh.pool)).toEqual(schema)
        const freshLedger = (await ledger(fresh.pool)).rows
        expect(freshLedger.map(({ name }) => name)).toEqual([...predecessors, migration])

        expect(await runMigrations(pool, directory)).toEqual([])
        expect(await runMigrations(fresh.pool, directory)).toEqual([])
        expect((await ledger(pool)).rows).toEqual(appliedLedger)
        expect((await ledger(fresh.pool)).rows).toEqual(freshLedger)
        expect(await outboxSnapshot(pool)).toEqual(before)
      } finally {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )

  it(
    'fails protection assertions when any 0157 object is dropped',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: assertOrderingProtections,
      })
      expect(report.problems).toEqual([])
      expect(report.results.filter(({ status }) => status === 'covered')).toHaveLength(3)
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )
})
