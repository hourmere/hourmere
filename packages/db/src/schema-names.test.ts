import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testing.ts'

/**
 * Native auth transactions set `search_path TO auth, public` and run application code on
 * that connection (invitation acceptance, team leave with its departure-impact check, the
 * sign-up policy). Unqualified public table names then resolve to `auth` first, so a
 * relation of the same name in both schemas would silently read the wrong table. Every
 * migration, including Better Auth's generated ones, must keep the two name sets disjoint.
 */
const serverUrl = process.env.DATABASE_URL

const RELATIONS = `SELECT n.nspname AS schema, c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('auth', 'public') AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`

async function sharedNames(client: pg.Pool | pg.PoolClient) {
  const { rows } = await client.query<{ schema: string; name: string }>(RELATIONS)
  const names = (schema: string) =>
    new Set(rows.filter((row) => row.schema === schema).map((row) => row.name))
  const auth = names('auth')
  const pub = names('public')
  return { auth, pub, shared: [...pub].filter((name) => auth.has(name)).sort() }
}

describe.skipIf(!serverUrl)('auth and public relation names', () => {
  let owned: TestDatabase
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'schema_names' })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('never names a relation the same in auth and public after every migration', async () => {
    const { auth, pub, shared } = await sharedNames(owned.pool)
    // Both schemas are populated by the migrations, so this cannot pass vacuously.
    expect(auth.has('member')).toBe(true)
    expect(pub.has('organization_operations')).toBe(true)
    expect(shared, 'relation names present in both auth and public').toEqual([])
  })

  it('detects a relation added to auth under a public name', async () => {
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('CREATE TABLE auth.organization_operations (id int)')
      expect((await sharedNames(client)).shared).toEqual(['organization_operations'])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
