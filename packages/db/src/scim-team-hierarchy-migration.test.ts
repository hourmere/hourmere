import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { seedEarly } from './upgrade-path-seed-early.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0181_scim_team_hierarchy.sql'

async function relations(pool: pg.Pool) {
  return (
    await pool.query<{ relation: string }>(
      `SELECT format('%I.%I',table_schema,table_name) AS relation FROM information_schema.tables
       WHERE table_schema IN ('auth','public') AND table_type='BASE TABLE'
       AND table_name <> 'schema_migrations' ORDER BY table_schema, table_name`,
    )
  ).rows.map(({ relation }) => relation)
}

async function records(pool: pg.Pool, tables: string[]) {
  const snapshots: Record<string, unknown[]> = {}
  for (const table of tables) {
    snapshots[table] = (
      await pool.query(
        `SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS fingerprint,
         xmin::text, ctid::text FROM ${table} t ORDER BY fingerprint, xmin::text, ctid::text`,
      )
    ).rows
  }
  return snapshots
}

async function seedDirectory(pool: pg.Pool) {
  await pool.query(`
    INSERT INTO scim_provisioning_tokens
      (organization_id,name,token_hash,previous_token_hash,previous_valid_until,
       created_by_user_id,rotated_by_user_id,created_at,rotated_at,last_used_at)
    SELECT o.id, 'Synthetic rotation',repeat('a',43),repeat('b',43),
      '2030-01-02T03:04:05.123456Z',m."userId",m."userId",'2026-01-02T03:04:05.123456Z',
      '2026-03-02T03:04:05.654321Z','2026-04-02T03:04:05.123456Z'
    FROM auth.organization o JOIN auth.member m ON m."organizationId"=o.id
    WHERE o.slug='upgrade-team' AND m.role='owner' ORDER BY m.id LIMIT 1;

    INSERT INTO scim_provisioning_tokens (organization_id,name,created_at,revoked_at)
    SELECT id,'Synthetic revocation','2026-02-02T03:04:05.123456Z','2026-05-02T03:04:05.123456Z'
    FROM auth.organization WHERE slug='upgrade-team';

    INSERT INTO scim_users
      (organization_id,connection_id,external_id,user_name,linked_user_id,linked_member_id,created_at)
    SELECT c.organization_id,c.id,'Employee-17','synthetic-upgrade-scim',m."userId",m.id,
      '2026-04-02T03:04:05.654321Z'
    FROM scim_connections c JOIN auth.member m ON m."organizationId"=c.organization_id
    WHERE m.role='member' ORDER BY m.id LIMIT 1;

    INSERT INTO scim_membership_blocks (organization_id,user_id,source,kind,created_at,cleared_at)
    SELECT organization_id,linked_user_id,'local','suspension','2026-03-04T01:02:03.123456Z',
      '2026-05-04T01:02:03.654321Z' FROM scim_users;
  `)
}

describe.skipIf(!serverUrl)('SCIM hierarchy storage migration', () => {
  it('preserves populated predecessor tables, matches a fresh install and reruns without writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-scim-hierarchy-predecessor-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const predecessors = (await readdir(migrationsDir))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort()
      const early = predecessors.filter((file) => file.slice(0, 4) <= '0012')
      for (const file of early) await copyFile(join(migrationsDir, file), join(directory, file))
      upgraded = await createTestDatabase(serverUrl as string, directory)
      await seedEarly(upgraded.pool)
      for (const file of predecessors.filter((file) => !early.includes(file))) {
        await copyFile(join(migrationsDir, file), join(directory, file))
      }
      await runMigrations(upgraded.pool, directory)
      await seedDirectory(upgraded.pool)
      const beforeTables = await relations(upgraded.pool)
      const before = await records(upgraded.pool, beforeTables)
      expect(before['auth.member']?.length).toBeGreaterThan(0)
      expect(before['public.bookings']?.length).toBeGreaterThan(0)
      expect(before['public.scim_provisioning_tokens']).toHaveLength(2)
      expect(before['public.scim_token_connections']).toHaveLength(2)
      expect(before['public.scim_connections']).toHaveLength(1)
      expect(before['public.scim_users']).toHaveLength(1)
      expect(before['public.scim_membership_blocks']).toHaveLength(1)

      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
      expect(await records(upgraded.pool, beforeTables)).toEqual(before)
      const afterTables = await relations(upgraded.pool)
      const newTables = afterTables.filter((table) => !beforeTables.includes(table))
      expect(newTables).toEqual([
        'public.scim_team_link_generations',
        'public.scim_team_link_roles',
        'public.scim_team_managed_memberships',
        'public.scim_team_mapping_consents',
        'public.scim_team_mapping_intents',
        'public.scim_team_mappings',
      ])
      for (const rows of Object.values(await records(upgraded.pool, newTables))) {
        expect(rows).toEqual([])
      }

      fresh = await createTestDatabase(serverUrl as string, undefined, { migrate: false })
      expect(await runMigrations(fresh.pool, directory)).toEqual([...predecessors, migration])
      expect(await snapshotSchema(fresh.pool)).toEqual(await snapshotSchema(upgraded.pool))
      const after = await records(upgraded.pool, [...afterTables, 'public.schema_migrations'])
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await records(upgraded.pool, [...afterTables, 'public.schema_migrations'])).toEqual(
        after,
      )
    } finally {
      try {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      } finally {
        await rm(directory, { recursive: true })
      }
    }
  }, 30_000)
})
