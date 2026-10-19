import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0033_conference_authorization_time.sql'
const userId = '00000000-0000-4000-8000-000000000001'
const sessionId = '00000000-0000-4000-8000-000000000002'
const connectionId = (n: number) => `00000000-0000-4000-8001-${String(n).padStart(12, '0')}`

async function seed(pool: pg.Pool) {
  await pool.query(
    `INSERT INTO auth."user" (id,name,email,"emailVerified","createdAt","updatedAt")
     VALUES ($1,'Synthetic Zoom migration owner','zoom-migration@example.test',true,
       '2026-01-02T03:04:05.123456Z','2026-02-03T04:05:06.654321Z')`,
    [userId],
  )
  await pool.query(
    `INSERT INTO auth.session (id,"userId",token,"expiresAt","createdAt","updatedAt")
     VALUES ($1,$2,'synthetic-migration-session','2027-01-01T00:00Z',
       '2026-01-02T03:04:05.123456Z','2026-02-03T04:05:06.654321Z')`,
    [sessionId, userId],
  )
  const identityScopes = ['user:read:user']
  const meetingScopes = [
    ...identityScopes,
    'meeting:write:meeting',
    'meeting:read:meeting',
    'meeting:update:meeting',
    'meeting:delete:meeting',
  ]
  const configurations = [
    { status: 'active', mode: 'identity', scopes: identityScopes, error: null },
    { status: 'active', mode: 'meetings', scopes: meetingScopes, error: null },
    { status: 'refreshing', mode: 'meetings', scopes: meetingScopes, error: null },
    { status: 'needs_reauth', mode: 'identity', scopes: identityScopes, error: 'needs_reauth' },
    { status: 'disconnected', mode: 'meetings', scopes: [], error: null },
    { status: 'disconnected', mode: 'identity', scopes: [], error: null },
  ]
  for (const [index, config] of configurations.entries()) {
    const retainedOwner = index !== 5
    await pool.query(
      `INSERT INTO conference_connections (id,user_id,provider,external_user_id,account_email,
         display_name,credentials,operation_id,scopes,status,last_error,created_at,updated_at,mode)
       VALUES ($1,$2,'zoom',$3,$4,$5,$6,$7,$8,$9,$10,
         '2026-03-04T05:06:07.123456Z','2026-04-05T06:07:08.654321Z',$11)`,
      [
        connectionId(index + 1),
        retainedOwner ? userId : null,
        retainedOwner ? `synthetic_zoom_${index}` : null,
        retainedOwner ? `synthetic-zoom-${index}@example.test` : null,
        retainedOwner ? `Synthetic Zoom ${index} 東京` : null,
        config.status === 'active' ? Buffer.from(`synthetic-ciphertext-${index}-é-\\`) : null,
        config.status === 'refreshing' ? '00000000-0000-4000-8002-000000000001' : null,
        config.scopes,
        config.status,
        config.error,
        config.mode,
      ],
    )
  }
  await pool.query(
    `INSERT INTO conference_oauth_states (state_hash,user_id,session_id,connection_id,verifier,
       claimed,expires_at,created_at,mode,binding_version)
     VALUES ($1,$2,$3,$4,$5,false,'2027-01-01T00:00Z',
       '2026-04-05T06:07:08.654321Z','meetings',2)`,
    ['a'.repeat(64), userId, sessionId, connectionId(2), Buffer.from('synthetic-pkce-ciphertext')],
  )
}

// Compare JSON encoded by PostgreSQL, retaining timestamp microseconds and all ciphertext
// bytes. Tuple identities prove adding the nullable column did not rewrite existing rows.
async function records(pool: pg.Pool) {
  return (
    await pool.query(
      `SELECT 'connections' AS relation,id::text,
         encode(convert_to((to_jsonb(c) - 'authorized_at')::text,'UTF8'),'hex') AS bytes,
         xmin::text,ctid::text FROM conference_connections c
       UNION ALL
       SELECT 'states',state_hash,encode(convert_to(to_jsonb(s)::text,'UTF8'),'hex'),
         xmin::text,ctid::text FROM conference_oauth_states s
       UNION ALL
       SELECT 'users',id::text,encode(convert_to(to_jsonb(u)::text,'UTF8'),'hex'),
         xmin::text,ctid::text FROM auth."user" u
       UNION ALL
       SELECT 'sessions',id::text,encode(convert_to(to_jsonb(s)::text,'UTF8'),'hex'),
         xmin::text,ctid::text FROM auth.session s ORDER BY relation,id`,
    )
  ).rows
}

async function authorizationColumn(pool: pg.Pool) {
  return (
    await pool.query(
      `SELECT data_type,is_nullable,column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name='conference_connections'
         AND column_name='authorized_at'`,
    )
  ).rows
}

describe.skipIf(!serverUrl)('conference authorization time migration', () => {
  it('preserves populated 0032 grants verbatim, matches a fresh install and reruns without writes', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-authorization-predecessor-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      for (const file of await readdir(migrationsDir)) {
        if (file.endsWith('.sql') && file < migration) {
          await copyFile(join(migrationsDir, file), join(predecessor, file))
        }
      }
      upgraded = await createTestDatabase(serverUrl as string, predecessor)
      const pool = upgraded.pool
      expect(
        (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.at(-1),
      ).toEqual({ name: '0032_booking_conferences_booking_id_index.sql' })
      expect(await authorizationColumn(pool)).toEqual([])
      await seed(pool)
      const before = await records(pool)
      expect(before.filter((row) => row.relation === 'connections')).toHaveLength(6)

      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      expect(await runMigrations(pool, predecessor)).toEqual([migration])
      expect(await records(pool)).toEqual(before)
      expect(await authorizationColumn(pool)).toEqual([
        { data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      ])
      expect(
        (await pool.query('SELECT authorized_at FROM conference_connections ORDER BY id')).rows,
      ).toEqual(Array.from({ length: 6 }, () => ({ authorized_at: null })))
      const upgradedSchema = await snapshotSchema(pool)
      const ledger =
        'SELECT name,checksum,applied_at::text,xmin::text,ctid::text FROM schema_migrations ORDER BY name'
      const recorded = (await pool.query(ledger)).rows

      expect(await runMigrations(pool, predecessor)).toEqual([])
      expect(await records(pool)).toEqual(before)
      expect((await pool.query(ledger)).rows).toEqual(recorded)
      expect(await snapshotSchema(pool)).toEqual(upgradedSchema)

      fresh = await createTestDatabase(serverUrl as string, predecessor)
      expect(await snapshotSchema(fresh.pool)).toEqual(upgradedSchema)
      expect(await authorizationColumn(fresh.pool)).toEqual(await authorizationColumn(pool))
      expect(
        (await fresh.pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(recorded.map(({ name, checksum }) => ({ name, checksum })))
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
  })
})
