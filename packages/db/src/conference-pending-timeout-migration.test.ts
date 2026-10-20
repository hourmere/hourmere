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
const migration = '0037_conference_pending_timeout.sql'
// The complete CHECK domain published in 0023, plus SQL NULL.
const legacyErrors = [
  'disabled',
  'calendar_unavailable',
  'needs_reauth',
  'permissions_missing',
  'provider_unavailable',
  'ambiguous_create',
  'conference_failed',
  'invalid_response',
  'meeting_started',
  'organizer_unavailable',
  null,
]
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
interface Table {
  schema: string
  name: string
  columns: string[]
}
async function tables(pool: pg.Pool): Promise<Table[]> {
  const inventory = (
    await pool.query<Table>(`SELECT table_schema AS schema,table_name AS name,
      array_agg(column_name::text ORDER BY ordinal_position) AS columns
      FROM information_schema.columns c
      WHERE table_schema IN ('auth','public') AND table_name <> 'schema_migrations'
        AND EXISTS (SELECT FROM information_schema.tables t
          WHERE t.table_schema=c.table_schema AND t.table_name=c.table_name
            AND t.table_type='BASE TABLE')
      GROUP BY table_schema,table_name ORDER BY table_schema,table_name`)
  ).rows
  // Only the intentionally retired flag is excluded from preservation checks.
  for (const table of inventory)
    if (table.schema === 'public' && table.name === 'booking_conferences')
      table.columns = table.columns.filter((column) => column !== 'retry_conference')
  return inventory
}
// Keep explicit predecessor columns, microsecond timestamps and physical tuples;
// retiring an unused flag must not rewrite retained data or request identities.
async function records(pool: pg.Pool, inventory: Table[]) {
  const result: Record<string, string[]> = {}
  for (const table of inventory)
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(`SELECT to_jsonb(r)::text AS row FROM
        (SELECT ${table.columns.map(quote).join(',')},xmin::text AS _xmin,ctid::text AS _ctid
          FROM ${quote(table.schema)}.${quote(table.name)}) r
        ORDER BY to_jsonb(r)::text COLLATE "C"`)
    ).rows.map((row) => row.row)
  return result
}

describe.skipIf(!serverUrl)('Conference pending timeout migration', () => {
  it('preserves every predecessor error and tuple, matches fresh schema and reruns without writes', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-meet-timeout-predecessor-'))
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
      // Preserve one legacy transport failure and one near-exhausted pending
      // import, including both historical values of the retired write-only flag.
      await pool.query(`UPDATE booking_conferences SET state='pending',applied_revision=NULL,
        attempts=11,retry_conference=true WHERE provider='google_meet'`)
      await pool.query(`UPDATE booking_conferences SET state='failed',applied_revision=NULL,
        error_code='provider_unavailable',retry_conference=false WHERE provider='zoom'`)
      const legacyRows = legacyErrors.flatMap((error_code, index) =>
        [false, true].map((retry_conference) => ({
          external_event_id: `synthetic_legacy_error_${index.toString().padStart(2, '0')}_${Number(retry_conference)}`,
          error_code,
          retry_conference,
        })),
      )
      // Every historical error must survive with either value of the dropped
      // flag. Give each case its own booking/root instead of rewriting one row.
      for (const [index, row] of legacyRows.entries())
        await pool.query(
          `WITH template AS (
            SELECT * FROM booking_conferences WHERE external_event_id='synthetic_meet_event'
          ), booking AS (
            INSERT INTO bookings (organization_id,event_type_id,start_at,end_at,title,location,
              responses,source,required_host_user_ids,hosts_use_default_schedule,created_at,updated_at)
            SELECT b.organization_id,b.event_type_id,b.start_at+$4::integer*interval '1 day',
              b.end_at+$4::integer*interval '1 day',b.title,b.location,b.responses,'web',
              b.required_host_user_ids,b.hosts_use_default_schedule,b.created_at,b.updated_at
            FROM bookings b JOIN template t ON t.booking_id=b.id RETURNING id
          )
          INSERT INTO booking_conferences (root_booking_id,organization_id,booking_id,
            organizer_user_id,calendar_id,connection_id,revision,state,request_id,create_started,
            external_event_id,error_code,attempts,next_attempt_at,updated_at,
            invitation_organizer_name,invitation_organizer_email,retry_conference)
          SELECT b.id,t.organization_id,b.id,t.organizer_user_id,t.calendar_id,t.connection_id,
            t.revision,'failed',gen_random_uuid(),true,$1,$2,$4,t.next_attempt_at,t.updated_at,
            t.invitation_organizer_name,t.invitation_organizer_email,$3
          FROM booking b CROSS JOIN template t`,
          [row.external_event_id, row.error_code, row.retry_conference, index + 1],
        )
      expect(
        (
          await pool.query(`SELECT external_event_id,error_code,retry_conference
            FROM booking_conferences WHERE external_event_id LIKE 'synthetic_legacy_error_%'
            ORDER BY external_event_id COLLATE "C"`)
        ).rows,
      ).toEqual(legacyRows)
      const inventory = await tables(pool)
      const before = await records(pool, inventory)
      expect(before['public.booking_conferences']).toHaveLength(24)
      expect(before['public.calendar_connections']?.length).toBeGreaterThan(0)
      expect(before['public.bookings']?.length).toBeGreaterThan(0)
      expect(
        (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({ name: '0036_google_meet_conference_patch.sql' })

      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      expect(await runMigrations(pool, predecessor)).toEqual([migration])
      expect(await records(pool, inventory)).toEqual(before)
      expect(
        (
          await pool.query(`SELECT external_event_id,error_code
            FROM booking_conferences WHERE external_event_id LIKE 'synthetic_legacy_error_%'
            ORDER BY external_event_id COLLATE "C"`)
        ).rows,
      ).toEqual(
        legacyRows.map(({ external_event_id, error_code }) => ({ external_event_id, error_code })),
      )
      expect(
        (
          await pool.query(`SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='booking_conferences'
            AND column_name='retry_conference'`)
        ).rows,
      ).toEqual([])
      await expect(
        pool.query(`UPDATE booking_conferences SET state='failed',
          error_code='conference_pending_timeout' WHERE external_event_id='synthetic_meet_event'`),
      ).resolves.toMatchObject({ rowCount: 1 })
      expect(
        (
          await pool.query(
            `SELECT error_code FROM booking_conferences WHERE external_event_id='synthetic_meet_event'`,
          )
        ).rows,
      ).toEqual([{ error_code: 'conference_pending_timeout' }])
      await expect(
        pool.query(`UPDATE booking_conferences SET error_code='unrecognized_error'`),
      ).rejects.toMatchObject({ code: '23514' })
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
