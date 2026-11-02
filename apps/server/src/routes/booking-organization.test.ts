import type { Principal } from '@hourmere/auth'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('booking space resolution', () => {
  let test: TestApp
  let bookingId: string
  let personalBookingId: string
  let teamId: string
  let host: TestUser
  let owner: TestUser
  let admin: TestUser
  let member: TestUser
  let otherMember: TestUser
  let outsider: TestUser

  beforeAll(async () => {
    test = await createTestApp(serverUrl as string)
    ;[host, owner, admin, member, otherMember, outsider] = (await Promise.all(
      ['Host', 'Owner', 'Admin', 'Member', 'Other member', 'Outsider'].map((name) =>
        createTestUser(test.db, name),
      ),
    )) as [TestUser, TestUser, TestUser, TestUser, TestUser, TestUser]
    const team = await createTestTeam(test.db, [
      { user: host, role: 'member' },
      { user: owner, role: 'owner' },
      { user: admin, role: 'member, admin' },
      { user: member, role: 'member' },
    ])
    teamId = team.id
    await createTestTeam(test.db, [{ user: otherMember, role: 'owner' }])
    const f = createFixtures(test.db)
    bookingId = await f.booking(teamId, [host.id], '2026-12-01T09:00Z', '2026-12-01T09:30Z')
    personalBookingId = await f.booking(
      host.principal.organization.id,
      [host.id],
      '2026-12-02T09:00Z',
      '2026-12-02T09:30Z',
    )
  })
  afterAll(async () => {
    await test?.drop()
  })

  async function session(
    user: TestUser,
    organizationId = user.principal.organization.id,
    expired = false,
  ): Promise<Principal & { kind: 'session' }> {
    const row = await test.db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token: crypto.randomUUID(),
        activeOrganizationId: organizationId,
        expiresAt: expired
          ? sql<Date>`clock_timestamp() - interval '1 minute'`
          : sql<Date>`clock_timestamp() + interval '1 hour'`,
        updatedAt: sql<Date>`clock_timestamp()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return {
      kind: 'session',
      sessionId: row.id,
      user: user.principal.user,
      organization: { ...user.principal.organization, id: organizationId },
    }
  }

  it.each(['host', 'owner', 'admin'] as const)(
    'resolves a current %s without changing the session space',
    async (role) => {
      const actor = await session({ host, owner, admin }[role])
      expect(await test.as(actor).get(`/api/v1/bookings/${bookingId}/organization`)).toEqual({
        status: 200,
        body: { organizationId: teamId, access: role === 'host' ? 'host' : 'team_admin' },
      })
      expect(
        (
          await test.db
            .selectFrom('auth.session')
            .select('activeOrganizationId')
            .where('id', '=', actor.sessionId)
            .executeTakeFirstOrThrow()
        ).activeOrganizationId,
      ).toBe(actor.organization.id)
    },
  )

  it.each(['member', 'otherMember', 'outsider'] as const)(
    'returns uniform not-found for %s and leaves the space unchanged',
    async (role) => {
      const actor = await session({ member, otherMember, outsider }[role])
      const client = test.as(actor)
      const refused = await client.get(`/api/v1/bookings/${bookingId}/organization`)
      expect(refused).toEqual(
        await client.get(`/api/v1/bookings/${crypto.randomUUID()}/organization`),
      )
      expect(refused).toEqual({
        status: 404,
        body: { error: 'booking_not_found', message: 'Booking not found' },
      })
      expect(
        (
          await test.db
            .selectFrom('auth.session')
            .select('activeOrganizationId')
            .where('id', '=', actor.sessionId)
            .executeTakeFirstOrThrow()
        ).activeOrganizationId,
      ).toBe(actor.organization.id)
    },
  )

  it('resolves the caller’s personal booking while in a team', async () => {
    const actor = await session(host, teamId)
    expect(await test.as(actor).get(`/api/v1/bookings/${personalBookingId}/organization`)).toEqual({
      status: 200,
      body: { organizationId: host.principal.organization.id, access: 'host' },
    })
  })

  it('denies scoped credentials, expired sessions and revoked target membership', async () => {
    const path = `/api/v1/bookings/${bookingId}/organization`
    const key = await test.as(host.principal).get(path)
    expect(key.status).toBe(404)
    const oauth: Principal = {
      kind: 'oauth',
      oauthConsentId: crypto.randomUUID(),
      clientId: 'fixture',
      scopes: ['mcp:tools'],
      user: host.principal.user,
      organization: host.principal.organization,
    }
    expect(await test.as(oauth).get(path)).toEqual(key)
    expect(await test.as(await session(host, undefined, true)).get(path)).toEqual(key)
    const actor = await session(host)
    await test.db
      .deleteFrom('auth.member')
      .where('userId', '=', host.id)
      .where('organizationId', '=', teamId)
      .execute()
    try {
      expect(await test.as(actor).get(path)).toEqual(key)
    } finally {
      await createFixtures(test.db).member(host.id, teamId)
    }
  })
})
