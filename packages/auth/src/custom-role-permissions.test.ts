import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ApiKeyScope } from './api-key-metadata.ts'
import { apiKeyAllows } from './api-key-scopes.ts'
import type { Principal } from './caller.ts'
import {
  resolveTeamPermissions,
  type TeamPermissionCheck,
  type TeamPermissionOptions,
} from './custom-role-permissions.ts'
import { checkTeamManagementMembership, teamRoles } from './team-management.ts'

const serverUrl = process.env.DATABASE_URL
type SessionPrincipal = Extract<Principal, { kind: 'session' }>

const denied = () => 'denied' as const
const base = () => 'base' as const
const customOperation: TeamPermissionCheck = {
  operation: 'event_types.update',
  fixed: denied,
  custom: true,
}

async function browser(db: Db, principal: Principal): Promise<SessionPrincipal> {
  const sessionId = randomUUID()
  await db
    .insertInto('auth.session')
    .values({
      id: sessionId,
      token: randomUUID(),
      userId: principal.user.id,
      activeOrganizationId: principal.organization.id,
      expiresAt: new Date('2099-01-01'),
      updatedAt: new Date(),
    })
    .execute()
  return { ...principal, kind: 'session', sessionId }
}

async function bearer(db: Db, principal: Principal, scope: ApiKeyScope, name: string) {
  const { id } = await db
    .insertInto('auth.apikey')
    .values({
      referenceId: principal.user.id,
      configId: 'default',
      name,
      key: randomUUID(),
      metadata: JSON.stringify({ organizationId: principal.organization.id, scope }),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { ...principal, kind: 'api_key', apiKeyId: id, apiKeyScope: scope } as const
}

async function oauth(db: Db, principal: Principal): Promise<Principal> {
  const clientId = randomUUID()
  await db
    .insertInto('auth.oauthClient')
    .values({ clientId, redirectUris: JSON.stringify(['https://example.test/callback']) })
    .execute()
  const { id: oauthGrantId } = await db
    .insertInto('mcp_oauth_grants')
    .values({
      organization_id: principal.organization.id,
      user_id: principal.user.id,
      client_id: clientId,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const { id: oauthConsentId } = await db
    .insertInto('auth.oauthConsent')
    .values({
      clientId,
      referenceId: oauthGrantId,
      userId: principal.user.id,
      scopes: JSON.stringify(['mcp:tools']),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return {
    ...principal,
    kind: 'oauth',
    oauthGrantId,
    oauthConsentId,
    clientId,
    scopes: ['mcp:tools'],
  }
}

function changeTeamPolicy(db: Db, teamId: string, enabled: boolean) {
  return db
    .updateTable('team_custom_role_policies')
    .set((eb) => ({ enabled, policy_epoch: eb('policy_epoch', '+', 1) }))
    .where('organization_id', '=', teamId)
    .executeTakeFirstOrThrow()
}

function changeMasterPolicy(db: Db, enabled: boolean) {
  return db
    .updateTable('custom_role_master_policy')
    .set((eb) => ({ enabled, policy_epoch: eb('policy_epoch', '+', 1) }))
    .executeTakeFirstOrThrow()
}

async function customFixture(db: Db) {
  const owner = await createTestUser(db, 'Role manager')
  const member = await createTestUser(db, 'Role assignee')
  const team = await createTestTeam(db, [
    { user: owner, role: 'owner' },
    { user: member, role: 'member' },
  ])
  const principal = await browser(db, team.as(member))
  const memberRow = await db
    .selectFrom('auth.member')
    .select('id')
    .where('userId', '=', member.id)
    .where('organizationId', '=', team.id)
    .executeTakeFirstOrThrow()
  const memberId = memberRow.id
  await changeMasterPolicy(db, true)
  await changeTeamPolicy(db, team.id, true)
  const roleId = await db.transaction().execute(async (trx) => {
    const { id } = await trx
      .insertInto('custom_roles')
      .values({ organization_id: team.id, active_revision: 1 })
      .returning('id')
      .executeTakeFirstOrThrow()
    await trx
      .insertInto('custom_role_revisions')
      .values({
        organization_id: team.id,
        role_id: id,
        revision: 1,
        name: 'Event editor',
        permission_ids: ['event_types.update', 'team_bookings.read'],
      })
      .execute()
    await trx
      .insertInto('custom_role_assignments')
      .values({
        organization_id: team.id,
        member_id: memberId,
        user_id: member.id,
        role_id: id,
        assigned_by_user_id: owner.id,
      })
      .execute()
    return id
  })
  return { principal, teamId: team.id, memberId, roleId, owner, member }
}

async function issue(
  db: Db,
  fixture: Awaited<ReturnType<typeof customFixture>>,
  permissions = ['event_types.update', 'team_bookings.read'],
  principal = fixture.principal,
): Promise<NonNullable<TeamPermissionOptions['credential']>> {
  const { masterEpoch, teamEpoch, memberGeneration } = await db
    .selectFrom('team_member_authorizations as member')
    .innerJoin(
      'team_custom_role_policies as team',
      'team.organization_id',
      'member.organization_id',
    )
    .innerJoin('custom_role_master_policy as master', (join) =>
      join.on('master.singleton', '=', true),
    )
    .select([
      'team.policy_epoch as teamEpoch',
      'master.policy_epoch as masterEpoch',
      'member.generation as memberGeneration',
    ])
    .where('member.member_id', '=', fixture.memberId)
    .executeTakeFirstOrThrow()

  const { id, credential_generation } = await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom('team_credential_authorizations')
      .where('organization_id', '=', fixture.teamId)
      .where('session_id', '=', principal.sessionId)
      .execute()
    return trx
      .insertInto('team_credential_authorizations')
      .values({
        organization_id: fixture.teamId,
        member_id: fixture.memberId,
        user_id: fixture.member.id,
        session_id: principal.sessionId,
        policy_epoch: teamEpoch,
        master_epoch: masterEpoch,
        member_generation: memberGeneration,
        credential_generation: 7,
        permission_ids: permissions,
      })
      .returning(['id', 'credential_generation'])
      .executeTakeFirstOrThrow()
  })
  return { authorizationId: id, generation: credential_generation }
}

describe.skipIf(!serverUrl)('versioned team permission resolution', () => {
  let testDb: TestDatabase
  let db: Db

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  it('preserves base fixed permissions for an operation that does not require verified email', async () => {
    const user = await createTestUser(db, 'Unverified member')
    const team = await createTestTeam(db, [{ user, role: 'member' }])
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', user.id)
      .execute()
    const principal = await browser(db, team.as(user))
    const result = await resolveTeamPermissions(db, principal, team.id, [
      { operation: 'members.read', fixed: base },
      {
        operation: 'invitations.create',
        fixed: ({ emailVerified }) => (emailVerified ? 'elevated' : 'denied'),
      },
      customOperation,
    ])
    expect(result?.decisions.map(({ allowed }) => allowed)).toEqual([true, false, false])
  })

  it('preserves fixed decisions byte for byte across policy changes and credential kinds', async () => {
    const fixedRoles = [
      'owner',
      'admin',
      'member',
      '\tmember\u00a0',
      'member, admin',
      'admin, unexpected',
      'owner, member',
      'owner, owner',
      'administrator',
      'member,',
      '',
    ]
    const users: TestUser[] = []
    for (const role of fixedRoles) users.push(await createTestUser(db, role || 'Empty role'))
    const team = await createTestTeam(
      db,
      users.map((user, i) => ({ role: fixedRoles[i] as string, user })),
    )
    const actors: { principal: Principal; role: string; personal: boolean; manager: boolean }[] = []
    for (const [i, user] of users.entries()) {
      const role = fixedRoles[i] as string
      const principal = team.as(user)
      const manager = await checkTeamManagementMembership(db, user.id, team.id).then(
        () => true,
        () => false,
      )
      for (const credential of [
        await browser(db, principal),
        await bearer(db, principal, 'full', 'Zapier'),
        await bearer(db, principal, 'read', 'n8n'),
        await bearer(db, principal, 'bookings', 'Calendar client'),
        await oauth(db, principal),
      ]) {
        actors.push({ principal: credential, role, personal: false, manager })
      }
    }
    const personalSession = await browser(db, (users[0] as TestUser).principal)
    actors.push({ principal: personalSession, role: 'owner', personal: true, manager: false })

    async function matrix(available: boolean) {
      const expected: string[] = []
      const resolved: string[] = []
      for (const { principal, manager, role, personal } of actors) {
        const bookingAccess = apiKeyAllows(principal, 'GET /api/v1/bookings')
        const eventAccess = apiKeyAllows(principal, 'PATCH /api/v1/event-types/{id}')
        const tokens = role.split(',').map((token) => token.trim())
        const privateProjection =
          !personal &&
          principal.kind === 'session' &&
          manager &&
          tokens.every((token) => ['owner', 'admin', 'member'].includes(token))
        const checks: readonly TeamPermissionCheck[] = [
          {
            operation: 'members.read_private',
            fixed: ({ role, personal }) =>
              !personal &&
              principal.kind === 'session' &&
              teamRoles(role).every((token) => ['owner', 'admin', 'member'].includes(token)) &&
              teamRoles(role).some((token) => token === 'owner' || token === 'admin')
                ? 'elevated'
                : 'denied',
          },
          {
            operation: 'invitations.create',
            fixed: ({ role, personal }) =>
              !personal &&
              principal.kind === 'session' &&
              teamRoles(role).some((token) => token === 'owner' || token === 'admin')
                ? 'elevated'
                : 'denied',
          },
          {
            operation: 'members.assign_role',
            fixed: ({ role, personal }) =>
              !personal && principal.kind === 'session' && teamRoles(role).includes('owner')
                ? 'elevated'
                : 'denied',
          },
          {
            operation: 'event_types.update',
            fixed: ({ role, personal }) => {
              if (!eventAccess) return 'denied'
              if (personal) return 'base'
              return teamRoles(role).some((token) => token === 'owner' || token === 'admin')
                ? 'elevated'
                : 'denied'
            },
            custom: true,
          },
          {
            operation: 'team_bookings.read',
            fixed: () => (bookingAccess ? 'base' : 'denied'),
          },
        ]
        const expects = [
          privateProjection,
          principal.kind === 'session' && manager,
          !personal && principal.kind === 'session' && tokens.includes('owner'),
          eventAccess && (personal || manager),
          bookingAccess,
        ]
        expected.push(
          JSON.stringify(
            checks.map(({ operation }, i) => ({
              operation,
              allowed: expects[i],
              source: expects[i] ? 'fixed' : null,
            })),
          ),
        )
        const result = await resolveTeamPermissions(
          db,
          principal,
          principal.organization.id,
          checks,
          {
            available,
          },
        )
        resolved.push(JSON.stringify(result?.decisions))
      }
      expect(resolved).toEqual(expected)
    }

    await matrix(false)
    for (const enabled of [true, false, true]) {
      await changeMasterPolicy(db, enabled)
      await changeTeamPolicy(db, team.id, enabled)
      await matrix(true)
    }
  })

  it.each([
    { teamEnabled: true, masterEnabled: false, allowed: false },
    { teamEnabled: false, masterEnabled: true, allowed: false },
    { teamEnabled: true, masterEnabled: true, allowed: true },
  ])(
    'resolves a custom grant with team switch $teamEnabled and instance switch $masterEnabled',
    async ({ teamEnabled, masterEnabled, allowed }) => {
      const fixture = await customFixture(db)
      const { principal, teamId } = fixture
      await changeTeamPolicy(db, teamId, teamEnabled)
      await changeMasterPolicy(db, masterEnabled)
      // Use the current epochs so a stale ceiling cannot mask a missing switch guard.
      const credential = await issue(db, fixture)

      const result = await resolveTeamPermissions(db, principal, teamId, [customOperation], {
        available: true,
        credential,
      })

      expect(result?.decisions).toEqual([
        { operation: customOperation.operation, allowed, source: allowed ? 'custom' : null },
      ])
    },
  )

  it('takes the fixed path when a late team or membership lacks snapshots', async () => {
    const owner = await createTestUser(db)
    const fixture = await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE auth.organization DISABLE TRIGGER team_custom_role_policy_initialize`.execute(
        trx,
      )
      await sql`ALTER TABLE auth.member DISABLE TRIGGER team_member_authorization_sync`.execute(trx)
      const team = await createTestTeam(trx, [{ user: owner, role: 'owner' }])
      await sql`ALTER TABLE auth.member ENABLE TRIGGER team_member_authorization_sync`.execute(trx)
      await sql`ALTER TABLE auth.organization ENABLE TRIGGER team_custom_role_policy_initialize`.execute(
        trx,
      )
      return { teamId: team.id, principal: await browser(trx, team.as(owner)) }
    })
    const result = await resolveTeamPermissions(
      db,
      fixture.principal,
      fixture.teamId,
      [
        {
          operation: 'invitations.create',
          fixed: ({ role }) => (role === 'owner' ? 'elevated' : 'denied'),
        },
        customOperation,
      ],
      { available: true },
    )
    expect(result).toEqual({
      decisions: [
        { operation: 'invitations.create', allowed: true, source: 'fixed' },
        { operation: 'event_types.update', allowed: false, source: null },
      ],
      membershipGeneration: null,
      policyVersion: null,
    })
  })

  it('requires an active exact team, phase-one grant, proof gate and issued credential', async () => {
    const fixture = await customFixture(db)
    const { principal, teamId, memberId } = fixture
    const credential = await issue(db, fixture)
    const options = { available: true, credential }
    const decision = async (options?: TeamPermissionOptions, check = customOperation) => {
      const result = await resolveTeamPermissions(db, principal, teamId, [check], options)
      return result?.decisions[0]?.source
    }
    expect(await decision(options)).toBe('custom')
    expect(await decision({ credential })).toBeNull()
    expect(await decision({ available: true })).toBeNull()
    expect(await decision({ ...options, credential: { ...credential, generation: 8 } })).toBeNull()
    expect(await decision(options, { ...customOperation, custom: false })).toBeNull()
    for (const operation of ['team_bookings.read', 'members.assign_role', 'unknown', '*']) {
      expect(await decision(options, { ...customOperation, operation })).toBeNull()
    }
    const otherSession = await browser(db, principal)
    expect(
      (await resolveTeamPermissions(db, otherSession, teamId, [customOperation], options))
        ?.decisions[0]?.allowed,
    ).toBe(false)
    expect(
      await resolveTeamPermissions(db, principal, randomUUID(), [customOperation], options),
    ).toBeUndefined()
    const replacement = await issue(db, fixture, ['event_types.update'])
    expect(await decision(options)).toBeNull()
    const replacementOptions = { available: true, credential: replacement }
    expect(await decision(replacementOptions)).toBe('custom')
    await changeTeamPolicy(db, teamId, false)
    expect(await decision(replacementOptions)).toBeNull()
    await changeTeamPolicy(db, teamId, true)
    expect(await decision(replacementOptions)).toBeNull()
    const renewedOptions = { available: true, credential: await issue(db, fixture) }
    expect(await decision(renewedOptions)).toBe('custom')
    await changeMasterPolicy(db, false)
    expect(await decision(renewedOptions)).toBeNull()
    await changeMasterPolicy(db, true)
    expect(await decision(renewedOptions)).toBeNull()
    const currentOptions = { available: true, credential: await issue(db, fixture) }
    expect(await decision(currentOptions)).toBe('custom')
    await db
      .updateTable('team_member_authorizations')
      .set({ fixed_role: 'admin', legacy_role_tokens: ['admin'] })
      .where('member_id', '=', memberId)
      .execute()
    expect(await decision(currentOptions)).toBeNull()
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: fixture.member.principal.organization.id })
      .where('id', '=', principal.sessionId)
      .execute()
    expect(await decision(currentOptions)).toBeUndefined()
  })

  it('keeps base Member authority but fences gains in fixed authority after assignment clearance', async () => {
    const fixture = await customFixture(db)
    const { principal, teamId, memberId } = fixture
    const checks: TeamPermissionCheck[] = [
      { operation: 'members.read', fixed: base },
      {
        operation: 'invitations.create',
        fixed: ({ role }) => (role === 'admin' ? 'elevated' : 'denied'),
        versionedFixed: true,
      },
    ]
    const old = await issue(db, fixture, ['invitations.create'])
    await db
      .deleteFrom('custom_role_assignments')
      .where('organization_id', '=', teamId)
      .where('member_id', '=', memberId)
      .execute()
    await db.updateTable('auth.member').set({ role: 'admin' }).where('id', '=', memberId).execute()
    const decisions = (options?: TeamPermissionOptions) =>
      resolveTeamPermissions(db, principal, teamId, checks, options)
    expect((await decisions({ credential: old }))?.decisions.map((d) => d.allowed)).toEqual([
      true,
      false,
    ])
    const current = await issue(db, fixture, ['invitations.create'])
    expect(
      (
        await resolveTeamPermissions(
          db,
          principal,
          teamId,
          checks.map((check) => ({ ...check, versionedFixed: false })),
          { credential: current },
        )
      )?.decisions.map((d) => d.allowed),
    ).toEqual([true, false])
    await changeMasterPolicy(db, false)
    await changeTeamPolicy(db, teamId, false)
    expect((await decisions({ credential: current }))?.decisions.map((d) => d.allowed)).toEqual([
      true,
      true,
    ])
  })

  it('denies a custom grant when the live role differs from the Member snapshot', async () => {
    const fixture = await customFixture(db)
    const { principal, teamId, memberId } = fixture
    const credential = await issue(db, fixture)
    const resolve = (connection: Db) =>
      resolveTeamPermissions(connection, principal, teamId, [customOperation], {
        available: true,
        credential,
      })
    expect((await resolve(db))?.decisions).toEqual([
      { operation: customOperation.operation, allowed: true, source: 'custom' },
    ])

    await db.transaction().execute(async (trx) => {
      // Retain the assignment and Member snapshot while changing the live role.
      await sql`ALTER TABLE auth.member DISABLE TRIGGER team_member_authorization_sync`.execute(trx)
      await trx
        .updateTable('auth.member')
        .set({ role: 'admin' })
        .where('id', '=', memberId)
        .execute()
      await sql`ALTER TABLE auth.member ENABLE TRIGGER team_member_authorization_sync`.execute(trx)

      const snapshot = await trx
        .selectFrom('team_member_authorizations')
        .select(['fixed_role', 'legacy_role_tokens'])
        .where('member_id', '=', memberId)
        .executeTakeFirstOrThrow()
      expect(snapshot).toEqual({ fixed_role: 'member', legacy_role_tokens: ['member'] })
      expect((await resolve(trx))?.decisions).toEqual([
        { operation: customOperation.operation, allowed: false, source: null },
      ])
    })
  })

  it('observes publication and its generation bump in one snapshot, despite a contended publish', async () => {
    const fixture = await customFixture(db)
    const { principal, teamId, roleId } = fixture
    const credential = await issue(db, fixture, ['event_types.update', 'analytics.read'])
    const checks = [customOperation, { ...customOperation, operation: 'analytics.read' }]
    const resolve = (credential: TeamPermissionOptions['credential']) =>
      resolveTeamPermissions(db, principal, teamId, checks, { available: true, credential })
    const publishing = Promise.withResolvers<void>()
    const commit = Promise.withResolvers<void>()
    const publication = db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('auth.organization')
        .select('id')
        .where('id', '=', teamId)
        .forUpdate()
        .execute()
      await trx
        .insertInto('custom_role_revisions')
        .values({
          organization_id: teamId,
          role_id: roleId,
          revision: 2,
          name: 'Analytics reader',
          permission_ids: ['analytics.read'],
        })
        .execute()
      await trx
        .updateTable('custom_roles')
        .set({ active_revision: 2 })
        .where('id', '=', roleId)
        .execute()
      publishing.resolve()
      await commit.promise
    })
    try {
      await Promise.race([publishing.promise, publication])
      const beforeCommit = await resolve(credential)
      expect(beforeCommit?.membershipGeneration).toBe(2)
      expect(beforeCommit?.decisions.map((d) => d.allowed)).toEqual([true, false])
    } finally {
      commit.resolve()
      await publication
    }
    const afterCommit = await resolve(credential)
    expect(afterCommit?.membershipGeneration).toBe(3)
    expect(afterCommit?.decisions.map((d) => d.allowed)).toEqual([false, false])
    const renewed = await issue(db, fixture, ['analytics.read'])
    expect((await resolve(renewed))?.decisions.map((d) => d.allowed)).toEqual([false, true])
  })
})
