import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationsDir } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import {
  workflowFixture,
  workflowMigration,
  workflowProtections,
  workflowTables,
} from './workflow-storage-protections.ts'

const serverUrl = process.env.DATABASE_URL

/** Constraints, standalone indexes, triggers and NOT NULL columns the migration creates. */
async function catalogObjects(pool: pg.Pool) {
  const tables = [...workflowTables]
  const relations = `SELECT oid FROM pg_class WHERE relname = ANY($1) AND relnamespace='public'::regnamespace`
  const names = async (sql: string) =>
    (await pool.query<{ name: string }>(sql, [tables])).rows.map(({ name }) => name).sort()
  return {
    constraints: await names(
      `SELECT conname AS name FROM pg_constraint WHERE contype<>'n' AND conrelid = ANY(${relations})`,
    ),
    indexes: await names(
      `SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE i.indrelid = ANY(${relations})
        AND NOT EXISTS (SELECT FROM pg_constraint k WHERE k.conindid=i.indexrelid)`,
    ),
    triggers: await names(
      `SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = ANY(${relations})`,
    ),
    // NOT NULL columns outside the primary key, as the coverage helper lists them.
    notNull: await names(
      `SELECT c.relname || '.' || a.attname AS name FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      WHERE c.oid = ANY(${relations}) AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull
        AND NOT EXISTS (SELECT FROM pg_index x WHERE x.indrelid=c.oid AND x.indisprimary
          AND a.attnum=ANY(x.indkey))`,
    ),
  }
}

describe.skipIf(!serverUrl)('workflow definition storage', () => {
  let owned: TestDatabase

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'workflow_storage' })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('names every constraint, index, trigger, NOT NULL column and trigger rule in a protection', async () => {
    const { constraints, indexes, triggers, notNull } = await catalogObjects(owned.pool)
    const source = await readFile(join(migrationsDir, workflowMigration), 'utf8')
    // Every rule a guard raises names itself as the error's constraint.
    const rules = [...source.matchAll(/CONSTRAINT = '([a-z_]+)'/g)].map(([, rule]) => rule)
    expect(new Set(rules).size).toBe(rules.length)
    expect(rules).toHaveLength(9)
    expect(indexes).toEqual(['workflow_definitions_owner_user_id'])
    expect(triggers).toEqual([
      'workflow_definitions_guard',
      'workflow_definitions_updated_at',
      'workflow_revisions_guard',
    ])
    expect(constraints).toHaveLength(14)
    expect(notNull).toHaveLength(7)
    // FK targets that cannot be dropped while their foreign keys exist need no check of
    // their own; the coverage test allow-lists exactly these.
    const targets = ['workflow_definitions_organization_id_id', 'workflow_revisions_pkey']
    const objects = [
      ...constraints.filter((name) => !targets.includes(name)),
      ...indexes,
      ...triggers,
      ...notNull,
      ...rules,
    ].sort()
    const covered = [
      ...new Set(Object.values(workflowProtections).flatMap(({ objects }) => objects)),
    ].sort()
    expect(covered).toEqual(objects)
    for (const [name, { mutants }] of Object.entries(workflowProtections))
      expect(mutants.length, name).toBeGreaterThan(0)
  })

  it.each(Object.keys(workflowProtections))(
    'enforces %s',
    async (name) => {
      const protection = workflowProtections[name]
      if (!protection) throw new Error(`Missing protection ${name}`)
      await protection.check(await workflowFixture(owned.pool))
      expect(owned.pool.totalCount).toBeLessThanOrEqual(3)
    },
    30_000,
  )
})
