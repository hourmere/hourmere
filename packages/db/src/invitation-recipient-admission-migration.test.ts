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
    await pool.query<Table>(`SELECT table_schema AS schema, table_name AS name,
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

describe.skipIf(!serverUrl)('invitation recipient admission migration', () => {
  it('preserves populated predecessor counters and all application data, matches a fresh install and reruns without writes', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-invite-recipient-predecessor-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort()
      const migration = files.find((file) => file.endsWith('_invitation_recipient_admission.sql'))
      if (!migration) throw new Error('Invitation recipient admission migration is missing')
      const initial = files.filter((file) => file < migration)
      const early = initial.filter((file) => file.slice(0, 4) <= '0012')
      for (const file of early) await copyFile(join(migrationsDir, file), join(predecessor, file))
      upgraded = await createTestDatabase(serverUrl as string, predecessor, {
        tag: 'invite_recip_old',
      })
      const pool = upgraded.pool
      await seedEarly(pool)
      for (const file of initial.filter((file) => !early.includes(file)))
        await copyFile(join(migrationsDir, file), join(predecessor, file))
      await runMigrations(pool, predecessor)
      await seedLater(pool)
      await pool.query(`INSERT INTO invitation_email_requests(user_id,organization_id,requested_at)
        SELECT "inviterId","organizationId",clock.requested_at
        FROM auth.invitation CROSS JOIN (VALUES
          ('2026-11-01T12:00:00.123456Z'::timestamptz),
          ('2026-10-31T13:00:00.654321Z'::timestamptz)
        ) AS clock(requested_at);
        INSERT INTO notification_email_sends(recipient_hash,sent_at) VALUES
          (sha256(convert_to('synthetic-invitation-recipient','UTF8')), '2026-11-01T12:00:00.123456Z'),
          (NULL, '2026-11-01T12:00:01.654321Z');`)
      const inventory = await tables(pool)
      const before = await records(pool, inventory)
      expect(before['public.invitation_email_requests']).toHaveLength(2)
      expect(before['public.bookings']).toHaveLength(8)
      expect(before['public.sign_in_emails']).toHaveLength(2)
      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      expect(await runMigrations(pool, predecessor)).toEqual([migration])
      expect(await records(pool, inventory)).toEqual(before)
      expect(
        (await pool.query('SELECT recipient_hash FROM invitation_email_requests')).rows,
      ).toEqual([{ recipient_hash: null }, { recipient_hash: null }])
      const schema = await snapshotSchema(pool)
      expect(
        (
          await pool.query(`SELECT column_name,data_type,is_nullable,column_default
            FROM information_schema.columns WHERE table_schema='public'
            AND table_name='invitation_email_requests' ORDER BY ordinal_position`)
        ).rows,
      ).toEqual([
        { column_name: 'user_id', data_type: 'uuid', is_nullable: 'NO', column_default: null },
        {
          column_name: 'organization_id',
          data_type: 'uuid',
          is_nullable: 'NO',
          column_default: null,
        },
        {
          column_name: 'requested_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'NO',
          column_default: null,
        },
        {
          column_name: 'recipient_hash',
          data_type: 'bytea',
          is_nullable: 'YES',
          column_default: null,
        },
      ])
      expect(
        (
          await pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname='public'
            AND indexname='invitation_email_requests_recipient_time'`)
        ).rows,
      ).toEqual([
        {
          indexdef:
            'CREATE INDEX invitation_email_requests_recipient_time ON public.invitation_email_requests USING btree (recipient_hash, requested_at)',
        },
      ])
      fresh = await createTestDatabase(serverUrl as string, predecessor, {
        tag: 'invite_recip_new',
      })
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      await pool.query(`INSERT INTO invitation_email_requests(user_id,organization_id,recipient_hash,requested_at)
        SELECT user_id,organization_id,sha256(convert_to('synthetic-new-recipient','UTF8')),requested_at
        FROM invitation_email_requests LIMIT 1`)
      const ledger =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const recorded = (await pool.query(ledger)).rows
      const acknowledged = await records(pool, await tables(pool))
      const freshRecorded = (await fresh.pool.query(ledger)).rows
      const freshAcknowledged = await records(fresh.pool, await tables(fresh.pool))
      expect(await runMigrations(pool, predecessor)).toEqual([])
      expect(await records(pool, await tables(pool))).toEqual(acknowledged)
      expect((await pool.query(ledger)).rows).toEqual(recorded)
      expect(await snapshotSchema(pool)).toEqual(schema)
      expect(await runMigrations(fresh.pool, predecessor)).toEqual([])
      expect(await records(fresh.pool, await tables(fresh.pool))).toEqual(freshAcknowledged)
      expect((await fresh.pool.query(ledger)).rows).toEqual(freshRecorded)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
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

  it('rolls the new column and recipient index back if migration acknowledgement fails', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-invite-recipient-rollback-'))
    let owned: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort()
      const migration = files.find((file) => file.endsWith('_invitation_recipient_admission.sql'))
      if (!migration) throw new Error('Invitation recipient admission migration is missing')
      for (const file of files.filter((file) => file < migration))
        await copyFile(join(migrationsDir, file), join(predecessor, file))
      owned = await createTestDatabase(serverUrl as string, predecessor, {
        tag: 'invite_recip_bad',
      })
      await owned.pool.query(`INSERT INTO invitation_email_requests(user_id,organization_id,requested_at)
        VALUES('00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000002','2026-11-01T12:00:00.123456Z');
        CREATE FUNCTION public.reject_invitation_recipient_migration() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN
            IF NEW.name LIKE '%_invitation_recipient_admission.sql' THEN
              RAISE EXCEPTION 'synthetic acknowledgement failure' USING ERRCODE='P0001';
            END IF;
            RETURN NEW;
          END $$;
        CREATE TRIGGER reject_invitation_recipient_migration BEFORE INSERT ON schema_migrations
          FOR EACH ROW EXECUTE FUNCTION public.reject_invitation_recipient_migration();`)
      const beforeSchema = await snapshotSchema(owned.pool)
      const beforeRows = await records(owned.pool, await tables(owned.pool))
      const ledger = 'SELECT name,checksum,applied_at::text FROM schema_migrations ORDER BY name'
      const beforeLedger = (await owned.pool.query(ledger)).rows
      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      await expect(runMigrations(owned.pool, predecessor)).rejects.toMatchObject({
        cause: { code: 'P0001' },
      })
      expect(await snapshotSchema(owned.pool)).toEqual(beforeSchema)
      expect(await records(owned.pool, await tables(owned.pool))).toEqual(beforeRows)
      expect((await owned.pool.query(ledger)).rows).toEqual(beforeLedger)
      expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      try {
        await owned?.drop()
      } finally {
        await rm(predecessor, { recursive: true, force: true })
      }
    }
  }, 60_000)
})
