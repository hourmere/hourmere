import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import type { checkTeamManagementAccess, Principal, TeamManagementError } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import {
  getSelfReadiness,
  getTeamReadiness,
  SelfReadinessPageSchema,
  TeamReadinessPageSchema,
} from '@hourmere/scheduling'
import { DomainError } from '@hourmere/scheduling/errors'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { createMiddleware } from 'hono/factory'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { errorResponses, json, serviceContext } from '../openapi.ts'
import type { teamManagementAccess } from '../team-management.ts'
import type { readinessRoutes } from './readiness.ts'
import { createTestApp, openApiDocument, productApp, type TestApp } from './test-app.ts'

const selfPath = '/api/v1/readiness/self'
const teamPath = (id: string) => `/api/v1/teams/${id}/readiness`
const denial = { error: 'team_management_access_denied' }

function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys)
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => [key, ...allKeys(child)])
}

function sourceCopy<T>(
  path: string,
  bindings: Record<string, unknown>,
  name: string,
  mutation?: [string, string],
): T {
  let source = readFileSync(path, 'utf8')
  if (mutation) {
    expect(source.includes(mutation[0]), 'mutation must match source').toBe(true)
    source = source.replace(...mutation)
  }
  const script = stripTypeScriptTypes(
    source.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\n/gm, ''),
  ).replace(/\bexport /g, '')
  return new Function(...Object.keys(bindings), `${script}; return ${name}`)(
    ...Object.values(bindings),
  ) as T
}

function readRouteCopy(mutation?: [string, string]) {
  const sharedAccess = sourceCopy<{
    checkTeamManagementAccess: typeof checkTeamManagementAccess
    TeamManagementError: typeof TeamManagementError
  }>(
    'packages/auth/src/team-management.ts',
    { sql },
    '({ checkTeamManagementAccess, TeamManagementError })',
    mutation,
  )
  const access = sourceCopy<typeof teamManagementAccess>(
    'apps/server/src/team-management.ts',
    { DomainError, createMiddleware, ...sharedAccess },
    'teamManagementAccess',
  )
  return sourceCopy<typeof readinessRoutes>(
    'apps/server/src/routes/readiness.ts',
    {
      createRoute,
      z,
      getSelfReadiness,
      getTeamReadiness,
      SelfReadinessPageSchema,
      TeamReadinessPageSchema,
      DomainError,
      createMiddleware,
      errorResponses,
      json,
      serviceContext,
      teamManagementAccess: access,
    },
    'readinessRoutes',
  )
}

describe('booking readiness OpenAPI', () => {
  it('documents both reads as web-session-only', async () => {
    const { paths } = await openApiDocument(productApp({} as Db))
    for (const path of [selfPath, '/api/v1/teams/{teamId}/readiness'])
      expect(paths[path]?.get?.security).toEqual([{ session: [] }])
  })
})

