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
const migration = '0073_scim_identity.sql'

async function records(pool: pg.Pool, tables?: { schema: string; name: string }[]) {
  const selected =
    tables ??
    (
      await pool.query<{ schema: string; name: string }>(
        `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
     WHERE table_schema IN ('auth','public') AND table_type='BASE TABLE'
     AND table_name <> 'schema_migrations' ORDER BY table_schema,table_name`,
      )
    ).rows
  const data: Record<string, unknown> = {}
  for (const table of selected) {
    data[`${table.schema}.${table.name}`] = (
      await pool.query(
        `SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS fingerprint,
       xmin::text,ctid::text FROM "${table.schema}"."${table.name}" t ORDER BY fingerprint`,
      )
    ).rows
  }
  return { tables: selected, data }
}

async function predecessor() {
  const directory = await mkdtemp(join(tmpdir(), 'hourmere-scim-identity-predecessor-'))
  const early = await mkdtemp(join(tmpdir(), 'hourmere-scim-identity-early-'))
  let database: TestDatabase | undefined
  try {
    // Every predecessor migration, including out-of-order numbers merged on main.
    for (const file of (await readdir(migrationsDir)).filter(
      (f) => f.endsWith('.sql') && f !== migration,
    )) {
      await copyFile(join(migrationsDir, file), join(directory, file))
      if (file.slice(0, 4) <= '0012') await copyFile(join(migrationsDir, file), join(early, file))
    }
    database = await createTestDatabase(serverUrl as string, early)
    await seedEarly(database.pool)
    await runMigrations(database.pool, directory)
    await seedLater(database.pool)
    await database.pool.query(`
      INSERT INTO auth.organization (name,slug,"createdAt")
        VALUES ('Second upgrade team','upgrade-scim-team',now());
      INSERT INTO scim_provisioning_tokens
        (organization_id,name,token_hash,previous_token_hash,previous_valid_until,
         created_by_user_id,rotated_by_user_id,rotated_at,last_used_at,revoked_at,created_at)
      SELECT o.id, 'Synthetic ' || states.n,
        CASE WHEN states.n <> 3 THEN substr(encode(sha256(convert_to(o.id::text || states.n::text,'UTF8')),'hex'),1,43) END,
        CASE WHEN states.n = 2 THEN substr(encode(sha256(convert_to(o.id::text || 'previous','UTF8')),'hex'),1,43) END,
        CASE WHEN states.n = 2 THEN '2030-01-02T03:04:05.123456Z'::timestamptz END,
        u.id, CASE WHEN states.n = 2 THEN u.id END,
        CASE WHEN states.n = 2 THEN '2026-01-02T03:04:05.123456Z'::timestamptz END,
        '2026-02-03T04:05:06.654321Z',
        CASE WHEN states.n = 3 THEN '2026-03-04T05:06:07.123456Z'::timestamptz END,
        '2026-01-01T01:02:03.123456Z'
      FROM auth.organization o CROSS JOIN generate_series(1,3) states(n)
      CROSS JOIN LATERAL (SELECT id FROM auth."user" ORDER BY id LIMIT 1) u
      WHERE o.slug IN ('upgrade-team','upgrade-scim-team');
    `)
    return { directory, database }
  } catch (error) {
    await database?.drop()
    await rm(directory, { recursive: true, force: true })
    throw error
  } finally {
    await rm(early, { recursive: true, force: true })
  }
}

