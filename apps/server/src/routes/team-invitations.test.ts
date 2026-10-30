import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import {
  type Auth,
  createAuth,
  createAuthPool,
  createCallerResolver,
  createMcpOAuthResolver,
  invitationRecipientIsMember,
  invitationResendDenial,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  type InvitationMailLimits,
  invitationEmailBudgetAvailable,
  reserveInvitationEmailBudget,
} from '@hourmere/notifications'
import { DomainError } from '@hourmere/scheduling'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { createMiddleware } from 'hono/factory'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { ErrorBody, json, type RouteModule } from '../openapi.ts'
import { productRoutes } from '../server.ts'
import { teamInvitationRoutes } from './team-invitations.ts'
import { openApiDocument, resolve, responseAndRequestStrictness } from './test-app.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:4391'
const secret = 'synthetic-team-invitation-summary-secret-0000000000'
const path = '/api/v1/team/invitations'
const denied = { error: 'team_management_access_denied' }
const generous: InvitationMailLimits = {
  invitationInviterMaxPerHour: 100,
  invitationInviterMaxPerDay: 200,
  invitationTeamMaxPerHour: 100,
  invitationTeamMaxPerDay: 200,
  mailRecipientMaxPerHour: 100,
  mailRecipientMaxPerDay: 200,
  mailMaxPerHour: 1_000,
}
const { signJWT } = createRequire(import.meta.resolve('@hourmere/auth'))('better-auth/plugins/jwt')

type InvitationStatus = 'pending' | 'accepted' | 'canceled' | 'rejected' | 'expired' | 'unknown'
type DeliveryState = 'queued' | 'sending' | 'smtp_accepted' | 'failed' | 'skipped'
interface Summary {
  id: string
  status: InvitationStatus
  createdAt: string
  expiresAt: string
  delivery: {
    state: DeliveryState | 'unknown'
    attempts: number | null
    lastAttemptAt: string | null
    lastErrorCode: string | null
  }
  resendAllowed: boolean
}
interface Page {
  data: Summary[]
  nextCursor: string | null
}

// Evaluate copies against the same runtime bindings as the real HTTP application.
function sourceCopy<T>(source: string, bindings: Record<string, unknown>, returned: string): T {
  const javascript = stripTypeScriptTypes(
    source.replace(/^import[\s\S]*?from '[^']+'\n/gm, ''),
  ).replace(/\bexport /g, '')
  return new Function(...Object.keys(bindings), `${javascript}; return ${returned}`)(
    ...Object.values(bindings),
  ) as T
}

