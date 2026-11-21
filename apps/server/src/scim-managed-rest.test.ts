import { randomBytes } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { updateDisplayName } from '@hourmere/scheduling'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { memberLeaveRoutes } from './routes/member-leave.ts'
import { memberRemovalRoutes } from './routes/member-removal.ts'
import { profileRoutes } from './routes/profile.ts'
import { teamInvitationRoutes } from './routes/team-invitations.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const secret = randomBytes(32).toString('base64url')
const signup = { mode: 'open', allowedDomains: [] } as const

describe.skipIf(!databaseUrl)('SCIM-managed memberships on existing REST routes', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'scim_rest_guards' })
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
    const auth = createAuth({
      db,
      pool: authPool,
      baseURL: publicUrl,
      secret,
      signup,
      mailer: { send: async () => expect.unreachable('No mail should be sent by these routes') },
    })
    app = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      ssoTeamReads: { db, capabilities: { ssoOidcEnabled: false, ssoSamlEnabled: false } },
      routes: [
        profileRoutes({ db }),
        memberLeaveRoutes({ db }),
        memberRemovalRoutes({ db }),
        teamInvitationRoutes({ db, invitationMailLimits: { secret } }),
      ],
    })
  })

  afterAll(async () => {
    try {
      await authPool?.end()
    } finally {
      await owned?.drop()
    }
  })

  async function browser(userId: string, organizationId: string) {
    const session = await db.transaction().execute((trx) =>
      createBrowserSession(
        trx,
        { publicUrl, secret },
        {
          userId,
          organizationId,
          now: Temporal.Now.instant().toString(),
          headers: new Headers(),
        },
      ),
    )
    const cookie = session.cookie.split(';')[0] as string
    return (method: string, path: string, body: object) =>
      app.request(`${publicUrl}${path}`, {
        method,
        headers: {
          cookie,
          origin: publicUrl,
          'content-type': 'application/json',
          'x-expected-organization-id': organizationId,
        },
        body: JSON.stringify(body),
      })
  }

  async function fixture() {
    const owner = await createTestUser(db, 'Team owner')
    const member = await createTestUser(db, 'Original account name')
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const memberRow = await db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', team.id)
      .where('userId', '=', member.id)
      .executeTakeFirstOrThrow()
    const manage = await browser(owner.id, team.id)
    const self = await browser(member.id, team.id)
    const personalId = member.principal.organization.id
    return {
      owner,
      member,
      team,
      memberId: memberRow.id,
      personalId,
      name: (name: string) => self('PATCH', '/api/v1/profile/name', { name }),
      remove: () =>
        manage('POST', `/api/v1/team/members/${member.id}/removal`, { teamId: team.id }),
      leave: () => self('POST', `/api/v1/teams/${team.id}/leave`, {}),
      cancel: (invitationId: string) =>
        manage('POST', `/api/v1/team/invitations/${invitationId}/cancel`, {}),
    }
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>

  async function managedEntry(f: Fixture, linked = true) {
    const connection = await db
      .insertInto('scim_connections')
      .values({ organization_id: f.team.id })
      .returning('id')
      .executeTakeFirstOrThrow()
    return db
      .insertInto('scim_users')
      .values({
        organization_id: f.team.id,
        connection_id: connection.id,
        user_name: f.member.email,
        display_name: 'Directory-controlled name',
        ...(linked && { linked_user_id: f.member.id, linked_member_id: f.memberId }),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function invitation(f: Fixture) {
    return db
      .insertInto('auth.invitation')
      .values({
        organizationId: f.team.id,
        inviterId: f.owner.id,
        email: f.member.email,
        role: 'member',
        status: 'pending',
        createdAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async function counted(request: () => Response | Promise<Response>, count: number) {
    const queries = vi.spyOn(pg.Client.prototype, 'query')
    try {
      const response = await request()
      expect(queries).toHaveBeenCalledTimes(count)
      return { status: response.status, body: await response.json() }
    } finally {
      queries.mockRestore()
    }
  }

  const cancelled = (row: Awaited<ReturnType<typeof invitation>>) => ({
    id: row.id,
    email: row.email,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status: 'canceled',
    invalidReason: null,
    delivery: { state: 'unknown', attempts: null, lastAttemptAt: null, lastErrorCode: null },
    resendAllowed: false,
    generation: 1,
    resendDeniedReason: 'INVITATION_INELIGIBLE',
    resendRetryAfterSeconds: null,
  })

  // Counts measured with the same fixtures and app composition on main.
  it('preserves the ordinary team display-name update response and statement count', async () => {
    const f = await fixture()
    expect(await counted(() => f.name(' Ordinary name '), 4)).toEqual({
      status: 200,
      body: { name: 'Ordinary name' },
    })
  })

  it('preserves the ordinary team leave response and statement count', async () => {
    const f = await fixture()
    expect(await counted(f.leave, 25)).toEqual({
      status: 200,
      body: { organizationId: f.personalId },
    })
  })

  it('preserves the ordinary member removal response and statement count', async () => {
    const f = await fixture()
    expect(await counted(f.remove, 36)).toEqual({
      status: 200,
      body: {
        operationId: expect.stringMatching(/^[\da-f-]{36}$/),
        memberUserId: f.member.id,
        deactivatedEventTypeIds: [],
      },
    })
  })

  it('preserves the ordinary invitation cancellation and replay responses and statement counts', async () => {
    const f = await fixture()
    const row = await invitation(f)
    const cancel = () => f.cancel(row.id)
    expect(await counted(cancel, 30)).toEqual({ status: 200, body: cancelled(row) })
    expect(await counted(cancel, 28)).toEqual({ status: 200, body: cancelled(row) })
  })

  it('refuses managed display-name changes in REST and the shared service', async () => {
    const f = await fixture()
    const entry = await managedEntry(f)
    const response = await f.name('Manual name')
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'scim_managed_resource',
      message: 'This resource is managed by your identity provider.',
    })
    await expect(
      updateDisplayName(
        { db, principal: f.team.as(f.member), now: Temporal.Now.instant },
        'API key name',
      ),
    ).rejects.toMatchObject({ kind: 'conflict', code: 'scim_managed_resource' })
    const currentName = () =>
      db
        .selectFrom('auth.user')
        .select('name')
        .where('id', '=', f.member.id)
        .executeTakeFirstOrThrow()
    expect(await currentName()).toEqual({ name: f.member.name })

    const personal = await browser(f.member.id, f.personalId)
    const personalResponse = await personal('PATCH', '/api/v1/profile/name', {
      name: 'Personal name',
    })
    expect(personalResponse.status).toBe(200)
    expect(await personalResponse.json()).toEqual({ name: 'Personal name' })
    expect(await currentName()).toEqual({ name: 'Personal name' })
    expect(
      await db
        .selectFrom('scim_users')
        .selectAll()
        .where('id', '=', entry.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(entry)
  })

  it.each(['leave', 'remove'] as const)(
    'retains a local decision when a managed member uses %s',
    async (operation) => {
      const f = await fixture()
      const entry = await managedEntry(f)
      expect((await f[operation]()).status).toBe(200)
      expect(
        await db
          .selectFrom('auth.member')
          .select('id')
          .where('id', '=', f.memberId)
          .executeTakeFirst(),
      ).toBeUndefined()
      expect(
        await db
          .selectFrom('scim_users')
          .selectAll()
          .where('id', '=', entry.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ ...entry, linked_member_id: null })
      expect(
        await db
          .selectFrom('scim_membership_blocks')
          .select(['user_id', 'identity_email', 'source', 'kind', 'cleared_at'])
          .where('organization_id', '=', f.team.id)
          .orderBy('user_id', 'asc')
          .execute(),
      ).toEqual([
        {
          user_id: f.member.id,
          identity_email: null,
          source: 'local',
          kind: 'removal',
          cleared_at: null,
        },
        {
          user_id: null,
          identity_email: f.member.email,
          source: 'local',
          kind: 'removal',
          cleared_at: null,
        },
      ])
    },
  )

  it('allows an administrator to cancel a claim-bound invitation without touching directory data', async () => {
    const f = await fixture()
    const entry = await managedEntry(f, false)
    const row = await invitation(f)
    const claim = await db
      .insertInto('scim_user_claims')
      .values({
        organization_id: f.team.id,
        connection_id: entry.connection_id,
        scim_user_id: entry.id,
        invitation_id: row.id,
        work_email: row.email,
        expires_at: row.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    const response = await f.cancel(row.id)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(cancelled(row))
    expect(
      await db
        .selectFrom('scim_user_claims')
        .selectAll()
        .where('id', '=', claim.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(claim)
    expect(
      await db
        .selectFrom('scim_users')
        .selectAll()
        .where('id', '=', entry.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(entry)
  })
})
