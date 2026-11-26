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

const migration = '0183_scim_groups.sql'
const serverUrl = process.env.DATABASE_URL

async function seedMappings(pool: pg.Pool) {
  const teams = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  const [parent, child, suspendedChild, retiredChild] = teams
  const [mapping, suspended, retired] = [randomUUID(), randomUUID(), randomUUID()]
  const connection = randomUUID()
  const [owner, member] = [randomUUID(), randomUUID()]
  await expect(
    pool.query(
      `INSERT INTO auth.organization (id, name, slug, "createdAt")
       SELECT id, 'SCIM team', id::text, now() FROM unnest($1::uuid[]) AS teams(id)`,
      [teams],
    ),
  ).resolves.toMatchObject({ rowCount: 4 })
  await expect(
    pool.query('INSERT INTO scim_connections (id, organization_id) VALUES ($1, $2)', [
      connection,
      parent,
    ]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query(
      `INSERT INTO scim_team_mappings (id, parent_organization_id, child_organization_id,
       connection_id, external_id) VALUES ($1,$2,$3,$4,'live'), ($5,$2,$6,$4,'paused'),
       ($7,$2,$8,$4,'reusable')`,
      [mapping, parent, child, connection, suspended, suspendedChild, retired, retiredChild],
    ),
  ).resolves.toMatchObject({ rowCount: 3 })
  await expect(
    pool.query('UPDATE scim_team_mappings SET suspended_at=clock_timestamp() WHERE id=$1', [
      suspended,
    ]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query('UPDATE scim_team_mappings SET retired_at=clock_timestamp() WHERE id=$1', [retired]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query(
      `INSERT INTO auth."user" (id, name, email, "emailVerified")
       VALUES ($1,'Fixture owner','owner@example.test',true)`,
      [owner],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query(
      `INSERT INTO auth.member (id, "organizationId", "userId", role, "createdAt")
       VALUES ($1,$2,$3,'owner',now()), (uuidv7(),$4,$3,'owner',now())`,
      [member, child, owner, parent],
    ),
  ).resolves.toMatchObject({ rowCount: 2 })
  return { parent, child, mapping, suspended, retired, connection }
}

async function seedRoster(pool: pg.Pool, f: Awaited<ReturnType<typeof seedMappings>>) {
  const user = randomUUID()
  const [childMember, parentMember, directoryUser] = [randomUUID(), randomUUID(), randomUUID()]
  await expect(
    pool.query(
      `INSERT INTO auth."user" (id, name, email, "emailVerified")
       VALUES ($1,'Fixture managed member','managed@example.test',true)`,
      [user],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query(
      `INSERT INTO auth.member (id, "organizationId", "userId", role, "createdAt")
       VALUES ($1,$2,$3,'member',now()), ($4,$5,$3,'member',now())`,
      [childMember, f.child, user, parentMember, f.parent],
    ),
  ).resolves.toMatchObject({ rowCount: 2 })
  await expect(
    pool.query(
      `INSERT INTO scim_users (id, organization_id, connection_id, user_name,
       linked_user_id, linked_member_id) VALUES ($1,$2,$3,'managed@example.test',$4,$5)`,
      [directoryUser, f.parent, f.connection, user, parentMember],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query(
      `INSERT INTO scim_team_managed_memberships (member_id, mapping_id,
       child_organization_id, user_id) VALUES ($1,$2,$3,$4)`,
      [childMember, f.mapping, f.child, user],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  return { childMember, directoryUser }
}

async function assertGroupProtections(pool: pg.Pool) {
  const f = await seedMappings(pool)
  const roster = await seedRoster(pool, f)
  const setRosterSource = (id: string) =>
    pool.query('UPDATE scim_team_managed_memberships SET scim_user_id=$1 WHERE member_id=$2', [
      id,
      roster.childMember,
    ])
  await expect(setRosterSource(randomUUID())).rejects.toMatchObject({
    code: '23503',
    constraint: 'scim_team_managed_memberships_scim_user_fkey',
  })
  await expect(setRosterSource(roster.directoryUser)).resolves.toMatchObject({ rowCount: 1 })
  const create = (mappingId: string | null) =>
    pool.query<{ id: string }>(
      'INSERT INTO scim_groups (mapping_id) VALUES ($1) RETURNING id, created_at, updated_at',
      [mappingId],
    )
  await expect(create(null)).rejects.toMatchObject({ code: '23502', column: 'mapping_id' })
  await expect(create(randomUUID())).rejects.toMatchObject({
    code: '23503',
    constraint: 'scim_groups_mapping_id_fkey',
  })
  for (const inactive of [f.suspended, f.retired]) {
    await expect(create(inactive)).rejects.toMatchObject({
      code: '23514',
      constraint: 'scim_groups_mapping_authority',
    })
  }
  for (const column of ['created_at', 'updated_at']) {
    await expect(
      pool.query(`INSERT INTO scim_groups (mapping_id, ${column}) VALUES ($1, NULL)`, [f.mapping]),
    ).rejects.toMatchObject({ code: '23502', column })
  }
  const created = create(f.mapping)
  await expect(created).resolves.toMatchObject({
    rows: [{ id: expect.any(String), created_at: expect.any(Date), updated_at: expect.any(Date) }],
  })
  const [{ id }] = (await created).rows as [{ id: string }]
  expect(id).not.toBe(f.mapping)
  await expect(create(f.mapping)).rejects.toMatchObject({
    code: '23505',
    constraint: 'scim_groups_mapping_id_key',
  })
  await expect(
    pool.query("UPDATE scim_groups SET updated_at=created_at-interval '1 second' WHERE id=$1", [
      id,
    ]),
  ).rejects.toMatchObject({ code: '23514', constraint: 'scim_groups_timestamp_order' })
  await expect(
    pool.query("UPDATE scim_groups SET created_at=created_at-interval '1 second' WHERE id=$1", [
      id,
    ]),
  ).rejects.toMatchObject({ code: '23514', constraint: 'scim_groups_identity' })
  await expect(
    pool.query("UPDATE scim_groups SET updated_at=created_at+interval '1 second' WHERE id=$1", [
      id,
    ]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query('DELETE FROM auth.member WHERE id=$1', [roster.childMember]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query('UPDATE scim_team_mappings SET retired_at=clock_timestamp() WHERE id=$1', [
      f.mapping,
    ]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(pool.query('DELETE FROM scim_groups WHERE id=$1', [id])).rejects.toMatchObject({
    code: '23514',
    constraint: 'scim_groups_identity',
  })
  const relinked = randomUUID()
  await expect(
    pool.query(
      `INSERT INTO scim_team_mappings (id, parent_organization_id, child_organization_id,
       connection_id, external_id) VALUES ($1,$2,$3,$4,'live')`,
      [relinked, f.parent, f.child, f.connection],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query('INSERT INTO scim_groups (id, mapping_id) VALUES ($1,$2)', [id, relinked]),
  ).rejects.toMatchObject({ code: '23505', constraint: 'scim_groups_pkey' })
  await expect(create(relinked)).resolves.toMatchObject({ rowCount: 1 })
}

async function snapshots(pool: pg.Pool) {
  const tables = [
    'auth.organization',
    'auth.member',
    'public.scim_connections',
    'public.scim_team_mappings',
    'public.scim_team_link_roles',
    'public.scim_team_link_generations',
    'public.scim_team_managed_memberships',
    'public.scim_users',
  ]
  return Promise.all(
    tables.map(
      async (table) =>
        (
          await pool.query(
            `SELECT to_jsonb(t) - 'scim_user_id' AS row, xmin::text, ctid::text FROM ${table} t ORDER BY row`,
          )
        ).rows,
    ),
  )
}

describe.skipIf(!serverUrl)('SCIM Group activation storage', () => {
  const replay = useMigrationReplay(serverUrl as string, migration)

  it(
    'fails a protection assertion when any migration object is dropped',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: serverUrl as string,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: assertGroupProtections,
      })
      expect(report.problems).toEqual([])
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it(
    'preserves existing mapped teams, matches a fresh install and reruns as a no-op',
    async () => {
      const { directory, predecessor } = replay
      let upgraded: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        upgraded = await predecessor.clone(undefined, { migrate: false, tag: 'group_upgrade' })
        const mappings = await seedMappings(upgraded.pool)
        const roster = await seedRoster(upgraded.pool, mappings)
        const before = await snapshots(upgraded.pool)
        await copyFile(join(migrationsDir, migration), join(directory, migration))
        await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([migration])
        expect(await snapshots(upgraded.pool)).toEqual(before)
        await expect(upgraded.pool.query('SELECT id FROM scim_groups')).resolves.toMatchObject({
          rows: [],
        })
        await expect(
          upgraded.pool.query('SELECT member_id, scim_user_id FROM scim_team_managed_memberships'),
        ).resolves.toMatchObject({ rows: [{ member_id: roster.childMember, scim_user_id: null }] })

        fresh = await predecessor.clone(directory, { tag: 'group_fresh' })
        expect(await snapshotSchema(upgraded.pool)).toEqual(await snapshotSchema(fresh.pool))
        await expect(runMigrations(upgraded.pool, directory)).resolves.toEqual([])
        await expect(runMigrations(fresh.pool, directory)).resolves.toEqual([])
        expect(await snapshots(upgraded.pool)).toEqual(before)
      } finally {
        await Promise.all([upgraded?.drop(), fresh?.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )
})
