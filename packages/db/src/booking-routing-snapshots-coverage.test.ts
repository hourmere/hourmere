import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import {
  bookingRoutingValues,
  insertRow,
  receiptValues,
  routingFixture,
} from './routing-storage-fixtures.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import {
  MIGRATION_COVERAGE_TIMEOUT,
  MIGRATION_REPLAY_TIMEOUT,
  useMigrationReplay,
} from './testing/migration-replay.ts'
import type { TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0167_booking_routing_snapshots.sql'

async function marker(pool: pg.Pool, id: string) {
  const { rows } = await pool.query<{ has_routing_snapshot: boolean }>(
    'SELECT has_routing_snapshot FROM bookings WHERE id = $1',
    [id],
  )
  return rows[0]?.has_routing_snapshot
}

async function assertRoutingMarker(pool: pg.Pool) {
  const fixture = await routingFixture(pool)
  await expect(marker(pool, fixture.booking)).resolves.toBe(false)
  await expect(
    pool.query('UPDATE bookings SET has_routing_snapshot = NULL WHERE id = $1', [
      fixture.otherBooking,
    ]),
  ).rejects.toMatchObject({ code: '23502', column: 'has_routing_snapshot' })

  const paid = await insertRow(pool, 'bookings', {
    organization_id: fixture.organization,
    event_type_id: fixture.event,
    start_at: '2099-05-04T11:00:00Z',
    end_at: '2099-05-04T11:30:00Z',
    payment_hold_expires_at: '2099-05-04T10:00:00Z',
    title: 'Synthetic checkout hold',
    source: 'web',
    status: 'pending_payment',
  })
  await expect(
    insertRow(pool, 'booking_routing', { ...bookingRoutingValues(fixture), booking_id: paid }),
  ).rejects.toMatchObject({ code: '23514', constraint: 'booking_routing_unpaid_booking' })
  await expect(marker(pool, paid)).resolves.toBe(false)
  await expect(
    insertRow(pool, 'booking_routing', bookingRoutingValues(fixture)),
  ).resolves.toBeUndefined()
  await expect(marker(pool, fixture.booking)).resolves.toBe(true)
  await expect(marker(pool, fixture.otherBooking)).resolves.toBe(false)
}

async function lifecycleRows(pool: pg.Pool) {
  const { rows } = await pool.query(`SELECT jsonb_build_object(
    'bookings', (SELECT jsonb_agg(to_jsonb(b) - 'has_routing_snapshot' ORDER BY id) FROM bookings b),
    'routing', (SELECT jsonb_agg(to_jsonb(r) ORDER BY booking_id) FROM booking_routing r),
    'receipts', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM routing_receipts r)
  ) AS snapshot`)
  return rows
}

describe.skipIf(!serverUrl)('booking routing snapshot marker migration', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'fails an assertion when either catalogued protection is dropped',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: assertRoutingMarker,
      })
      expect(report.problems).toEqual([])
      expect(report.results.filter((result) => result.status === 'covered')).toHaveLength(2)
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it(
    'marks existing routed bookings without changing their data, matches a fresh install and reruns as a no-op',
    async () => {
      const { directory, predecessor } = replay
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        upgraded = await predecessor.clone(undefined, { migrate: false, tag: 'routing_marker' })
        const fixture = await routingFixture(upgraded.pool)
        await insertRow(upgraded.pool, 'booking_routing', {
          ...bookingRoutingValues(fixture),
          questions: '[{"type":"short_text","id":"case","label":"Case detail"}]',
          answers: '{"case":"Existing private description"}',
          replay_fingerprint: Buffer.alloc(32, 0xab),
        })
        await insertRow(upgraded.pool, 'routing_receipts', {
          ...receiptValues(fixture),
          consumed_booking_id: fixture.booking,
          answers_ciphertext: null,
        })
        const before = await lifecycleRows(upgraded.pool)

        await copyFile(join(migrationsDir, migration), join(directory, migration))
        expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
        await expect(marker(upgraded.pool, fixture.booking)).resolves.toBe(true)
        await expect(marker(upgraded.pool, fixture.otherBooking)).resolves.toBe(false)
        expect(await lifecycleRows(upgraded.pool)).toEqual(before)

        fresh = await predecessor.clone(directory, { tag: 'routing_fresh' })
        const schema = await snapshotSchema(upgraded.pool)
        expect(await snapshotSchema(fresh.pool)).toEqual(schema)
        expect(await runMigrations(upgraded.pool, directory)).toEqual([])
        expect(await runMigrations(fresh.pool, directory)).toEqual([])
        expect(await lifecycleRows(upgraded.pool)).toEqual(before)
      } finally {
        await fresh?.drop()
        await upgraded?.drop()
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )
})
