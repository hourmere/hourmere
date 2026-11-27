import { randomUUID } from 'node:crypto'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { migrationsDir, runMigrations } from './migrate.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import {
  MIGRATION_COVERAGE_TIMEOUT,
  MIGRATION_REPLAY_TIMEOUT,
  useMigrationReplay,
} from './testing/migration-replay.ts'
import type { TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL
const migration = '0184_scim_group_members.sql'
const table = 'scim_team_managed_memberships'
const indexes = {
  [`${table}_scim_user_idx`]: '(scim_user_id)',
  [`${table}_suspended_idx`]: '(child_organization_id, user_id) WHERE (suspended_at IS NOT NULL)',
}

async function assertRosterIndexes(pool: pg.Pool) {
  await expect(
    pool.query(
      `SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index
       WHERE indexrelid IN (SELECT to_regclass(name) FROM unnest($1::text[]) AS name)
         AND indisready AND indisvalid ORDER BY 1`,
      [Object.keys(indexes).map((name) => `public.${name}`)],
    ),
  ).resolves.toMatchObject({
    rows: Object.entries(indexes).map(([name, columns]) => ({
      definition: `CREATE INDEX ${name} ON public.${table} USING btree ${columns}`,
    })),
  })
}

async function seedRoster(pool: pg.Pool) {
  const [parent, child, connection, user, directoryUser] = Array.from({ length: 5 }, randomUUID)
  const [parentMember, childMember, mapping] = Array.from({ length: 3 }, randomUUID)
  await pool.query(
    `INSERT INTO auth.organization (id, name, slug, "createdAt")
     VALUES ($1::uuid,'Roster parent',$1::uuid::text,now()),
            ($2::uuid,'Roster child',$2::uuid::text,now())`,
    [parent, child],
  )
  await pool.query('INSERT INTO scim_connections (id, organization_id) VALUES ($1,$2)', [
    connection,
    parent,
  ])
  await pool.query(
    `INSERT INTO auth."user" (id, name, email, "emailVerified")
     VALUES ($1,'Fixture managed member','roster@example.test',true)`,
    [user],
  )
  await pool.query(
    `INSERT INTO auth.member (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1,$2,$5,'member',now()), ($3,$4,$5,'member',now())`,
    [parentMember, parent, childMember, child, user],
  )
  await pool.query(
    `INSERT INTO scim_users (id, organization_id, connection_id, user_name,
     linked_user_id, linked_member_id) VALUES ($1,$2,$3,'roster@example.test',$4,$5)`,
    [directoryUser, parent, connection, user, parentMember],
  )
  await pool.query(
    `INSERT INTO scim_team_mappings (id, parent_organization_id, child_organization_id,
     connection_id, external_id) VALUES ($1,$2,$3,$4,'roster')`,
    [mapping, parent, child, connection],
  )
  await pool.query(
    `INSERT INTO ${table} (member_id, mapping_id, child_organization_id, user_id, scim_user_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [childMember, mapping, child, user, directoryUser],
  )
}

async function rosterRows(pool: pg.Pool) {
  return (
    await pool.query(
      `SELECT to_jsonb(t) - 'suspended_at' AS row, xmin::text, ctid::text FROM ${table} t`,
    )
  ).rows
}

describe.skipIf(!serverUrl)('SCIM Group membership storage', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'has valid roster indexes and fails the assertion when either is dropped',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: assertRosterIndexes,
      })
      expect(report.problems).toEqual([])
      expect(report.results.map(({ key, status }) => [key, status])).toEqual(
        Object.keys(indexes).map((name) => [`index public.${table}.${name}`, 'covered']),
      )
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it(
    'keeps predecessor roster rows unsuspended, matches a fresh install and reruns as a no-op',
    async () => {
      const { directory, predecessor } = replay
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        upgraded = await predecessor.clone(undefined, { migrate: false, tag: 'members_up' })
        await seedRoster(upgraded.pool)
        const before = await rosterRows(upgraded.pool)
        expect(before).toHaveLength(1)
        await copyFile(join(migrationsDir, migration), join(directory, migration))
        await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([migration])
        expect(await rosterRows(upgraded.pool)).toEqual(before)
        await expect(
          upgraded.pool.query(`SELECT suspended_at FROM ${table}`),
        ).resolves.toMatchObject({ rows: [{ suspended_at: null }] })

        fresh = await predecessor.clone(directory, { tag: 'members_new' })
        expect(await snapshotSchema(upgraded.pool)).toEqual(await snapshotSchema(fresh.pool))
        await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([])
        await expect(runMigrations(fresh.pool, directory)).resolves.toEqual([])
        expect(await rosterRows(upgraded.pool)).toEqual(before)
      } finally {
        await Promise.all([upgraded?.drop(), fresh?.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )
})