describe.skipIf(!serverUrl)('SCIM identity migration', () => {
  it('preserves every predecessor record including active, overlapping and revoked credentials; equals fresh and reruns without writes', async () => {
    const { directory, database } = await predecessor()
    let fresh: TestDatabase | undefined
    try {
      const before = await records(database.pool)
      expect((before.data['public.scim_provisioning_tokens'] as unknown[]).length).toBe(6)
      expect((before.data['public.bookings'] as unknown[]).length).toBeGreaterThan(0)
      expect((before.data['auth.member'] as unknown[]).length).toBeGreaterThan(0)
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(database.pool, directory)).toEqual([migration])
      expect((await records(database.pool, before.tables)).data).toEqual(before.data)
      expect(
        (
          await database.pool.query(
            `SELECT count(*)::integer AS count,count(DISTINCT connection_id)::integer AS connections FROM scim_token_connections`,
          )
        ).rows,
      ).toEqual([{ count: 6, connections: 2 }])
      expect(
        (
          await database.pool.query(
            `SELECT count(*)::integer AS count FROM scim_token_connections b JOIN scim_provisioning_tokens t ON t.id=b.token_id JOIN scim_connections c ON c.id=b.connection_id WHERE b.organization_id=t.organization_id AND c.organization_id=t.organization_id`,
          )
        ).rows,
      ).toEqual([{ count: 6 }])
      expect(
        (
          await database.pool.query(
            `SELECT o.slug,count(DISTINCT c.id)::integer AS connections,
              count(b.token_id)::integer AS bindings
             FROM auth.organization o JOIN scim_connections c ON c.organization_id=o.id
             JOIN scim_token_connections b ON b.connection_id=c.id
             GROUP BY o.slug ORDER BY o.slug`,
          )
        ).rows,
      ).toEqual([
        { slug: 'upgrade-scim-team', connections: 1, bindings: 3 },
        { slug: 'upgrade-team', connections: 1, bindings: 3 },
      ])
      const upgraded = await records(database.pool)
      expect(await runMigrations(database.pool, directory)).toEqual([])
      expect(await records(database.pool)).toEqual(upgraded)
      fresh = await createTestDatabase(serverUrl as string)
      expect(await snapshotSchema(database.pool)).toEqual(await snapshotSchema(fresh.pool))
    } finally {
      await fresh?.drop()
      await database.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('blocks concurrent token creation before the connection snapshot, including a removed-lock control', async () => {
    const source = await readFile(join(migrationsDir, migration), 'utf8')
    for (const mutated of [true, false]) {
      const { directory, database } = await predecessor()
      const migrator = await database.pool.connect()
      const writer = await database.pool.connect()
      try {
        const organization = (
          await writer.query(`INSERT INTO auth.organization (name,slug,"createdAt")
            VALUES ('Concurrent team','concurrent-team',now()) RETURNING id`)
        ).rows[0].id
        const sql = mutated
          ? source.replace('LOCK TABLE scim_provisioning_tokens IN SHARE ROW EXCLUSIVE MODE;', '')
          : source
        const boundary = sql.indexOf('INSERT INTO scim_connections (organization_id)')
        expect(boundary).toBeGreaterThan(0)
        await migrator.query('BEGIN')
        await migrator.query(sql.slice(0, boundary))
        await writer.query("BEGIN; SET LOCAL lock_timeout = '150ms'")
        const insert = () =>
          writer.query(
            `INSERT INTO scim_provisioning_tokens (organization_id,name,token_hash)
            VALUES ($1,'Concurrent token',repeat('z',43))`,
            [organization],
          )
        const verify = async () => {
          await expect(insert()).rejects.toMatchObject({ code: '55P03' })
        }
        if (mutated) await expect(verify()).rejects.toMatchObject({ name: 'AssertionError' })
        else await verify()
        await writer.query('ROLLBACK')
        await migrator.query(sql.slice(boundary))
        await migrator.query('COMMIT')
        await insert()
        expect(
          (
            await writer.query(
              `SELECT count(*)::integer AS count FROM scim_token_connections
            WHERE organization_id=$1`,
              [organization],
            )
          ).rows,
        ).toEqual([{ count: 1 }])
      } finally {
        await writer.query('ROLLBACK')
        await migrator.query('ROLLBACK')
        writer.release()
        migrator.release()
        await database.drop()
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 30_000)

  it.each(['preservation', 'credential binding backfill'])(
    'detects %s source-copy mutation and restores the original assertion',
    async (protection) => {
      const source = await readFile(join(migrationsDir, migration), 'utf8')
      for (const mutated of [true, false]) {
        const { directory, database } = await predecessor()
        try {
          const before = await records(database.pool)
          await writeFile(
            join(directory, migration),
            mutated
              ? protection === 'preservation'
                ? `${source}\nUPDATE scim_provisioning_tokens SET name = 'mutated';`
                : source.replace(
                    /INSERT INTO scim_token_connections \(token_id, organization_id, connection_id\)\nSELECT[^;]+;/,
                    '',
                  )
              : source,
          )
          await runMigrations(database.pool, directory)
          const verify = async () => {
            if (protection === 'preservation')
              expect((await records(database.pool, before.tables)).data).toEqual(before.data)
            else
              expect(
                (
                  await database.pool.query(
                    'SELECT count(*)::integer AS count FROM scim_token_connections',
                  )
                ).rows,
              ).toEqual([{ count: 6 }])
          }
          if (mutated) await expect(verify()).rejects.toMatchObject({ name: 'AssertionError' })
          else await verify()
        } finally {
          await database.drop()
          await rm(directory, { recursive: true, force: true })
        }
      }
    },
    30_000,
  )
})
