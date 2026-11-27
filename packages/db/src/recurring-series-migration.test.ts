import { ok } from 'node:assert/strict'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { MIGRATION_REPLAY_TIMEOUT } from './testing/migration-replay.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { type SchemaSnapshot, snapshotSchema } from './upgrade-schema-snapshot.ts'

vi.setConfig({ testTimeout: MIGRATION_REPLAY_TIMEOUT, hookTimeout: MIGRATION_REPLAY_TIMEOUT })

const serverUrl = process.env.DATABASE_URL
const migration = '0126_recurring_series.sql'
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

// Read the same columns after the upgrade, including tuple identity to detect rewrites.
async function records(pool: pg.Pool, inventory: SchemaSnapshot) {
  const result: Record<string, string[]> = {}
  for (const table of inventory.relations.filter(({ kind }) => kind === 'r')) {
    if (table.schema === 'public' && table.name === 'schema_migrations') continue
    const qualifiedName = `${quote(table.schema)}.${quote(table.name)}`
    const columns = inventory.columns
      .filter(({ schema, relation }) => schema === table.schema && relation === table.name)
      .map(({ name }) => quote(name))
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(`
        SELECT to_jsonb(r)::text AS row FROM (
          SELECT ${columns.join(',')}, xmin::text AS _xmin, ctid::text AS _ctid
          FROM ${qualifiedName}
        ) r ORDER BY to_jsonb(r)::text COLLATE "C"
      `)
    ).rows.map(({ row }) => row)
  }
  return result
}

const ledgerQuery =
  'SELECT name, checksum, applied_at::text, xmin::text, ctid::text FROM schema_migrations'

async function assertOrdinaryBookingLifecycle(pool: pg.Pool) {
  const {
    rows: [event],
  } = await pool.query<{ id: string; organization_id: string }>(`
    INSERT INTO event_types (organization_id, slug, title, duration_minutes)
    SELECT id, 'single-after-upgrade', 'Single after upgrade', 30
    FROM auth.organization WHERE slug = 'upgrade-team'
    RETURNING id, organization_id
  `)
  ok(event, 'Single event was inserted')
  const insertBooking = (date: string, predecessor: string | null) =>
    pool.query<{ id: string }>(
      `INSERT INTO bookings (
         organization_id, event_type_id, start_at, end_at, title, source, rescheduled_from_id
       ) VALUES ($1, $2, $3::timestamptz, $3::timestamptz + interval '30 minutes',
         'Single after upgrade', 'web', $4)
       RETURNING id`,
      [event.organization_id, event.id, date, predecessor],
    )
  const assignHost = (booking: string) =>
    pool.query(
      `INSERT INTO booking_hosts (booking_id, user_id)
       SELECT $1, id FROM auth."user" WHERE email = 'upgrade-host-1@example.test'`,
      [booking],
    )

  const root = (await insertBooking('2040-07-01T10:00Z', null)).rows[0]?.id
  ok(root, 'Single booking was inserted')
  await assignHost(root)
  await pool.query("UPDATE bookings SET status='cancelled', cancelled_at=now() WHERE id=$1", [root])
  const successor = (await insertBooking('2040-07-08T10:00Z', root)).rows[0]?.id
  ok(successor, 'Single booking successor was inserted')
  await assignHost(successor)
  await expect(
    pool.query(
      `SELECT b.id, b.series_occurrence_id, b.rescheduled_from_id, b.status, h.active
       FROM bookings b JOIN booking_hosts h ON h.booking_id=b.id
       WHERE b.event_type_id=$1 ORDER BY b.start_at`,
      [event.id],
    ),
  ).resolves.toMatchObject({
    rows: [
      {
        id: root,
        series_occurrence_id: null,
        rescheduled_from_id: null,
        status: 'cancelled',
        active: false,
      },
      {
        id: successor,
        series_occurrence_id: null,
        rescheduled_from_id: root,
        status: 'confirmed',
        active: true,
      },
    ],
  })
}

describe.skipIf(!serverUrl)('recurring series schema migration', () => {
  it('preserves predecessor data and single bookings, matches a fresh install and reruns as a no-op', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-recurring-upgrade-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort()
      const early = files.filter((file) => file < '0013')
      const later = files.slice(early.length)
      for (const file of early) await copyFile(join(migrationsDir, file), join(directory, file))
      upgraded = await createTestDatabase(serverUrl as string, directory)
      const pool = upgraded.pool
      await seedEarly(pool)
      for (const file of later) await copyFile(join(migrationsDir, file), join(directory, file))
      expect(await runMigrations(pool, directory)).toEqual(later)
      await seedLater(pool)

      const predecessor = await snapshotSchema(pool)
      const before = await records(pool, predecessor)
      for (const table of [
        'auth.organization',
        'public.event_types',
        'public.bookings',
        'public.booking_hosts',
        'public.booking_attendees',
        'public.booking_conferences',
        'public.webhook_deliveries',
      ])
        expect(before[table]?.length, table).toBeGreaterThan(0)
      const ledger = (await pool.query(`${ledgerQuery} ORDER BY name`)).rows

      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(pool, directory)).toEqual([migration])
      expect(await records(pool, predecessor)).toEqual(before)
      expect(
        (await pool.query(`${ledgerQuery} WHERE name<>$1 ORDER BY name`, [migration])).rows,
      ).toEqual(ledger)
      expect(
        (await pool.query('SELECT DISTINCT recurrence, recurrence_revision FROM event_types')).rows,
      ).toEqual([{ recurrence: null, recurrence_revision: '0' }])
      expect((await pool.query('SELECT DISTINCT series_occurrence_id FROM bookings')).rows).toEqual(
        [{ series_occurrence_id: null }],
      )
      expect((await pool.query('SELECT id FROM booking_series')).rows).toEqual([])
      expect((await pool.query('SELECT id FROM booking_series_occurrences')).rows).toEqual([])

      fresh = await createTestDatabase(serverUrl as string, undefined, { migrate: false })
      expect(await runMigrations(fresh.pool, directory)).toEqual([...files, migration])
      const schema = await snapshotSchema(pool)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      const appliedLedger = (await pool.query(`${ledgerQuery} ORDER BY name`)).rows
      const upgradedRows = await records(pool, schema)
      expect(await runMigrations(pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await records(pool, schema)).toEqual(upgradedRows)
      expect((await pool.query(`${ledgerQuery} ORDER BY name`)).rows).toEqual(appliedLedger)
      expect(await snapshotSchema(pool)).toEqual(schema)
      await assertOrdinaryBookingLifecycle(pool)
      expect(pool.totalCount).toBeLessThanOrEqual(1)
      expect(fresh.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      try {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  })
})
