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
const migration = '0038_booking_ical_identity.sql'
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
// Explicit predecessor columns retain every old value, including SQL timestamp
// microseconds. The identity backfill necessarily updates bookings' physical tuples.
async function records(pool: pg.Pool, inventory: Table[], tuples = false) {
  const result: Record<string, string[]> = {}
  for (const table of inventory) {
    const columns = table.columns.map(quote)
    if (tuples) columns.push('xmin::text AS _xmin', 'ctid::text AS _ctid')
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(`SELECT to_jsonb(r)::text AS row FROM
        (SELECT ${columns.join(',')} FROM ${quote(table.schema)}.${quote(table.name)}) r
        ORDER BY to_jsonb(r)::text COLLATE "C"`)
    ).rows.map((row) => row.row)
  }
  return result
}

async function insertNewBooking(pool: pg.Pool) {
  return (
    await pool.query(`INSERT INTO bookings (organization_id,start_at,end_at,title,source)
      SELECT id,'2035-01-02T12:00Z','2035-01-02T12:30Z','Post-upgrade booking','web'
      FROM auth.organization ORDER BY id LIMIT 1
      RETURNING id,ical_version,ical_organizer_name,ical_organizer_email`)
  ).rows[0]
}

describe.skipIf(!serverUrl)('booking iCalendar identity migration', () => {
  it('pins legacy organizers without changing history and defaults only new UIDs to v2', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-ical-predecessor-'))
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
      // Neither an unverified account nor a former organization member may be
      // promoted to organizer merely because a historical booking_host remains.
      await pool.query(`DO $$ DECLARE booking_id uuid; org_id uuid;
        unverified_id uuid; former_id uuid; BEGIN
        SELECT id,organization_id INTO booking_id,org_id FROM bookings
          WHERE title='Upgrade booking 6';
        INSERT INTO auth."user" (name,email,"emailVerified") VALUES
          ('Unverified host','unverified-ical@example.test',false) RETURNING id INTO unverified_id;
        INSERT INTO auth."user" (name,email,"emailVerified") VALUES
          ('Former host','former-ical@example.test',true) RETURNING id INTO former_id;
        INSERT INTO auth.member ("organizationId","userId",role,"createdAt")
          VALUES (org_id,unverified_id,'member',now());
        INSERT INTO booking_hosts (booking_id,user_id)
          VALUES (booking_id,unverified_id),(booking_id,former_id);
      END $$`)
      const organization = (
        await pool.query(`SELECT organization_id FROM bookings WHERE title='Upgrade booking 6'`)
      ).rows[0]?.organization_id
      const namedSecond = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      await pool.query(
        `INSERT INTO auth."user" (id,name,email,"emailVerified")
        VALUES ($1,'Named second host','named-second-ical@example.test',true)`,
        [namedSecond],
      )
      await pool.query(
        `INSERT INTO auth.member ("organizationId","userId",role,"createdAt")
        VALUES ($1,$2,'member',now())`,
        [organization, namedSecond],
      )
      const fallbackCases = [
        {
          name: '',
          handle: 'empty-ical-host',
          email: 'empty-name-ical@example.test',
          safeName: undefined,
        },
        {
          name: '\t\u00a0\ufeff ',
          handle: 'space-ical-host',
          email: 'space-name-ical@example.test',
          safeName: undefined,
        },
        {
          name: '  ',
          handle: undefined,
          email: `${'first.'.repeat(6)}long-fallback@${'subdomain.'.repeat(15)}example.test`,
          safeName: undefined,
        },
        {
          name: `Control${String.fromCharCode(1)}Host`,
          handle: undefined,
          email: 'control-name-ical@example.test',
          safeName: 'Control Host',
        },
        {
          name: String.fromCharCode(1),
          handle: 'control-ical-host',
          email: 'control-only-ical@example.test',
          safeName: 'control-ical-host',
        },
        {
          name: 'Long'.repeat(100),
          handle: undefined,
          email: 'long-name-ical@example.test',
          safeName: 'Long'.repeat(80),
        },
      ]
      const fallbackExpected = new Map<string, { name: string; email: string }>()
      for (const [index, sample] of fallbackCases.entries()) {
        const host = `00000000-0000-4000-8000-00000000000${index + 1}`
        await pool.query(
          `INSERT INTO auth."user" (id,name,email,"emailVerified") VALUES ($1,$2,$3,true)`,
          [host, sample.name, sample.email],
        )
        await pool.query(
          `INSERT INTO auth.member ("organizationId","userId",role,"createdAt")
          VALUES ($1,$2,'member',now())`,
          [organization, host],
        )
        if (sample.handle)
          await pool.query(`INSERT INTO profiles (user_id,handle,time_zone) VALUES ($1,$2,'UTC')`, [
            host,
            sample.handle,
          ])
        const booking = (
          await pool.query(
            `INSERT INTO bookings (organization_id,start_at,end_at,title,source,status,cancelled_at)
            VALUES ($1,'2035-01-02T12:00Z','2035-01-02T12:30Z',$2,'web','cancelled',now())
            RETURNING id`,
            [organization, `Blank primary name ${index}`],
          )
        ).rows[0]?.id
        fallbackExpected.set(booking, {
          name: sample.safeName ?? sample.handle ?? sample.email,
          email: sample.email,
        })
        await pool.query(`INSERT INTO booking_hosts (booking_id,user_id) VALUES ($1,$2),($1,$3)`, [
          booking,
          host,
          namedSecond,
        ])
      }
      // Conference organizer account names differ from their pinned invitations.
      // A rescheduled successor must inherit that same snapshot as its UID's root.
      await pool.query(`DO $$ DECLARE root_id uuid; next_id uuid; org_id uuid; BEGIN
        SELECT id,organization_id INTO root_id,org_id FROM bookings
          WHERE title='Upgrade collective Meet';
        UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=root_id;
        INSERT INTO bookings (organization_id,start_at,end_at,title,source,rescheduled_from_id)
          VALUES (org_id,'2028-04-12T09:00Z','2028-04-12T09:45Z',
            'Rescheduled legacy Meet','web',root_id) RETURNING id INTO next_id;
        INSERT INTO booking_hosts (booking_id,user_id)
          SELECT next_id,user_id FROM booking_hosts WHERE booking_id=root_id;
        INSERT INTO booking_attendees (booking_id,name,email,time_zone,is_booker)
          VALUES (next_id,'Legacy invitee','legacy-invitee@example.test','Europe/Berlin',true);
        UPDATE booking_conferences SET booking_id=next_id WHERE root_booking_id=root_id;
      END $$`)
      const expected = (
        await pool.query(`SELECT b.id,u.name,u.handle,u.email FROM bookings b
          LEFT JOIN LATERAL (SELECT u.name,p.handle,u.email FROM booking_hosts h
            JOIN auth."user" u ON u.id=h.user_id
            JOIN auth.member m ON m."userId"=u.id AND m."organizationId"=b.organization_id
            LEFT JOIN profiles p ON p.user_id=u.id
            WHERE h.booking_id=b.id AND u."emailVerified" ORDER BY u.id LIMIT 1) u ON true
          ORDER BY b.id`)
      ).rows.map((row) => ({
        id: row.id,
        ical_version: 1,
        ical_organizer_name:
          fallbackExpected.get(row.id)?.name ?? (row.name?.trim() || row.handle || row.email),
        ical_organizer_email: row.email,
      }))
      const pinned = (
        await pool.query(`SELECT id FROM bookings WHERE title IN
          ('Upgrade collective Meet','Upgrade individual Zoom','Rescheduled legacy Meet')`)
      ).rows.map((row) => row.id)
      expect(pinned).toHaveLength(3)
      for (const row of expected)
        if (pinned.includes(row.id)) {
          row.ical_organizer_name = 'Synthetic organizer'
          row.ical_organizer_email = 'organizer@example.test'
        }
      expect(expected.some((row) => row.ical_organizer_email === null)).toBe(true)
      const inventory = await tables(pool)
      const before = await records(pool, inventory)
      expect(before['public.bookings']).toHaveLength(15)
      expect(before['public.booking_attendees']?.length).toBeGreaterThan(0)
      expect(before['public.booking_conferences']).toHaveLength(2)
      expect(
        (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({ name: '0037_conference_pending_timeout.sql' })

      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      await expect(runMigrations(pool, predecessor)).resolves.toEqual([migration])
      expect(await records(pool, inventory)).toEqual(before)
      expect(
        (
          await pool.query(`SELECT id,ical_version,ical_organizer_name,ical_organizer_email
          FROM bookings ORDER BY id`)
        ).rows,
      ).toEqual(expected)
      expect(
        (
          await pool.query(`SELECT ical_organizer_name,ical_organizer_email FROM bookings
            WHERE title LIKE 'Blank primary name %' ORDER BY title`)
        ).rows,
      ).toEqual(
        fallbackCases.map((sample) => ({
          ical_organizer_name: sample.safeName ?? sample.handle ?? sample.email,
          ical_organizer_email: sample.email,
        })),
      )
      expect(await insertNewBooking(pool)).toMatchObject({
        ical_version: 2,
        ical_organizer_name: null,
        ical_organizer_email: null,
      })
      const schema = await snapshotSchema(pool)
      fresh = await createTestDatabase(serverUrl as string, predecessor)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      await fresh.pool.query(`INSERT INTO auth.organization (name,slug,"createdAt")
        VALUES ('Fresh install','fresh-ical-install',now())`)
      const created = await insertNewBooking(fresh.pool)
      expect(created).toMatchObject({
        ical_version: 2,
        ical_organizer_name: null,
        ical_organizer_email: null,
      })
      for (const assignment of [
        'ical_version=0',
        'ical_version=3',
        "ical_organizer_name='Host'",
        "ical_organizer_email='host@example.test'",
        "ical_organizer_name='',ical_organizer_email='host@example.test'",
        "ical_organizer_name=E'Host\\nInjected',ical_organizer_email='host@example.test'",
        "ical_organizer_name='Host',ical_organizer_email=E'host@example.test\\n'",
        "ical_organizer_name='Host',ical_organizer_email='host @example.test'",
      ])
        await expect(
          fresh.pool.query(`UPDATE bookings SET ${assignment} WHERE id=$1`, [created.id]),
        ).rejects.toMatchObject({ code: '23514' })
      await fresh.pool.query(
        `UPDATE bookings SET ical_organizer_name='Host 東京',
        ical_organizer_email='sender@self-host.example.test' WHERE id=$1`,
        [created.id],
      )
      const ledger =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const recorded = (await pool.query(ledger)).rows
      expect(
        (await fresh.pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(recorded.map(({ name, checksum }) => ({ name, checksum })))
      const latest = await tables(pool)
      const acknowledged = await records(pool, latest, true)
      expect(await runMigrations(pool, predecessor)).toEqual([])
      expect(await records(pool, latest, true)).toEqual(acknowledged)
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
