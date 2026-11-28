import { randomUUID } from 'node:crypto'
import { copyFile, readdir } from 'node:fs/promises'
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
import { createTestDatabase, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const url = process.env.DATABASE_URL as string
const migration = '0200_custom_role_membership_lifecycle.sql'

async function organization(pool: pg.Pool, personal = false) {
  const team = randomUUID()
  const people = [randomUUID(), randomUUID()]
  const memberships = [randomUUID(), randomUUID()]
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO auth.organization (id, name, slug, "createdAt")
       VALUES ($1, 'Membership lifecycle', $1::uuid::text, now())`,
      [team],
    )
    for (const [index, role] of ['owner', '\tmember\u00a0'].entries()) {
      await client.query(
        `INSERT INTO auth."user" (id, email, name, "emailVerified")
         VALUES ($1, $1::uuid || '@example.test', 'Lifecycle fixture', true)`,
        [people[index]],
      )
      await client.query(
        `INSERT INTO auth.member (id, "organizationId", "userId", role, "createdAt")
         VALUES ($1, $2, $3, $4, now())`,
        [memberships[index], team, people[index], role],
      )
    }
    if (personal) {
      await client.query(
        'INSERT INTO personal_organizations (organization_id, user_id) VALUES ($1, $2)',
        [team, people[0]],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return {
    team,
    owner: people[0] as string,
    ownerMember: memberships[0] as string,
    user: people[1] as string,
    member: memberships[1] as string,
  }
}

type Fixture = Awaited<ReturnType<typeof organization>>

function policy(pool: pg.Pool, team: string) {
  return pool.query(
    'SELECT enabled, policy_epoch FROM team_custom_role_policies WHERE organization_id = $1',
    [team],
  )
}

function authorization(pool: pg.Pool | pg.PoolClient, member: string) {
  return pool.query(
    'SELECT fixed_role, legacy_role_tokens, generation FROM team_member_authorizations WHERE member_id = $1',
    [member],
  )
}

async function assign(pool: pg.Pool, fixture: Fixture) {
  const role = randomUUID()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      'INSERT INTO custom_roles (organization_id, id, active_revision) VALUES ($1, $2, 1)',
      [fixture.team, role],
    )
    await client.query(
      `INSERT INTO custom_role_revisions (organization_id, role_id, revision, name, permission_ids)
       VALUES ($1, $2, 1, 'Coordinator', ARRAY['team_bookings.read', 'event_types.create'])`,
      [fixture.team, role],
    )
    await client.query(
      `INSERT INTO custom_role_assignments (organization_id, member_id, user_id, role_id, assigned_by_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [fixture.team, fixture.member, fixture.user, role, fixture.owner],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return role
}

const base = { fixed_role: 'member', legacy_role_tokens: ['member'], generation: 1 }
const elevated = (role: string) => ({ fixed_role: role, legacy_role_tokens: [role], generation: 3 })

function assignments(pool: pg.Pool | pg.PoolClient, member: string) {
  return pool.query('SELECT role_id FROM custom_role_assignments WHERE member_id = $1', [member])
}

function updateRole(pool: pg.Pool | pg.PoolClient, member: string, role: string) {
  return pool.query('UPDATE auth.member SET role = $2 WHERE id = $1', [member, role])
}

function clearance(pool: pg.Pool | pg.PoolClient, member: string) {
  return pool.query(
    `SELECT actor_type, actor_id, credential_type, details
     FROM audit_events WHERE action = 'membership.custom_role_cleared' AND target_id = $1`,
    [member],
  )
}

function clearanceRow(role: string) {
  return {
    actor_type: 'system',
    actor_id: 'system',
    credential_type: 'none',
    details: {
      roleId: role,
      oldRevision: 1,
      policyEpoch: 0,
      masterEpoch: 0,
      outcome: 'succeeded',
      personalDataPermissionIds: ['team_bookings.read'],
    },
  }
}

async function verifyPromotion(pool: pg.Pool) {
  const target = await organization(pool)
  await expect(authorization(pool, target.member)).resolves.toMatchObject({ rows: [base] })
  const customRole = await assign(pool, target)
  await expect(updateRole(pool, target.member, 'admin')).resolves.toMatchObject({ rowCount: 1 })
  await expect(authorization(pool, target.member)).resolves.toMatchObject({
    rows: [elevated('admin')],
  })
  await expect(assignments(pool, target.member)).resolves.toMatchObject({ rows: [] })
  await expect(clearance(pool, target.member)).resolves.toMatchObject({
    rows: [clearanceRow(customRole)],
  })
  await expect(updateRole(pool, target.member, 'member,  unknown')).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(authorization(pool, target.member)).resolves.toMatchObject({
    rows: [{ fixed_role: null, legacy_role_tokens: ['member', 'unknown'], generation: 3 }],
  })
}

function memberRows(pool: pg.Pool) {
  return pool.query(
    'SELECT to_jsonb(m)::text AS row, xmin::text, ctid::text FROM auth.member m ORDER BY id',
  )
}

describe.skipIf(!url)('custom role membership lifecycle', () => {
  const replay = useMigrationReplay(url, migration)

  it(
    'keeps each policy and membership lifecycle protection covered',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl: url,
        migration,
        predecessorTemplate: replay.predecessor,
        assertions: async (pool) => {
          const team = await organization(pool)
          await expect(policy(pool, team.team)).resolves.toMatchObject({
            rows: [{ enabled: false, policy_epoch: 0 }],
          })
          const personal = await organization(pool, true)
          await expect(policy(pool, personal.team)).resolves.toMatchObject({ rows: [] })
          await verifyPromotion(pool)
        },
      })
      expect(report.problems).toEqual([])
      expect(report.results).toHaveLength(2)
      expect(report.results.every(({ status }) => status === 'covered')).toBe(true)
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )

  it(
    'repairs missing and stale predecessor snapshots, preserves fixed rows and matches a fresh install',
    async () => {
      const { directory, predecessor } = replay
      const upgraded = await predecessor.clone(undefined, { migrate: false })
      let fresh: TestDatabase | undefined
      try {
        const team = await organization(upgraded.pool)
        const personal = await organization(upgraded.pool, true)
        await expect(policy(upgraded.pool, team.team)).resolves.toMatchObject({ rows: [] })
        await expect(authorization(upgraded.pool, team.member)).resolves.toMatchObject({ rows: [] })
        await upgraded.pool.query(
          `INSERT INTO team_member_authorizations
           (organization_id, member_id, user_id, legacy_role_tokens, fixed_role)
           VALUES ($1, $2, $3, ARRAY['member'], 'member')`,
          [team.team, team.member, team.user],
        )
        const customRole = await assign(upgraded.pool, team)
        await updateRole(upgraded.pool, team.member, 'admin')
        const before = (await memberRows(upgraded.pool)).rows
        await expect(assignments(upgraded.pool, team.member)).resolves.toMatchObject({
          rows: [{ role_id: customRole }],
        })

        await copyFile(join(migrationsDir, migration), join(directory, migration))
        expect(await runMigrations(upgraded.pool, directory)).toEqual([migration])
        await expect(memberRows(upgraded.pool)).resolves.toMatchObject({ rows: before })
        await expect(policy(upgraded.pool, team.team)).resolves.toMatchObject({
          rows: [{ enabled: false, policy_epoch: 0 }],
        })
        await expect(policy(upgraded.pool, personal.team)).resolves.toMatchObject({ rows: [] })
        await expect(authorization(upgraded.pool, personal.member)).resolves.toMatchObject({
          rows: [base],
        })
        await expect(authorization(upgraded.pool, team.member)).resolves.toMatchObject({
          rows: [elevated('admin')],
        })
        await expect(assignments(upgraded.pool, team.member)).resolves.toMatchObject({ rows: [] })
        await expect(clearance(upgraded.pool, team.member)).resolves.toMatchObject({
          rows: [clearanceRow(customRole)],
        })

        fresh = await createTestDatabase(url, undefined, { migrate: false })
        const staged = (await readdir(directory)).sort()
        expect(await runMigrations(fresh.pool, directory)).toEqual(staged)
        expect(await snapshotSchema(upgraded.pool)).toEqual(await snapshotSchema(fresh.pool))
        expect(await runMigrations(upgraded.pool, directory)).toEqual([])
        expect(await runMigrations(fresh.pool, directory)).toEqual([])
        await expect(clearance(upgraded.pool, team.member)).resolves.toMatchObject({
          rows: [clearanceRow(customRole)],
        })
      } finally {
        await Promise.all([fresh?.drop(), upgraded.drop()])
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )

  it('clears the assignment inside transfer confirmation and rolls it back with the transfer', async () => {
    const db = await createTestDatabase(url)
    try {
      const { pool } = db
      const target = await organization(pool)
      const customRole = await assign(pool, target)
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO organization_ownership_transfers (
           organization_id, initiator_user_id, initiator_membership_id,
           target_user_id, target_membership_id, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, now(), now() + interval '24 hours') RETURNING id`,
        [target.team, target.owner, target.ownerMember, target.user, target.member],
      )
      const offer = rows[0]?.id
      const client = await pool.connect()
      try {
        for (const boundary of ['ROLLBACK', 'COMMIT']) {
          await client.query('BEGIN')
          await client.query('SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE', [
            target.team,
          ])
          await client.query(
            `UPDATE organization_ownership_transfers
             SET state = 'confirmed', terminal_at = clock_timestamp() WHERE id = $1`,
            [offer],
          )
          await updateRole(client, target.member, 'owner')
          await updateRole(client, target.ownerMember, 'admin')
          await expect(authorization(client, target.member)).resolves.toMatchObject({
            rows: [elevated('owner')],
          })
          await expect(assignments(client, target.member)).resolves.toMatchObject({ rows: [] })
          await expect(clearance(client, target.member)).resolves.toMatchObject({
            rows: [clearanceRow(customRole)],
          })
          await expect(authorization(pool, target.member)).resolves.toMatchObject({
            rows: [{ ...base, generation: 2 }],
          })
          await client.query(boundary)
        }
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
      await expect(authorization(pool, target.member)).resolves.toMatchObject({
        rows: [elevated('owner')],
      })
      await expect(assignments(pool, target.member)).resolves.toMatchObject({ rows: [] })
      await expect(clearance(pool, target.member)).resolves.toMatchObject({
        rows: [clearanceRow(customRole)],
      })
    } finally {
      await db.drop()
    }
  })
})
