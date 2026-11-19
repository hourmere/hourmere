import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import {
  insert,
  lapsedDomainValues,
  oidcProviderValues,
  ssoFixture,
} from './sso-storage-fixtures.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const migration = '0117_sso_domain_retirement.sql'
async function snapshot(pool: pg.Pool) {
  const result: Record<string, unknown[]> = {}
  for (const table of [
    'auth."user"',
    'auth.organization',
    'auth.member',
    'sso_domains',
    'sso_providers',
    'sso_policies',
  ])
    result[table] = (
      await pool.query(
        `SELECT to_jsonb(t)::text AS value, xmin::text, ctid::text FROM ${table} t ORDER BY to_jsonb(t)::text`,
      )
    ).rows
  return result
}

describe.skipIf(!process.env.DATABASE_URL)('domain retirement upgrade', () => {
  it('preserves a populated predecessor, matches fresh install and reruns without changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hourmere-domain-retirement-upgrade-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      for (const file of (await readdir(migrationsDir)).filter(
        (f) => f.endsWith('.sql') && f < migration,
      ))
        await copyFile(join(migrationsDir, file), join(dir, file))
      upgraded = await createTestDatabase(process.env.DATABASE_URL as string, dir)
      const client = await upgraded.pool.connect()
      try {
        const f = await ssoFixture(client)
        await insert(client, 'sso_domains', lapsedDomainValues(f.team))
        await insert(client, 'sso_providers', oidcProviderValues(f.team))
        await insert(client, 'sso_policies', {
          organization_id: f.team,
          require_sso: true,
          admission: 'invitation_only',
        })
      } finally {
        client.release()
      }
      const before = await snapshot(upgraded.pool)
      expect(Object.values(before).every((rows) => rows.length > 0)).toBe(true)
      await copyFile(join(migrationsDir, migration), join(dir, migration))
      expect(await runMigrations(upgraded.pool, dir)).toEqual([migration])
      expect(await snapshot(upgraded.pool)).toEqual(before)
      fresh = await createTestDatabase(process.env.DATABASE_URL as string, dir)
      const schema = await snapshotSchema(upgraded.pool)
      expect(schema).toEqual(await snapshotSchema(fresh.pool))
      expect((await upgraded.pool.query('SELECT * FROM sso_domain_retirements')).rows).toEqual([])
      expect(
        (await upgraded.pool.query('SELECT * FROM sso_domain_retirement_notifications')).rows,
      ).toEqual([])
      const ledger = (await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name'))
        .rows
      expect(await runMigrations(upgraded.pool, dir)).toEqual([])
      expect(await snapshot(upgraded.pool)).toEqual(before)
      expect(await snapshotSchema(upgraded.pool)).toEqual(schema)
      expect(
        (await upgraded.pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows,
      ).toEqual(ledger)
    } finally {
      await fresh?.drop()
      await upgraded?.drop()
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
