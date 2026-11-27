import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Principal } from './caller.ts'
import {
  type CustomRoleCommand,
  type CustomRoleView,
  customRoleWrite,
  readCustomRoles,
} from './custom-role-writes.ts'
import { type Auth, createAuth, createAuthPool } from './index.ts'

const databaseUrl = process.env.DATABASE_URL
const origin = 'http://localhost:43829'
const secret = 'synthetic-custom-role-write-fixture-at-least-32-characters'
const signup = { mode: 'open', allowedDomains: [] } as const

describe.skipIf(!databaseUrl)('custom role writes', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string)
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
    })
    await db
      .updateTable('custom_role_master_policy')
      .set({ enabled: true, policy_epoch: 1 })
      .execute()
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  async function team(enabled = true) {
    const id = randomUUID()
    const organization = { id, name: 'Custom role test team', slug: id, personal: false }
    await db
      .insertInto('auth.organization')
      .values({ id, name: organization.name, slug: id, createdAt: new Date() })
      .execute()
    if (enabled)
      await db
        .updateTable('team_custom_role_policies')
        .set({ enabled: true, policy_epoch: 1 })
        .where('organization_id', '=', id)
        .execute()
    return organization
  }

  async function user(organization: Principal['organization'], role: string) {
    const id = randomUUID()
    const email = `${id}@example.test`
    const name = 'Synthetic team member'
    await db.insertInto('auth.user').values({ id, name, email, emailVerified: true }).execute()
    const { memberId } = await db
      .insertInto('auth.member')
      .values({ organizationId: organization.id, userId: id, role, createdAt: new Date() })
      .returning('id as memberId')
      .executeTakeFirstOrThrow()
    const token = randomBytes(24).toString('base64url')
    const { sessionId } = await db
      .insertInto('auth.session')
      .values({
        userId: id,
        token,
        activeOrganizationId: organization.id,
        expiresAt: sql<Date>`clock_timestamp() + interval '1 hour'`,
        updatedAt: new Date(),
      })
      .returning('id as sessionId')
      .executeTakeFirstOrThrow()
    const principal = {
      user: { id, email, name },
      organization,
      kind: 'session',
      sessionId,
    } satisfies Principal
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
    return { memberId, principal, cookie }
  }

  async function fixture(enabled = true) {
    const organization = await team(enabled)
    const owner = await user(organization, 'owner')
    const member = await user(organization, 'member')
    return { owner, member, organization }
  }

  const access = (principal: Principal) => ({
    enabled: true,
    principal,
    teamId: principal.organization.id,
    expectedOrganizationId: principal.organization.id,
  })

  const create = {
    kind: 'create',
    name: 'Scheduling coordinator',
    permissionIds: ['event_types.update', 'analytics.read'],
  } as const

  function write(principal: Principal, command: CustomRoleCommand, enabled = true) {
    const callbacks = customRoleWrite({ ...access(principal), enabled, command })
    return db.transaction().execute(callbacks.mutate)
  }

  async function createRole(principal: Principal): Promise<CustomRoleView> {
    const result = await write(principal, create)
    if (result.kind !== 'role') throw new Error('Expected a created role')
    return result.role
  }

  function journal(teamId: string) {
    return db
      .selectFrom('audit_events')
      .select(['action', 'actor_id', 'credential_id', 'target_id', 'details'])
      .where('organization_id', '=', teamId)
      .execute()
  }

  it('publishes immutable revisions and audits only changes with actual actors and team epochs', async () => {
    const { owner, member, organization } = await fixture()
    const role = await createRole(owner.principal)
    expect(role).toMatchObject({
      revision: 1,
      catalogueVersion: 1,
      permissionIds: ['analytics.read', 'event_types.update'],
    })
    expect(await readCustomRoles(db, { ...access(owner.principal), roleId: role.id })).toEqual([
      role,
    ])
    const assign = {
      kind: 'assign',
      memberId: member.memberId,
      roleId: role.id,
      expectedRevision: 1,
      expectedGeneration: 1,
    } as const
    const assigned = await write(owner.principal, assign)
    expect(assigned).toEqual({
      kind: 'assignment',
      memberId: member.memberId,
      roleId: role.id,
      revision: 1,
      generation: 2,
    })
    await expect(write(owner.principal, assign)).rejects.toMatchObject({
      code: 'role_revision_conflict',
    })
    expect(await write(owner.principal, { ...assign, expectedGeneration: 2 })).toEqual(assigned)
    const publish = {
      ...create,
      kind: 'publish',
      roleId: role.id,
      expectedRevision: 1,
    } as const
    expect(await write(owner.principal, publish)).toEqual({ kind: 'role', role })
    expect(await write(owner.principal, { ...publish, permissionIds: ['analytics.read'] })).toEqual(
      {
        kind: 'role',
        role: { ...role, revision: 2, permissionIds: ['analytics.read'] },
      },
    )
    await expect(
      write(owner.principal, { kind: 'archive', roleId: role.id, expectedRevision: 2 }),
    ).rejects.toMatchObject({ code: 'role_in_use' })
    await expect(
      write(owner.principal, {
        ...assign,
        roleId: null,
        expectedRevision: 1,
        expectedGeneration: 3,
      }),
    ).rejects.toMatchObject({ code: 'role_revision_conflict' })
    expect(
      await write(owner.principal, {
        ...assign,
        roleId: null,
        expectedRevision: 2,
        expectedGeneration: 3,
      }),
    ).toMatchObject({ kind: 'assignment', roleId: null, revision: null, generation: 4 })
    const archive = { kind: 'archive', roleId: role.id, expectedRevision: 2 } as const
    const archived = await write(owner.principal, archive)
    expect(archived).toMatchObject({ kind: 'role', role: { archived: true } })
    expect(await write(owner.principal, archive)).toEqual(archived)
    expect(await readCustomRoles(db, access(owner.principal))).toEqual([])
    await expect(
      write(owner.principal, { ...assign, expectedRevision: 2, expectedGeneration: 4 }),
    ).rejects.toMatchObject({ code: 'team_management_access_denied' })
    expect(
      await db
        .selectFrom('custom_role_revisions')
        .select(['revision', 'permission_ids'])
        .where('role_id', '=', role.id)
        .orderBy('revision')
        .execute(),
    ).toEqual([
      { revision: 1, permission_ids: ['analytics.read', 'event_types.update'] },
      { revision: 2, permission_ids: ['analytics.read'] },
    ])
    const events = await journal(organization.id)
    expect(events).toHaveLength(5)
    expect(events).toEqual(
      expect.arrayContaining([
        {
          action: 'custom_role.created',
          actor_id: owner.principal.user.id,
          credential_id: null,
          target_id: role.id,
          details: {
            roleId: role.id,
            newRevision: 1,
            policyEpoch: 1,
            masterEpoch: 1,
            outcome: 'succeeded',
          },
        },
        expect.objectContaining({
          action: 'membership.custom_role_cleared',
          target_id: member.memberId,
          details: {
            roleId: role.id,
            oldRevision: 2,
            policyEpoch: 1,
            masterEpoch: 1,
            outcome: 'succeeded',
          },
        }),
      ]),
    )
    expect(events.every((event) => event.credential_id === null)).toBe(true)
  })

  it('requires a live, unambiguous fixed Owner session and masks unavailable targets', async () => {
    const { owner, member, organization } = await fixture()
    const role = await createRole(owner.principal)
    const other = await fixture()
    const foreignRole = await createRole(other.owner.principal)
    const disabledTeam = await fixture(false)
    const admin = await user(organization, 'admin')
    const ambiguousOwner = await user(organization, 'owner,member')

    await expect(write(owner.principal, create, false)).rejects.toMatchObject({
      code: 'custom_roles_disabled',
    })
    await expect(write(disabledTeam.owner.principal, create)).rejects.toMatchObject({
      code: 'custom_roles_disabled',
    })
    await expect(write(disabledTeam.member.principal, create)).rejects.toMatchObject({
      code: 'team_management_access_denied',
    })
    const principals: Principal[] = [
      { ...owner.principal, kind: 'api_key', apiKeyId: randomUUID(), apiKeyScope: 'full' },
      {
        ...owner.principal,
        kind: 'oauth',
        oauthConsentId: randomUUID(),
        clientId: 'test',
        scopes: ['mcp:tools'],
      },
      admin.principal,
      ambiguousOwner.principal,
      member.principal,
      { ...owner.principal, sessionId: randomUUID() },
    ]
    for (const principal of principals) {
      await expect(write(principal, create)).rejects.toMatchObject({
        code: 'team_management_access_denied',
      })
      await expect(readCustomRoles(db, access(principal))).rejects.toMatchObject({
        code: 'team_management_access_denied',
      })
    }
    const assign = {
      kind: 'assign',
      memberId: member.memberId,
      roleId: role.id,
      expectedGeneration: 1,
      expectedRevision: 1,
    } as const
    const deniedAssignments = [
      { ...assign, memberId: owner.memberId },
      { ...assign, memberId: admin.memberId },
      { ...assign, memberId: other.member.memberId },
      { ...assign, roleId: foreignRole.id, expectedGeneration: 99 },
    ]
    for (const command of deniedAssignments)
      await expect(write(owner.principal, command)).rejects.toMatchObject({
        code: 'team_management_access_denied',
      })
    await expect(
      readCustomRoles(db, { ...access(owner.principal), roleId: foreignRole.id }),
    ).rejects.toMatchObject({ code: 'team_management_access_denied' })

    for (const permissionIds of [
      ['members.assign_role'],
      ['*'],
      ['team_bookings.read'],
      ['event_types.update', 'event_types.update'],
    ])
      await expect(write(owner.principal, { ...create, permissionIds })).rejects.toMatchObject({
        code: 'invalid_request',
      })
    expect(await journal(organization.id)).toHaveLength(1)
  })

  it('makes role edits and their audit entries roll back together', async () => {
    const { owner, organization } = await fixture()
    const { mutate } = customRoleWrite({ ...access(owner.principal), command: create })
    await expect(
      db.transaction().execute(async (trx) => {
        await mutate(trx)
        throw new Error('rollback test')
      }),
    ).rejects.toThrow('rollback test')
    expect(await readCustomRoles(db, access(owner.principal))).toEqual([])
    expect(await journal(organization.id)).toEqual([])
  })

  it('serializes an in-flight assignment with native Member promotion', async () => {
    const { owner, member, organization } = await fixture()
    const role = await createRole(owner.principal)
    const output = Promise.withResolvers<number>()
    const commit = Promise.withResolvers<void>()
    const assignment = db.transaction().execute(async (trx) => {
      const { mutate } = customRoleWrite({
        ...access(owner.principal),
        command: {
          kind: 'assign',
          memberId: member.memberId,
          roleId: role.id,
          expectedGeneration: 1,
          expectedRevision: 1,
        },
      })
      const result = await mutate(trx)
      const activity = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
      output.resolve(activity.rows[0]?.pid ?? 0)
      await commit.promise
      return result
    })
    void assignment.catch(output.reject)
    const blockingPid = await output.promise
    let native: Promise<Response> | undefined
    try {
      native = Promise.resolve(
        auth.handler(
          new Request(`${origin}/api/auth/organization/update-member-role`, {
            method: 'POST',
            headers: {
              cookie: owner.cookie,
              origin,
              'content-type': 'application/json',
              'X-Expected-Organization-Id': organization.id,
            },
            body: JSON.stringify({
              organizationId: organization.id,
              memberId: member.memberId,
              role: 'admin',
            }),
          }),
        ),
      )
      await vi.waitFor(async () => {
        const { rows } = await sql<{ blocked: boolean }>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
            AND ${blockingPid} = ANY(pg_blocking_pids(pid))
        ) AS blocked`.execute(db)
        expect(rows[0]?.blocked).toBe(true)
      })
    } finally {
      commit.resolve()
      await assignment
      await native
    }
    expect((await native)?.status).toBe(200)
    expect(await assignment).toMatchObject({ generation: 2, roleId: role.id })
    expect(
      await db
        .selectFrom('team_member_authorizations')
        .select(['fixed_role', 'generation'])
        .where('member_id', '=', member.memberId)
        .executeTakeFirst(),
    ).toEqual({ fixed_role: 'admin', generation: 3 })
    expect(
      await db
        .selectFrom('custom_role_assignments')
        .select('role_id')
        .where('member_id', '=', member.memberId)
        .executeTakeFirst(),
    ).toBeUndefined()
    expect(await journal(organization.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'membership.custom_role_cleared',
          target_id: member.memberId,
          details: expect.objectContaining({ roleId: role.id, oldRevision: 1 }),
        }),
      ]),
    )
  })
})
