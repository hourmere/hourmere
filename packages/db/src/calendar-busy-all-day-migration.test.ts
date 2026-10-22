import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
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
const migration = '0039_calendar_busy_all_day_dates.sql'
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
interface Table {
  schema: string
  name: string
  columns: string[]
}
async function tables(pool: pg.Pool): Promise<Table[]> {
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
async function records(pool: pg.Pool, inventory: Table[], invalidateGoogle = false) {
  const result: Record<string, string[]> = {}
  for (const table of inventory) {
    const calendars = table.schema === 'public' && table.name === 'calendars'
    const columns = table.columns.map((column) =>
      invalidateGoogle && calendars && (column === 'sync_state' || column === 'last_synced_at')
        ? `CASE WHEN EXISTS (SELECT FROM calendar_connections cc
            WHERE cc.id=connection_id AND cc.provider='google')
            THEN NULL ELSE ${quote(column)} END AS ${quote(column)}`
        : quote(column),
    )
    // Only calendars are deliberately rewritten; every other physical tuple stays.
    if (!invalidateGoogle || !calendars) columns.push('xmin::text AS _xmin', 'ctid::text AS _ctid')
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(`SELECT to_jsonb(r)::text AS row FROM
        (SELECT ${columns.join(',')} FROM ${quote(table.schema)}.${quote(table.name)}) r
        ORDER BY to_jsonb(r)::text COLLATE "C"`)
    ).rows.map((row) => row.row)
  }
  return result
}