describe.skipIf(!serverUrl)(
  'team invitation delivery summaries over real HTTP and PostgreSQL',
  () => {
    let owned: TestDatabase
    let db: Db
    let authPool: ReturnType<typeof createAuthPool>
    let auth: Auth
    let resolveCaller: ReturnType<typeof createCallerResolver>
    let limits: InvitationMailLimits
    let app: ReturnType<typeof createApp>
    let seeded: Awaited<ReturnType<typeof fixture>>

    beforeAll(async () => {
      owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'invite_summary' })
      db = createDb(owned.pool)
      const signup = { mode: 'open', allowedDomains: [] } as const
      // One shared auth pool, plus the helper pool, bounds this file far below 100 connections.
      authPool = createAuthPool(owned.url, signup)
      auth = createAuth({
        pool: authPool,
        db,
        baseURL: origin,
        secret,
        signup,
        mailer: { send: async () => {} },
        mcpOAuth: true,
        reserveInvitationEmail: (trx, input, now) =>
          reserveInvitationEmailBudget(trx, input, { ...limits, secret }, now),
      })
      resolveCaller = createCallerResolver({ auth, db })
    })
    beforeEach(async () => {
      await db.deleteFrom('auth.organization').execute()
      await db.deleteFrom('auth.user').execute()
      await db.deleteFrom('invitation_email_requests').execute()
      limits = { ...generous }
      seeded = await fixture()
      app = application()
    })
    afterEach(() => vi.useRealTimers())
    afterAll(async () => {
      try {
        await authPool?.end()
      } finally {
        await owned?.drop()
      }
    })

    function application(
      routes: RouteModule[] = [
        teamInvitationRoutes({ db, invitationMailLimits: { ...limits, secret } }),
      ],
      onResolve?: () => void,
    ) {
      return createApp({
        publicUrl: origin,
        checkDb: async () => {},
        authHandler: auth.handler,
        resolveCaller: (headers) => {
          onResolve?.()
          return resolveCaller(headers)
        },
        routes,
      })
    }

    async function session(user: TestUser, organizationId: string) {
      const token = randomBytes(24).toString('base64url')
      const row = await db
        .insertInto('auth.session')
        .values({
          userId: user.id,
          token,
          activeOrganizationId: organizationId,
          expiresAt: new Date(Date.now() + 3_600_000),
          updatedAt: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const signature = createHmac('sha256', secret).update(token).digest('base64')
      return {
        sessionId: row.id,
        cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
      }
    }

    async function fixture() {
      const owner = await createTestUser(db, 'Invitation owner')
      const admin = await createTestUser(db, 'Invitation admin')
      const member = await createTestUser(db, 'Invitation member')
      const team = await createTestTeam(db, [
        { user: owner, role: 'owner' },
        { user: admin, role: 'admin' },
        { user: member, role: 'member' },
      ])
      const other = await createTestTeam(db, [{ user: owner, role: 'owner' }])
      return {
        owner,
        admin,
        member,
        team,
        other,
        ownerSession: await session(owner, team.id),
        adminSession: await session(admin, team.id),
        memberSession: await session(member, team.id),
      }
    }

    async function invitation(
      options: {
        organizationId?: string
        status?: string
        state?: DeliveryState | 'unknown'
        attempts?: number
        lastErrorCode?: string | null
        expired?: boolean
        recentGeneration?: boolean
        recentAttempt?: boolean
        generation?: number
        id?: string
        role?: string
      } = {},
    ) {
      const clock = await db
        .selectNoFrom(sql<Date>`clock_timestamp()`.as('now'))
        .executeTakeFirstOrThrow()
      const now = clock.now
      const aged = new Date(now.getTime() - 120_000)
      const row = await db
        .insertInto('auth.invitation')
        .values({
          id: options.id ?? randomUUID(),
          organizationId: options.organizationId ?? seeded.team.id,
          inviterId: seeded.owner.id,
          email: `${randomUUID()}@private-summary.example`,
          role: options.role ?? 'member',
          status: options.status ?? 'pending',
          createdAt: aged,
          expiresAt: new Date(now.getTime() + (options.expired ? -3_600_000 : 3_600_000)),
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      const state = options.state ?? 'queued'
      const attempts =
        options.attempts ?? (state === 'sending' || state === 'smtp_accepted' ? 1 : 0)
      if (state !== 'unknown') {
        await db
          .insertInto('invitation_deliveries')
          .values({
            invitation_id: row.id,
            state,
            attempts,
            generation: options.generation ?? 1,
            generation_started_at: options.recentGeneration ? now : aged,
            updated_at: options.recentAttempt ? now : aged,
            expiry_duration_ms: 48 * 3_600_000,
            lease_id: state === 'sending' ? randomUUID() : null,
            lease_until: state === 'sending' ? new Date(now.getTime() + 120_000) : null,
            smtp_accepted_at: state === 'smtp_accepted' ? aged : null,
            last_error_code:
              options.lastErrorCode ??
              (state === 'failed'
                ? 'smtp_permanent'
                : state === 'skipped'
                  ? 'invitation_ineligible'
                  : null),
            resend_request_id: randomUUID(),
            last_job_id: randomUUID(),
          })
          .execute()
      }
      return {
        ...row,
        state,
        attempts,
      }
    }

    function get(cookie?: string, query = '', headers: Record<string, string> = {}, target = app) {
      return target.request(`${path}${query}`, {
        headers: { ...(cookie && { cookie }), ...headers },
      })
    }

    async function page(response: Response): Promise<Page> {
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const result = (await response.json()) as Page
      expect(Object.keys(result).sort()).toEqual(['data', 'nextCursor'])
      for (const row of result.data) {
        expect(Object.keys(row).sort()).toEqual([
          'createdAt',
          'delivery',
          'expiresAt',
          'id',
          'resendAllowed',
          'status',
        ])
        expect(Object.keys(row.delivery).sort()).toEqual([
          'attempts',
          'lastAttemptAt',
          'lastErrorCode',
          'state',
        ])
      }
      return result
    }

    async function expectDenied(response: Response) {
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(denied)
      expect(response.headers.has('www-authenticate')).toBe(false)
    }

    async function resend(
      row: Awaited<ReturnType<typeof invitation>>,
      cookie = seeded.ownerSession.cookie,
    ) {
      return app.request('/api/auth/organization/invite-member', {
        method: 'POST',
        headers: {
          origin,
          cookie,
          'content-type': 'application/json',
          'x-expected-organization-id': seeded.team.id,
        },
        body: JSON.stringify({
          organizationId: seeded.team.id,
          email: row.email,
          invitationId: row.id,
          resend: true,
          expectedGeneration: 1,
          requestId: randomUUID(),
        }),
      })
    }

    async function verifyRoles(target = app) {
      await invitation()
      for (const cookie of [seeded.ownerSession.cookie, seeded.adminSession.cookie]) {
        const result = await page(await get(cookie, '', {}, target))
        expect(result.data).toHaveLength(1)
      }
      await expectDenied(await get(seeded.memberSession.cookie, '', {}, target))
    }

    it('lets current verified owners and admins read summaries and uniformly denies members', () =>
      verifyRoles())

    it('uniformly denies missing, invalid, personal and inaccessible current sessions', async () => {
      const outsider = await createTestUser(db, 'Unrelated user')
      const outsiderSession = await session(outsider, seeded.team.id)
      const personal = await session(seeded.owner, seeded.owner.principal.organization.id)
      for (const cookie of [
        undefined,
        'better-auth.session_token=invalid',
        outsiderSession.cookie,
        personal.cookie,
      ]) {
        for (const query of ['', '?limit=0']) await expectDenied(await get(cookie, query))
      }
    })

    it.each(['demoted', 'removed', 'unverified', 'expired'] as const)(
      'rechecks the current database role and session after the actor becomes %s',
      async (change) => {
        expect((await get(seeded.adminSession.cookie)).status).toBe(200)
        if (change === 'demoted')
          await db
            .updateTable('auth.member')
            .set({ role: 'member' })
            .where('userId', '=', seeded.admin.id)
            .where('organizationId', '=', seeded.team.id)
            .execute()
        if (change === 'removed')
          await db
            .deleteFrom('auth.member')
            .where('userId', '=', seeded.admin.id)
            .where('organizationId', '=', seeded.team.id)
            .execute()
        if (change === 'unverified')
          await db
            .updateTable('auth.user')
            .set({ emailVerified: false })
            .where('id', '=', seeded.admin.id)
            .execute()
        if (change === 'expired')
          await db
            .updateTable('auth.session')
            .set({ expiresAt: new Date(Date.now() - 60_000) })
            .where('id', '=', seeded.adminSession.sessionId)
            .execute()
        await expectDenied(await get(seeded.adminSession.cookie))
      },
    )

    it('rejects every Authorization header before resolving credentials, even with an owner cookie', async () => {
      const key = await auth.api.createApiKey({
        body: { userId: seeded.owner.id, metadata: { organizationId: seeded.team.id } },
      })
      let resolutions = 0
      const observed = application(undefined, () => resolutions++)
      for (const authorization of [
        '',
        'Basic invalid',
        'Bearer',
        'Bearer invalid',
        `Bearer ${key.key}`,
      ]) {
        for (const cookie of [undefined, seeded.ownerSession.cookie]) {
          await expectDenied(await get(cookie, '?limit=0', { authorization }, observed))
        }
      }
      expect(resolutions).toBe(0)
    })

    it('denies a genuine MCP OAuth grant before credential resolution, with and without an owner cookie', async () => {
      const clientId = 'https://invitation-boundary.example/client.json'
      await db
        .insertInto('auth.oauthClient')
        .values({
          clientId,
          redirectUris: JSON.stringify(['https://invitation-boundary.example/callback']),
        })
        .execute()
      const grant = await db
        .insertInto('mcp_oauth_grants')
        .values({ user_id: seeded.owner.id, organization_id: seeded.team.id, client_id: clientId })
        .returning('id')
        .executeTakeFirstOrThrow()
      await db
        .insertInto('auth.oauthConsent')
        .values({
          clientId,
          userId: seeded.owner.id,
          referenceId: grant.id,
          scopes: JSON.stringify(['mcp:tools']),
          resources: JSON.stringify([`${origin}/mcp`]),
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .execute()
      const token = await signJWT(
        { context: await auth.$context },
        {
          header: { typ: 'at+jwt' },
          payload: {
            sub: seeded.owner.id,
            client_id: clientId,
            scope: 'mcp:tools',
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 300,
            iss: `${origin}/api/auth`,
            aud: `${origin}/mcp`,
            'https://hourmere.com/organization': seeded.team.id,
            'https://hourmere.com/grant': grant.id,
          },
        },
      )
      const headers = { authorization: `Bearer ${token}` }
      const resolved = await createMcpOAuthResolver({ auth, db, publicUrl: origin })(
        new Request(`${origin}/mcp`, { headers }),
      )
      expect(resolved.ok).toBe(true)
      let resolutions = 0
      const observed = application(undefined, () => resolutions++)
      for (const cookie of [undefined, seeded.ownerSession.cookie])
        await expectDenied(await get(cookie, '', headers, observed))
      expect(resolutions).toBe(0)
    })

    async function verifyIsolation(target = app) {
      const own = await invitation()
      const other = await invitation({ organizationId: seeded.other.id })
      const result = await page(
        await get(seeded.ownerSession.cookie, `?organizationId=${seeded.other.id}`, {}, target),
      )
      expect(result.data.map((row) => row.id)).toEqual([own.id])
      const otherSession = await session(seeded.owner, seeded.other.id)
      const otherPage = await page(await get(otherSession.cookie, '', {}, target))
      expect(otherPage.data.map((row) => row.id)).toEqual([other.id])
    }

    it('scopes invitations to the current team, ignoring a client supplied organization', () =>
      verifyIsolation())

    it('preserves every invitation lifecycle and stored delivery state with an exact safe field set', async () => {
      const rows = await Promise.all([
        invitation(),
        invitation({ state: 'sending', attempts: 2 }),
        invitation({ state: 'smtp_accepted', attempts: 3 }),
        invitation({ state: 'failed', attempts: 4, lastErrorCode: 'attempts_exhausted' }),
        invitation({ state: 'skipped', status: 'canceled', expired: true }),
        invitation({ status: 'accepted', state: 'smtp_accepted', expired: true }),
        invitation({ status: 'rejected', state: 'skipped' }),
        invitation({ expired: true, state: 'failed', attempts: 1 }),
        invitation({ state: 'unknown' }),
      ])
      const result = await page(await get(seeded.ownerSession.cookie))
      expect(result.data).toHaveLength(rows.length)
      for (const stored of rows) {
        const summary = result.data.find((row) => row.id === stored.id)
        const delivery = await db
          .selectFrom('invitation_deliveries')
          .selectAll()
          .where('invitation_id', '=', stored.id)
          .executeTakeFirst()
        expect(summary).toMatchObject({
          id: stored.id,
          status:
            stored.expiresAt <= new Date() && stored.status === 'pending'
              ? 'expired'
              : stored.status,
          createdAt: stored.createdAt.toISOString(),
          expiresAt: stored.expiresAt.toISOString(),
          delivery: {
            state: delivery?.state ?? 'unknown',
            attempts: delivery?.attempts ?? null,
            lastAttemptAt: delivery?.last_attempt_at?.toISOString() ?? null,
            lastErrorCode: delivery?.last_error_code ?? null,
          },
        })
        if (summary?.status !== 'pending') expect(summary?.resendAllowed).toBe(false)
        expect(JSON.stringify(result)).not.toContain(stored.email)
        if (delivery?.resend_request_id)
          expect(JSON.stringify(result)).not.toContain(delivery.resend_request_id)
        if (delivery?.last_job_id)
          expect(JSON.stringify(result)).not.toContain(delivery.last_job_id)
        if (delivery?.lease_id) expect(JSON.stringify(result)).not.toContain(delivery.lease_id)
      }
    })

    async function verifyAttemptTimestamp(target = app) {
      const waiting = await invitation({ attempts: 0 })
      const attempted = await invitation({ state: 'failed', attempts: 2 })
      const stored = await db
        .selectFrom('invitation_deliveries')
        .select(['last_attempt_at', 'updated_at'])
        .where('invitation_id', '=', attempted.id)
        .executeTakeFirstOrThrow()
      expect(stored.last_attempt_at).toBeInstanceOf(Date)
      // Outcome/metadata edits must not manufacture a later attempt or reuse updated_at.
      await db
        .updateTable('invitation_deliveries')
        .set({ updated_at: new Date(stored.updated_at.getTime() + 3_600_000) })
        .where('invitation_id', '=', attempted.id)
        .execute()
      const result = await page(await get(seeded.ownerSession.cookie, '', {}, target))
      expect(result.data.find((row) => row.id === waiting.id)?.delivery.lastAttemptAt).toBeNull()
      expect(result.data.find((row) => row.id === attempted.id)?.delivery.lastAttemptAt).toBe(
        stored.last_attempt_at?.toISOString(),
      )
      expect(result.data.find((row) => row.id === attempted.id)?.delivery.lastAttemptAt).not.toBe(
        stored.updated_at.toISOString(),
      )
    }

    it('returns the stored database attempt time and leaves waiting deliveries without a fabricated attempt', () =>
      verifyAttemptTimestamp())

    async function verifyDatabaseExpiry(target = app) {
      const expired = await invitation({ expired: true })
      const pending = await invitation()
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2000-01-01T00:00:00Z'))
      try {
        const result = await page(await get(seeded.ownerSession.cookie, '', {}, target))
        expect(result.data.find((row) => row.id === expired.id)).toMatchObject({
          status: 'expired',
          resendAllowed: false,
        })
        expect(result.data.find((row) => row.id === pending.id)?.status).toBe('pending')
      } finally {
        vi.useRealTimers()
      }
    }

    it('derives expired from database wall time even when the application clock is years behind', () =>
      verifyDatabaseExpiry())

    it('matches real resend cooldowns for generation starts and worker updates without mutating stored rows', async () => {
      const waiting = await invitation({ recentGeneration: true })
      const attempted = await invitation({ state: 'failed', attempts: 1, recentAttempt: true })
      const ready = await invitation({ state: 'failed', attempts: 4 })
      const before = await db
        .selectFrom('invitation_deliveries')
        .selectAll()
        .orderBy('invitation_id')
        .execute()
      const result = await page(await get(seeded.ownerSession.cookie))
      expect(
        await db.selectFrom('invitation_deliveries').selectAll().orderBy('invitation_id').execute(),
      ).toEqual(before)
      expect(await db.selectFrom('invitation_email_requests').selectAll().execute()).toEqual([])
      for (const row of [waiting, attempted]) {
        expect(result.data.find((entry) => entry.id === row.id)?.resendAllowed).toBe(false)
        const response = await resend(row)
        expect(response.status).toBe(429)
        expect(await response.json()).toMatchObject({ code: 'INVITATION_RESEND_COOLDOWN' })
      }
      expect(result.data.find((entry) => entry.id === ready.id)?.resendAllowed).toBe(true)
      expect((await resend(ready)).status).toBe(200)
      const updated = await page(await get(seeded.ownerSession.cookie))
      expect(updated.data.find((entry) => entry.id === ready.id)).toMatchObject({
        resendAllowed: false,
        delivery: { state: 'queued', attempts: 0, lastAttemptAt: null, lastErrorCode: null },
      })
    })

    it('matches the real generation cap, live sending lease and unsupported historical role refusals', async () => {
      const capped = await invitation({ generation: 32 })
      const busy = await invitation({ state: 'sending' })
      const elevated = await invitation({ role: 'admin' })
      const result = await page(await get(seeded.ownerSession.cookie))
      for (const row of [capped, busy, elevated])
        expect(result.data.find((entry) => entry.id === row.id)?.resendAllowed).toBe(false)
      for (const [row, code, status] of [
        [capped, 'INVITATION_GENERATION_LIMIT', 409],
        [busy, 'INVITATION_DELIVERY_BUSY', 409],
        [elevated, 'TEAM_MANAGEMENT_ACCESS_DENIED', 403],
      ] as const) {
        const response =
          row === capped
            ? await app.request('/api/auth/organization/invite-member', {
                method: 'POST',
                headers: {
                  origin,
                  cookie: seeded.ownerSession.cookie,
                  'content-type': 'application/json',
                  'x-expected-organization-id': seeded.team.id,
                },
                body: JSON.stringify({
                  organizationId: seeded.team.id,
                  email: row.email,
                  invitationId: row.id,
                  resend: true,
                  expectedGeneration: 32,
                  requestId: randomUUID(),
                }),
              })
            : await resend(row)
        expect(response.status).toBe(status)
        expect(await response.json()).toMatchObject({ code })
      }
    })

    it('refuses to resend a retained invitation whose recipient already belongs to the team', async () => {
      const row = await invitation()
      await db
        .updateTable('auth.invitation')
        .set({ email: seeded.member.email })
        .where('id', '=', row.id)
        .execute()
      const summary = await page(await get(seeded.ownerSession.cookie))
      expect(summary.data.find((entry) => entry.id === row.id)?.resendAllowed).toBe(false)
      const response = await resend({ ...row, email: seeded.member.email })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: 'INVITATION_RECIPIENT_ALREADY_MEMBER' })
    })

    it('matches real request budget limits for the current reader without reserving capacity', async () => {
      const row = await invitation()
      limits.invitationInviterMaxPerHour = 1
      app = application()
      await db.transaction().execute(async (trx) => {
        expect(
          await reserveInvitationEmailBudget(
            trx,
            {
              userId: seeded.owner.id,
              organizationId: seeded.team.id,
              email: 'different@private-summary.example',
            },
            { ...limits, secret },
          ),
        ).toBe(true)
      })
      const ownerPage = await page(await get(seeded.ownerSession.cookie))
      expect(ownerPage.data.find((entry) => entry.id === row.id)?.resendAllowed).toBe(false)
      const adminPage = await page(await get(seeded.adminSession.cookie))
      expect(adminPage.data.find((entry) => entry.id === row.id)?.resendAllowed).toBe(true)
      expect(await db.selectFrom('invitation_email_requests').selectAll().execute()).toHaveLength(1)
      const refusal = await resend(row)
      expect(refusal.status).toBe(429)
      expect(await refusal.json()).toMatchObject({ code: 'INVITATION_RATE_LIMITED' })
      expect((await resend(row, seeded.adminSession.cookie)).status).toBe(200)
    })

    async function verifyUnknownStatuses(target = app) {
      const statuses = ['pending', 'archived', 'pending', 'retired', 'accepted']
      const ids = statuses.map(
        (_status, index) => `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      )
      const storedRows: Awaited<ReturnType<typeof invitation>>[] = []
      for (const [index, status] of statuses.entries())
        storedRows.push(
          await invitation({ id: ids[index] as string, status, expired: status === 'retired' }),
        )

      // The unknown row is inside a page with limit 3 and the cursor boundary with limit 2.
      for (const limit of [3, 2]) {
        const observed: Summary[] = []
        let cursor: string | null = null
        for (let index = 0; index < ids.length; index++) {
          const query = new URLSearchParams({ limit: String(limit) })
          if (cursor) query.set('cursor', cursor)
          const result = await page(await get(seeded.ownerSession.cookie, `?${query}`, {}, target))
          expect(result.data.length).toBeGreaterThan(0)
          observed.push(...result.data)
          cursor = result.nextCursor
          if (cursor === null) break
        }
        expect(cursor).toBeNull()
        expect(observed.map((row) => row.id)).toEqual(ids)
        expect(observed.map((row) => row.status)).toEqual([
          'pending',
          'unknown',
          'pending',
          'unknown',
          'accepted',
        ])
        expect(observed.filter((row) => row.status === 'pending')).toHaveLength(2)
        for (const row of observed.filter((row) => row.status === 'unknown'))
          expect(row.resendAllowed).toBe(false)
      }
      for (const row of storedRows.filter((row) => ['archived', 'retired'].includes(row.status))) {
        const response = await resend(row)
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'INVITATION_INELIGIBLE' })
      }
      expect(
        (await db.selectFrom('auth.invitation').select('status').orderBy('id').execute()).map(
          (row) => row.status,
        ),
      ).toEqual(statuses)
      expect(await db.selectFrom('invitation_email_requests').selectAll().execute()).toEqual([])
    }

    it('normalizes unknown stored statuses without blocking pages or treating them as pending', () =>
      verifyUnknownStatuses())

    it('uses stable invitation ID keysets, including ties and inserts before a page boundary', async () => {
      const ids = [1, 2, 3].map(
        (number) => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
      )
      for (const id of ids) await invitation({ id })
      const first = await page(await get(seeded.ownerSession.cookie, '?limit=1'))
      expect(first.data.map((row) => row.id)).toEqual(ids.slice(0, 1))
      expect(first.nextCursor).not.toBeNull()
      await invitation({ id: '00000000-0000-4000-8000-000000000001' })
      const observed = [...first.data.map((row) => row.id)]
      let cursor = first.nextCursor
      for (let index = 1; index < ids.length; index++) {
        const next = await page(
          await get(
            seeded.ownerSession.cookie,
            `?${new URLSearchParams({ limit: '1', cursor: cursor as string })}`,
          ),
        )
        observed.push(...next.data.map((row) => row.id))
        cursor = next.nextCursor
      }
      expect(observed).toEqual(ids)
      expect(new Set(observed).size).toBe(ids.length)
      expect(cursor).toBeNull()
      const switched = await session(seeded.owner, seeded.other.id)
      const wrongTeam = await get(
        switched.cookie,
        `?${new URLSearchParams({ cursor: first.nextCursor as string })}`,
      )
      expect(wrongTeam.status).toBe(400)
      expect(await wrongTeam.json()).toMatchObject({ error: 'invalid_cursor' })
    })

    it.each(['?limit=0', '?limit=101', '?limit=1.5', '?limit=invalid', '?cursor=invalid'])(
      'rejects invalid pagination %s',
      async (query) => {
        const response = await get(seeded.ownerSession.cookie, query)
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          error: query.includes('cursor') ? 'invalid_cursor' : 'invalid_request',
        })
      },
    )

    it('registers the production route as Hourmere session-only protocol with additive OpenAPI responses', async () => {
      await invitation()
      const production = application(
        productRoutes({ db, socialProviders: {}, invitationMailLimits: { ...limits, secret } }),
      )
      expect(
        (await page(await get(seeded.ownerSession.cookie, '', {}, production))).data,
      ).toHaveLength(1)
      const document = await openApiDocument(production)
      const operation = document.paths[path]?.get
      expect(operation?.security).toEqual([{ session: [] }])
      expect(operation?.responses['401']).toBeUndefined()
      expect(operation?.responses['403']).toBeDefined()
      expect(responseAndRequestStrictness(document, [path]).closedResponses).toEqual([])
      const schema = operation?.responses['200']?.content?.['application/json']?.schema
      const envelope = resolve(document, schema as Record<string, unknown>)
      expect(Object.keys(envelope.properties as object).sort()).toEqual(['data', 'nextCursor'])
      const item = resolve(
        document,
        (envelope.properties as Record<string, { items: Record<string, unknown> }>).data
          ?.items as Record<string, unknown>,
      )
      expect(Object.keys(item.properties as object).sort()).toEqual([
        'createdAt',
        'delivery',
        'expiresAt',
        'id',
        'resendAllowed',
        'status',
      ])
      expect((item.properties as Record<string, { enum: string[] }>).status?.enum).toContain(
        'unknown',
      )
    })
    function routeSourceCopy(replacement?: {
      file: 'access' | 'summary'
      before: string
      after: string
    }): typeof teamInvitationRoutes {
      const roleSource = readFileSync(
        new URL('../../../../packages/auth/src/team-management.ts', import.meta.url),
        'utf8',
      )
      if (replacement?.file === 'access')
        expect(roleSource.includes(replacement.before), 'role mutation matches source').toBe(true)
      const role = sourceCopy<Record<string, unknown>>(
        replacement?.file === 'access'
          ? roleSource.replace(replacement.before, replacement.after)
          : roleSource,
        { sql },
        '{ checkTeamManagementAccess, TeamManagementError }',
      )
      const management = sourceCopy<Record<string, unknown>>(
        readFileSync(new URL('../team-management.ts', import.meta.url), 'utf8'),
        { DomainError, createMiddleware, sql, ...role },
        '{ teamManagementAccess }',
      )
      const summarySource = readFileSync(new URL('../team-invitations.ts', import.meta.url), 'utf8')
      if (replacement?.file === 'summary')
        expect(summarySource.includes(replacement.before), 'summary mutation matches source').toBe(
          true,
        )
      const summary = sourceCopy<Record<string, unknown>>(
        replacement?.file === 'summary'
          ? summarySource.replace(replacement.before, replacement.after)
          : summarySource,
        {
          invitationRecipientIsMember,
          invitationResendDenial,
          invitationEmailBudgetAvailable,
          DomainError,
          sql,
          z,
        },
        '{ listTeamInvitationSummaries, TeamInvitationSummarySchema }',
      )
      return sourceCopy<typeof teamInvitationRoutes>(
        readFileSync(new URL('./team-invitations.ts', import.meta.url), 'utf8'),
        { createRoute, z, ErrorBody, json, ...management, ...summary },
        'teamInvitationRoutes',
      )
    }

    it('passes access, privacy, isolation, attempt-time and database-clock assertions with unmodified source copies', async () => {
      const factory = routeSourceCopy()
      const target = application([factory({ db, invitationMailLimits: { ...limits, secret } })])
      await verifyRoles(target)
      await db.deleteFrom('auth.invitation').execute()
      await verifyIsolation(target)
      await db.deleteFrom('auth.invitation').execute()
      await verifyDatabaseExpiry(target)
      await db.deleteFrom('auth.invitation').execute()
      await verifyAttemptTimestamp(target)
      await db.deleteFrom('auth.invitation').execute()
      await verifyUnknownStatuses(target)
    })

    it.each<
      [
        string,
        { file: 'access' | 'summary'; before: string; after: string },
        (target: ReturnType<typeof createApp>) => Promise<void>,
      ]
    >([
      [
        'owner/admin role check',
        { file: 'access', before: 'if (!role) throw denied()', after: 'if (false) throw denied()' },
        verifyRoles,
      ],
      [
        'organization filter',
        {
          file: 'summary',
          before: `WHERE i."organizationId" = \${actor.organizationId}::uuid`,
          after: 'WHERE TRUE',
        },
        verifyIsolation,
      ],
      [
        'safe field whitelist',
        {
          file: 'summary',
          before: '    data,\n    nextCursor:',
          after:
            '    data: data.map((summary, index) => ({ ...summary, email: rows[index].email })),\n    nextCursor:',
        },
        verifyRoles,
      ],
      [
        'stored attempt timestamp mapping',
        {
          file: 'summary',
          before: 'lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,',
          after: 'lastAttemptAt: null,',
        },
        verifyAttemptTimestamp,
      ],
      [
        'unknown invitation status normalization',
        {
          file: 'summary',
          before:
            "WHEN i.status IN ('pending', 'accepted', 'canceled', 'rejected') THEN i.status\n        ELSE 'unknown' END AS status,",
          after: 'ELSE i.status END AS status,',
        },
        verifyUnknownStatuses,
      ],
      [
        'database expiration clock',
        {
          file: 'summary',
          before: 'SELECT clock_timestamp() AS now',
          after: `SELECT \${new Date()}::timestamptz AS now`,
        },
        verifyDatabaseExpiry,
      ],
    ])(
      'detects removal of %s through a real HTTP assertion failure',
      async (_label, replacement, verify) => {
        // Compile before checking the assertion failure: source/load errors cannot count as detection.
        const factory = routeSourceCopy(replacement)
        const target = application([factory({ db, invitationMailLimits: { ...limits, secret } })])
        await expect(verify(target)).rejects.toMatchObject({ name: 'AssertionError' })
      },
    )
  },
)
