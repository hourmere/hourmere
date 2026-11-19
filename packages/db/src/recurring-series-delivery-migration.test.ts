import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { insertRecord } from './group-seats-fixtures.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createSeries, createTenant } from './recurring-series-protections.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0127_recurring_series_delivery.sql'
const newTables = [
  'booking_series_receipts',
  'booking_series_notifications',
  'booking_series_admissions',
] as const
const populatedTables = [
  'auth.organization',
  'event_types',
  'booking_series',
  'booking_series_occurrences',
  'bookings',
  'booking_attendees',
] as const

async function seedPredecessor(pool: pg.Pool) {
  const tenant = await createTenant(pool)
  await pool.query(
    `UPDATE event_types SET recurrence = '{"timeZone":"UTC","allowedPatterns":["weekly"],"maxOccurrences":6}',
       recurrence_revision = 2 WHERE id = $1`,
    [tenant.event],
  )
  const { first, second } = await createSeries(pool, tenant, {
    revision: 3,
    manage_token_hash: createHash('sha256').update('synthetic-series-capability').digest(),
  })
  const ordinary = await insertRecord(pool, 'bookings', {
    organization_id: tenant.organization,
    event_type_id: tenant.event,
    start_at: '2032-01-15T09:00Z',
    end_at: '2032-01-15T09:30Z',
    title: 'Single consultation',
    source: 'web',
  })
  for (const booking of [first.root, second.root, ordinary]) {
    await insertRecord(pool, 'booking_attendees', {
      booking_id: booking,
      name: 'Example Booker',
      email: 'booker@example.test',
      time_zone: 'UTC',
      locale: 'en',
      is_booker: true,
    })
  }
}

async function records(
  pool: pg.Pool,
  tables: ReadonlyArray<(typeof populatedTables)[number] | (typeof newTables)[number]>,
) {
  const rows: Record<string, unknown[]> = {}
  for (const table of tables) {
    rows[table] = (
      await pool.query(`SELECT t.*, xmin::text, ctid::text FROM ${table} t ORDER BY id`)
    ).rows
  }
  return rows
}

const ledger = (pool: pg.Pool) =>
  pool.query(
    'SELECT name, checksum, applied_at::text, xmin::text, ctid::text FROM schema_migrations ORDER BY name',
  )

describe.skipIf(!serverUrl)('recurring series delivery migration', () => {
  it('preserves populated 0126 rows, matches a fresh install and reruns as a no-op', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-recurring-delivery-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const predecessors = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort()
      await Promise.all(
        predecessors.map((file) => copyFile(join(migrationsDir, file), join(directory, file))),
      )
      upgraded = await createTestDatabase(serverUrl as string, directory, { tag: 'series_upgrade' })
      const pool = upgraded.pool
      expect((await ledger(pool)).rows.at(-1)?.name).toBe('0126_recurring_series.sql')
      await seedPredecessor(pool)
      const before = await records(pool, populatedTables)
      expect(Object.values(before).map((rows) => rows.length)).toEqual([1, 1, 1, 2, 3, 3])
      const predecessorLedger = (await ledger(pool)).rows

      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(pool, directory)).toEqual([migration])
      expect(await records(pool, populatedTables)).toEqual(before)
      const newRows = await records(pool, newTables)
      expect(Object.values(newRows)).toEqual([[], [], []])
      const appliedLedger = (await ledger(pool)).rows
      expect(appliedLedger.slice(0, -1)).toEqual(predecessorLedger)

      fresh = await createTestDatabase(serverUrl as string, directory, { migrate: false })
      expect(await runMigrations(fresh.pool, directory)).toEqual([...predecessors, migration])
      const schema = await snapshotSchema(pool)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      const freshLedger = (await ledger(fresh.pool)).rows

      expect(await runMigrations(pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect((await ledger(pool)).rows).toEqual(appliedLedger)
      expect((await ledger(fresh.pool)).rows).toEqual(freshLedger)
      expect(await records(pool, [...populatedTables, ...newTables])).toEqual({
        ...before,
        ...newRows,
      })
      expect(await snapshotSchema(pool)).toEqual(schema)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
    } finally {
      try {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 120_000)
})
