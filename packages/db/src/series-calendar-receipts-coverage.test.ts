import { createHash } from 'node:crypto'
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
const migration = '0151_series_calendar_receipts.sql'
const sentAt = '2031-12-01T10:00:00Z'
const seriesConstraint = 'booking_series_notifications_calendar_ordinals_check'
const bookingConstraint = 'booking_notifications_calendar_attached_check'

async function seedReceipts(pool: pg.Pool) {
  const tenant = await createTenant(pool)
  const { series, first } = await createSeries(pool, tenant)
  const attendee = await insertRecord(pool, 'booking_attendees', {
    booking_id: first.root,
    name: 'Calendar test booker',
    email: 'calendar-test-booker@example.test',
    time_zone: 'UTC',
    is_booker: true,
  })
  const digest = (kind: string) => createHash('sha256').update(`${series}:${kind}`).digest()
  const recipient = `attendee:${attendee}`
  await expect(
    pool.query(
      `INSERT INTO booking_notifications
         (booking_id,kind,recipient,outcome,manage_token_hash,created_at)
       VALUES ($1,'confirmed',$2,'sent',$3,$4), ($1,'reminder',$2,'rejected',NULL,$4)`,
      [first.root, recipient, digest('booking'), sentAt],
    ),
  ).resolves.toMatchObject({ rowCount: 2 })
  const ownership = {
    organization_id: tenant.organization,
    series_id: series,
    kind: 'confirmation',
    sequence: 1,
  }
  const insertNotification = (values: Record<string, unknown>) =>
    insertRecord(pool, 'booking_series_notifications', { ...ownership, ...values })
  const delivered = insertNotification({
    row_type: 'receipt',
    recipient_role: 'booker',
    recipient_id: attendee,
    outcome: 'delivered',
    capability_scope: 'manage',
    manage_token_hash: digest('series'),
    sent_at: sentAt,
    reported_ordinals: [1, 2],
    reported_link_states: ['pending', 'ready'],
  })
  await expect(delivered).resolves.toMatch(/^[0-9a-f-]+$/)
  const outbox = insertNotification({
    row_type: 'outbox',
    due_at: sentAt,
    attempts: 1,
    outbox_state: 'done',
  })
  await expect(outbox).resolves.toMatch(/^[0-9a-f-]+$/)
  return { booking: first.root, recipient, delivered: await delivered, outbox: await outbox }
}

async function assertCalendarReceiptProtections(pool: pg.Pool) {
  const f = await seedReceipts(pool)
  const setOrdinals = (id: string, ordinals: unknown) =>
    pool.query('UPDATE booking_series_notifications SET calendar_ordinals = $2 WHERE id = $1', [
      id,
      ordinals,
    ])
  await expect(setOrdinals(f.delivered, [])).resolves.toMatchObject({ rowCount: 1 })
  await expect(setOrdinals(f.delivered, [2])).resolves.toMatchObject({ rowCount: 1 })
  for (const ordinals of [[3], [[1, 2]], Array<number>(13).fill(1), [null]]) {
    await expect(setOrdinals(f.delivered, ordinals)).rejects.toMatchObject({
      code: '23514',
      constraint: seriesConstraint,
    })
  }
  await expect(setOrdinals(f.outbox, [1])).rejects.toMatchObject({
    code: '23514',
    constraint: seriesConstraint,
  })

  const markAttached = (kind: string) =>
    pool.query(
      `UPDATE booking_notifications SET calendar_attached = true
       WHERE booking_id = $1 AND recipient = $2 AND kind = $3`,
      [f.booking, f.recipient, kind],
    )
  await expect(markAttached('confirmed')).resolves.toMatchObject({ rowCount: 1 })
  await expect(markAttached('reminder')).rejects.toMatchObject({
    code: '23514',
    constraint: bookingConstraint,
  })
  await expect(
    pool.query(
      `INSERT INTO booking_notifications (booking_id,recipient,kind,outcome,calendar_attached)
       VALUES ($1,$2,'rescheduled','rejected',true)`,
      [f.booking, f.recipient],
    ),
  ).rejects.toMatchObject({ code: '23514', constraint: bookingConstraint })
}

async function receiptSnapshot(pool: pg.Pool) {
  const booking = await pool.query(
    `SELECT to_jsonb(n) - 'calendar_attached' AS receipt, xmin::text, ctid::text
     FROM booking_notifications n ORDER BY booking_id, recipient, kind`,
  )
  const series = await pool.query(
    `SELECT to_jsonb(n) - 'calendar_ordinals' AS receipt, xmin::text, ctid::text
     FROM booking_series_notifications n ORDER BY id`,
  )
  return { booking: booking.rows, series: series.rows }
}

const ledger = (pool: pg.Pool) =>
  pool.query('SELECT name, checksum, applied_at, xmin::text FROM schema_migrations ORDER BY name')

describe.skipIf(!serverUrl)('series calendar attachment receipts', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'preserves predecessor receipts, matches a fresh install and reruns as a no-op',
    async () => {
      const { directory, predecessor } = replay
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        const predecessors = (await readdir(migrationsDir))
          .filter((file) => file.endsWith('.sql') && file < migration)
          .sort()
        upgraded = await predecessor.clone(undefined, { migrate: false, tag: 'ics_upgrade' })
        const pool = upgraded.pool
        await seedReceipts(pool)
        const before = await receiptSnapshot(pool)
        expect(before.booking).toHaveLength(2)
        expect(before.series).toHaveLength(2)
        const beforeLedger = (await ledger(pool)).rows

        await copyFile(join(migrationsDir, migration), join(directory, migration))
        expect(await runMigrations(pool, directory)).toEqual([migration])
        expect(await receiptSnapshot(pool)).toEqual(before)
        expect(
          (await pool.query('SELECT DISTINCT calendar_attached FROM booking_notifications')).rows,
        ).toEqual([{ calendar_attached: null }])
        expect(
          (await pool.query('SELECT DISTINCT calendar_ordinals FROM booking_series_notifications'))
            .rows,
        ).toEqual([{ calendar_ordinals: null }])
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
        expect(await receiptSnapshot(pool)).toEqual(before)
      } finally {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )

  it(
    'fails a protection assertion when either calendar receipt constraint is dropped',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: assertCalendarReceiptProtections,
      })
      expect(report.problems).toEqual([])
      expect(report.results.filter(({ status }) => status === 'covered')).toHaveLength(2)
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )
})
