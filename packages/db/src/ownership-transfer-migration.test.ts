import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { detailsCheckBranches, latestDetailsCheckMigration } from './audit-details-check-source.ts'
import { migrationsDir, runMigrations } from './migrate.ts'
import { assertOwnershipTransferAuditProtections } from './ownership-transfer-audit-protections.ts'
import { assertOwnershipTransferStorageProtections } from './ownership-transfer-storage-protections.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const migration = '0195_ownership_transfer.sql'
const serverUrl = process.env.DATABASE_URL

it('preserves every predecessor audit detail rule when adding the offer rule', () => {
  const predecessor = detailsCheckBranches(latestDetailsCheckMigration(migration))
  const current = detailsCheckBranches(migration)
  const offered = "    WHEN action = 'organization.ownership_transfer_offered' THEN"
  expect(current.head).toBe(predecessor.head)
  expect(current.tail).toBe(predecessor.tail)
  expect(current.branches.filter(({ when }) => when.startsWith(offered))).toHaveLength(1)
  expect(current.branches.filter(({ when }) => !when.startsWith(offered))).toEqual(
    predecessor.branches,
  )
})

async function seedTeam(pool: pg.Pool) {
  await pool.query(`
    DO $$
    DECLARE
      owners_and_members uuid[] := ARRAY[gen_random_uuid(), gen_random_uuid(),
        gen_random_uuid(), gen_random_uuid()];
      team uuid := gen_random_uuid();
      personal uuid := gen_random_uuid();
      target uuid := gen_random_uuid();
      stamp timestamptz := '2026-01-02T03:04:05.123456Z';
    BEGIN
      INSERT INTO auth."user" (id, name, email, "emailVerified")
        SELECT id, 'Transfer fixture ' || position, 'transfer-' || position || '@example.test', true
        FROM unnest(owners_and_members) WITH ORDINALITY AS person(id, position);
      INSERT INTO auth.organization (id, name, slug, "createdAt", metadata) VALUES
        (team, 'Transfer fixture team', 'transfer-fixture-team', stamp, '{"department":"engineering"}'),
        (personal, 'Transfer fixture personal', 'transfer-fixture-personal', stamp, '{"kind":"personal"}');
      INSERT INTO personal_organizations VALUES (owners_and_members[1], personal);
      INSERT INTO auth.member (id, "organizationId", "userId", role, "createdAt") VALUES
        (gen_random_uuid(), team, owners_and_members[1], 'owner', stamp),
        (gen_random_uuid(), team, owners_and_members[2], 'owner,admin', stamp),
        (target, team, owners_and_members[3], 'admin', stamp),
        (gen_random_uuid(), team, owners_and_members[4], 'member', stamp),
        (gen_random_uuid(), personal, owners_and_members[1], 'owner', stamp);
      INSERT INTO audit_events (organization_id, actor_type, actor_id, credential_type,
        action, target_type, target_id, details) VALUES
        (team, 'user', owners_and_members[1]::text, 'session',
         'membership.role_changed', 'membership', target::text, '{"oldRole":"member","newRole":"admin"}'),
        (team, 'user', owners_and_members[1]::text, 'session',
         'organization.branding_updated', 'organization', team::text, '{"primaryColor":"set"}');
    END $$;
  `)
}

async function snapshotExistingRows(pool: pg.Pool) {
  // Compare full rows and tuple versions to catch even a rewrite that keeps the same role.
  return (
    await pool.query(`
      SELECT 'organization' AS kind, to_jsonb(o) AS row, xmin::text, ctid::text
        FROM auth.organization o
      UNION ALL
      SELECT 'member', to_jsonb(m), xmin::text, ctid::text FROM auth.member m
      UNION ALL
      SELECT 'personal', to_jsonb(p), xmin::text, ctid::text FROM personal_organizations p
      UNION ALL
      SELECT 'audit', to_jsonb(a), xmin::text, ctid::text FROM audit_events a
      ORDER BY kind, row
    `)
  ).rows
}

describe.skipIf(!serverUrl)('ownership transfer storage migration', () => {
  it('keeps the populated predecessor intact and matches fresh and no-op migrations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-ownership-upgrade-'))
    let upgraded: TestDatabase | undefined
    let fresh: TestDatabase | undefined
    try {
      const predecessors = (await readdir(migrationsDir)).filter(
        (file) => file.endsWith('.sql') && file < migration,
      )
      for (const file of predecessors)
        await copyFile(join(migrationsDir, file), join(directory, file))
      upgraded = await createTestDatabase(serverUrl as string, directory)
      await seedTeam(upgraded.pool)
      const before = await snapshotExistingRows(upgraded.pool)
      expect(before).toHaveLength(10)

      await copyFile(join(migrationsDir, migration), join(directory, migration))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
      expect(await snapshotExistingRows(upgraded.pool)).toEqual(before)
      for (const table of [
        'organization_ownership_transfers',
        'organization_ownership_transfer_budgets',
      ]) {
        expect((await upgraded.pool.query(`SELECT * FROM ${table}`)).rows).toEqual([])
      }

      fresh = await createTestDatabase(serverUrl as string, undefined, { migrate: false })
      expect(await runMigrations(fresh.pool, directory)).toEqual([
        ...predecessors.sort(),
        migration,
      ])
      expect(await snapshotSchema(upgraded.pool)).toEqual(await snapshotSchema(fresh.pool))
      expect(await runMigrations(upgraded.pool, directory)).toEqual([])
      expect(await runMigrations(fresh.pool, directory)).toEqual([])
      expect(await snapshotExistingRows(upgraded.pool)).toEqual(before)
    } finally {
      await Promise.all([fresh?.drop(), upgraded?.drop(), rm(directory, { recursive: true })])
    }
  })

  it('applies storage and audit protections on the installed schema', async () => {
    const db = await createTestDatabase(serverUrl as string)
    try {
      await assertOwnershipTransferStorageProtections(db.pool)
      await assertOwnershipTransferAuditProtections(db.pool)
    } finally {
      await db.drop()
    }
  })
})
