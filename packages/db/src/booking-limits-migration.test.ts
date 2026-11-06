import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0057_weekly_monthly_booking_limits.sql'
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

interface Table {
  schema: string
  name: string
  columns: string[]
}

async function inventory(pool: pg.Pool): Promise<Table[]> {
  return (
    await pool.query<Table>(`SELECT table_schema AS schema,table_name AS name,
      array_agg(column_name::text ORDER BY ordinal_position) AS columns
      FROM information_schema.columns c
      WHERE table_schema IN ('auth','public') AND table_name <> 'schema_migrations'
        AND EXISTS (SELECT FROM information_schema.tables t
          WHERE t.table_schema=c.table_schema AND t.table_name=c.table_name
            AND t.table_type='BASE TABLE')
      GROUP BY table_schema,table_name ORDER BY table_schema,table_name`)
  ).rows
}

async function records(pool: pg.Pool, tables: Table[]) {
  const result: Record<string, string[]> = {}
  for (const table of tables) {
    const columns = [...table.columns.map(quote), 'xmin::text AS _xmin', 'ctid::text AS _ctid']
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(`SELECT to_jsonb(r)::text AS row FROM
        (SELECT ${columns.join(',')} FROM ${quote(table.schema)}.${quote(table.name)}) r
        ORDER BY to_jsonb(r)::text COLLATE "C"`)
    ).rows.map(({ row }) => row)
  }
  return result
}

async function copyPredecessor(directory: string, through = '0056') {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && file.slice(0, 4) <= through)
    .sort()
  for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
  return files
}

async function seedEvent(pool: pg.Pool) {
  const organization = randomUUID()
  await pool.query(
    `INSERT INTO auth.organization (id,name,slug,"createdAt")
      VALUES ($1::uuid,'Booking limit team',$1::text,now())`,
    [organization],
  )
  return organization
}

function insert(
  pool: pg.Pool,
  organization: string,
  day: number | null,
  week: number | null,
  month: number | null,
) {
  return pool.query(
    `INSERT INTO event_types
      (organization_id,slug,title,duration_minutes,max_bookings_per_day,
        max_bookings_per_week,max_bookings_per_month)
      VALUES ($1,$2,'Booking limit event',30,$3,$4,$5)
      RETURNING max_bookings_per_day,max_bookings_per_week,max_bookings_per_month`,
    [organization, randomUUID(), day, week, month],
  )
}

const invalid = [
  {
    name: 'weekly minimum',
    day: null,
    week: 0,
    month: null,
    constraint: 'event_types_max_bookings_per_week_range',
    original: 'max_bookings_per_week BETWEEN 1 AND 1000',
    broken: 'max_bookings_per_week <= 1000',
  },
  {
    name: 'weekly maximum',
    day: null,
    week: 1001,
    month: null,
    constraint: 'event_types_max_bookings_per_week_range',
    original: 'max_bookings_per_week BETWEEN 1 AND 1000',
    broken: 'max_bookings_per_week >= 1',
  },
  {
    name: 'monthly minimum',
    day: null,
    week: null,
    month: 0,
    constraint: 'event_types_max_bookings_per_month_range',
    original: 'max_bookings_per_month BETWEEN 1 AND 1000',
    broken: 'max_bookings_per_month <= 1000',
  },
  {
    name: 'monthly maximum',
    day: null,
    week: null,
    month: 1001,
    constraint: 'event_types_max_bookings_per_month_range',
    original: 'max_bookings_per_month BETWEEN 1 AND 1000',
    broken: 'max_bookings_per_month >= 1',
  },
  {
    name: 'day/week ordering',
    day: 2,
    week: 1,
    month: null,
    constraint: 'event_types_booking_limits_day_week',
    original: 'max_bookings_per_week >= max_bookings_per_day',
    broken: 'true',
  },
  {
    name: 'week/month ordering',
    day: null,
    week: 2,
    month: 1,
    constraint: 'event_types_booking_limits_week_month',
    original: 'max_bookings_per_month >= max_bookings_per_week',
    broken: 'true',
  },
  {
    name: 'day/month ordering without week',
    day: 2,
    week: null,
    month: 1,
    constraint: 'event_types_booking_limits_day_month',
    original: 'max_bookings_per_month >= max_bookings_per_day',
    broken: 'true',
  },
] as const

async function rejectsInvalid(pool: pg.Pool, organization: string, row: (typeof invalid)[number]) {
  await expect(
    insert(pool, organization, row.day, row.week, row.month),
    row.name,
  ).rejects.toMatchObject({ code: '23514', constraint: row.constraint })
}

