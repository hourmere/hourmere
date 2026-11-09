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
const migration = '0066_scim_provisioning_tokens.sql'
async function records(pool: pg.Pool) {
  const tables = (
    await pool.query<{ schema: string; name: string }>(
      `SELECT table_schema AS schema,table_name AS name FROM information_schema.tables WHERE table_schema IN ('auth','public') AND table_type='BASE TABLE' AND table_name NOT IN ('schema_migrations','scim_provisioning_tokens') ORDER BY table_schema,table_name`,
    )
  ).rows
  const result: Record<string, unknown> = {}
  for (const t of tables)
    result[`${t.schema}.${t.name}`] = (
      await pool.query(
        `SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS fingerprint,xmin::text,ctid::text FROM "${t.schema}"."${t.name}" t ORDER BY fingerprint`,
      )
    ).rows
  return result
}
// The predecessor is every other migration in the current set, including later ones such as
// 0070: deployed instances apply 0066 out of order, and the result must equal a fresh install.
async function predecessor() {
  const directory = await mkdtemp(join(tmpdir(), 'hourmere-scim-predecessor-'))
  const early = await mkdtemp(join(tmpdir(), 'hourmere-scim-early-'))
  let database: TestDatabase | undefined
  try {
    for (const f of (await readdir(migrationsDir)).filter(
      (f) => f.endsWith('.sql') && f !== migration,
    )) {
      await copyFile(join(migrationsDir, f), join(directory, f))
      if (f.slice(0, 4) <= '0012') await copyFile(join(migrationsDir, f), join(early, f))
    }
    database = await createTestDatabase(serverUrl as string, early)
    await seedEarly(database.pool)
    await runMigrations(database.pool, directory)
    await seedLater(database.pool)
    return { directory, database }
  } catch (error) {
    await database?.drop()
    await rm(directory, { recursive: true, force: true })
    throw error
  } finally {
    await rm(early, { recursive: true, force: true })
  }
}
describe.skipIf(!serverUrl)('SCIM token migration', () => {
  it('preserves populated predecessor records, matches fresh install and reruns without writes', async () => {
    const { directory, database } = await predecessor()
    let fresh: TestDatabase | undefined
    try {
      const before = await records(database.pool)
      expect(Object.values(before).some((rows) => Array.isArray(rows) && rows.length > 0)).toBe(
        true,
      )
      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(database.pool, directory)).toEqual([migration])
      expect(await records(database.pool)).toEqual(before)
      expect(await runMigrations(database.pool, directory)).toEqual([])
      expect(await records(database.pool)).toEqual(before)
      fresh = await createTestDatabase(serverUrl as string)
      expect(await snapshotSchema(database.pool)).toEqual(await snapshotSchema(fresh.pool))
      await expect(
        database.pool.query(
          `INSERT INTO scim_provisioning_tokens(organization_id,name,token_hash) SELECT id,'Synthetic','scim_plaintext' FROM auth.organization LIMIT 1`,
        ),
      ).rejects.toMatchObject({ code: '23514' })
    } finally {
      await fresh?.drop()
      await database.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
  it.each(['preservation', 'hash constraint'])(
    'detects %s SQL source-copy mutation and restores',
    async (protection) => {
      const source = await readFile(join(migrationsDir, migration), 'utf8')
      const mutant =
        protection === 'preservation'
          ? `${source}\nUPDATE auth.organization SET name='mutated';`
          : source.replace("CHECK (token_hash ~ '^[A-Za-z0-9_-]{43}$')", '')
      expect(mutant).not.toBe(source)
      for (const mutated of [true, false]) {
        const { directory, database } = await predecessor()
        try {
          const before = await records(database.pool)
          await writeFile(join(directory, migration), mutated ? mutant : source)
          await runMigrations(database.pool, directory)
          const verify = async () => {
            if (protection === 'preservation') expect(await records(database.pool)).toEqual(before)
            else {
              let code: string | undefined
              try {
                await database.pool.query(
                  `INSERT INTO scim_provisioning_tokens(organization_id,name,token_hash) SELECT id,'Synthetic','scim_plaintext' FROM auth.organization LIMIT 1`,
                )
              } catch (error) {
                code = (error as { code: string }).code
              }
              expect(code).toBe('23514')
            }
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