describe.skipIf(!serverUrl)('all-day calendar busy date migration', () => {
  it('invalidates every Google snapshot, preserves predecessor data, constrains representations and matches a fresh install', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-busy-dates-predecessor-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort()
      const initial = files.filter((file) => file < migration)
      const early = initial.filter((file) => file.slice(0, 4) <= '0012')
      for (const file of early) await copyFile(join(migrationsDir, file), join(predecessor, file))
      upgraded = await createTestDatabase(serverUrl as string, predecessor)
      const pool = upgraded.pool
      await seedEarly(pool)
      for (const file of initial.filter((file) => !early.includes(file)))
        await copyFile(join(migrationsDir, file), join(predecessor, file))
      await runMigrations(pool, predecessor)
      await seedLater(pool)
      await pool.query(`DO $$
        DECLARE google_id uuid; owner_id uuid; connection_id uuid;
        BEGIN
          SELECT c.id,cc.user_id INTO google_id,owner_id FROM calendars c
            JOIN calendar_connections cc ON cc.id=c.connection_id WHERE cc.provider='google';
          INSERT INTO calendar_busy (calendar_id,external_event_id,period) VALUES
            (google_id,'legacy_shanghai_all_day',tstzrange('2026-11-09T16:00Z','2026-11-10T16:00Z','[)')),
            (google_id,'legacy_timed',tstzrange('2026-11-10T17:00:00.123456Z','2026-11-10T18:00:00.654321Z','[)'));
          INSERT INTO calendars (connection_id,external_id,name,check_conflicts,time_zone,sync_state,last_synced_at)
            SELECT c.connection_id,'unselected-google','Unselected Google',false,'Asia/Shanghai',
              '{"syncToken":"synthetic-unselected-cursor"}','2026-10-21T03:04:05.123456Z'
            FROM calendars c WHERE c.id=google_id;
          INSERT INTO calendar_connections (user_id,provider,external_account_id,credentials,status)
            VALUES (owner_id,'google','synthetic-inactive-google',decode('a1b2','hex'),'needs_reauth')
            RETURNING id INTO connection_id;
          INSERT INTO calendars (connection_id,external_id,name,check_conflicts,sync_state,last_synced_at,sync_error)
            VALUES (connection_id,'inactive-google','Inactive Google',false,
              '{"syncToken":"synthetic-inactive-cursor"}','2026-10-20T03:04:05.654321Z','needs_reauth');
          INSERT INTO calendar_connections (user_id,provider,external_account_id,credentials,status)
            VALUES (owner_id,'caldav','synthetic-caldav',decode('c3d4','hex'),'active')
            RETURNING id INTO connection_id;
          INSERT INTO calendars (connection_id,external_id,name,sync_state,last_synced_at)
            VALUES (connection_id,'caldav-calendar','CalDAV preserved',
              '{"syncToken":"synthetic-caldav-cursor"}','2026-10-19T03:04:05.654321Z');
        END $$`)
      const inventory = await tables(pool)
      const expected = await records(pool, inventory, true)
      expect(expected['public.bookings']?.length).toBeGreaterThan(0)
      expect(expected['public.calendar_busy']).toHaveLength(4)
      const nonGoogle = (
        await pool.query(`SELECT c.id,to_jsonb(c)::text AS data,c.xmin::text,c.ctid::text
          FROM calendars c JOIN calendar_connections cc ON cc.id=c.connection_id
          WHERE cc.provider<>'google' ORDER BY c.id`)
      ).rows
      expect(nonGoogle).toHaveLength(2)
      expect(
        (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({ name: '0038_booking_ical_identity.sql' })

      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      expect(await runMigrations(pool, predecessor)).toEqual([migration])
      // The expected snapshot applies only the exact intentional invalidation.
      expect(await records(pool, inventory, true)).toEqual(expected)
      expect(
        (
          await pool.query(`SELECT c.external_id,c.check_conflicts,c.sync_state,c.last_synced_at
            FROM calendars c JOIN calendar_connections cc ON cc.id=c.connection_id
            WHERE cc.provider='google' ORDER BY c.external_id`)
        ).rows,
      ).toEqual([
        {
          external_id: 'inactive-google',
          check_conflicts: false,
          sync_state: null,
          last_synced_at: null,
        },
        {
          external_id: 'synthetic-calendar-1',
          check_conflicts: true,
          sync_state: null,
          last_synced_at: null,
        },
        {
          external_id: 'unselected-google',
          check_conflicts: false,
          sync_state: null,
          last_synced_at: null,
        },
      ])
      expect(
        (
          await pool.query(`SELECT c.id,to_jsonb(c)::text AS data,c.xmin::text,c.ctid::text
            FROM calendars c JOIN calendar_connections cc ON cc.id=c.connection_id
            WHERE cc.provider<>'google' ORDER BY c.id`)
        ).rows,
      ).toEqual(nonGoogle)
      expect(
        (await pool.query('SELECT all_day_start,all_day_end FROM calendar_busy')).rows,
      ).toEqual(Array.from({ length: 4 }, () => ({ all_day_start: null, all_day_end: null })))
      const calendar = (await pool.query<{ id: string }>('SELECT id FROM calendars LIMIT 1'))
        .rows[0]
      expect(calendar).toBeDefined()
      const insert = (
        id: string,
        period: string | null,
        start: string | null,
        end: string | null,
      ) =>
        pool.query(
          `INSERT INTO calendar_busy (calendar_id,external_event_id,period,all_day_start,all_day_end)
            VALUES ($1,$2,$3,$4,$5)`,
          [calendar?.id, id, period, start, end],
        )
      await expect(
        insert('valid_all_day', null, '2026-11-10', '2026-11-12'),
      ).resolves.toMatchObject({ rowCount: 1 })
      await expect(
        insert('valid_date_bounds', null, '0001-01-01', '9999-12-31'),
      ).resolves.toMatchObject({ rowCount: 1 })
      await expect(
        insert('valid_timed', '[2026-11-10T17:00Z,2026-11-10T18:00Z)', null, null),
      ).resolves.toMatchObject({ rowCount: 1 })
      const invalid: [string, string | null, string | null, string | null][] = [
        ['missing', null, null, null],
        ['missing_start', null, null, '2026-11-11'],
        ['missing_end', null, '2026-11-10', null],
        ['mixed', '[2026-11-10T17:00Z,2026-11-10T18:00Z)', '2026-11-10', '2026-11-11'],
        ['timed_with_start', '[2026-11-10T17:00Z,2026-11-10T18:00Z)', '2026-11-10', null],
        ['timed_with_end', '[2026-11-10T17:00Z,2026-11-10T18:00Z)', null, '2026-11-11'],
        ['empty_timed', 'empty', null, null],
        ['empty_dates', null, '2026-11-10', '2026-11-10'],
        ['reversed_dates', null, '2026-11-11', '2026-11-10'],
        ['infinite_start', null, '-infinity', '2026-11-11'],
        ['infinite_end', null, '2026-11-10', 'infinity'],
        ['before_supported_year', null, '0001-01-01 BC', '2026-11-11'],
        ['after_supported_year', null, '2026-11-10', '10000-01-01'],
      ]
      for (const [id, period, start, end] of invalid)
        await expect(insert(id, period, start, end), id).rejects.toMatchObject({ code: '23514' })
      expect(
        (
          await pool.query(`SELECT i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid,1,true) AS calendar,
            pg_get_indexdef(i.indexrelid,2,true) AS start,pg_get_indexdef(i.indexrelid,3,true) AS end,
            pg_get_expr(i.indpred,i.indrelid) AS predicate FROM pg_index i
            WHERE i.indexrelid=to_regclass('calendar_busy_calendar_all_day')`)
        ).rows,
      ).toEqual([
        {
          indisvalid: true,
          indisready: true,
          calendar: 'calendar_id',
          start: 'all_day_start',
          end: 'all_day_end',
          predicate: '(all_day_start IS NOT NULL)',
        },
      ])
      const schema = await snapshotSchema(pool)
      fresh = await createTestDatabase(serverUrl as string, predecessor)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      const ledger =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const recorded = (await pool.query(ledger)).rows
      expect(
        (await fresh.pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(recorded.map(({ name, checksum }) => ({ name, checksum })))
      const latest = await tables(pool)
      const acknowledged = await records(pool, latest)
      expect(await runMigrations(pool, predecessor)).toEqual([])
      expect(await records(pool, latest)).toEqual(acknowledged)
      expect((await pool.query(ledger)).rows).toEqual(recorded)
      expect(await snapshotSchema(pool)).toEqual(schema)
      expect(await runMigrations(fresh.pool, predecessor)).toEqual([])
      expect(pool.totalCount).toBeLessThanOrEqual(1)
      expect(fresh.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      try {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      } finally {
        await rm(predecessor, { recursive: true, force: true })
      }
    }
  }, 60_000)
})
