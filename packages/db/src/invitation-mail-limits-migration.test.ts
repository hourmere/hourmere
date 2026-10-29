import { randomUUID } from 'node:crypto'
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
  for (const table of inventory)
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(`SELECT to_jsonb(r)::text AS row FROM
        (SELECT ${table.columns.map(quote).join(',')}
          FROM ${quote(table.schema)}.${quote(table.name)}) r
        ORDER BY to_jsonb(r)::text COLLATE "C"`)
    ).rows.map((row) => row.row)
  return result
}

describe.skipIf(!serverUrl)('invitation mail limits migration', () => {
  it('preserves populated predecessor data and prior native resend expiry while pinning 48-hour validity, matching fresh install and rerunning without writes', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-invite-budget-predecessor-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort()
      const migration = files.find((file) => file.endsWith('_invitation_mail_limits.sql'))
      if (!migration) throw new Error('Invitation limits migration is missing')
      const initial = files.filter((file) => file < migration)
      const early = initial.filter((file) => file.slice(0, 4) <= '0012')
      for (const file of early) await copyFile(join(migrationsDir, file), join(predecessor, file))
      upgraded = await createTestDatabase(serverUrl as string, predecessor, {
        tag: 'invite_old',
      })
      const pool = upgraded.pool
      await seedEarly(pool)
      for (const file of initial.filter((file) => !early.includes(file)))
        await copyFile(join(migrationsDir, file), join(predecessor, file))
      await runMigrations(pool, predecessor)
      await seedLater(pool)
      await pool.query(`INSERT INTO auth.invitation
        ("organizationId",email,role,status,"expiresAt","createdAt","inviterId")
        SELECT "organizationId",'limit-'||fixture.name||'@example.test','member',
          fixture.status,fixture.expires,'2026-01-02T03:04:05.123456Z',"inviterId"
        FROM auth.invitation CROSS JOIN (VALUES
          ('queued','pending','2026-01-05T04:05:06.123457Z'::timestamptz),
          ('accepted','accepted','2026-01-04T03:04:05.123456Z'::timestamptz),
          ('expired','pending','2026-01-02T02:04:05.123456Z'::timestamptz),
          ('prior-resend','pending','2027-01-04T03:04:05.123456Z'::timestamptz)
        ) AS fixture(name,status,expires);
        INSERT INTO invitation_deliveries
          (invitation_id,generation,state,attempts,created_at,updated_at,resend_request_id,last_error_code)
          SELECT id,7,'failed',4,'2026-01-03T04:05:06.654321Z',
            '2026-01-04T05:06:07.123456Z',gen_random_uuid(),'smtp_temporary'
          FROM auth.invitation WHERE email LIKE 'limit-%';
        INSERT INTO notification_email_sends (recipient_hash,sent_at)
          VALUES (sha256(convert_to('synthetic-budget-recipient','UTF8')),
            '2026-02-03T04:05:06.654321Z');`)
      const inventory = await tables(pool)
      const before = await records(pool, inventory)
      expect(before['public.invitation_deliveries']).toHaveLength(5)
      expect(before['public.bookings']).toHaveLength(8)
      expect(before['public.sign_in_emails']).toHaveLength(2)
      // A native resend retained creation time while replacing expiry. The migration
      // must preserve these timestamps without interpreting the widened gap as TTL.
      expect(
        (
          await pool.query(`SELECT "expiresAt"-"createdAt">interval '48 hours' AS renewed
            FROM auth.invitation WHERE email='limit-prior-resend@example.test'`)
        ).rows,
      ).toEqual([{ renewed: true }])
      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      expect(await runMigrations(pool, predecessor)).toEqual([migration])
      expect(await records(pool, inventory)).toEqual(before)
      expect(
        (
          await pool.query(`SELECT email,generation_started_at::text,expiry_duration_ms::text,
          generation_started_at=created_at AS original_generation_start
          FROM invitation_deliveries d JOIN auth.invitation i ON i.id=d.invitation_id
          WHERE email LIKE 'limit-%' ORDER BY email`)
        ).rows,
      ).toEqual([
        {
          email: 'limit-accepted@example.test',
          generation_started_at: '2026-01-03 04:05:06.654321+00',
          expiry_duration_ms: '172800000',
          original_generation_start: true,
        },
        {
          email: 'limit-expired@example.test',
          generation_started_at: '2026-01-03 04:05:06.654321+00',
          expiry_duration_ms: '172800000',
          original_generation_start: true,
        },
        {
          email: 'limit-prior-resend@example.test',
          generation_started_at: '2026-01-03 04:05:06.654321+00',
          expiry_duration_ms: '172800000',
          original_generation_start: true,
        },
        {
          email: 'limit-queued@example.test',
          generation_started_at: '2026-01-03 04:05:06.654321+00',
          expiry_duration_ms: '172800000',
          original_generation_start: true,
        },
      ])
      expect(
        (
          await pool.query(`SELECT bool_and(expiry_duration_ms=172800000) AS known_validity
          FROM invitation_deliveries`)
        ).rows,
      ).toEqual([{ known_validity: true }])
      expect((await pool.query('SELECT * FROM invitation_email_requests')).rows).toEqual([])
      const schema = await snapshotSchema(pool)
      fresh = await createTestDatabase(serverUrl as string, predecessor, {
        tag: 'invite_new',
      })
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      const ledger =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const recorded = (await pool.query(ledger)).rows
      const latest = await tables(pool)
      const acknowledged = await records(pool, latest)
      expect(await runMigrations(pool, predecessor)).toEqual([])
      expect(await records(pool, latest)).toEqual(acknowledged)
      expect((await pool.query(ledger)).rows).toEqual(recorded)
      expect(await snapshotSchema(pool)).toEqual(schema)
      expect(await runMigrations(fresh.pool, predecessor)).toEqual([])
      expect(
        (await fresh.pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(recorded.map(({ name, checksum }) => ({ name, checksum })))
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

  it('retains admission counters after account/team deletion and enforces positive original validity', async () => {
    const owned = await createTestDatabase(serverUrl as string, undefined, {
      tag: 'invite_checks',
    })
    try {
      const userId = randomUUID()
      const organizationId = randomUUID()
      const invitationId = randomUUID()
      await owned.pool.query(
        `INSERT INTO auth.organization(id,name,slug,"createdAt")
        VALUES($1,'Budget team',$2,now());`,
        [organizationId, `budget-${organizationId}`],
      )
      await owned.pool.query(
        `INSERT INTO auth."user"(id,name,email,"emailVerified")
        VALUES($1,'Budget inviter',$2,true);`,
        [userId, `budget-${userId}@example.test`],
      )
      await owned.pool.query(
        `INSERT INTO auth.invitation
        (id,"organizationId",email,role,status,"expiresAt","inviterId")
        VALUES($1,$2,'budget-recipient@example.test','member','pending',now()+interval '2 days',$3)`,
        [invitationId, organizationId, userId],
      )
      await owned.pool.query(
        `INSERT INTO invitation_deliveries(invitation_id,state) VALUES($1,'queued')`,
        [invitationId],
      )
      expect(
        (
          await owned.pool.query(`SELECT expiry_duration_ms::text,
        generation_started_at=created_at AS generation_default FROM invitation_deliveries`)
        ).rows,
      ).toEqual([{ expiry_duration_ms: '172800000', generation_default: true }])
      for (const duration of [0, -1])
        await expect(
          owned.pool.query(`UPDATE invitation_deliveries SET expiry_duration_ms=$1`, [duration]),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'invitation_deliveries_expiry_duration',
        })
      await expect(
        owned.pool.query(`UPDATE invitation_deliveries SET generation_started_at=NULL`),
      ).rejects.toMatchObject({ code: '23502', column: 'generation_started_at' })
      await owned.pool.query(
        `INSERT INTO invitation_email_requests(user_id,organization_id,recipient_hash,requested_at)
        VALUES($1,$2,sha256(convert_to('synthetic-retained-recipient','UTF8')),
          '2026-11-01T12:00:00.123456Z')`,
        [userId, organizationId],
      )
      const retained = (
        await owned.pool.query('SELECT to_jsonb(r)::text AS row FROM invitation_email_requests r')
      ).rows
      await owned.pool.query('DELETE FROM auth.organization WHERE id=$1', [organizationId])
      await owned.pool.query('DELETE FROM auth."user" WHERE id=$1', [userId])
      expect(
        (await owned.pool.query('SELECT to_jsonb(r)::text AS row FROM invitation_email_requests r'))
          .rows,
      ).toEqual(retained)
      const schema = await snapshotSchema(owned.pool)
      expect(
        schema.constraints.filter(
          (c) => c.relation === 'invitation_email_requests' && c.kind === 'f',
        ),
      ).toEqual([])
      expect(
        schema.indexes.filter((i) => i.relation === 'invitation_email_requests').map((i) => i.name),
      ).toEqual([
        'invitation_email_requests_organization_time',
        'invitation_email_requests_recipient_time',
        'invitation_email_requests_time',
        'invitation_email_requests_user_time',
      ])
      expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      await owned.drop()
    }
  }, 60_000)
})
