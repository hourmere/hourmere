import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import {
  creationKeyFixture,
  creationKeyProtections,
  creationKeyTable,
} from './workflow-storage-creation-keys-protections.ts'

const serverUrl = process.env.DATABASE_URL

/** Constraints, standalone indexes, triggers and NOT NULL columns outside the primary key. */
async function catalogObjects(pool: pg.Pool) {
  const relation = `SELECT oid FROM pg_class WHERE relname=$1 AND relnamespace='public'::regnamespace`
  const names = async (sql: string) =>
    (await pool.query<{ name: string }>(sql, [creationKeyTable])).rows
      .map(({ name }) => name)
      .sort()
  return {
    constraints: await names(
      `SELECT conname AS name FROM pg_constraint WHERE contype<>'n' AND conrelid=(${relation})`,
    ),
    indexes: await names(
      `SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE i.indrelid=(${relation})
        AND NOT EXISTS (SELECT FROM pg_constraint k WHERE k.conindid=i.indexrelid)`,
    ),
    triggers: await names(
      `SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal AND tgrelid=(${relation})`,
    ),
    notNull: await names(
      `SELECT c.relname || '.' || a.attname AS name FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      WHERE c.oid=(${relation}) AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull
        AND NOT EXISTS (SELECT FROM pg_index x WHERE x.indrelid=c.oid AND x.indisprimary
          AND a.attnum=ANY(x.indkey))`,
    ),
  }
}

describe.skipIf(!serverUrl)('workflow creation key storage', () => {
  let owned: TestDatabase

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'workflow_keys' })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('names every constraint and NOT NULL column in a protection', async () => {
    const { constraints, indexes, triggers, notNull } = await catalogObjects(owned.pool)
    expect(constraints).toEqual([
      'workflow_creation_keys_credential',
      'workflow_creation_keys_fingerprint_length',
      'workflow_creation_keys_key_format',
      'workflow_creation_keys_pkey',
      'workflow_creation_keys_scope',
      'workflow_creation_keys_workflow',
    ])
    expect(indexes).toEqual([])
    expect(triggers).toEqual([])
    expect(notNull).toEqual([
      'workflow_creation_keys.actor_user_id',
      'workflow_creation_keys.created_at',
      'workflow_creation_keys.credential_kind',
      'workflow_creation_keys.idempotency_key',
      'workflow_creation_keys.request_fingerprint',
    ])
    const covered = [
      ...new Set(Object.values(creationKeyProtections).flatMap(({ objects }) => objects)),
    ].sort()
    expect(covered).toEqual([...constraints, ...notNull].sort())
    for (const [name, { mutants }] of Object.entries(creationKeyProtections))
      expect(mutants.length, name).toBeGreaterThan(0)
  })

  it.each(Object.keys(creationKeyProtections))(
    'enforces %s',
    async (name) => {
      const protection = creationKeyProtections[name]
      if (!protection) throw new Error(`Missing protection ${name}`)
      await protection.check(await creationKeyFixture(owned.pool))
      expect(owned.pool.totalCount).toBeLessThanOrEqual(3)
    },
    30_000,
  )
})
