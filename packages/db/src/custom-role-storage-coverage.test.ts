import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { checkTeamManagementMembership } from '../../auth/src/team-management.ts'
import { assertTeamOwnerRemains } from '../../auth/src/team-owner-continuity.ts'
import { customRoleCatalogueV1 } from '../../core/src/custom-role-catalogue.ts'
import { assertCustomRoleAuditProtections } from './custom-role-audit-protections.ts'
import { assertCustomRoleStorageProtections } from './custom-role-storage-protections.ts'
import { createDb } from './index.ts'
import { runMigrations } from './migrate.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'
import {
  MIGRATION_COVERAGE_TIMEOUT,
  MIGRATION_REPLAY_TIMEOUT,
  useMigrationReplay,
} from './testing/migration-replay.ts'
import { createTestDatabase, createTestDatabaseTemplate, type TestDatabase } from './testing.ts'
import { snapshotSchema } from './upgrade-schema-snapshot.ts'

const serverUrl = process.env.DATABASE_URL as string
const migration = '0197_custom_role_storage.sql'

const predecessorRoles = [
  { stored: 'owner', tokens: ['owner'], fixed: 'owner' },
  { stored: 'admin', tokens: ['admin'], fixed: 'admin' },
  { stored: '\tmember\u00a0', tokens: ['member'], fixed: 'member' },
  { stored: 'member,\tadmin , ', tokens: ['member', 'admin', ''], fixed: null },
  { stored: 'member, administrator', tokens: ['member', 'administrator'], fixed: null },
  { stored: 'notowner', tokens: ['notowner'], fixed: null },
  { stored: 'owner', tokens: ['owner'], fixed: 'owner' },
] as const

const teamId = randomUUID()
const personalId = randomUUID()
const memberIds = predecessorRoles.map(() => randomUUID())
const userIds = [
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
] as const
const [owner, admin, member, multiRole, partiallyKnown, unknown, personalOwner] = userIds
const scimTokenId = randomUUID()

async function seedPredecessor(pool: pg.Pool) {
  await pool.query(
    `INSERT INTO auth.organization (id, name, slug, "createdAt")
     VALUES ($1, 'Existing team', 'custom-role-upgrade-team', now()),
            ($2, 'Existing personal space', 'custom-role-upgrade-personal', now())`,
    [teamId, personalId],
  )
  await pool.query(
    `INSERT INTO auth.user (id, name, email, "emailVerified")
     SELECT id, 'Existing member', id || '@example.test', true FROM unnest($1::uuid[]) AS id`,
    [userIds],
  )
  await pool.query(
    `INSERT INTO auth.member (id, "organizationId", "userId", role, "createdAt")
     SELECT member_id, org_id, user_id, role, '2026-01-02 01:02:03.123456Z'
       FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[])
         AS f(member_id, org_id, user_id, role)`,
    [
      memberIds,
      predecessorRoles.map((_, i) => (i === predecessorRoles.length - 1 ? personalId : teamId)),
      userIds,
      predecessorRoles.map(({ stored }) => stored),
    ],
  )
  await pool.query(
    'INSERT INTO personal_organizations (user_id, organization_id) VALUES ($1, $2)',
    [personalOwner, personalId],
  )
  await pool.query(
    `INSERT INTO auth.invitation ("organizationId", email, role, status, "expiresAt", "inviterId")
     VALUES ($1, 'pending@example.test', 'member', 'pending', '2030-01-01', $2),
            ($1, 'historical@example.test', 'member', 'accepted', '2026-01-01', $2)`,
    [teamId, owner],
  )

  const sessionId = randomUUID()
  const grantId = randomUUID()
  const refreshId = randomUUID()
  await pool.query(
    `INSERT INTO auth.session (id, "userId", token, "expiresAt", "updatedAt", "activeOrganizationId")
     VALUES ($1, $2, 'synthetic-existing-session', '2030-01-01', now(), $3)`,
    [sessionId, owner, teamId],
  )
  await pool.query(
    `INSERT INTO auth.apikey ("configId", "referenceId", key, name, enabled, metadata, "createdAt", "updatedAt")
     SELECT 'default', $1, 'synthetic-key-digest-' || scope, label, true,
       jsonb_build_object('scope', scope, 'organizationId', $2::uuid)::text, now(), now()
     FROM (VALUES ('full', 'Zapier'), ('read', 'n8n'), ('bookings', 'Booking client')) AS f(scope, label)`,
    [owner, teamId],
  )
  await pool.query(`INSERT INTO auth."oauthClient" ("clientId", "redirectUris")
    VALUES ('existing-mcp-client', '["https://mcp.example.test/callback"]')`)
  await pool.query(
    `INSERT INTO mcp_oauth_grants (id, user_id, organization_id, client_id)
     VALUES ($1, $2, $3, 'existing-mcp-client')`,
    [grantId, owner, teamId],
  )
  await pool.query(
    `INSERT INTO auth."oauthConsent" ("clientId", "userId", "referenceId", scopes, "createdAt", "updatedAt")
     VALUES ('existing-mcp-client', $1, $2, '["mcp:tools"]', now(), now())`,
    [owner, grantId],
  )
  await pool.query(
    `INSERT INTO auth."oauthRefreshToken"
      (id, token, "clientId", "sessionId", "userId", "referenceId", scopes, "expiresAt", "createdAt")
     VALUES ($1, 'synthetic-refresh-digest', 'existing-mcp-client', $2, $3, $4, '["mcp:tools"]', '2030-01-01', now())`,
    [refreshId, sessionId, owner, grantId],
  )
  await pool.query(
    `INSERT INTO auth."oauthAccessToken"
      (token, "clientId", "sessionId", "userId", "referenceId", "refreshId", scopes, "expiresAt", "createdAt")
     VALUES ('synthetic-access-digest', 'existing-mcp-client', $1, $2, $3, $4, '["mcp:tools"]', '2030-01-01', now())`,
    [sessionId, owner, grantId, refreshId],
  )
  await pool.query(
    `INSERT INTO scim_provisioning_tokens
      (id, organization_id, name, token_hash, previous_token_hash, previous_valid_until, created_by_user_id)
     VALUES ($1, $2, 'Existing directory client', repeat('a', 43), repeat('b', 43), '2030-01-01', $3)`,
    [scimTokenId, teamId, owner],
  )
  await pool.query(
    `INSERT INTO audit_events
      (organization_id, action, actor_type, actor_id, credential_type, target_type, target_id, details)
     VALUES ($1, 'membership.role_changed', 'user', $2, 'session', 'membership', $3, '{"oldRole":"member","newRole":"admin"}')`,
    [teamId, owner, memberIds[1]],
  )
}

