import { randomUUID } from 'node:crypto'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import {
  MIGRATION_COVERAGE_TIMEOUT,
  MIGRATION_REPLAY_TIMEOUT,
  useMigrationReplay,
} from './testing/migration-replay.ts'
import type { TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0186_microsoft_calendar_delta.sql'
const graphCalendar = randomUUID()
const graphSibling = randomUUID()
const googleCalendar = randomUUID()
const seriesIndex = 'calendar_busy_microsoft_series'

async function seedCalendars(pool: pg.Pool) {
  await expect(
    pool.query(
      `WITH owner AS (
        INSERT INTO auth."user" (name, email, "emailVerified")
        VALUES ('Calendar owner', 'calendar@example.test', true) RETURNING id
      ), connections AS (
        INSERT INTO calendar_connections (user_id, provider, external_account_id, scopes, credentials)
        SELECT id, 'microsoft', 'graph-user', ARRAY['Calendars.ReadBasic'], decode('a1b2', 'hex') FROM owner
        UNION ALL
        SELECT id, 'google', 'google-user', ARRAY['https://www.googleapis.com/auth/calendar.events.readonly'], decode('c3d4', 'hex') FROM owner
        RETURNING id, provider
      )
      INSERT INTO calendars (id, connection_id, external_id, name, check_conflicts, time_zone, sync_state, last_synced_at, sync_error)
      SELECT $1::uuid, id, 'graph-primary', 'Outlook calendar', true, NULL,
        '{"version":2,"start":"2026-10-19T00:00:00Z","end":"2027-11-29T00:00:00Z","timeZone":null}'::jsonb,
        '2026-10-22T13:45:00.123456Z'::timestamptz, 'provider_unavailable'
        FROM connections WHERE provider = 'microsoft'
      UNION ALL
      SELECT $2::uuid, id, 'graph-shared', 'Shared calendar', true, NULL, NULL, NULL, NULL
        FROM connections WHERE provider = 'microsoft'
      UNION ALL
      SELECT $3::uuid, id, 'google-calendar', 'Google calendar', false, 'America/Los_Angeles',
        '{"version":2,"token":"synthetic-google-cursor","start":"2026-10-19T00:00:00Z","end":"2027-11-29T00:00:00Z","timeZone":"America/Los_Angeles"}'::jsonb,
        '2026-10-22T13:00:00Z'::timestamptz, NULL
        FROM connections WHERE provider = 'google'`,
      [graphCalendar, graphSibling, googleCalendar],
    ),
  ).resolves.toMatchObject({ rowCount: 3 })
}

async function assertDeltaProtections(pool: pg.Pool) {
  await seedCalendars(pool)
  const setError = (error: string | null) =>
    pool.query('UPDATE calendars SET sync_error = $1 WHERE id = $2', [error, graphCalendar])
  for (const error of [
    'calendar_removed',
    'needs_reauth',
    'permissions_missing',
    'provider_unavailable',
    null,
  ]) {
    await expect(setError(error)).resolves.toMatchObject({ rowCount: 1 })
  }
  await expect(setError('raw_graph_error')).rejects.toMatchObject({
    code: '23514',
    constraint: 'calendars_sync_error_check',
  })

  const stage = (
    calendar: string,
    position: number,
    event: string | null,
    removesSeries: boolean | null,
    isException: boolean | null,
  ) =>
    pool.query(
      `INSERT INTO calendar_microsoft_changes
        (calendar_id, position, external_event_id, removes_series, is_exception)
      VALUES ($1, $2, $3, $4, $5)`,
      [calendar, position, event, removesSeries, isException],
    )
  await expect(stage(graphCalendar, 0, 'occurrence', false, false)).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(stage(graphCalendar, 0, 'duplicate position', false, false)).rejects.toMatchObject({
    code: '23505',
    constraint: 'calendar_microsoft_changes_pkey',
  })
  await expect(stage(graphSibling, 0, 'cancelled series', true, false)).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(stage(randomUUID(), 1, 'orphan', false, false)).rejects.toMatchObject({
    code: '23503',
    constraint: 'calendar_microsoft_changes_calendar_id_fkey',
  })
  await expect(stage(graphCalendar, 1, null, false, false)).rejects.toMatchObject({
    code: '23502',
    column: 'external_event_id',
  })
  await expect(stage(graphCalendar, 1, 'event', null, false)).rejects.toMatchObject({
    code: '23502',
    column: 'removes_series',
  })
  await expect(stage(graphCalendar, 1, 'event', false, null)).rejects.toMatchObject({
    code: '23502',
    column: 'is_exception',
  })
  await expect(
    pool.query('DELETE FROM calendars WHERE id = $1', [graphCalendar]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query('SELECT calendar_id, position FROM calendar_microsoft_changes'),
  ).resolves.toMatchObject({ rows: [{ calendar_id: graphSibling, position: 0 }] })

  await expect(
    pool.query(
      `SELECT pg_get_indexdef(indexrelid) AS definition
      FROM pg_index WHERE indexrelid = to_regclass($1) AND indisready AND indisvalid`,
      [`public.${seriesIndex}`],
    ),
  ).resolves.toMatchObject({
    rows: [
      {
        definition: `CREATE INDEX ${seriesIndex} ON public.calendar_busy USING btree (calendar_id, microsoft_series_id, microsoft_original_start) WHERE (microsoft_series_id IS NOT NULL)`,
      },
    ],
  })
}

async function originalRows(pool: pg.Pool) {
  const connections = await pool.query(
    'SELECT to_jsonb(cc)::text AS data, xmin::text, ctid::text FROM calendar_connections cc ORDER BY id',
  )
  const calendars = await pool.query(
    'SELECT to_jsonb(c)::text AS data, xmin::text, ctid::text FROM calendars c ORDER BY id',
  )
  const busy = await pool.query(
    `SELECT (to_jsonb(b) - 'microsoft_series_id' - 'microsoft_original_start')::text AS data,
      xmin::text, ctid::text FROM calendar_busy b ORDER BY calendar_id, external_event_id`,
  )
  return { connections: connections.rows, calendars: calendars.rows, busy: busy.rows }
}

describe.skipIf(!serverUrl)('Microsoft calendar delta migration', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'fails an assertion when any new protection is dropped',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        assertions: assertDeltaProtections,
        predecessorTemplate: replay.predecessor,
      })
      expect(report.problems).toEqual([])
      expect(report.results.map(({ status }) => status)).toEqual(Array(7).fill('covered'))
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it(
    'preserves busy snapshots and settings, matches a fresh schema, and reruns as a no-op',
    async () => {
      const { directory, predecessor } = replay
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        upgraded = await predecessor.clone(undefined, { migrate: false, tag: 'graph_delta_up' })
        await seedCalendars(upgraded.pool)
        await upgraded.pool.query(
          `INSERT INTO calendar_busy (calendar_id, external_event_id, period, all_day_start, all_day_end) VALUES
          ($1, 'legacy-graph-event', '[2026-10-23T15:00:00.123456Z,2026-10-23T16:00:00Z)', NULL, NULL),
          ($1, 'legacy-graph-all-day', '[2026-11-01T07:00:00Z,2026-11-02T08:00:00Z)', NULL, NULL),
          ($2, 'google-floating-date', NULL, '2026-10-23', '2026-10-24')`,
          [graphCalendar, googleCalendar],
        )
        const before = await originalRows(upgraded.pool)
        expect(before.calendars).toHaveLength(3)
        expect(before.busy).toHaveLength(3)

        await copyFile(join(migrationsDir, migration), join(directory, migration))
        await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([migration])
        expect(await originalRows(upgraded.pool)).toEqual(before)
        await expect(
          upgraded.pool.query('SELECT * FROM calendar_microsoft_changes'),
        ).resolves.toMatchObject({ rows: [] })
        await expect(
          upgraded.pool.query(
            `SELECT external_event_id FROM calendar_busy
          WHERE microsoft_series_id IS NOT NULL OR microsoft_original_start IS NOT NULL`,
          ),
        ).resolves.toMatchObject({ rows: [] })

        fresh = await predecessor.clone(undefined, { migrate: false, tag: 'graph_delta_new' })
        await expect(runMigrations(fresh.pool, directory)).resolves.toEqual([migration])
        expect(await snapshotSchema(upgraded.pool)).toEqual(await snapshotSchema(fresh.pool))
        await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([])
        await expect(runMigrations(fresh.pool, directory)).resolves.toEqual([])
        expect(await originalRows(upgraded.pool)).toEqual(before)
      } finally {
        await Promise.all([upgraded?.drop(), fresh?.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )
})
