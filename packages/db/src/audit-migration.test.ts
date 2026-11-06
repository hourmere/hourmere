import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('audit migration', () => {
  it('preserves populated predecessor records, equals a fresh install, and reruns as a no-op', async () => {
    const early = await mkdtemp(join(tmpdir(), 'hourmere-audit-early-'))
    const predecessor = await mkdtemp(join(tmpdir(), 'hourmere-audit-before-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql') && f < '0063')
      for (const file of files) {
        await copyFile(join(migrationsDir, file), join(predecessor, file))
        if (file < '0013') await copyFile(join(migrationsDir, file), join(early, file))
      }
      upgraded = await createTestDatabase(serverUrl as string, early)
      await seedEarly(upgraded.pool)
      await runMigrations(upgraded.pool, predecessor)
      await seedLater(upgraded.pool)
      const tables = (
        await upgraded.pool.query<{ schema: string; name: string }>(
          `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables WHERE table_schema IN ('public','auth') AND table_type='BASE TABLE' AND table_name <> 'schema_migrations' ORDER BY 1,2`,
        )
      ).rows
      const pool = upgraded.pool
      const records = async () => {
        const result: unknown[] = []
        for (const table of tables)
          result.push(
            (
              await pool.query(
                `SELECT to_jsonb(t)::text, xmin::text, ctid::text FROM "${table.schema}"."${table.name}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
              )
            ).rows,
          )
        return result
      }
      const before = await records()
      expect(
        (await upgraded.pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n,
      ).toBeGreaterThan(0)
      expect(await runMigrations(upgraded.pool)).toEqual(['0063_audit_events.sql'])
      expect(await records()).toEqual(before)
      fresh = await createTestDatabase(serverUrl as string)
      expect(await snapshotSchema(upgraded.pool)).toEqual(await snapshotSchema(fresh.pool))
      expect(await runMigrations(upgraded.pool)).toEqual([])
      expect(await runMigrations(fresh.pool)).toEqual([])
      expect(await records()).toEqual(before)
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(early, { recursive: true, force: true })
      await rm(predecessor, { recursive: true, force: true })
    }
  }, 60000)
})
