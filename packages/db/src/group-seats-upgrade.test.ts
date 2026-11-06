import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { groupSeatsPredecessor } from './group-seats-upgrade-seed.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0059_group_seats.sql'
const predecessor = '0058_one_time_link_idempotency.sql'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

interface Table {
  schema: string
  name: string
  columns: string[]
}

async function inventory(pool: pg.Pool) {
  return (
    await pool.query<Table>(`SELECT table_schema AS schema,table_name AS name,
      array_agg(column_name::text ORDER BY ordinal_position) AS columns
      FROM information_schema.columns c
      WHERE table_schema IN ('auth','public')
        AND EXISTS(SELECT FROM information_schema.tables t
          WHERE t.table_schema=c.table_schema AND t.table_name=c.table_name
            AND t.table_type='BASE TABLE')
      GROUP BY table_schema,table_name ORDER BY table_schema,table_name`)
  ).rows
}

// Keep the predecessor's explicit columns: a dropped historical column must not
// silently disappear from the assertion. Text JSON preserves timestamp microseconds,
// credential digests, arrays and JSON without JavaScript conversion losing precision.
async function records(pool: pg.Pool, tables: Table[], physical = false) {
  const result: Record<string, string[]> = {}
  for (const table of tables) {
    const columns = table.columns.map(quote)
    if (physical) columns.push('xmin::text AS _xmin', 'ctid::text AS _ctid')
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(`SELECT to_jsonb(r)::text AS row FROM
        (SELECT ${columns.join(',')} FROM ${quote(table.schema)}.${quote(table.name)}) r
        ORDER BY to_jsonb(r)::text COLLATE "C"`)
    ).rows.map(({ row }) => row)
  }
  return result
}

