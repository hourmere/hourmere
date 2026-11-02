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
const migration = '0052_follow_up_host_note.sql'
const rule = {
  id: 'after',
  offsetMinutes: 60,
  recipients: { invitee: true, guests: true, host: false },
}
const custom = { reminders: [], followUps: [rule] }
const noteSettings = (hostNote: unknown) => ({ reminders: [], followUps: [{ ...rule, hostNote }] })
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

async function records(pool: pg.Pool) {
  const tables = (
    await pool.query<{ schema: string; name: string }>(`
    SELECT table_schema AS schema,table_name AS name FROM information_schema.tables
    WHERE table_schema IN ('auth','public') AND table_type='BASE TABLE'
      AND table_name<>'schema_migrations' ORDER BY table_schema,table_name`)
  ).rows
  const result: Record<string, string[]> = {}
  for (const table of tables) {
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(`
      SELECT to_jsonb(r)::text AS row FROM
        (SELECT *,xmin::text AS _xmin,ctid::text AS _ctid FROM ${quote(table.schema)}.${quote(table.name)}) r
      ORDER BY to_jsonb(r)::text COLLATE "C"`)
    ).rows.map(({ row }) => row)
  }
  return result
}

async function predecessor(directory: string): Promise<TestDatabase> {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && file.slice(0, 4) <= '0049')
    .sort()
  const early = files.filter((file) => file.slice(0, 4) <= '0012')
  for (const file of early) await copyFile(join(migrationsDir, file), join(directory, file))
  const owned = await createTestDatabase(serverUrl as string, directory, { tag: 'note_old' })
  try {
    await seedEarly(owned.pool)
    for (const file of files.filter((file) => !early.includes(file)))
      await copyFile(join(migrationsDir, file), join(directory, file))
    await runMigrations(owned.pool, directory)
    await seedLater(owned.pool)
    await owned.pool.query(
      `UPDATE event_types SET notifications=$1::jsonb WHERE slug='upgrade-event-1'`,
      [JSON.stringify(custom)],
    )
    await owned.pool.query(
      `UPDATE event_types SET notifications='{"reminders":[],"followUps":[]}' WHERE slug='upgrade-event-2'`,
    )
    await owned.pool.query(
      `UPDATE bookings SET notification_snapshot=$1::jsonb WHERE status='confirmed'`,
      [JSON.stringify({ version: 1, executionMode: 'configurable', notifications: custom })],
    )
    await owned.pool.query(`INSERT INTO booking_scheduled_messages
      (organization_id,booking_id,kind,rule_id,anchor_start_at,anchor_end_at,due_at,expires_at,next_attempt_at,attempts)
      SELECT organization_id,id,'follow_up','after',start_at,end_at,end_at+interval '1 hour',
        end_at+interval '25 hours',end_at+interval '1 hour',2 FROM bookings WHERE status='confirmed';
      INSERT INTO notification_email_sends (recipient_hash,sent_at) VALUES
        (decode(repeat('bc',32),'hex'),'2026-10-01T00:00Z'),(NULL,'2026-10-01T01:00Z');`)
    return owned
  } catch (error) {
    await owned.drop()
    throw error
  }
}

const invalid = [
  noteSettings(null),
  noteSettings(42),
  noteSettings({}),
  noteSettings('a'.repeat(2001)),
  noteSettings('😀'.repeat(1001)),
  noteSettings('\u000b'),
  noteSettings('\u007f'),
  noteSettings('\u0085'),
  noteSettings('\u202a'),
  noteSettings('\u2066'),
  { reminders: [{ ...rule, hostNote: '' }], followUps: [] },
]