const fixedTables = [
  'auth.organization',
  'personal_organizations',
  'auth.member',
  'auth.invitation',
  'auth.session',
  'auth.apikey',
  'auth."oauthClient"',
  'auth."oauthConsent"',
  'auth."oauthAccessToken"',
  'auth."oauthRefreshToken"',
  'mcp_oauth_grants',
  'scim_provisioning_tokens',
  'scim_token_connections',
  'audit_events',
]

async function fixedRows(pool: pg.Pool) {
  const rows: Record<string, string[]> = {}
  for (const table of fixedTables) {
    rows[table] = (
      await pool.query<{ row: string }>(
        `SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY to_jsonb(t)::text COLLATE "C"`,
      )
    ).rows.map(({ row }) => row)
  }
  return rows
}

async function assertExistingFixedChecks(pool: pg.Pool) {
  const db = createDb(pool)
  for (const [userId, role] of [
    [owner, 'owner'],
    [admin, 'admin'],
    [member, 'member'],
    [multiRole, 'admin'],
    [partiallyKnown, 'member'],
  ] as const) {
    await expect(
      checkTeamManagementMembership(db, userId, teamId, false, false, true),
    ).resolves.toMatchObject({ role, personal: false })
  }
  await expect(checkTeamManagementMembership(db, unknown, teamId)).rejects.toMatchObject({
    code: 'team_management_access_denied',
  })
  await expect(
    checkTeamManagementMembership(db, personalOwner, personalId, false, true),
  ).resolves.toMatchObject({ role: 'owner', personal: true })
  await db.transaction().execute(async (trx) => {
    await trx
      .selectFrom('auth.organization')
      .select('id')
      .where('id', '=', teamId)
      .forUpdate()
      .executeTakeFirstOrThrow()
    await expect(assertTeamOwnerRemains(trx, teamId, owner)).rejects.toMatchObject({
      code: 'member_departure_owner_required',
    })
    await expect(assertTeamOwnerRemains(trx, teamId, admin)).resolves.toBeUndefined()
  })
}

async function assertEmptyCustomAuthority(pool: pg.Pool) {
  expect((await pool.query('SELECT * FROM custom_role_master_policy')).rows).toEqual([
    { singleton: true, enabled: false, policy_epoch: 0 },
  ])
  for (const table of [
    'custom_roles',
    'custom_role_revisions',
    'custom_role_assignments',
    'team_credential_authorizations',
  ]) {
    expect((await pool.query(`SELECT FROM ${table}`)).rowCount, table).toBe(0)
  }
}

