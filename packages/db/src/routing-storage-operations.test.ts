import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationsDir } from './migrate.ts'
import {
  operationsFixture,
  operationsMigration,
  operationsProtections,
  operationsTable,
} from './routing-storage-operations-protections.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL

/** Constraints, standalone indexes, triggers and NOT NULL columns of the operations table. */
async function catalogObjects(pool: pg.Pool) {
  const relation = `SELECT oid FROM pg_class WHERE relname=$1 AND relnamespace='public'::regnamespace`
  const names = async (sql: string) =>
    (await pool.query<{ name: string }>(sql, [operationsTable])).rows.map(({ name }) => name).sort()
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
    // NOT NULL columns outside the primary key, as the coverage helper lists them.
    notNull: await names(
      `SELECT c.relname || '.' || a.attname AS name FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      WHERE c.oid=(${relation}) AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull
        AND NOT EXISTS (SELECT FROM pg_index x WHERE x.indrelid=c.oid AND x.indisprimary
          AND a.attnum=ANY(x.indkey))`,
    ),
  }
}

describe.skipIf(!serverUrl)('routing form operation storage', () => {
  let owned: TestDatabase

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'routing_ops' })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('names every constraint, trigger, NOT NULL column and trigger rule in a protection', async () => {
    const { constraints, indexes, triggers, notNull } = await catalogObjects(owned.pool)
    const source = await readFile(join(migrationsDir, operationsMigration), 'utf8')
    // Every rule a guard raises names itself as the error's constraint.
    const rules = [...source.matchAll(/CONSTRAINT = '([a-z_]+)'/g)].map(([, rule]) => rule)
    expect(rules).toEqual([`${operationsTable}_immutable`])
    expect(indexes).toEqual([])
    expect(triggers).toEqual([`${operationsTable}_guard`])
    expect(constraints).toHaveLength(10)
    expect(notNull).toHaveLength(7)
    const objects = [...constraints, ...indexes, ...triggers, ...notNull, ...rules].sort()
    const covered = [
      ...new Set(Object.values(operationsProtections).flatMap(({ objects }) => objects)),
    ].sort()
    expect(covered).toEqual(objects)
    for (const [name, { mutants }] of Object.entries(operationsProtections))
      expect(mutants.length, name).toBeGreaterThan(0)
  })

  it.each(Object.keys(operationsProtections))(
    'enforces %s',
    async (name) => {
      const protection = operationsProtections[name]
      if (!protection) throw new Error(`Missing protection ${name}`)
      await protection.check(await operationsFixture(owned.pool))
      expect(owned.pool.totalCount).toBeLessThanOrEqual(3)
    },
    30_000,
  )
})
