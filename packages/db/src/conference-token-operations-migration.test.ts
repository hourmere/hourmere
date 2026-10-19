import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0035_conference_token_operations.sql'
const ownerId = '00000000-0000-4000-8000-000000000001'
const otherId = '00000000-0000-4000-8000-000000000002'
const organizationId = '00000000-0000-4000-8000-000000000003'
const sessionId = '00000000-0000-4000-8000-000000000004'
const operationId = '00000000-0000-4000-8000-000000000005'
const connectionId = (n: number) => `00000000-0000-4000-8001-${String(n).padStart(12, '0')}`
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

interface Table {
  schema: string
  name: string
  columns: string[]
}

async function tables(pool: pg.Pool): Promise<Table[]> {
  return (
    await pool.query<Table>(`
      SELECT table_schema AS schema,table_name AS name,
        array_agg(column_name::text ORDER BY ordinal_position) AS columns
      FROM information_schema.columns c
      WHERE table_schema IN ('auth','public') AND table_name <> 'schema_migrations'
        AND EXISTS (SELECT FROM information_schema.tables t
          WHERE t.table_schema=c.table_schema AND t.table_name=c.table_name
            AND t.table_type='BASE TABLE')
      GROUP BY table_schema,table_name ORDER BY table_schema,table_name`)
  ).rows
}

// Explicit predecessor columns and PostgreSQL JSON text retain microseconds and all
// ciphertext bytes. Physical tuple identity also detects unintended data rewrites.
async function records(pool: pg.Pool, inventory: Table[]) {
  const result: Record<string, string[]> = {}
  for (const table of inventory) {
    result[`${table.schema}.${table.name}`] = (
      await pool.query<{ row: string }>(
        `SELECT to_jsonb(r)::text AS row FROM
          (SELECT ${table.columns.map(quote).join(',')},xmin::text AS _xmin,ctid::text AS _ctid
           FROM ${quote(table.schema)}.${quote(table.name)}) r
         ORDER BY to_jsonb(r)::text COLLATE "C"`,
      )
    ).rows.map((row) => row.row)
  }
  return result
}

async function seed(pool: pg.Pool) {
  await pool.query(
    `INSERT INTO auth."user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES
      ($1,'Synthetic lease owner','lease-owner@example.test',true,
        '2026-01-02T03:04:05.123456Z','2026-02-03T04:05:06.654321Z'),
      ($2,'Synthetic other owner','other-lease-owner@example.test',true,
        '2026-01-02T03:04:05.123456Z','2026-02-03T04:05:06.654321Z')`,
    [ownerId, otherId],
  )
  await pool.query(
    `INSERT INTO auth.organization (id,name,slug,"createdAt")
     VALUES ($1,'Synthetic lease team','synthetic-lease-team','2026-01-02T03:04:05.123456Z')`,
    [organizationId],
  )
  await pool.query(
    `INSERT INTO auth.member ("userId","organizationId",role,"createdAt") VALUES
      ($1,$3,'member','2026-01-02T03:04:05.123456Z'),
      ($2,$3,'owner','2026-01-02T03:04:05.123456Z')`,
    [ownerId, otherId, organizationId],
  )
  await pool.query(
    `INSERT INTO auth.session (id,"userId",token,"expiresAt","createdAt","updatedAt",
       "activeOrganizationId")
     VALUES ($1,$2,'synthetic-lease-session','2027-01-01T00:00:00.123456Z',
       '2026-01-02T03:04:05.123456Z','2026-02-03T04:05:06.654321Z',$3)`,
    [sessionId, ownerId, organizationId],
  )
  const identityScopes = ['user:read:user'],
    meetingScopes = [
      ...identityScopes,
      'meeting:write:meeting',
      'meeting:read:meeting',
      'meeting:update:meeting',
      'meeting:delete:meeting',
    ],
    configurations = [
      { status: 'active', mode: 'identity', scopes: identityScopes, error: null },
      { status: 'active', mode: 'meetings', scopes: meetingScopes, error: null },
      { status: 'refreshing', mode: 'meetings', scopes: meetingScopes, error: null },
      { status: 'needs_reauth', mode: 'identity', scopes: identityScopes, error: 'needs_reauth' },
      { status: 'disconnected', mode: 'meetings', scopes: [], error: null },
    ]
  for (const [index, configuration] of configurations.entries()) {
    await pool.query(
      `INSERT INTO conference_connections (id,user_id,provider,external_user_id,account_email,
         display_name,credentials,operation_id,scopes,status,last_error,created_at,updated_at,
         mode,authorized_at)
       VALUES ($1,$2,'zoom',$3,$4,$5,$6,$7,$8,$9,$10,
         '2026-03-04T05:06:07.123456Z','2026-04-05T06:07:08.654321Z',$11,$12)`,
      [
        connectionId(index + 1),
        index === 4 ? null : ownerId,
        index === 4 ? null : `synthetic-lease-zoom-${index}`,
        index === 4 ? null : `lease-zoom-${index}@example.test`,
        index === 4 ? null : `Synthetic Zoom ${index} 東京`,
        configuration.status === 'active'
          ? Buffer.from(`synthetic-lease-ciphertext-${index}-é-\\`)
          : null,
        configuration.status === 'refreshing' ? operationId : null,
        configuration.scopes,
        configuration.status,
        configuration.error,
        configuration.mode,
        index === 1 ? '2026-04-05T06:07:08.123456Z' : null,
      ],
    )
  }
  await pool.query(
    `INSERT INTO conference_oauth_states (state_hash,user_id,session_id,connection_id,verifier,
       claimed,expires_at,created_at,mode,binding_version) VALUES
      ($1,$3,$4,$5,$6,false,'2027-01-01T00:00:00.123456Z',
        '2026-04-05T06:07:08.654321Z','meetings',2),
      ($2,$3,$4,NULL,NULL,true,'2027-01-01T00:00:00.654321Z',
        '2026-04-05T06:07:08.123456Z','identity',2)`,
    [
      'a'.repeat(64),
      'b'.repeat(64),
      ownerId,
      sessionId,
      connectionId(2),
      Buffer.from('synthetic-lease-pkce-ciphertext'),
    ],
  )
}

