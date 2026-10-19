import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedIntermediate, seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

interface Table {
  schema: string
  name: string
  columns: string[]
}

async function tables(pool: pg.Pool): Promise<Table[]> {
  return (
    await pool.query<Table>(`
      SELECT table_schema AS schema, table_name AS name,
        array_agg(column_name::text ORDER BY ordinal_position) AS columns
      FROM information_schema.columns c
      WHERE table_schema IN ('auth','public') AND table_name <> 'schema_migrations'
        AND EXISTS (SELECT FROM information_schema.tables t
          WHERE t.table_schema=c.table_schema AND t.table_name=c.table_name
            AND t.table_type='BASE TABLE')
      GROUP BY table_schema,table_name ORDER BY table_schema,table_name
    `)
  ).rows
}

// Keep the predecessor's explicit column list: to_jsonb(current_row) alone could
// accidentally bless a dropped column. PostgreSQL text retains timestamp microseconds,
// JSON, arrays and bytea without JavaScript's Date/number conversion losing precision.
async function data(pool: pg.Pool, inventory: Table[], discardIdTokens = false, tuples = false) {
  const result: Record<string, string[]> = {}
  for (const table of inventory) {
    const columns = table.columns.map((column) =>
      discardIdTokens && table.schema === 'auth' && table.name === 'account' && column === 'idToken'
        ? 'NULL::text AS "idToken"' // 0031 deliberately retires only sign-in ID tokens.
        : quote(column),
    )
    if (tuples) columns.push('xmin::text AS "_xmin"', 'ctid::text AS "_ctid"')
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(
        `SELECT to_jsonb(r)::text AS row FROM
          (SELECT ${columns.join(',')} FROM ${quote(table.schema)}.${quote(table.name)}) r
          ORDER BY to_jsonb(r)::text COLLATE "C"`,
      )
    ).rows.map((row) => row.row)
  }
  return result
}

async function assertEarlyBackfills(pool: pg.Pool) {
  expect(
    (
      await pool.query(`SELECT is_hidden,allow_guests,conference_organizer_user_id,zoom_connection_id
      FROM event_types ORDER BY id`)
    ).rows,
  ).toEqual(
    Array.from({ length: 5 }, () => ({
      is_hidden: false,
      allow_guests: false,
      conference_organizer_user_id: null,
      zoom_connection_id: null,
    })),
  )
  expect(
    (
      await pool.query(`SELECT b.id FROM bookings b WHERE
      required_host_user_ids IS DISTINCT FROM ARRAY(
        SELECT h.user_id FROM booking_hosts h WHERE h.booking_id=b.id ORDER BY h.user_id)
      OR hosts_use_default_schedule IS DISTINCT FROM (cardinality(required_host_user_ids)>1)
      OR oauth_consent_id IS NOT NULL OR cancelled_oauth_consent_id IS NOT NULL`)
    ).rows,
  ).toEqual([])
  expect(
    (await pool.query('SELECT last_assigned_sequence::text FROM event_type_hosts')).rows,
  ).toEqual(Array.from({ length: 7 }, () => ({ last_assigned_sequence: '0' })))
  expect((await pool.query('SELECT * FROM round_robin_state')).rows).toEqual([])
  expect((await pool.query('SELECT supports_google_meet FROM calendars')).rows).toEqual([
    { supports_google_meet: false },
    { supports_google_meet: false },
  ])
}

async function activityBackfill(pool: pg.Pool) {
  return (
    await pool.query(`SELECT client_id,min(consented_at)::text AS consented_at,
      max(last_used_at)::text AS last_used_at FROM (
        SELECT "clientId" AS client_id,"createdAt" AS consented_at,"updatedAt" AS last_used_at
          FROM auth."oauthConsent"
        UNION ALL SELECT "clientId","createdAt","createdAt" FROM auth."oauthRefreshToken"
        UNION ALL SELECT "clientId","createdAt","createdAt" FROM auth."oauthAccessToken"
      ) activity GROUP BY client_id ORDER BY client_id`)
  ).rows
}

async function assertIntermediateBackfills(pool: pg.Pool, activity: pg.QueryResultRow[]) {
  expect(
    (
      await pool.query(`SELECT client_id,consented_at::text,last_used_at::text
    FROM mcp_oauth_client_activity ORDER BY client_id`)
    ).rows,
  ).toEqual(activity)
  expect(activity).toHaveLength(2) // A registered but never approved client stays absent.
  expect((await pool.query(`SELECT mode FROM conference_connections ORDER BY id`)).rows).toEqual([
    { mode: 'identity' },
    { mode: 'identity' },
  ])
  expect(
    (
      await pool.query(
        `SELECT mode,binding_version FROM conference_oauth_states ORDER BY state_hash`,
      )
    ).rows,
  ).toEqual([
    { mode: 'identity', binding_version: 1 },
    { mode: 'identity', binding_version: 1 },
  ])
  expect(
    (
      await pool.query(`SELECT provider,zoom_connection_id,zoom_user_id,zoom_meeting_id
    FROM booking_conferences ORDER BY root_booking_id`)
    ).rows,
  ).toEqual([
    {
      provider: 'google_meet',
      zoom_connection_id: null,
      zoom_user_id: null,
      zoom_meeting_id: null,
    },
    {
      provider: 'google_meet',
      zoom_connection_id: null,
      zoom_user_id: null,
      zoom_meeting_id: null,
    },
  ])
  expect(
    (
      await pool.query(`SELECT attempts,lease_id,lease_until,last_error,exhausted_at,skipped_at
    FROM booking_conference_notifications ORDER BY booking_id,kind`)
    ).rows,
  ).toEqual(
    Array.from({ length: 3 }, () => ({
      attempts: 0,
      lease_id: null,
      lease_until: null,
      last_error: null,
      exhausted_at: null,
      skipped_at: null,
    })),
  )
}