async function verifyDatabaseGuards(pool: pg.Pool) {
  const eventId = (
    await pool.query<{ id: string }>('SELECT id FROM event_types ORDER BY id LIMIT 1')
  ).rows[0]?.id
  const bookingId = (
    await pool.query<{ id: string }>('SELECT id FROM bookings ORDER BY id LIMIT 1')
  ).rows[0]?.id
  for (const value of invalid) {
    await expect(
      pool.query('UPDATE event_types SET notifications=$1::jsonb WHERE id=$2', [
        JSON.stringify(value),
        eventId,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      pool.query('UPDATE bookings SET notification_snapshot=$1::jsonb WHERE id=$2', [
        JSON.stringify({ version: 1, executionMode: 'configurable', notifications: value }),
        bookingId,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
  }
  for (const hostNote of [
    '',
    'a'.repeat(2000),
    '😀'.repeat(1000),
    '<script>A & B</script>\r\nNext\tline',
  ]) {
    const settings = noteSettings(hostNote)
    expect(
      (
        await pool.query(
          'UPDATE event_types SET notifications=$1::jsonb WHERE id=$2 RETURNING notifications',
          [JSON.stringify(settings), eventId],
        )
      ).rows,
    ).toEqual([{ notifications: settings }])
    const snapshot = { version: 1, executionMode: 'configurable', notifications: settings }
    expect(
      (
        await pool.query(
          'UPDATE bookings SET notification_snapshot=$1::jsonb WHERE id=$2 RETURNING notification_snapshot',
          [JSON.stringify(snapshot), bookingId],
        )
      ).rows,
    ).toEqual([{ notification_snapshot: snapshot }])
  }
  // JSONB itself rejects invalid Unicode and NUL before the CHECK function runs.
  for (const hostNote of ['\ud800', '\udc00', '\u0000']) {
    await expect(
      pool.query('SELECT valid_booking_message_settings($1::jsonb)', [
        JSON.stringify(noteSettings(hostNote)),
      ]),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^22P0[25]$/) })
  }
}

async function verifyFunctionGuards(pool: pg.Pool) {
  for (const value of invalid)
    expect(
      (
        await pool.query('SELECT valid_booking_message_settings($1::jsonb) AS valid', [
          JSON.stringify(value),
        ])
      ).rows,
    ).toEqual([{ valid: false }])
}

describe.skipIf(!serverUrl)('follow-up host note migration', () => {
  it('preserves populated 0049 data and unchanged defaults, matches fresh install, reruns without writes, and enforces host notes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-note-predecessor-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      upgraded = await predecessor(directory)
      const pool = upgraded.pool
      expect(
        (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({ name: '0049_configurable_booking_messages.sql' })
      const before = await records(pool)
      expect(before['public.booking_scheduled_messages']?.length).toBeGreaterThan(0)
      expect(before['public.booking_notifications']?.length).toBeGreaterThan(0)
      expect(before['public.notification_email_sends']).toHaveLength(2)
      const defaults = (
        await pool.query("SELECT notifications FROM event_types WHERE slug='upgrade-event-3'")
      ).rows
      expect(defaults).toEqual([
        {
          notifications: {
            reminders: [
              {
                id: 'default-24h',
                offsetMinutes: 1440,
                recipients: { invitee: true, guests: true, host: true },
              },
            ],
            followUps: [],
          },
        },
      ])
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(pool, directory)).toEqual([migration])
      expect(await records(pool)).toEqual(before)
      expect(
        (await pool.query("SELECT notifications FROM event_types WHERE slug='upgrade-event-3'"))
          .rows,
      ).toEqual(defaults)
      const schema = await snapshotSchema(pool)
      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'note_fresh' })
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      const ledger =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const recorded = (await pool.query(ledger)).rows
      expect(await runMigrations(pool, directory)).toEqual([])
      expect(await records(pool)).toEqual(before)
      expect((await pool.query(ledger)).rows).toEqual(recorded)
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      await verifyDatabaseGuards(pool)
      await verifyFunctionGuards(pool)
      const source = await readFile(join(migrationsDir, migration), 'utf8')
      const mutations = [
        ["IF rule ? 'hostNote' THEN RETURN false; END IF;", ''],
        [
          "IF jsonb_typeof(rule->'hostNote') IS DISTINCT FROM 'string'",
          "IF false AND jsonb_typeof(rule->'hostNote') IS DISTINCT FROM 'string'",
        ],
        ['IF note ~', 'IF false AND note ~'],
        ['IF note_units > 2000', 'IF note_units > 2001'],
        ['WHEN octet_length(scalar) = 4 THEN 2', 'WHEN octet_length(scalar) = 4 THEN 1'],
      ] as const
      for (const [original, broken] of mutations) {
        expect(source.includes(original)).toBe(true)
        try {
          await pool.query(source.replace(original, broken))
          await expect(verifyFunctionGuards(pool)).rejects.toMatchObject({ name: 'AssertionError' })
        } finally {
          await pool.query(source)
        }
      }
      await verifyFunctionGuards(pool)
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
})