describe.skipIf(!serverUrl)('conference token operation lease migration', () => {
  it('preserves predecessor grants, matches fresh schema, reruns without writes and cascades owner deletion', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-token-lease-predecessor-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort(),
        initial = files.filter((file) => file < migration)
      expect(['0033', '0034']).toContain(initial.at(-1)?.slice(0, 4))
      for (const file of initial) await copyFile(join(migrationsDir, file), join(predecessor, file))
      upgraded = await createTestDatabase(serverUrl as string, predecessor)
      const pool = upgraded.pool
      expect(
        (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({ name: initial.at(-1) })
      expect(
        (await pool.query("SELECT to_regclass('conference_token_operations') AS name")).rows,
      ).toEqual([{ name: null }])
      await seed(pool)
      const inventory = await tables(pool),
        before = await records(pool, inventory)
      expect(before['public.conference_connections']).toHaveLength(5)
      expect(before['public.conference_oauth_states']).toHaveLength(2)
      expect(before['auth.user']).toHaveLength(2)
      expect(before['auth.session']).toHaveLength(1)

      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      expect(await runMigrations(pool, predecessor)).toEqual([migration])
      expect(await records(pool, inventory)).toEqual(before)
      const latest = await tables(pool)
      expect(latest.filter((table) => table.name !== 'conference_token_operations')).toEqual(
        inventory,
      )
      expect(latest.find((table) => table.name === 'conference_token_operations')).toEqual({
        schema: 'public',
        name: 'conference_token_operations',
        columns: ['user_id', 'operation_id', 'expires_at'],
      })
      expect((await pool.query('SELECT * FROM conference_token_operations')).rows).toEqual([])
      expect(
        (
          await pool.query(`SELECT column_name,udt_name,is_nullable,column_default
         FROM information_schema.columns WHERE table_schema='public'
           AND table_name='conference_token_operations' ORDER BY ordinal_position`)
        ).rows,
      ).toEqual([
        { column_name: 'user_id', udt_name: 'uuid', is_nullable: 'NO', column_default: null },
        { column_name: 'operation_id', udt_name: 'uuid', is_nullable: 'NO', column_default: null },
        {
          column_name: 'expires_at',
          udt_name: 'timestamptz',
          is_nullable: 'NO',
          column_default: null,
        },
      ])
      const schema = await snapshotSchema(pool)
      fresh = await createTestDatabase(serverUrl as string, predecessor)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      const ledger =
          'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name',
        recorded = (await pool.query(ledger)).rows
      expect(
        (await fresh.pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(recorded.map(({ name, checksum }) => ({ name, checksum })))

      await pool.query(
        `INSERT INTO conference_token_operations (user_id,operation_id,expires_at) VALUES
          ($1,$3,'2026-11-01T01:02:03.123456Z'),
          ($2,$3,'2026-11-01T01:02:03.654321Z')`,
        [ownerId, otherId, operationId],
      )
      await expect(
        pool.query(
          `INSERT INTO conference_token_operations (user_id,operation_id,expires_at)
         VALUES ($1,$2,'2026-11-02T00:00Z')`,
          [ownerId, operationId],
        ),
      ).rejects.toMatchObject({ code: '23505' })
      await expect(
        pool.query(
          `INSERT INTO conference_token_operations (user_id,operation_id,expires_at)
         VALUES ('00000000-0000-4000-8000-000000000099',$1,'2026-11-02T00:00Z')`,
          [operationId],
        ),
      ).rejects.toMatchObject({ code: '23503' })
      const populated = await records(pool, await tables(pool))
      expect(await runMigrations(pool, predecessor)).toEqual([])
      expect(await records(pool, await tables(pool))).toEqual(populated)
      expect((await pool.query(ledger)).rows).toEqual(recorded)
      expect(await snapshotSchema(pool)).toEqual(schema)
      expect(await runMigrations(fresh.pool, predecessor)).toEqual([])

      await expect(
        pool.query('DELETE FROM auth."user" WHERE id=$1', [ownerId]),
      ).resolves.toMatchObject({ rowCount: 1 })
      expect((await pool.query('SELECT user_id FROM conference_token_operations')).rows).toEqual([
        { user_id: otherId },
      ])
      expect(pool.totalCount).toBeLessThanOrEqual(1)
      expect(fresh.pool.totalCount).toBeLessThanOrEqual(1)
    } finally {
      try {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      } finally {
        await rm(predecessor, { recursive: true, force: true })
      }
    }
  })
})
