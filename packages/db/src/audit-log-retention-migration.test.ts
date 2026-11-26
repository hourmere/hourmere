import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { assertAuditLogRetentionProtections } from './audit-log-retention-protections.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { MIGRATION_REPLAY_TIMEOUT } from './testing/migration-replay.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { seedLater } from './upgrade-path-seed-later.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

vi.setConfig({ testTimeout: MIGRATION_REPLAY_TIMEOUT, hookTimeout: MIGRATION_REPLAY_TIMEOUT })

const serverUrl = process.env.DATABASE_URL
const migration = '0090_audit_log_retention.sql'
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

/** Every row of every table, with its physical version, except the table 0090 adds. */
async function records(pool: pg.Pool) {
  const tables = (
    await pool.query<{ schema: string; name: string }>(
      `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
       WHERE table_schema IN ('public','auth') AND table_type='BASE TABLE'
         AND table_name NOT IN ('schema_migrations','audit_log_settings') ORDER BY 1,2`,
    )
  ).rows
  const result: Record<string, unknown[]> = {}
  for (const table of tables)
    result[`${table.schema}.${table.name}`] = (
      await pool.query(
        `SELECT to_jsonb(t)::text, xmin::text, ctid::text FROM ${quote(table.schema)}.${quote(table.name)} t ORDER BY to_jsonb(t)::text COLLATE "C"`,
      )
    ).rows
  return result
}

/** Journal rows as the previous version stores them, in a team, instance-wide and orphaned. */
async function seedAuditEvents(pool: pg.Pool) {
  const organization = (
    await pool.query<{ id: string }>('SELECT id FROM auth.organization ORDER BY id LIMIT 1')
  ).rows[0]?.id
  for (const [organizationId, daysAgo] of [
    [organization, 400],
    [organization, 1],
    [null, 400],
    [randomUUID(), 400],
  ] as const)
    await pool.query(
      `INSERT INTO audit_events (organization_id, occurred_at, actor_type, actor_id, credential_type,
         action, target_type, target_id)
       VALUES ($1, now() - make_interval(days => $2), 'system', 'seed', 'none',
         'organization.updated', 'organization', $3)`,
      [organizationId, daysAgo, randomUUID()],
    )
}

describe.skipIf(!serverUrl)('audit log retention migration', () => {
  it('keeps populated data and the journal, chooses no retention, equals a fresh install and reruns as a no-op', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-audit-retention-'))
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
      await seedAuditEvents(upgraded.pool)
      const pool = upgraded.pool
      const before = await records(pool)
      for (const table of [
        'auth.user',
        'public.bookings',
        'auth.organization',
        'public.audit_events',
      ])
        expect(before[table]?.length, table).toBeGreaterThan(0)
      const ledger = (await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows

      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(pool, directory)).toEqual([migration])
      expect(await records(pool)).toEqual(before)
      // Every organization keeps following the instance default until an owner chooses.
      expect((await pool.query('SELECT * FROM audit_log_settings')).rows).toEqual([])
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
      await assertAuditLogRetentionProtections(pool)
      await assertAuditLogRetentionProtections(fresh.pool)
      expect((await pool.query('SELECT * FROM audit_log_settings')).rows).toEqual([])
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
