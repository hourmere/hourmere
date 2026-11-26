import { randomUUID } from 'node:crypto'
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
const migration = '0193_booking_routing_snapshot_guard.sql'
const mismatch = { code: '23514', constraint: 'bookings_routing_snapshot_matches' }

function setMarker(pool: pg.Pool, id: string, value: boolean) {
  return pool.query('UPDATE bookings SET has_routing_snapshot = $2 WHERE id = $1', [id, value])
}

async function marker(pool: pg.Pool, id: string) {
  const { rows } = await pool.query<{ has_routing_snapshot: boolean }>(
    'SELECT has_routing_snapshot FROM bookings WHERE id = $1',
    [id],
  )
  return rows[0]?.has_routing_snapshot
}

async function assertSnapshotMarker(pool: pg.Pool) {
  const f = await routingFixture(pool)
  await expect(marker(pool, f.booking)).resolves.toBe(false)
  await expect(setMarker(pool, f.booking, true)).rejects.toMatchObject(mismatch)
  await expect(
    insertRow(pool, 'bookings', {
      organization_id: f.organization,
      start_at: '2030-01-01T10:00Z',
      end_at: '2030-01-01T10:30Z',
      title: 'Ordinary booking with an invalid marker',
      source: 'web',
      has_routing_snapshot: true,
    }),
  ).rejects.toMatchObject(mismatch)

  const snapshot = bookingRoutingValues(f)
  await expect(insertRow(pool, 'booking_routing', snapshot)).resolves.toBeUndefined()
  await expect(marker(pool, f.booking)).resolves.toBe(true)
  await expect(setMarker(pool, f.booking, false)).rejects.toMatchObject(mismatch)
  await expect(marker(pool, f.booking)).resolves.toBe(true)

  // A privileged answer purge can remove the snapshot while keeping the booking.
  await expect(
    pool.query('DELETE FROM booking_routing WHERE booking_id = $1', [f.booking]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(marker(pool, f.booking)).resolves.toBe(false)

  // The ordinary cascades still remove both the snapshot and the consumed receipt.
  await expect(insertRow(pool, 'booking_routing', snapshot)).resolves.toBeUndefined()
  await expect(
    insertRow(pool, 'routing_receipts', {
      ...receiptValues(f),
      consumed_booking_id: f.booking,
      answers_ciphertext: null,
    }),
  ).resolves.toEqual(expect.any(String))
  await expect(
    pool.query('DELETE FROM auth.organization WHERE id = $1', [f.organization]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(marker(pool, f.booking)).resolves.toBeUndefined()
  await expect(marker(pool, f.otherBooking)).resolves.toBe(false)
  await expect(
    pool.query('SELECT booking_id FROM booking_routing WHERE booking_id = $1', [f.booking]),
  ).resolves.toMatchObject({ rowCount: 0 })
  await expect(
    pool.query('SELECT id FROM routing_receipts WHERE consumed_booking_id = $1', [f.booking]),
  ).resolves.toMatchObject({ rowCount: 0 })
}

async function bookingData(pool: pg.Pool) {
  const { rows } = await pool.query(`SELECT jsonb_build_object(
    'bookings', (SELECT jsonb_agg(to_jsonb(b) - 'has_routing_snapshot' ORDER BY id) FROM bookings b),
    'routing', (SELECT jsonb_agg(to_jsonb(r) ORDER BY booking_id) FROM booking_routing r),
    'receipts', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM routing_receipts r)
  ) AS data`)
  return rows
}

describe.skipIf(!serverUrl)('booking routing snapshot marker guard', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'fails an assertion when either catalogued trigger is dropped',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: assertSnapshotMarker,
      })
      expect(report.problems).toEqual([])
      expect(report.results.filter((result) => result.status === 'covered')).toHaveLength(2)
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it(
    'repairs both predecessor marker errors, preserves booking data and matches a fresh install',
    async () => {
      const { directory, predecessor } = replay
      const upgraded = await predecessor.clone(undefined, { migrate: false, tag: 'marker_guard' })
      let fresh: TestDatabase | undefined
      try {
        const { pool } = upgraded
        const f = await routingFixture(pool)
        const questionId = randomUUID()
        await insertRow(pool, 'booking_routing', {
          ...bookingRoutingValues(f),
          questions: JSON.stringify([
            { type: 'short_text', id: questionId, label: 'Case details' },
          ]),
          answers: JSON.stringify({ [questionId]: 'Original information from the invitee' }),
          replay_fingerprint: Buffer.alloc(32, 0xab),
        })
        await insertRow(pool, 'routing_receipts', {
          ...receiptValues(f),
          consumed_booking_id: f.booking,
          answers_ciphertext: null,
        })
        await setMarker(pool, f.booking, false)
        await setMarker(pool, f.otherBooking, true)
        const before = await bookingData(pool)

        await copyFile(join(migrationsDir, migration), join(directory, migration))
        expect(await runMigrations(pool, directory)).toEqual([migration])
        await expect(marker(pool, f.booking)).resolves.toBe(true)
        await expect(marker(pool, f.otherBooking)).resolves.toBe(false)
        expect(await bookingData(pool)).toEqual(before)

        fresh = await predecessor.clone(directory, { tag: 'marker_fresh' })
        expect(await snapshotSchema(pool)).toEqual(await snapshotSchema(fresh.pool))
        expect(await runMigrations(pool, directory)).toEqual([])
        expect(await runMigrations(fresh.pool, directory)).toEqual([])
        expect(await bookingData(pool)).toEqual(before)

        await expect(
          pool.query('DELETE FROM booking_routing WHERE booking_id = $1', [f.booking]),
        ).resolves.toMatchObject({ rowCount: 1 })
        await expect(marker(pool, f.booking)).resolves.toBe(false)
      } finally {
        await fresh?.drop()
        await upgraded.drop()
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )
})
