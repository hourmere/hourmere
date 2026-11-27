import { copyFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { assertOwnershipTransferAuditProtections } from './ownership-transfer-audit-protections.ts'
import { assertOwnershipTransferStorageProtections } from './ownership-transfer-storage-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import {
  MIGRATION_COVERAGE_TIMEOUT,
  MIGRATION_REPLAY_TIMEOUT,
  useMigrationReplay,
} from './testing/migration-replay.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0195_ownership_transfer.sql'

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
         'organization.branding_updated', 'organization', team::text, '{"primaryColor":"set"}'),
        (team, 'user', owners_and_members[1]::text, 'session',
         'organization.updated', 'organization', team::text,
         '{"oldSlug":"legacy-transfer-fixture","newSlug":"transfer-fixture-team","nameChanged":true}');
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

describe.skipIf(!serverUrl)('ownership transfer constraint coverage', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'fails a storage or audit protection assertion when any object is dropped',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: async (pool) => {
          await assertOwnershipTransferStorageProtections(pool)
          await assertOwnershipTransferAuditProtections(pool)
        },
      })
      expect(report.problems).toEqual([])
      expect(report.results.filter(({ status }) => status === 'covered')).toHaveLength(
        report.objects.length,
      )
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it(
    'keeps the populated predecessor intact and matches fresh and no-op migrations',
    async () => {
      const { directory, predecessor } = replay
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        upgraded = await predecessor.clone(undefined, { migrate: false })
        await seedTeam(upgraded.pool)
        const before = await snapshotExistingRows(upgraded.pool)
        expect(before).toHaveLength(11)

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
        const stagedMigrations = (await readdir(directory)).sort()
        expect(await runMigrations(fresh.pool, directory)).toEqual(stagedMigrations)
        expect(await snapshotSchema(upgraded.pool)).toEqual(await snapshotSchema(fresh.pool))
        expect(await runMigrations(upgraded.pool, directory)).toEqual([])
        expect(await runMigrations(fresh.pool, directory)).toEqual([])
        expect(await snapshotExistingRows(upgraded.pool)).toEqual(before)
      } finally {
        await Promise.all([fresh?.drop(), upgraded?.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )
})
