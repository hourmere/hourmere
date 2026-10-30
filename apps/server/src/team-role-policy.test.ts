import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  type Auth,
  createAuth,
  createAuthPool,
  createCallerResolver,
  ensurePersonalOrganization,
  type SignupPolicy,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4391'
const signup: SignupPolicy = { mode: 'open', allowedDomains: [] }
const expectedHeader = 'x-expected-organization-id'
const denial = {
  code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
  message: 'team_management_access_denied',
}

interface HookInput {
  member?: { id: string }
  invitation?: { id?: string; email: string }
}
interface OrganizationOptions {
  organizationHooks: Record<string, (input: HookInput) => unknown>
}

describe.skipIf(!serverUrl)('launch team role policy through HTTP', () => {
  let owned: TestDatabase
  let db: Db
  let pool: pg.Pool
  let auth: Auth
  let hooks: OrganizationOptions['organizationHooks']
  let app: ReturnType<typeof createApp>
  const secret = randomBytes(32).toString('base64')

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'team_role' })
    db = createDb(owned.pool)
    // Reuse this auth pool, its two lock connections and the fixture pool for every case.
    pool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
    })
    const plugin = auth.options.plugins.find((candidate) => candidate.id === 'organization')
    hooks = (plugin as unknown as { options: OrganizationOptions }).options.organizationHooks
    app = createApp({
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      checkDb: async () => {},
      publicUrl: origin,
    })
  })

  afterAll(async () => {
    await pool?.end()
    await owned?.drop()
  })

  async function account() {
    const user = await db
      .insertInto('auth.user')
      .values({ name: 'Role fixture', email: `${randomUUID()}@example.com`, emailVerified: true })
      .returning(['id', 'email'])
      .executeTakeFirstOrThrow()
    const personal = await ensurePersonalOrganization(db, user.id)
    const token = randomBytes(24).toString('base64url')
    const session = await db
      .insertInto('auth.session')
      .values({
        token,
        userId: user.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        activeOrganizationId: personal,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    return {
      ...user,
      personal,
      sessionId: session.id,
      cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    }
  }

  async function fixture(actorRole = 'owner', targetRole = 'member') {
    const actor = await account()
    const target = await account()
    const survivor = await account()
    const team = await db
      .insertInto('auth.organization')
      .values({ name: 'Role policy team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    const members = await db
      .insertInto('auth.member')
      .values([
        { organizationId: team.id, userId: actor.id, role: actorRole, createdAt: new Date() },
        { organizationId: team.id, userId: target.id, role: targetRole, createdAt: new Date() },
        { organizationId: team.id, userId: survivor.id, role: 'owner', createdAt: new Date() },
      ])
      .returning(['id', 'userId'])
      .execute()
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: team.id })
      .where('userId', 'in', [actor.id, target.id, survivor.id])
      .execute()
    return {
      actor,
      target,
      survivor,
      teamId: team.id,
      actorMemberId: members.find((member) => member.userId === actor.id)?.id as string,
      targetMemberId: members.find((member) => member.userId === target.id)?.id as string,
    }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function post(
    f: Fixture,
    action: string,
    body: Record<string, unknown>,
    options: { cookie?: string; expected?: string | null; from?: string } = {},
  ) {
    const expected = options.expected === undefined ? f.teamId : options.expected
    return app.request(`/api/auth/organization/${action}`, {
      method: 'POST',
      headers: {
        cookie: options.cookie ?? f.actor.cookie,
        origin: options.from ?? origin,
        'content-type': 'application/json',
        ...(expected === null ? {} : { [expectedHeader]: expected }),
      },
      body: JSON.stringify(body),
    })
  }

  async function refused(response: Response) {
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual(denial)
  }

  function operations(f: Fixture) {
    return db
      .selectFrom('organization_operations')
      .selectAll()
      .where('organization_id', '=', f.teamId)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute()
  }

  function roleOperation(f: Fixture, previousRole: string, newRole: string) {
    return {
      id: expect.any(String),
      organization_id: f.teamId,
      operation: 'member_role_changed',
      actor_user_id: f.actor.id,
      booking_id: null,
      target_user_id: f.target.id,
      previous_role: previousRole,
      new_role: newRole,
      source: 'web',
      api_key_id: null,
      oauth_consent_id: null,
      occurred_at: expect.any(Date),
    }
  }

  function snapshot(f: Fixture) {
    return Promise.all([
      db
        .selectFrom('auth.member')
        .select(['id', 'userId', 'role'])
        .where('organizationId', '=', f.teamId)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('auth.invitation')
        .select(['id', 'role', 'email', 'status', 'expiresAt'])
        .where('organizationId', '=', f.teamId)
        .orderBy('id')
        .execute(),
      operations(f),
    ])
  }

  async function historicalInvitation(
    f: Fixture,
    role: string,
    email = `${randomUUID()}@example.com`,
  ) {
    return db
      .insertInto('auth.invitation')
      .values({
        organizationId: f.teamId,
        inviterId: f.survivor.id,
        email,
        role,
        status: 'pending',
        createdAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning(['id', 'email'])
      .executeTakeFirstOrThrow()
  }

  const invitationCells = ['owner', 'admin', 'member'].flatMap((actorRole) =>
    [
      undefined,
      'member',
      ['member'],
      'admin',
      'owner',
      'custom',
      'member,admin',
      ['member', 'owner'],
    ].map((requestedRole) => ({
      actorRole,
      requestedRole,
      allowed:
        actorRole !== 'member' &&
        (requestedRole === undefined ||
          requestedRole === 'member' ||
          (Array.isArray(requestedRole) &&
            requestedRole.length === 1 &&
            requestedRole[0] === 'member')),
    })),
  )
  it.each(invitationCells)(
    '$actorRole inviting $requestedRole follows the fixed invitation matrix',
    async ({ actorRole, requestedRole, allowed }) => {
      const f = await fixture(actorRole)
      const before = await snapshot(f)
      const email = `${randomUUID()}@example.com`
      const response = await post(f, 'invite-member', {
        organizationId: f.teamId,
        email,
        ...(requestedRole === undefined ? {} : { role: requestedRole }),
      })
      if (allowed) {
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          organizationId: f.teamId,
          email,
          role: 'member',
          status: 'pending',
        })
        expect(
          await db
            .selectFrom('auth.invitation')
            .select('role')
            .where('organizationId', '=', f.teamId)
            .where('email', '=', email)
            .executeTakeFirstOrThrow(),
        ).toEqual({ role: 'member' })
        expect(await operations(f)).toEqual([])
      } else {
        await refused(response)
        expect(await snapshot(f)).toEqual(before)
      }
    },
  )

  const roleCells = ['owner', 'admin', 'member'].flatMap((actorRole) =>
    [
      { targetRole: 'member', requestedRole: 'admin' },
      { targetRole: 'admin', requestedRole: 'member' },
      { targetRole: 'member', requestedRole: 'member' },
      { targetRole: 'admin', requestedRole: 'admin' },
      { targetRole: 'member', requestedRole: ['admin'] },
      { targetRole: 'admin', requestedRole: ['member'] },
      { targetRole: 'owner', requestedRole: 'member' },
      { targetRole: 'owner', requestedRole: 'admin' },
      { targetRole: 'owner', requestedRole: 'owner' },
      { targetRole: 'member', requestedRole: 'owner' },
      { targetRole: 'member', requestedRole: 'custom' },
      { targetRole: 'member', requestedRole: 'member,admin' },
      { targetRole: 'member', requestedRole: ['member', 'admin'] },
    ].map((cell) => ({
      ...cell,
      actorRole,
      allowed:
        actorRole === 'owner' &&
        cell.targetRole !== 'owner' &&
        (cell.requestedRole === 'member' ||
          cell.requestedRole === 'admin' ||
          (Array.isArray(cell.requestedRole) && cell.requestedRole.length === 1)),
    })),
  )
  it.each(roleCells)(
    '$actorRole changing $targetRole to $requestedRole follows the fixed role matrix',
    async ({ actorRole, targetRole, requestedRole, allowed }) => {
      const f = await fixture(actorRole, targetRole)
      const before = await snapshot(f)
      const response = await post(f, 'update-member-role', {
        organizationId: f.teamId,
        memberId: f.targetMemberId,
        role: requestedRole,
      })
      if (allowed) {
        const storedRole = Array.isArray(requestedRole) ? requestedRole.join(',') : requestedRole
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          id: f.targetMemberId,
          userId: f.target.id,
          organizationId: f.teamId,
          role: storedRole,
        })
        expect(
          await db
            .selectFrom('auth.member')
            .select('role')
            .where('id', '=', f.targetMemberId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ role: storedRole })
        expect(await operations(f)).toEqual(
          targetRole === storedRole ? [] : [roleOperation(f, targetRole, storedRole)],
        )
      } else {
        await refused(response)
        expect(await snapshot(f)).toEqual(before)
      }
    },
  )

  it('rolls back the HTTP role change when its attribution record cannot be written', async () => {
    const f = await fixture()
    const before = await snapshot(f)
    await owned.pool.query(`
      CREATE FUNCTION public.reject_test_team_role_operation() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'Synthetic role operation record failure';
      END $$;
      CREATE TRIGGER reject_test_team_role_operation BEFORE INSERT
      ON public.organization_operations FOR EACH ROW
      EXECUTE FUNCTION public.reject_test_team_role_operation();
    `)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await post(f, 'update-member-role', {
        organizationId: f.teamId,
        memberId: f.targetMemberId,
        role: 'admin',
      })
      expect(response.status).toBe(500)
      expect(await snapshot(f)).toEqual(before)
    } finally {
      errors.mockRestore()
      await owned.pool.query(`
        DROP TRIGGER reject_test_team_role_operation ON public.organization_operations;
        DROP FUNCTION public.reject_test_team_role_operation();
      `)
    }
  })

  it('retains a legacy target role verbatim in the actual role transition', async () => {
    const f = await fixture('owner', 'member, admin')
    const response = await post(f, 'update-member-role', {
      organizationId: f.teamId,
      memberId: f.targetMemberId,
      role: 'member',
    })
    expect(response.status).toBe(200)
    expect(await operations(f)).toEqual([roleOperation(f, 'member, admin', 'member')])
  })

  it.each(['owner', 'admin', 'member'])(
    'refuses %s self-promotion and unauthorized self-role changes',
    async (actorRole) => {
      const f = await fixture(actorRole)
      const before = await snapshot(f)
      for (const role of ['owner', 'admin', 'member', 'member,owner']) {
        await refused(
          await post(f, 'update-member-role', {
            organizationId: f.teamId,
            memberId: f.actorMemberId,
            role,
          }),
        )
      }
      expect(await snapshot(f)).toEqual(before)
    },
  )

  it.each(['owner', 'admin', 'member'])(
    'keeps add-member unavailable over HTTP to %s, including ordinary member additions',
    async (actorRole) => {
      const f = await fixture(actorRole)
      const outsider = await account()
      const before = await snapshot(f)
      for (const role of ['member', 'admin', 'owner', ['member', 'admin']]) {
        const response = await post(f, 'add-member', {
          organizationId: f.teamId,
          userId: outsider.id,
          role,
        })
        expect(response.status).toBe(404)
      }
      expect(await snapshot(f)).toEqual(before)
    },
  )

  it('keeps trusted add-member limited to the ordinary role', async () => {
    const f = await fixture()
    const recipient = await account()
    for (const role of ['admin', 'owner', 'custom', 'member,admin', ['member', 'owner']]) {
      const before = await snapshot(f)
      // Exercise invalid runtime input that the trusted API's static role union excludes.
      const request = {
        body: { organizationId: f.teamId, userId: recipient.id, role },
      } as unknown as Parameters<typeof auth.api.addMember>[0]
      await expect(auth.api.addMember(request)).rejects.toMatchObject({
        status: 'FORBIDDEN',
        body: denial,
      })
      expect(await snapshot(f)).toEqual(before)
    }
    const member = await auth.api.addMember({
      body: { organizationId: f.teamId, userId: recipient.id, role: 'member' },
    })
    expect(member).toMatchObject({ organizationId: f.teamId, userId: recipient.id, role: 'member' })
  })

  it.each(['owner', 'admin', 'member'])(
    '%s resends only ordinary member invitations under the same invitation policy',
    async (actorRole) => {
      const f = await fixture(actorRole)
      const invitation = await historicalInvitation(f, 'member')
      const before = await snapshot(f)
      const response = await post(f, 'invite-member', {
        organizationId: f.teamId,
        email: invitation.email,
        invitationId: invitation.id,
        expectedGeneration: 1,
        requestId: randomUUID(),
        resend: true,
      })
      if (actorRole === 'member') {
        await refused(response)
        expect(await snapshot(f)).toEqual(before)
      } else {
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ id: invitation.id, role: 'member' })
      }
    },
  )

  it.each(['admin', 'owner', 'member,admin', 'member,owner', 'custom'])(
    'does not revive a historical %s invitation by resending it as member',
    async (storedRole) => {
      const f = await fixture()
      const invitation = await historicalInvitation(f, storedRole)
      const before = await snapshot(f)
      for (const role of [undefined, 'member']) {
        await refused(
          await post(f, 'invite-member', {
            organizationId: f.teamId,
            email: invitation.email.toUpperCase(),
            invitationId: invitation.id,
            expectedGeneration: 1,
            requestId: randomUUID(),
            resend: true,
            ...(role === undefined ? {} : { role }),
          }),
        )
      }
      expect(await snapshot(f)).toEqual(before)
    },
  )

  it.each(['admin', 'owner', 'member,admin', 'member,owner', 'custom'])(
    'refuses accepting a historical invitation with stored %s role',
    async (storedRole) => {
      const f = await fixture()
      const recipient = await account()
      const invitation = await historicalInvitation(f, storedRole, recipient.email)
      const before = await snapshot(f)
      await refused(
        await post(
          f,
          'accept-invitation',
          { invitationId: invitation.id },
          { cookie: recipient.cookie, expected: null },
        ),
      )
      expect(await snapshot(f)).toEqual(before)
      expect(
        await db
          .selectFrom('auth.session')
          .select('activeOrganizationId')
          .where('id', '=', recipient.sessionId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ activeOrganizationId: recipient.personal })
    },
  )

  it('accepts an ordinary historical invitation into its explicit team from another active context', async () => {
    const f = await fixture()
    const recipient = await account()
    const invitation = await historicalInvitation(f, 'member', recipient.email)
    const response = await post(
      f,
      'accept-invitation',
      { invitationId: invitation.id },
      { cookie: recipient.cookie, expected: null },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      invitation: { id: invitation.id, status: 'accepted', role: 'member' },
      member: { userId: recipient.id, organizationId: f.teamId, role: 'member' },
    })
  })

  it('keeps legitimate legacy owners able to manage fixed roles without changing either owner', async () => {
    const f = await fixture('member,owner')
    for (const [cookie, role] of [
      [f.actor.cookie, 'admin'],
      [f.survivor.cookie, 'member'],
    ]) {
      const response = await post(
        f,
        'update-member-role',
        { organizationId: f.teamId, memberId: f.targetMemberId, role },
        { cookie },
      )
      expect(response.status).toBe(200)
    }
    expect(
      await db
        .selectFrom('auth.member')
        .select(['userId', 'role'])
        .where('organizationId', '=', f.teamId)
        .where('userId', 'in', [f.actor.id, f.survivor.id])
        .orderBy('userId')
        .execute(),
    ).toEqual(
      [
        { userId: f.actor.id, role: 'member,owner' },
        { userId: f.survivor.id, role: 'owner' },
      ].sort((left, right) => left.userId.localeCompare(right.userId)),
    )
  })

  it.each(['member,admin', 'member, admin', 'admin,owner', 'admin, owner'])(
    'recognizes exact comma-separated actor tokens in %j',
    async (actorRole) => {
      const f = await fixture(actorRole)
      const invited = await post(f, 'invite-member', {
        organizationId: f.teamId,
        email: `${randomUUID()}@example.com`,
        role: 'member',
      })
      expect(invited.status).toBe(200)
      const changed = await post(f, 'update-member-role', {
        organizationId: f.teamId,
        memberId: f.targetMemberId,
        role: 'admin',
      })
      if (actorRole.includes('owner')) expect(changed.status).toBe(200)
      else await refused(changed)
    },
  )

  it.each(['superadmin', 'team-owner', 'administrator', 'OWNER', 'member,team-owner'])(
    'does not grant management for substring or differently cased actor role %j',
    async (actorRole) => {
      const f = await fixture(actorRole)
      const before = await snapshot(f)
      await refused(
        await post(f, 'invite-member', {
          organizationId: f.teamId,
          email: `${randomUUID()}@example.com`,
          role: 'member',
        }),
      )
      await refused(
        await post(f, 'update-member-role', {
          organizationId: f.teamId,
          memberId: f.targetMemberId,
          role: 'admin',
        }),
      )
      expect(await snapshot(f)).toEqual(before)
    },
  )

  it.each(['member,owner', 'member, owner', 'admin,owner'])(
    'refuses every owner target represented as %j',
    async (targetRole) => {
      for (const actorRole of ['owner', 'admin']) {
        const f = await fixture(actorRole, targetRole)
        const before = await snapshot(f)
        const response = await post(f, 'update-member-role', {
          organizationId: f.teamId,
          memberId: f.targetMemberId,
          role: 'member',
        })
        await refused(response)
        expect(await snapshot(f)).toEqual(before)
      }
    },
  )

  it('returns identical role-change denials for a missing member and another team member', async () => {
    const f = await fixture()
    const other = await fixture()
    const before = [await snapshot(f), await snapshot(other)]
    for (const memberId of ['not-an-id', randomUUID(), other.targetMemberId]) {
      await refused(
        await post(f, 'update-member-role', { organizationId: f.teamId, memberId, role: 'admin' }),
      )
    }
    expect([await snapshot(f), await snapshot(other)]).toEqual(before)
  })

  it('requires current verification and loses role authority immediately in the same session', async () => {
    const f = await fixture()
    expect(
      (
        await post(f, 'invite-member', {
          organizationId: f.teamId,
          email: `${randomUUID()}@example.com`,
          role: 'member',
        })
      ).status,
    ).toBe(200)
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', f.actor.id)
      .execute()
    const before = await snapshot(f)
    await refused(
      await post(f, 'update-member-role', {
        organizationId: f.teamId,
        memberId: f.targetMemberId,
        role: 'admin',
      }),
    )
    await refused(
      await post(f, 'invite-member', {
        organizationId: f.teamId,
        email: `${randomUUID()}@example.com`,
        role: 'member',
      }),
    )
    expect(await snapshot(f)).toEqual(before)

    const revoked = await fixture()
    expect(
      (
        await post(revoked, 'update-member-role', {
          organizationId: revoked.teamId,
          memberId: revoked.targetMemberId,
          role: 'admin',
        })
      ).status,
    ).toBe(200)
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('id', '=', revoked.actorMemberId)
      .execute()
    const unchanged = await snapshot(revoked)
    await refused(
      await post(revoked, 'update-member-role', {
        organizationId: revoked.teamId,
        memberId: revoked.targetMemberId,
        role: 'member',
      }),
    )
    expect(await snapshot(revoked)).toEqual(unchanged)
  })

  it('retains organization context and same-origin checks on direct role endpoints', async () => {
    const f = await fixture()
    const other = await fixture()
    const before = await snapshot(f)
    for (const expected of [null, other.teamId]) {
      const response = await post(
        f,
        'update-member-role',
        { organizationId: f.teamId, memberId: f.targetMemberId, role: 'admin' },
        { expected },
      )
      expect(response.status).toBe(expected === null ? 409 : 403)
      expect(await response.json()).toMatchObject({
        code: expected === null ? 'ORGANIZATION_CONTEXT_CHANGED' : 'TEAM_MANAGEMENT_ACCESS_DENIED',
      })
    }
    expect(
      (
        await post(
          f,
          'update-member-role',
          { organizationId: f.teamId, memberId: f.targetMemberId, role: 'admin' },
          { from: 'https://other.example' },
        )
      ).status,
    ).toBe(403)
    expect(await snapshot(f)).toEqual(before)
  })

  it('rechecks revoked actor authority when role change reaches persistence after its before hook', async () => {
    const f = await fixture('owner')
    const hook = 'beforeUpdateMemberRole'
    const original = hooks[hook]
    const resume = Promise.withResolvers<void>()
    let entered = false
    hooks[hook] = async (input) => {
      const result = await original?.(input)
      if (input.member?.id === f.targetMemberId) {
        entered = true
        await resume.promise
      }
      return result
    }
    let pending: Promise<Response> | undefined
    const revoker = await owned.pool.connect()
    try {
      const before = await snapshot(f)
      pending = Promise.resolve(
        post(f, 'update-member-role', {
          organizationId: f.teamId,
          memberId: f.targetMemberId,
          role: 'admin',
        }),
      )
      await vi.waitFor(() => expect(entered).toBe(true), { interval: 10, timeout: 1_500 })
      await revoker.query("SET lock_timeout = '1000ms'")
      await revoker.query('UPDATE auth.member SET role = $1 WHERE id = $2', [
        'member',
        f.actorMemberId,
      ])
      resume.resolve()
      await refused(await pending)
      const after = await snapshot(f)
      expect(after).toEqual([
        before[0].map((member) =>
          member.id === f.actorMemberId ? { ...member, role: 'member' } : member,
        ),
        before[1],
        before[2],
      ])
    } finally {
      resume.resolve()
      hooks[hook] = original as (input: HookInput) => unknown
      await revoker.query('SET lock_timeout = 0')
      revoker.release()
      await pending
    }
  })

  it('rechecks a stored invitation role changed after the acceptance before hook', async () => {
    const f = await fixture()
    const recipient = await account()
    const invitation = await historicalInvitation(f, 'member', recipient.email)
    const original = hooks.beforeAcceptInvitation
    hooks.beforeAcceptInvitation = async (input) => {
      const result = await original?.(input)
      if (input.invitation?.id === invitation.id) {
        await db
          .updateTable('auth.invitation')
          .set({ role: 'admin' })
          .where('id', '=', invitation.id)
          .execute()
      }
      return result
    }
    try {
      await refused(
        await post(
          f,
          'accept-invitation',
          { invitationId: invitation.id },
          { cookie: recipient.cookie, expected: null },
        ),
      )
      expect(
        await db
          .selectFrom('auth.invitation')
          .select(['role', 'status'])
          .where('id', '=', invitation.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ role: 'admin', status: 'pending' })
      expect(
        await db
          .selectFrom('auth.member')
          .select('id')
          .where('organizationId', '=', f.teamId)
          .where('userId', '=', recipient.id)
          .executeTakeFirst(),
      ).toBeUndefined()
    } finally {
      hooks.beforeAcceptInvitation = original as (input: HookInput) => unknown
    }
  })

  it('rechecks an owner target changed after the role before hook', async () => {
    const f = await fixture()
    const original = hooks.beforeUpdateMemberRole
    hooks.beforeUpdateMemberRole = async (input) => {
      const result = await original?.(input)
      if (input.member?.id === f.targetMemberId) {
        await db
          .updateTable('auth.member')
          .set({ role: 'member,owner' })
          .where('id', '=', f.targetMemberId)
          .execute()
      }
      return result
    }
    try {
      await refused(
        await post(f, 'update-member-role', {
          organizationId: f.teamId,
          memberId: f.targetMemberId,
          role: 'admin',
        }),
      )
      expect(
        await db
          .selectFrom('auth.member')
          .select('role')
          .where('id', '=', f.targetMemberId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ role: 'member,owner' })
      expect(await operations(f)).toEqual([])
    } finally {
      hooks.beforeUpdateMemberRole = original as (input: HookInput) => unknown
    }
  })

  it('rereads a target promoted to owner while its persistence lock is waiting', async () => {
    const f = await fixture()
    const holder = await owned.pool.connect()
    let pending: Promise<Response> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('UPDATE auth.member SET role = $1 WHERE id = $2', [
        'member,owner',
        f.targetMemberId,
      ])
      pending = Promise.resolve(
        post(f, 'update-member-role', {
          organizationId: f.teamId,
          memberId: f.targetMemberId,
          role: 'member',
        }),
      )
      await vi.waitFor(
        async () => {
          const result = await owned.pool.query<{ blocked: boolean }>(`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
            AND wait_event_type = 'Lock' AND query LIKE '%auth%member%'
          ) AS blocked`)
          expect(result.rows[0]?.blocked).toBe(true)
        },
        { interval: 10, timeout: 1_500 },
      )
      await holder.query('COMMIT')
      await refused(await pending)
      expect(
        await db
          .selectFrom('auth.member')
          .select('role')
          .where('id', '=', f.targetMemberId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ role: 'member,owner' })
      expect(await operations(f)).toEqual([])
    } finally {
      await holder.query('ROLLBACK')
      holder.release()
      await pending
    }
  })

  it('refuses an elevated member role returned by a native before hook', async () => {
    const f = await fixture()
    const hook = 'beforeUpdateMemberRole'
    const original = hooks[hook]
    const before = await snapshot(f)
    hooks[hook] = async (input) => {
      const result = await original?.(input)
      return input.member?.id === f.targetMemberId ? { data: { role: 'owner' } } : result
    }
    try {
      await refused(
        await post(f, 'update-member-role', {
          organizationId: f.teamId,
          memberId: f.targetMemberId,
          role: 'admin',
        }),
      )
      expect(await snapshot(f)).toEqual(before)
    } finally {
      hooks[hook] = original as (input: HookInput) => unknown
    }
  })

  it('binds admission to its validated actor, team and member role independently of native create hooks', async () => {
    const f = await fixture('admin')
    const other = await fixture()
    const email = `${randomUUID()}@example.com`
    const original = hooks.beforeCreateInvitation
    let called = false
    hooks.beforeCreateInvitation = async () => {
      called = true
      return { data: { organizationId: other.teamId, inviterId: other.actor.id, role: 'owner' } }
    }
    try {
      const response = await post(f, 'invite-member', { organizationId: f.teamId, email })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        organizationId: f.teamId,
        inviterId: f.actor.id,
        email,
        role: 'member',
      })
      expect(called).toBe(false)
      expect(
        await db
          .selectFrom('auth.invitation')
          .select('id')
          .where('organizationId', '=', other.teamId)
          .execute(),
      ).toEqual([])
    } finally {
      hooks.beforeCreateInvitation = original as (input: HookInput) => unknown
    }
  })

  it.each(['deleted', 'expired'])(
    'refuses a session %s after the role before hook and before persistence',
    async (sessionState) => {
      const f = await fixture()
      const original = hooks.beforeUpdateMemberRole
      const before = await snapshot(f)
      hooks.beforeUpdateMemberRole = async (input) => {
        const result = await original?.(input)
        if (input.member?.id === f.targetMemberId) {
          if (sessionState === 'deleted') {
            await db.deleteFrom('auth.session').where('id', '=', f.actor.sessionId).execute()
          } else {
            await db
              .updateTable('auth.session')
              .set({ expiresAt: new Date(Date.now() - 60_000) })
              .where('id', '=', f.actor.sessionId)
              .execute()
          }
        }
        return result
      }
      try {
        await refused(
          await post(f, 'update-member-role', {
            organizationId: f.teamId,
            memberId: f.targetMemberId,
            role: 'admin',
          }),
        )
        expect(await snapshot(f)).toEqual(before)
      } finally {
        hooks.beforeUpdateMemberRole = original as (input: HookInput) => unknown
      }
    },
  )
})
