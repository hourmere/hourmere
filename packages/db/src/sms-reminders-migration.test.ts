import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
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
const migration = '0100_sms_reminders.sql'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
const ADDED = new Set(['sms_reminders_enabled', 'sms_consent', 'sms_phone'])

/**
 * Every row of every table with its physical version. The columns 0100 adds are left out,
 * so the comparison shows that nothing else changed, and their values are returned apart.
 */
async function records(pool: pg.Pool) {
  const tables = (
    await pool.query<{ schema: string; name: string; columns: string[] }>(
      `SELECT c.table_schema AS schema, c.table_name AS name,
          array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema IN ('public','auth') AND t.table_type = 'BASE TABLE'
         AND c.table_name NOT IN ('schema_migrations', 'sms_suppressions', 'sms_inbound_receipts')
       GROUP BY 1, 2 ORDER BY 1, 2`,
    )
  ).rows
  const result: Record<string, unknown[]> = {}
  for (const table of tables) {
    const columns = table.columns.filter((column) => !ADDED.has(column)).map(quote)
    result[`${table.schema}.${table.name}`] = (
      await pool.query(
        `SELECT to_jsonb(r)::text AS row FROM (SELECT ${columns.join(',')},
            xmin::text AS _xmin, ctid::text AS _ctid
          FROM ${quote(table.schema)}.${quote(table.name)}) r
          ORDER BY to_jsonb(r)::text COLLATE "C"`,
      )
    ).rows
  }
  return result
}

async function addedValues(pool: pg.Pool) {
  const values = async (table: string) =>
    (await pool.query(`SELECT DISTINCT sms_reminders_enabled FROM ${table}`)).rows
  return { eventTypes: await values('event_types'), bookings: await values('bookings') }
}

describe.skipIf(!serverUrl)('SMS reminder migration', () => {
  it('keeps populated data with SMS off, equals a fresh install and reruns as a no-op', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-sms-reminders-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort()
      for (const file of files.filter((file) => file < '0013'))
        await copyFile(join(migrationsDir, file), join(directory, file))
      upgraded = await createTestDatabase(serverUrl as string, directory)
      await seedEarly(upgraded.pool)
      for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
      await runMigrations(upgraded.pool, directory)
      await seedLater(upgraded.pool)
      const pool = upgraded.pool
      const before = await records(pool)
      for (const table of ['auth.user', 'public.event_types', 'public.bookings'])
        expect(before[table]?.length, table).toBeGreaterThan(0)
      const ledger = (await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows

      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(pool, directory)).toEqual([migration])
      // No row is rewritten; every existing event type and booking has SMS off.
      expect(await records(pool)).toEqual(before)
      expect(await addedValues(pool)).toEqual({
        eventTypes: [{ sms_reminders_enabled: false }],
        bookings: [{ sms_reminders_enabled: false }],
      })
      expect(
        (
          await pool.query('SELECT * FROM schema_migrations WHERE name <> $1 ORDER BY name', [
            migration,
          ])
        ).rows,
      ).toEqual(ledger)

      fresh = await createTestDatabase(serverUrl as string, directory)
      const schema = await snapshotSchema(pool)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      expect(await runMigrations(pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await records(pool)).toEqual(before)
      expect(await snapshotSchema(pool)).toEqual(schema)
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)
})
