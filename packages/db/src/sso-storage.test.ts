import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationsDir } from './migrate.ts'
import {
  inRolledBackTransaction,
  ssoFixture,
  ssoMigration,
  ssoTables,
} from './sso-storage-fixtures.ts'
import { ssoProtections } from './sso-storage-protections.ts'
import { checkActiveClaimRace } from './sso-storage-races.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL

/** Constraints, standalone indexes and triggers the migration creates, by name. */
async function catalogObjects(pool: pg.Pool) {
  const tables = [...ssoTables]
  const constraints = (
    await pool.query<{ name: string }>(
      `SELECT conname AS name FROM pg_constraint
      WHERE conrelid = ANY(SELECT oid FROM pg_class WHERE relname = ANY($1) AND relnamespace='public'::regnamespace)`,
      [tables],
    )
  ).rows.map(({ name }) => name)
  const indexes = (
    await pool.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = ANY(SELECT oid FROM pg_class WHERE relname = ANY($1) AND relnamespace='public'::regnamespace)
        AND NOT EXISTS (SELECT FROM pg_constraint k WHERE k.conindid = i.indexrelid)`,
      [tables],
    )
  ).rows.map(({ name }) => name)
  const triggers = (
    await pool.query<{ name: string }>(
      `SELECT tgname AS name FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid = ANY(SELECT oid FROM pg_class WHERE relname = ANY($1) AND relnamespace='public'::regnamespace)`,
      [tables],
    )
  ).rows.map(({ name }) => name)
  return { constraints, indexes: indexes.sort(), triggers }
}

describe.skipIf(!serverUrl)('SSO configuration storage', () => {
  let owned: TestDatabase

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'sso_storage' })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('names every constraint, index, trigger and trigger rule in a protection', async () => {
    const { constraints, indexes, triggers } = await catalogObjects(owned.pool)
    const source = await readFile(join(migrationsDir, ssoMigration), 'utf8')
    // Every rule a guard raises names itself as the error's constraint.
    const rules = [...source.matchAll(/CONSTRAINT = '([a-z_]+)'/g)].map(([, rule]) => rule)
    const objects = [...new Set([...constraints, ...indexes, ...triggers, ...rules])].sort()
    expect(constraints.length).toBeGreaterThan(60)
    expect(indexes).toEqual([
      'sso_domains_active_name',
      'sso_domains_organization_name',
      'sso_provider_domains_domain_id',
      'sso_recovery_nominations_member_id',
      'sso_recovery_owners_member_id',
    ])
    expect(triggers).toHaveLength(5)
    expect(new Set(rules).size).toBe(22)
    const covered = [...new Set(Object.values(ssoProtections).flatMap(({ objects }) => objects))]
    expect(covered.sort()).toEqual(objects)
    for (const [name, { mutants }] of Object.entries(ssoProtections))
      expect(mutants.length, name).toBeGreaterThan(0)
  })

  it.each(Object.keys(ssoProtections))('enforces %s', async (name) => {
    const protection = ssoProtections[name]
    if (!protection) throw new Error(`Missing protection ${name}`)
    await inRolledBackTransaction(owned.pool, async (db) => protection.check(await ssoFixture(db)))
    expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
  })

  it('keeps one active claim per domain under concurrent writers', async () => {
    await checkActiveClaimRace(owned.pool)
    expect(owned.pool.totalCount).toBeLessThanOrEqual(4)
  }, 30_000)
})
