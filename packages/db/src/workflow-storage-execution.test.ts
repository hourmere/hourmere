import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationsDir } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import {
  executionExtendedTables,
  executionFixture,
  executionMigration,
  executionProtections,
  executionTables,
} from './workflow-storage-execution-protections.ts'

const serverUrl = process.env.DATABASE_URL

/**
 * Constraints, standalone indexes, triggers and NOT NULL columns of the new tables, plus the
 * objects the migration names on the existing tables it extends.
 */
async function catalogObjects(pool: pg.Pool, named: Set<string>) {
  const relations = `SELECT oid FROM pg_class WHERE relname = ANY($1) AND relnamespace='public'::regnamespace`
  const names = async (sql: string) => {
    const created = (await pool.query<{ name: string }>(sql, [[...executionTables]])).rows
    const extended = (await pool.query<{ name: string }>(sql, [[...executionExtendedTables]])).rows
    return [
      ...created.map(({ name }) => name),
      ...extended.map(({ name }) => name).filter((name) => named.has(name)),
    ].sort()
  }
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

describe.skipIf(!serverUrl)('workflow execution storage', () => {
  let owned: TestDatabase

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'workflow_exec' })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('names every constraint, index, trigger, NOT NULL column and trigger rule in a protection', async () => {
    const source = await readFile(join(migrationsDir, executionMigration), 'utf8')
    const named = new Set(
      [...source.matchAll(/(?:CONSTRAINT|INDEX|TRIGGER) (?:= ')?([a-z_]+)/g)].map(
        ([, name]) => name as string,
      ),
    )
    const { constraints, indexes, triggers, notNull } = await catalogObjects(owned.pool, named)
    // Every rule a guard raises names itself as the error's constraint.
    const rules = [...source.matchAll(/CONSTRAINT = '([a-z_]+)'/g)].map(([, rule]) => rule)
    expect(new Set(rules).size).toBe(rules.length)
    expect(rules).toHaveLength(19)
    expect(indexes).toEqual([
      'notification_email_sends_workflow_reservation',
      'workflow_enrollments_workflow',
      'workflow_mail_reservations_owner',
      'workflow_mail_reservations_retention',
      'workflow_run_history_page',
      'workflow_run_history_retention',
      'workflow_runs_due',
    ])
    expect(triggers).toEqual([
      'workflow_definitions_purge',
      'workflow_enrollments_guard',
      'workflow_mail_reservations_guard',
      'workflow_recipient_claims_guard',
      'workflow_recipient_claims_updated_at',
      'workflow_run_history_guard',
      'workflow_runs_guard',
      'workflow_runs_updated_at',
    ])
    expect(constraints).toHaveLength(26)
    expect(notNull).toHaveLength(39)
    // FK targets that cannot be dropped while their foreign keys exist need no check of
    // their own; the coverage test allow-lists exactly these.
    const targets = ['workflow_enrollments_booking_key', 'workflow_runs_booking_key']
    const objects = [
      ...constraints.filter((name) => !targets.includes(name)),
      ...indexes,
      ...triggers,
      ...notNull,
      ...rules,
    ].sort()
    const covered = [
      ...new Set(Object.values(executionProtections).flatMap(({ objects }) => objects)),
    ].sort()
    expect(covered).toEqual(objects)
    for (const [name, { mutants }] of Object.entries(executionProtections))
      expect(mutants.length, name).toBeGreaterThan(0)
  })

  it.each(Object.keys(executionProtections))(
    'enforces %s',
    async (name) => {
      const protection = executionProtections[name]
      if (!protection) throw new Error(`Missing protection ${name}`)
      await protection.check(await executionFixture(owned.pool))
      expect(owned.pool.totalCount).toBeLessThanOrEqual(4)
    },
    60_000,
  )
})