describe.skipIf(!serverUrl)('weekly and monthly booking limit migration', () => {
  it('preserves populated predecessor data and daily limits, matches fresh install and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-booking-limits-upgrade-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      await copyPredecessor(directory, '0012')
      upgraded = await createTestDatabase(serverUrl as string, directory, { tag: 'limits_old' })
      await seedEarly(upgraded.pool)
      const predecessor = await copyPredecessor(directory)
      await runMigrations(upgraded.pool, directory)
      await seedLater(upgraded.pool)
      await upgraded.pool.query(`UPDATE event_types SET max_bookings_per_day =
        CASE slug WHEN 'upgrade-event-1' THEN NULL WHEN 'upgrade-event-2' THEN 1
          WHEN 'upgrade-event-3' THEN 1000 ELSE 12 END`)
      const tables = await inventory(upgraded.pool)
      const before = await records(upgraded.pool, tables)
      expect(before['public.bookings']).toHaveLength(8)
      expect(before['public.event_types']).toHaveLength(7)
      expect(before['public.booking_hosts']?.length).toBeGreaterThan(0)
      expect(before['public.booking_notifications']?.length).toBeGreaterThan(0)
      expect(
        (await upgraded.pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({ name: predecessor.at(-1) })
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
      expect(await records(upgraded.pool, tables)).toEqual(before)
      expect(
        (
          await upgraded.pool.query(`SELECT max_bookings_per_week,max_bookings_per_month
        FROM event_types`)
        ).rows,
      ).toEqual(
        Array.from({ length: 7 }, () => ({
          max_bookings_per_week: null,
          max_bookings_per_month: null,
        })),
      )
      const schema = await snapshotSchema(upgraded.pool)
      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'limits_fresh' })
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      const ledger =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const recorded = (await upgraded.pool.query(ledger)).rows
      const latest = await inventory(upgraded.pool)
      const acknowledged = await records(upgraded.pool, latest)
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await records(upgraded.pool, latest)).toEqual(acknowledged)
      expect((await upgraded.pool.query(ledger)).rows).toEqual(recorded)
      expect(await snapshotSchema(upgraded.pool)).toEqual(schema)
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      expect(upgraded.pool.totalCount).toBeLessThanOrEqual(1)
      expect(fresh.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      try {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 60_000)

  it('accepts nullable and inclusive ceilings, rejects bounds and descending configured pairs on insert and update', async () => {
    const owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'limits_checks' })
    try {
      const organization = await seedEvent(owned.pool)
      for (const [day, week, month] of [
        [null, null, null],
        [null, 1, null],
        [null, 1000, null],
        [null, null, 1],
        [null, null, 1000],
        [1, 1, 1],
        [1000, 1000, 1000],
        [1, null, 1],
        [null, 1, 1],
        [1, 2, 3],
      ]) {
        await expect(
          insert(owned.pool, organization, day ?? null, week ?? null, month ?? null),
        ).resolves.toMatchObject({
          rows: [
            {
              max_bookings_per_day: day,
              max_bookings_per_week: week,
              max_bookings_per_month: month,
            },
          ],
        })
      }
      const id = (
        await owned.pool.query<{ id: string }>(
          `INSERT INTO event_types
        (organization_id,slug,title,duration_minutes) VALUES ($1,$2,'Legacy booking limits',30)
        RETURNING id,max_bookings_per_day,max_bookings_per_week,max_bookings_per_month`,
          [organization, randomUUID()],
        )
      ).rows[0]?.id
      for (const row of invalid) {
        await rejectsInvalid(owned.pool, organization, row)
        await expect(
          owned.pool.query(
            `UPDATE event_types SET max_bookings_per_day=$1,
          max_bookings_per_week=$2,max_bookings_per_month=$3 WHERE id=$4`,
            [row.day, row.week, row.month, id],
          ),
          row.name,
        ).rejects.toMatchObject({
          code: '23514',
          constraint: row.constraint,
        })
      }
      // Existing daily range guards remain unchanged by the additive migration.
      for (const day of [0, 1001])
        await expect(insert(owned.pool, organization, day, null, null)).rejects.toMatchObject({
          code: '23514',
        })
      expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      await owned.drop()
    }
  }, 30_000)

  it('detects source-copy mutations of each range boundary and ordering constraint, then passes after restoration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-booking-limits-mutant-'))
    let owned: TestDatabase | undefined
    try {
      await copyPredecessor(directory)
      owned = await createTestDatabase(serverUrl as string, directory, { tag: 'limits_mutant' })
      const pool = owned.pool
      const organization = await seedEvent(pool)
      const source = await readFile(join(migrationsDir, migration), 'utf8')
      const replaceMigration = async (sql: string) => {
        // A mutated CHECK (true) has no column dependency and survives DROP COLUMN.
        for (const constraint of new Set(invalid.map((row) => row.constraint)))
          await pool.query(`ALTER TABLE event_types DROP CONSTRAINT IF EXISTS ${quote(constraint)}`)
        await pool.query(`ALTER TABLE event_types DROP COLUMN IF EXISTS max_bookings_per_week,
          DROP COLUMN IF EXISTS max_bookings_per_month`)
        await pool.query(sql)
      }
      for (const row of invalid) {
        expect(source.includes(row.original), row.name).toBe(true)
        await replaceMigration(source)
        await rejectsInvalid(pool, organization, row)
        try {
          await replaceMigration(source.replace(row.original, row.broken))
          await expect(rejectsInvalid(pool, organization, row), row.name).rejects.toMatchObject({
            name: 'AssertionError',
          })
        } finally {
          await pool.query('DELETE FROM event_types WHERE organization_id=$1', [organization])
          await replaceMigration(source)
        }
        await rejectsInvalid(pool, organization, row)
      }
      expect(pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      try {
        await owned?.drop()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 60_000)
})
