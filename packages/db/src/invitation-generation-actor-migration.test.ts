import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
const migration = '0045_invitation_generation_actor.sql'
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
      WHERE table_schema IN ('auth','public') AND table_name <> 'schema_migrations'
        AND EXISTS (SELECT FROM information_schema.tables t
          WHERE t.table_schema=c.table_schema AND t.table_name=c.table_name
            AND t.table_type='BASE TABLE')
      GROUP BY table_schema,table_name ORDER BY table_schema,table_name`)
  ).rows
}
async function records(pool: pg.Pool, tables: Table[]) {
  const result: Record<string, string[]> = {}
  for (const table of tables)
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(`SELECT to_jsonb(r)::text AS row FROM
        (SELECT ${table.columns.map(quote).join(',')},xmin::text AS _xmin,ctid::text AS _ctid
          FROM ${quote(table.schema)}.${quote(table.name)}) r
        ORDER BY to_jsonb(r)::text COLLATE "C"`)
    ).rows.map((row) => row.row)
  return result
}
async function verifyColumn(pool: pg.Pool) {
  expect(
    (
      await pool.query(`SELECT data_type,is_nullable,column_default
        FROM information_schema.columns WHERE table_schema='public'
        AND table_name='invitation_deliveries' AND column_name='authorized_by_user_id'`)
    ).rows,
    'the generation actor column must exist without changing legacy rows',
  ).toEqual([{ data_type: 'uuid', is_nullable: 'YES', column_default: null }])
}

describe.skipIf(!serverUrl)('invitation generation actor migration', () => {
  it('preserves populated predecessor data, matches a fresh install and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-generation-actor-predecessor-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort()
      const early = files.filter((file) => file.slice(0, 4) <= '0012')
      for (const file of early) await copyFile(join(migrationsDir, file), join(directory, file))
      upgraded = await createTestDatabase(serverUrl as string, directory, { tag: 'actor_old' })
      const pool = upgraded.pool
      await seedEarly(pool)
      for (const file of files.filter((file) => !early.includes(file)))
        await copyFile(join(migrationsDir, file), join(directory, file))
      await runMigrations(pool, directory)
      await seedLater(pool)
      await pool.query(`INSERT INTO auth.invitation
        ("organizationId",email,role,status,"expiresAt","createdAt","inviterId")
        SELECT "organizationId",'actor-'||fixture.name||'@example.test','member',
          fixture.status,fixture.expires,'2026-01-02T03:04:05.123456Z',"inviterId"
        FROM (SELECT * FROM auth.invitation ORDER BY id LIMIT 1) original CROSS JOIN (VALUES
          ('queued','pending',now()+interval '2 days'),
          ('accepted','accepted',now()+interval '2 days'),
          ('expired','pending',now()-interval '2 days'),
          ('canceled','canceled',now()+interval '2 days')
        ) AS fixture(name,status,expires);
        INSERT INTO invitation_deliveries
          (invitation_id,generation,state,attempts,created_at,updated_at,
            generation_started_at,resend_request_id,last_error_code)
          SELECT id,7,'failed',2,'2026-01-03T04:05:06.654321Z',
            '2026-01-04T05:06:07.123456Z','2026-01-03T04:05:06.654321Z',
            gen_random_uuid(),'smtp_temporary'
          FROM auth.invitation WHERE email LIKE 'actor-%';`)
      const tables = await inventory(pool)
      const before = await records(pool, tables)
      expect(before['public.invitation_deliveries']).toHaveLength(5)
      expect(before['public.bookings']).toHaveLength(8)
      expect(before['public.sign_in_emails']).toHaveLength(2)
      expect(
        (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({ name: '0044_invitation_delivery_attempt_time.sql' })
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(pool, directory)).toEqual([migration])
      expect(await records(pool, tables)).toEqual(before)
      await verifyColumn(pool)
      expect(
        (await pool.query('SELECT authorized_by_user_id FROM invitation_deliveries')).rows,
      ).toEqual(Array.from({ length: 5 }, () => ({ authorized_by_user_id: null })))
      const schema = await snapshotSchema(pool)
      fresh = await createTestDatabase(serverUrl as string, directory, { tag: 'actor_fresh' })
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      await verifyColumn(fresh.pool)
      const currentTables = await inventory(pool)
      const currentRecords = await records(pool, currentTables)
      const ledger =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const acknowledgements = (await pool.query(ledger)).rows
      expect(await runMigrations(pool, directory)).toEqual([])
      expect(await records(pool, currentTables)).toEqual(currentRecords)
      expect((await pool.query(ledger)).rows).toEqual(acknowledgements)
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      expect(
        (await fresh.pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(acknowledgements.map(({ name, checksum }) => ({ name, checksum })))
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

  it('detects a source-copy migration that omits the actor column with a real database assertion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-generation-actor-mutation-'))
    let owned: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file <= migration)
        .sort()
      for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
      const source = await readFile(join(directory, migration), 'utf8')
      expect(source.includes('ADD COLUMN authorized_by_user_id uuid')).toBe(true)
      await writeFile(
        join(directory, migration),
        source.replace(
          'ADD COLUMN authorized_by_user_id uuid',
          'ADD COLUMN ignored_generation_actor uuid',
        ),
      )
      owned = await createTestDatabase(serverUrl as string, directory, { tag: 'actor_mutant' })
      await expect(verifyColumn(owned.pool)).rejects.toMatchObject({ name: 'AssertionError' })
    } finally {
      try {
        await owned?.drop()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 30_000)
})
