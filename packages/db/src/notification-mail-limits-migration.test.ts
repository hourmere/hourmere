import { createHash } from 'node:crypto'
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
const migration = '0040_notification_mail_limits.sql'
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
async function records(pool: pg.Pool, inventory: Table[]) {
  const result: Record<string, string[]> = {}
  for (const table of inventory) {
    const columns = table.columns.map(quote).concat('xmin::text AS _xmin', 'ctid::text AS _ctid')
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(`SELECT to_jsonb(r)::text AS row FROM
        (SELECT ${columns.join(',')} FROM ${quote(table.schema)}.${quote(table.name)}) r
        ORDER BY to_jsonb(r)::text COLLATE "C"`)
    ).rows.map((row) => row.row)
  }
  return result
}

describe.skipIf(!serverUrl)('notification mail limits migration', () => {
  it('preserves populated predecessor data, backfills retained deliveries, matches fresh schema and reruns without writes', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-mail-limits-predecessor-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const initial = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort()
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
        DECLARE selected_booking_id uuid; attendee_id uuid; host_id uuid;
        BEGIN
          SELECT a.booking_id,a.id INTO selected_booking_id,attendee_id
            FROM booking_attendees a WHERE a.is_booker ORDER BY a.id LIMIT 1;
          SELECT h.user_id INTO host_id FROM booking_hosts h
            WHERE h.booking_id=selected_booking_id ORDER BY h.user_id LIMIT 1;
          DELETE FROM booking_notifications;
          UPDATE booking_attendees SET email='  Ada@Example.TEST  ' WHERE id=attendee_id;
          INSERT INTO booking_notifications (booking_id,kind,recipient,outcome,created_at)
            VALUES (selected_booking_id,'confirmed','attendee:'||attendee_id,'sent',now()-interval '10 minutes'),
              (selected_booking_id,'reminder','host:'||host_id,'sent',now()-interval '20 minutes'),
              (selected_booking_id,'cancelled','attendee:00000000-0000-4000-8000-000000000001','sent',now()-interval '2 hours'),
              (selected_booking_id,'rescheduled','attendee:'||attendee_id,'rejected',now()-interval '30 minutes'),
              (selected_booking_id,'cancelled','attendee:'||attendee_id,'sent',now()-interval '3 days');
        END $$`)
      const inventory = await tables(pool)
      const before = await records(pool, inventory)
      expect(before['public.bookings']?.length).toBeGreaterThan(0)
      expect(before['public.booking_notifications']).toHaveLength(5)
      expect(
        (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({ name: '0039_calendar_busy_all_day_dates.sql' })
      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      expect(await runMigrations(pool, predecessor)).toEqual([migration])
      expect(await records(pool, inventory)).toEqual(before)
      expect(
        (await pool.query('SELECT suppression_reason FROM booking_notifications')).rows,
      ).toEqual(Array.from({ length: 5 }, () => ({ suppression_reason: null })))
      const accounting = (
        await pool.query<{ hash: string | null; at: string }>(`SELECT
          encode(recipient_hash,'hex') AS hash,sent_at::text AS at
          FROM notification_email_sends ORDER BY sent_at DESC`)
      ).rows
      expect(accounting.map((row) => row.hash)).toEqual([
        createHash('sha256').update('ada@example.test').digest('hex'),
        null,
        null,
      ])
      expect(
        (
          await pool.query(`SELECT created_at::text AS at FROM booking_notifications
            WHERE outcome='sent' AND created_at >= now()-interval '2 days'
            ORDER BY created_at DESC`)
        ).rows.map((row) => row.at),
      ).toEqual(accounting.map((row) => row.at))

      const bookingId = (await pool.query<{ id: string }>('SELECT id FROM bookings LIMIT 1'))
        .rows[0]?.id
      const recipient = 'attendee:00000000-0000-4000-8000-000000000002'
      const insert = (reason: string | null, outcome = 'suppressed', token: Buffer | null = null) =>
        pool.query(
          `INSERT INTO booking_notifications
          (booking_id,kind,recipient,outcome,suppression_reason,manage_token_hash)
          VALUES ($1,'confirmed',$2,$3,$4,$5)`,
          [bookingId, recipient, outcome, reason, token],
        )
      await expect(insert(null)).rejects.toMatchObject({ code: '23514' })
      await expect(insert('unknown_limit')).rejects.toMatchObject({ code: '23514' })
      await expect(insert('recipient_hourly_limit', 'sent')).rejects.toMatchObject({
        code: '23514',
      })
      await expect(
        insert('recipient_hourly_limit', 'suppressed', Buffer.alloc(32, 1)),
      ).rejects.toMatchObject({ code: '23514' })
      await expect(insert('recipient_hourly_limit')).resolves.toMatchObject({ rowCount: 1 })
      await expect(
        pool.query('INSERT INTO notification_email_sends VALUES ($1,now())', [Buffer.alloc(31)]),
      ).rejects.toMatchObject({ code: '23514' })

      const schema = await snapshotSchema(pool)
      fresh = await createTestDatabase(serverUrl as string, predecessor)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      expect((await fresh.pool.query('SELECT * FROM notification_email_sends')).rows).toEqual([])
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