describe.skipIf(!serverUrl)('custom role storage migration', () => {
  const replay = useMigrationReplay(serverUrl, migration)

  it(
    'preserves existing fixed authority on upgrade and after restoring the predecessor',
    async () => {
      const pristine = await replay.predecessor.clone(undefined, {
        migrate: false,
        tag: 'role_before',
      })
      const predecessorSchema = await snapshotSchema(pristine.pool).finally(() => pristine.drop())
      const backup = await createTestDatabaseTemplate(serverUrl, seedPredecessor, {
        template: replay.predecessor.name,
        tag: 'role_backup',
      })
      let upgraded: TestDatabase | undefined
      let restored: TestDatabase | undefined
      let fresh: TestDatabase | undefined
      try {
        upgraded = await backup.clone(undefined, { migrate: false, tag: 'role_upgrade' })
        const before = await fixedRows(upgraded.pool)
        await assertExistingFixedChecks(upgraded.pool)

        expect(await runMigrations(upgraded.pool)).toContain(migration)
        expect(await fixedRows(upgraded.pool)).toEqual(before)
        await assertExistingFixedChecks(upgraded.pool)
        await assertEmptyCustomAuthority(upgraded.pool)
        expect((await upgraded.pool.query('SELECT * FROM team_custom_role_policies')).rows).toEqual(
          [{ organization_id: teamId, enabled: false, policy_epoch: 0 }],
        )
        expect(
          (await upgraded.pool.query('SELECT * FROM scim_token_protocol_versions')).rows,
        ).toEqual([{ token_id: scimTokenId, protocol_version: 1 }])
        const authorizationRows = (
          await upgraded.pool.query('SELECT * FROM team_member_authorizations ORDER BY member_id')
        ).rows
        expect(authorizationRows).toEqual(
          predecessorRoles
            .map(({ tokens, fixed }, i) => ({
              member_id: memberIds[i],
              user_id: userIds[i],
              organization_id: i === predecessorRoles.length - 1 ? personalId : teamId,
              generation: 1,
              fixed_policy_version: 1,
              legacy_role_tokens: tokens,
              fixed_role: fixed,
            }))
            .sort((a, b) => String(a.member_id).localeCompare(String(b.member_id))),
        )
        expect(await runMigrations(upgraded.pool)).toEqual([])
        expect(await fixedRows(upgraded.pool)).toEqual(before)
        expect(
          (await upgraded.pool.query('SELECT * FROM team_member_authorizations ORDER BY member_id'))
            .rows,
        ).toEqual(authorizationRows)

        fresh = await createTestDatabase(serverUrl, undefined, {
          migrate: false,
          tag: 'role_fresh',
        })
        expect(await runMigrations(fresh.pool)).toContain(migration)
        await assertEmptyCustomAuthority(fresh.pool)
        for (const table of [
          'team_custom_role_policies',
          'team_member_authorizations',
          'scim_token_protocol_versions',
        ]) {
          expect((await fresh.pool.query(`SELECT FROM ${table}`)).rowCount, table).toBe(0)
        }
        expect(await snapshotSchema(fresh.pool)).toEqual(await snapshotSchema(upgraded.pool))
        expect(await runMigrations(fresh.pool)).toEqual([])
        await assertEmptyCustomAuthority(fresh.pool)

        restored = await backup.clone(undefined, { migrate: false, tag: 'role_restore' })
        expect(
          (await restored.pool.query("SELECT to_regclass('public.custom_roles') AS relation")).rows,
        ).toEqual([{ relation: null }])
        expect(await snapshotSchema(restored.pool)).toEqual(predecessorSchema)
        expect(await fixedRows(restored.pool)).toEqual(before)
        await assertExistingFixedChecks(restored.pool)
      } finally {
        try {
          await Promise.all([upgraded?.drop(), restored?.drop(), fresh?.drop()])
        } finally {
          await backup.drop()
        }
      }
    },
    MIGRATION_REPLAY_TIMEOUT,
  )

  it('pins storage to the frozen operation and custom-grant IDs', async () => {
    const db = await createTestDatabase(serverUrl, undefined, { tag: 'role_catalogue' })
    try {
      const { fixed, phaseOne, phaseTwoPersonalData } = customRoleCatalogueV1
      const grants = [...phaseOne, ...phaseTwoPersonalData].sort()
      const { rows } = await db.pool.query<{ grants: string[]; operations: string[] }>(`
        SELECT custom_role_grantable_permissions_v1() AS grants,
               custom_role_operation_ids_v1() AS operations
      `)
      expect(rows[0]?.grants.sort()).toEqual(grants)
      expect(rows[0]?.operations.sort()).toEqual([...fixed, ...grants].sort())
    } finally {
      await db.drop()
    }
  })

  it(
    'fails a protection assertion for each independently protective object removed',
    async () => {
      const report = await checkConstraintCoverage({
        serverUrl,
        migration,
        allowList: {
          'constraint public.custom_roles.custom_role_scope':
            'Team-scoped FK target. The role ID is already unique by primary key.',
          'constraint public.custom_role_revisions.custom_role_revisions_pkey':
            'Team-scoped target for the active revision FK, which cannot be dropped independently.',
          'constraint public.team_member_authorizations.team_member_authorization_scope':
            'Team- and user-scoped FK target. The member ID is already unique by primary key.',
          'constraint public.team_member_authorizations.team_member_authorizations_pkey':
            'Membership identity already follows from the scoped unique key and native membership FK.',
        },
        predecessorTemplate: replay.predecessor,
        assertions: async (pool) => {
          await assertCustomRoleStorageProtections(pool)
          await assertCustomRoleAuditProtections(pool)
        },
      })
      expect(report.problems).toEqual([])
    },
    MIGRATION_COVERAGE_TIMEOUT,
  )
})