describe.skipIf(!serverUrl)('database upgrade path', () => {
  // Fixed historical checkpoints, but the destination is ALWAYS every migration on disk.
  // The later checkpoint exercises data in tables that did not exist at 0012.
  it.each(['0012', '0023', '0030'])(
    'preserves an installation through %s when upgrading to latest',
    async (baseline) => {
      const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-upgrade-path-'))
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort()
        const initial = files.filter((file) => file.slice(0, 4) <= baseline)
        const remaining = files.filter((file) => file.slice(0, 4) > baseline)
        expect(initial.length).toBeGreaterThan(0)
        expect(remaining.length).toBeGreaterThan(0)
        const early = initial.filter((file) => file.slice(0, 4) <= '0012')
        for (const file of early) {
          await copyFile(join(migrationsDir, file), join(predecessor, file))
        }
        upgraded = await createTestDatabase(serverUrl as string, predecessor)
        const pool = upgraded.pool
        await seedEarly(pool)
        // Reuse real early installation history at later checkpoints, including the
        // required-host backfill, before inserting features native to those schemas.
        for (const file of initial.filter((file) => !early.includes(file))) {
          await copyFile(join(migrationsDir, file), join(predecessor, file))
        }
        expect(await runMigrations(pool, predecessor)).toEqual(
          initial.filter((file) => !early.includes(file)),
        )
        if (baseline === '0023') await seedIntermediate(pool)
        if (baseline === '0030') await seedLater(pool)
        const activity = baseline === '0023' ? await activityBackfill(pool) : []
        const inventory = await tables(pool)
        const before = await data(pool, inventory, true)
        // Every predecessor table needs a real row; an empty fixture cannot prove retention.
        if (baseline !== '0023') {
          for (const [table, rows] of Object.entries(before))
            expect(rows.length, table).toBeGreaterThan(0)
        }

        expect(await runMigrations(pool)).toEqual(remaining)
        const upgradedTables = await tables(pool)
        for (const table of inventory) {
          const current = upgradedTables.find(
            (candidate) => candidate.schema === table.schema && candidate.name === table.name,
          )
          expect(current?.columns, `${table.schema}.${table.name}: preserved columns`).toEqual(
            expect.arrayContaining(table.columns),
          )
        }
        expect(await data(pool, inventory)).toEqual(before)
        expect(
          (await pool.query('SELECT "idToken" IS NULL AS cleared FROM auth.account')).rows,
        ).toEqual([{ cleared: true }, { cleared: true }, { cleared: true }])
        if (baseline === '0012') await assertEarlyBackfills(pool)
        if (baseline === '0023') await assertIntermediateBackfills(pool, activity)

        const ledger =
          'SELECT name,checksum,applied_at::text FROM schema_migrations ORDER BY applied_at,name'
        const recorded = (await pool.query(ledger)).rows
        expect(recorded.map((row) => row.name)).toEqual(files)
        for (const [index, file] of files.entries()) {
          const sql = await readFile(join(migrationsDir, file), 'utf8')
          expect(recorded[index]?.checksum).toBe(
            createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex'),
          )
        }
        fresh = await createTestDatabase(serverUrl as string)
        const schema = await snapshotSchema(pool)
        expect(schema).toEqual(await snapshotSchema(fresh.pool))
        expect(
          (await fresh.pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name'))
            .rows,
        ).toEqual(recorded.map(({ name, checksum }) => ({ name, checksum })))

        // A no-op includes data, ledger timestamps and physical tuples, not just return value.
        const latestTables = await tables(pool)
        latestTables.push({
          schema: 'public',
          name: 'schema_migrations',
          columns: ['name', 'checksum', 'applied_at'],
        })
        const after = await data(pool, latestTables, false, true)
        expect(await runMigrations(pool)).toEqual([])
        expect(await data(pool, latestTables, false, true)).toEqual(after)
        expect((await pool.query(ledger)).rows).toEqual(recorded)
        expect(await snapshotSchema(pool)).toEqual(schema)
        // Sequential queries reuse one connection per database, with no auth/job pools.
        expect(pool.totalCount).toBeLessThanOrEqual(1)
        expect(fresh.pool.totalCount).toBeLessThanOrEqual(1)
      } finally {
        try {
          await Promise.all([fresh?.drop(), upgraded?.drop()])
        } finally {
          await rm(predecessor, { recursive: true, force: true })
        }
      }
    },
    60_000,
  )
})