describe.skipIf(!process.env.DATABASE_URL)('booking readiness REST', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await createTestApp(process.env.DATABASE_URL as string)
  })
  afterAll(async () => {
    await t?.drop()
  })

  async function session(user: TestUser, principal: Principal = user.principal) {
    const row = await t.db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        activeOrganizationId: principal.organization.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { user: actor, organization } = principal
    return { kind: 'session', sessionId: row.id, user: actor, organization } as const
  }

  it('requires authentication and refuses API keys and OAuth before private reads', async () => {
    const user = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [{ user, role: 'owner' }])
    for (const path of [selfPath, teamPath(team.id)]) {
      expect((await t.anonymous.get(path)).status).toBe(401)
      const key = await t.as(team.as(user)).get(path)
      expect(key.status).toBe(403)
      expect(key.body).toEqual({
        error: path === selfPath ? 'readiness_access_denied' : denial.error,
      })
      const oauth: Principal = {
        ...team.as(user),
        kind: 'oauth',
        oauthConsentId: randomUUID(),
        clientId: 'synthetic-readiness-client',
        scopes: ['bookings:read'],
      }
      expect((await t.as(oauth).get(path)).status).toBe(403)
    }
  })

  it.each(['owner', 'admin'])('accepts the current team %s session', async (role) => {
    const user = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [{ user, role }])
    const response = await t.as(await session(user, team.as(user))).get(teamPath(team.id))
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ organizationId: team.id })
  })

  it('refuses cross-team reads with the same response as missing teams and ordinary members', async () => {
    const owner = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [{ user: owner, role: 'owner' }])
    const other = await createTestTeam(t.db, [{ user: owner, role: 'owner' }])
    const client = t.as(await session(owner, team.as(owner)))
    const crossTeam = await client.get(teamPath(other.id))
    const missing = await client.get(teamPath(randomUUID()))
    const member = await createTestUser(t.db)
    const memberTeam = await createTestTeam(t.db, [{ user: member, role: 'member' }])
    const ordinary = await t
      .as(await session(member, memberTeam.as(member)))
      .get(teamPath(memberTeam.id))
    expect(crossTeam).toEqual({ status: 403, body: denial })
    expect(missing).toEqual(crossTeam)
    expect(ordinary).toEqual(crossTeam)
  })

  it('detects cross-team guard removal in a source-copy route with a real assertion failure', async () => {
    const owner = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [{ user: owner, role: 'owner' }])
    const other = await createTestTeam(t.db, [{ user: owner, role: 'owner' }])
    const principal = await session(owner, team.as(owner))
    const verify = async (routes: typeof readinessRoutes) => {
      const app = productApp(t.db, new Map([['hm_source_copy_readiness', principal]]), [
        routes({ db: t.db }),
      ])
      const response = await app.request(teamPath(other.id), {
        headers: { authorization: 'Bearer hm_source_copy_readiness' },
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denial)
    }
    await verify(readRouteCopy())
    const mutated = readRouteCopy([
      '    !uuid(teamId) ||\n    teamId.toLowerCase() !== principal.organization.id.toLowerCase()',
      '    !uuid(teamId)',
    ])
    await expect(verify(mutated)).rejects.toMatchObject({
      name: 'AssertionError',
      actual: 200,
      expected: 403,
    })
    // The repository source was only read; rerun the original to prove it remains intact.
    await verify(readRouteCopy())
  })

  it('rechecks demotion and removal despite a previously resolved owner session', async () => {
    const user = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [{ user, role: 'owner' }])
    const client = t.as(await session(user, team.as(user)))
    expect((await client.get(teamPath(team.id))).status).toBe(200)
    await t.db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', team.id)
      .where('userId', '=', user.id)
      .execute()
    expect(await client.get(teamPath(team.id))).toEqual({ status: 403, body: denial })
    await t.db
      .deleteFrom('auth.member')
      .where('organizationId', '=', team.id)
      .where('userId', '=', user.id)
      .execute()
    expect(await client.get(teamPath(team.id))).toEqual({ status: 403, body: denial })
    expect(await client.get(selfPath)).toEqual({
      status: 403,
      body: { error: 'readiness_access_denied' },
    })
  })

  it.each(['deleted', 'expired', 'unverified'] as const)(
    'rechecks a %s cached session for both projections',
    async (change) => {
      const user = await createTestUser(t.db)
      const team = await createTestTeam(t.db, [{ user, role: 'owner' }])
      const principal = await session(user, team.as(user))
      const client = t.as(principal)
      if (change === 'deleted')
        await t.db.deleteFrom('auth.session').where('id', '=', principal.sessionId).execute()
      else if (change === 'expired')
        await t.db
          .updateTable('auth.session')
          .set({ expiresAt: new Date(Date.now() - 60_000) })
          .where('id', '=', principal.sessionId)
          .execute()
      else
        await t.db
          .updateTable('auth.user')
          .set({ emailVerified: false })
          .where('id', '=', user.id)
          .execute()
      for (const path of [selfPath, teamPath(team.id)])
        expect((await client.get(path)).status).toBe(403)
    },
  )

  it('returns only self detail and personal events, then only self member detail in a team', async () => {
    const user = await createTestUser(t.db)
    const other = await createTestUser(t.db)
    const fx = createFixtures(t.db)
    await fx.schedule(user.id)
    const ownEvent = await fx.eventType(user.principal.organization.id, user.id)
    const privateEvent = await fx.eventType(other.principal.organization.id, other.id)
    const team = await createTestTeam(t.db, [
      { user, role: 'member' },
      { user: other, role: 'owner' },
    ])
    const teamEvent = await fx.eventType(team.id, null, { hosts: [{ userId: other.id }] })
    const personal = await t.as(await session(user)).get(selfPath)
    expect(personal.status).toBe(200)
    const serialized = JSON.stringify(personal.body)
    expect(serialized).toContain(ownEvent)
    expect(serialized).not.toContain(privateEvent)
    expect(serialized).not.toContain(teamEvent)
    const member = await t.as(await session(user, team.as(user))).get(selfPath)
    expect(member.status).toBe(200)
    expect(member.body).toMatchObject({ eventTypes: { data: [], nextCursor: null } })
    expect(JSON.stringify(member.body)).not.toContain(other.id)
  })

  it('does not expose a departed host through current team member summaries', async () => {
    const owner = await createTestUser(t.db)
    const removed = await createTestUser(t.db, 'departed-member-name-canary')
    const team = await createTestTeam(t.db, [
      { user: owner, role: 'owner' },
      { user: removed, role: 'member' },
    ])
    const eventId = await createFixtures(t.db).eventType(team.id, null, {
      hosts: [{ userId: removed.id }],
    })
    await t.db
      .deleteFrom('auth.member')
      .where('organizationId', '=', team.id)
      .where('userId', '=', removed.id)
      .execute()
    const response = await t.as(await session(owner, team.as(owner))).get(teamPath(team.id))
    expect(response.status).toBe(200)
    const body = JSON.stringify(response.body)
    expect(body).toContain(eventId)
    expect(body).toContain('host_configuration_required')
    expect(body.includes(removed.id)).toBe(false)
    expect(body.includes(removed.name)).toBe(false)
  })

  it('keeps private field and content canaries out of the team projection', async () => {
    const user = await createTestUser(t.db)
    const other = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [
      { user, role: 'owner' },
      { user: other, role: 'member' },
    ])
    const fx = createFixtures(t.db)
    const scheduleId = await fx.schedule(other.id)
    await t.db
      .updateTable('schedules')
      .set({ name: 'private-schedule-canary' })
      .where('id', '=', scheduleId)
      .execute()
    const eventId = await fx.eventType(team.id, null, {
      hosts: [{ userId: other.id }],
      title: 'private-title-canary',
      description: 'private-description-canary',
    })
    const connection = await t.db
      .insertInto('calendar_connections')
      .values({
        user_id: other.id,
        provider: 'google',
        external_account_id: 'private-external-account-canary',
        account_email: 'private-calendar-account-canary@example.com',
        credentials: Buffer.from('private-credential-canary'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const calendar = await t.db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: 'private-external-calendar-canary',
        name: 'private-calendar-name-canary',
        check_conflicts: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await t.db
      .insertInto('calendar_busy')
      .values({
        calendar_id: calendar.id,
        external_event_id: 'private-busy-event-canary',
        period: '[2026-11-03T12:34:56Z,2026-11-03T13:34:56Z)',
      })
      .execute()
    const response = await t.as(await session(user, team.as(user))).get(teamPath(team.id))
    expect(response.status).toBe(200)
    const body = JSON.stringify(response.body)
    expect(body).toContain(eventId)
    expect(body).toContain('calendar_attention_required')
    for (const value of [
      scheduleId,
      connection.id,
      calendar.id,
      other.email,
      'private-',
      '2026-11-03T12:34:56',
    ])
      expect(body.includes(value)).toBe(false)
    const forbiddenKeys = new Set([
      'signals',
      'details',
      'provider',
      'accountEmail',
      'calendarId',
      'calendarName',
      'lastSyncedAt',
      'syncError',
      'weeklyHours',
      'timeZone',
      'scheduleId',
      'title',
      'description',
      'busy',
    ])
    expect(allKeys(response.body).filter((key) => forbiddenKeys.has(key))).toEqual([])
  })

  it('validates bounded pagination and refuses audience, user and organization overrides', async () => {
    const user = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [{ user, role: 'owner' }])
    const client = t.as(await session(user, team.as(user)))
    for (const query of [
      '?limit=0',
      '?limit=101',
      '?limit=1.5',
      '?limit=invalid',
      '?eventTypeCursor=invalid',
      '?memberCursor=invalid',
      '?audience=self_detail',
      `?userId=${user.id}`,
      `?organizationId=${team.id}`,
    ]) {
      expect((await client.get(`${teamPath(team.id)}${query}`)).status).toBe(400)
      expect((await client.get(`${selfPath}${query}`)).status).toBe(400)
    }
    expect((await client.get(`${selfPath}?memberCursor=${randomUUID()}`)).status).toBe(400)
  })
})
