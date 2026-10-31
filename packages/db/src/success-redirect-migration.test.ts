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
const migration = '0048_booking_success_redirect.sql'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
async function records(pool: pg.Pool) {
  const inventory = (
    await pool.query<{ schema: string; name: string }>(`
    SELECT table_schema AS schema,table_name AS name FROM information_schema.tables
    WHERE table_schema IN ('auth','public') AND table_type='BASE TABLE'
    ORDER BY table_schema,table_name`)
  ).rows
  const result: Record<string, unknown[]> = {}
  for (const table of inventory)
    result[`${table.schema}.${table.name}`] = (
      await pool.query(`
      SELECT (to_jsonb(t)-'success_redirect')::text AS value,xmin::text,ctid::text
      FROM ${quote(table.schema)}.${quote(table.name)} t ORDER BY (to_jsonb(t)-'success_redirect')::text COLLATE "C"`)
    ).rows
  return result
}

describe.skipIf(!serverUrl)('booking success redirect migration', () => {
  it('preserves populated predecessor rows, defaults to no redirect, matches fresh schema and reruns without changes', async () => {
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-success-redirect-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort()
      const early = files.filter((file) => file.slice(0, 4) <= '0012')
      for (const file of early) await copyFile(join(migrationsDir, file), join(predecessor, file))
      upgraded = await createTestDatabase(serverUrl as string, predecessor)
      const pool = upgraded.pool
      await seedEarly(pool)
      for (const file of files.filter((file) => !early.includes(file)))
        await copyFile(join(migrationsDir, file), join(predecessor, file))
      await runMigrations(pool, predecessor)
      await seedLater(pool)
      const before = await records(pool)
      expect(before['public.event_types']?.length).toBeGreaterThan(0)
      expect(before['public.bookings']?.length).toBeGreaterThan(0)
      delete before['public.schema_migrations']
      await copyFile(join(migrationsDir, migration), join(predecessor, migration))
      expect(await runMigrations(pool, predecessor)).toEqual([migration])
      const after = await records(pool)
      delete after['public.schema_migrations']
      expect(after).toEqual(before)
      for (const table of ['event_types', 'bookings']) {
        expect(
          (
            await pool.query(
              `SELECT count(*)::int AS count FROM ${table} WHERE success_redirect IS NOT NULL`,
            )
          ).rows,
        ).toEqual([{ count: 0 }])
        await expect(
          pool.query(`UPDATE ${table} SET success_redirect='[]'::jsonb`),
        ).rejects.toMatchObject({ code: '23514' })
      }
      const schema = await snapshotSchema(pool)
      fresh = await createTestDatabase(serverUrl as string, predecessor)
      expect(await snapshotSchema(fresh.pool)).toEqual(schema)
      const acknowledged = await records(pool)
      expect(await runMigrations(pool, predecessor)).toEqual([])
      expect(await records(pool)).toEqual(acknowledged)
      expect(await snapshotSchema(pool)).toEqual(schema)
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
  }, 60_000)
})