async function assertFixture(pool: pg.Pool, before: Record<string, string[]>) {
  // Every historical table has data; otherwise its preservation check is vacuous.
  for (const [table, rows] of Object.entries(before))
    expect(rows.length, `${table}: populated predecessor`).toBeGreaterThan(0)
  expect(
    (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
  ).toEqual({ name: predecessor })
  expect(
    (
      await pool.query(`SELECT DISTINCT CASE WHEN b.organization_id=p.organization_id
        THEN 'personal' ELSE e.scheduling_type END AS kind
        FROM bookings b JOIN event_types e ON e.id=b.event_type_id
        LEFT JOIN personal_organizations p ON p.organization_id=b.organization_id ORDER BY kind`)
    ).rows,
  ).toEqual([
    { kind: 'collective' },
    { kind: 'individual' },
    { kind: 'personal' },
    { kind: 'round_robin' },
  ])
  expect(
    (
      await pool.query(`SELECT DISTINCT provider,state,error_code FROM booking_conferences
        ORDER BY provider,state,error_code`)
    ).rows,
  ).toEqual(
    ['google_meet', 'zoom'].flatMap((provider) => [
      { provider, state: 'failed', error_code: 'ambiguous_create' },
      { provider, state: 'pending', error_code: null },
      { provider, state: 'ready', error_code: null },
    ]),
  )
  expect(
    (
      await pool.query(`SELECT
        EXISTS(SELECT FROM bookings b JOIN event_types e ON e.id=b.event_type_id
          WHERE extract(epoch FROM b.end_at-b.start_at)/60<>e.duration_minutes) AS historical_length,
        EXISTS(SELECT FROM bookings WHERE rescheduled_from_id IS NOT NULL) AS successors,
        EXISTS(SELECT FROM bookings WHERE status='cancelled') AS cancelled,
        EXISTS(SELECT FROM booking_attendees WHERE NOT is_booker) AS guests,
        EXISTS(SELECT FROM bookings WHERE responses<>'{}'::jsonb) AS answers,
        EXISTS(SELECT FROM bookings WHERE api_key_id IS NOT NULL) AS api_origin,
        EXISTS(SELECT FROM bookings WHERE oauth_consent_id IS NOT NULL) AS oauth_origin,
        EXISTS(SELECT FROM bookings WHERE manage_token_hash IS NOT NULL) AS manage_hashes,
        EXISTS(SELECT FROM booking_notifications WHERE manage_token_hash IS NOT NULL) AS email_hashes,
        EXISTS(SELECT FROM bookings WHERE notification_snapshot IS NOT NULL) AS snapshots,
        EXISTS(SELECT FROM booking_notifications WHERE outcome='suppressed') AS suppressions,
        EXISTS(SELECT FROM calendar_busy WHERE all_day_start IS NOT NULL) AS all_day,
        EXISTS(SELECT FROM booking_calendar_targets) AS pinned_destinations,
        EXISTS(SELECT FROM one_time_booking_links WHERE state='active') AS active_link,
        EXISTS(SELECT FROM one_time_booking_links WHERE state='used') AS used_link,
        EXISTS(SELECT FROM waitlist_entries WHERE status='notified') AS active_waitlist,
        EXISTS(SELECT FROM waitlist_entries WHERE status='removed' AND email IS NULL) AS erased_waitlist,
        EXISTS(SELECT FROM waitlist_slot_tombstones) AS tombstones`)
    ).rows,
  ).toEqual([
    {
      historical_length: true,
      successors: true,
      cancelled: true,
      guests: true,
      answers: true,
      api_origin: true,
      oauth_origin: true,
      manage_hashes: true,
      email_hashes: true,
      snapshots: true,
      suppressions: true,
      all_day: true,
      pinned_destinations: true,
      active_link: true,
      used_link: true,
      active_waitlist: true,
      erased_waitlist: true,
      tombstones: true,
    },
  ])
}

describe.skipIf(!serverUrl)('group seats populated predecessor migration', () => {
  it('preserves all 0058 business values and timestamps, matches fresh schema and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-group-upgrade-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      upgraded = await groupSeatsPredecessor(serverUrl as string, directory)
      const pool = upgraded.pool
      const oldTables = await inventory(pool)
      const oldBusinessTables = oldTables.filter((table) => table.name !== 'schema_migrations')
      const before = await records(pool, oldBusinessTables)
      await assertFixture(pool, before)
      const ledgerBefore = await records(
        pool,
        oldTables.filter((table) => table.name === 'schema_migrations'),
        true,
      )
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(pool, directory)).toEqual([migration])
      const latestTables = await inventory(pool)
      for (const table of oldTables)
        expect(
          latestTables.find(
            (current) => current.schema === table.schema && current.name === table.name,
          )?.columns,
          `${table.schema}.${table.name}: historical columns retained`,
        ).toEqual(expect.arrayContaining(table.columns))
      expect(
        await records(pool, oldBusinessTables),
        'retained predecessor business values',
      ).toEqual(before)
      expect(
        (
          await pool.query(`SELECT bool_and(booking_mode='individual' AND group_capacity IS NULL) AS ordinary
            FROM event_types`)
        ).rows,
      ).toEqual([{ ordinary: true }])
      expect(
        (
          await pool.query(`SELECT count(*)::integer AS hosts,count(DISTINCT id)::integer AS ids,
            bool_and(group_slot_id IS NULL AND substring(id::text,15,1)='7') AS ordinary
            FROM booking_hosts`)
        ).rows,
      ).toEqual([
        {
          hosts: before['public.booking_hosts']?.length,
          ids: before['public.booking_hosts']?.length,
          ordinary: true,
        },
      ])
      expect(
        (
          await pool.query(`SELECT id FROM bookings WHERE group_slot_id IS NOT NULL OR group_booker_key IS NOT NULL
            UNION ALL SELECT id FROM organization_operations WHERE group_slot_id IS NOT NULL`)
        ).rows,
      ).toEqual([])
      expect((await pool.query('SELECT * FROM group_slots')).rows).toEqual([])
      // Old ledger rows retain physical identity; this migration adds one new record.
      const oldLedger = await pool.query<{ row: string }>(
        `SELECT to_jsonb(r)::text AS row FROM
          (SELECT name,checksum,applied_at,xmin::text AS _xmin,ctid::text AS _ctid
            FROM schema_migrations WHERE name<>$1) r ORDER BY to_jsonb(r)::text COLLATE "C"`,
        [migration],
      )
      expect(oldLedger.rows.map(({ row }) => row)).toEqual(ledgerBefore['public.schema_migrations'])

      const schema = await snapshotSchema(pool)
      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'group_fresh' })
      expect(await snapshotSchema(fresh.pool), 'fresh and populated-upgrade schema').toEqual(schema)
      expect(
        (await fresh.pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(
        (await pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,
      )
      // A no-op includes all new tables/fields, ledger timestamps and physical tuples.
      const after = await records(pool, latestTables, true)
      expect(await runMigrations(pool, directory)).toEqual([])
      expect(await records(pool, latestTables, true), 'no-op preserves physical tuples').toEqual(
        after,
      )
      expect(await snapshotSchema(pool)).toEqual(schema)
      const freshTables = await inventory(fresh.pool)
      const freshAfter = await records(fresh.pool, freshTables, true)
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await records(fresh.pool, freshTables, true)).toEqual(freshAfter)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      expect(pool.totalCount).toBeLessThanOrEqual(1)
      expect(fresh.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      try {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 60_000)

  it.each([
    ['historical business overwrite', `UPDATE bookings SET responses='{}' WHERE source='api';`],
    ['historical timestamp rewrite', 'UPDATE bookings SET title=title;'],
    [
      'mail budget reseed',
      'INSERT INTO notification_email_sends(recipient_hash,sent_at) VALUES(NULL,now());',
    ],
  ])(
    'detects source-copy %s and passes with restored source',
    async (_protection, appended) => {
      const directory = await mkdtemp(join(tmpdir(), 'hourmere-group-upgrade-mutation-'))
      let owned: TestDatabase | undefined
      try {
        const source = await readFile(join(migrationsDir, migration), 'utf8')
        const check = async (sql: string) => {
          // Only delete the copied migration this test created. All runs rebuild
          // real predecessor data in a new owned throwaway database.
          await rm(join(directory, migration), { force: true })
          owned = await groupSeatsPredecessor(serverUrl as string, directory)
          try {
            const oldTables = (await inventory(owned.pool)).filter(
              (table) => table.name !== 'schema_migrations',
            )
            const before = await records(owned.pool, oldTables)
            await writeFile(join(directory, migration), sql)
            expect(await runMigrations(owned.pool, directory)).toEqual([migration])
            expect(
              await records(owned.pool, oldTables),
              'retained predecessor business values',
            ).toEqual(before)
            expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
          } finally {
            await owned.drop()
            owned = undefined
          }
        }
        await check(source)
        await expect(check(`${source}\n${appended}\n`)).rejects.toMatchObject({
          name: 'AssertionError',
        })
        await check(source)
      } finally {
        try {
          await owned?.drop()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
    },
    60_000,
  )
})
