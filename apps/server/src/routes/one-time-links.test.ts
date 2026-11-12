import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import '@hono/zod-openapi'
import {
  type Auth,
  createAuth,
  createAuthPool,
  createCallerResolver,
  type Principal,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  ONE_TIME_LINK_PAGE_MAX,
  ONE_TIME_LINK_PREFILL_EMAIL_MAX,
  ONE_TIME_LINK_PREFILL_NAME_MAX,
} from '@hourmere/scheduling'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import * as Routes from './one-time-links.ts'
import {
  openApiDocument,
  productApp,
  responseAndRequestStrictness,
  syntheticSessionCookie,
} from './test-app.ts'

const path = (event: string) => `/api/v1/event-types/${event}/one-time-links`
const basePath = '/api/v1/event-types/{eventTypeId}/one-time-links'
const publicUrl = 'https://hourmere.example.com'
async function sourceCopy(replacement: readonly [string, string]): Promise<typeof Routes> {
  const location = new URL('./one-time-links.ts', import.meta.url)
  const original = readFileSync(location, 'utf8')
  expect(original.includes(replacement[0]), 'mutation must match').toBe(true)
  const source = stripTypeScriptTypes(original.replace(...replacement)).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('node:') ? specifier : specifier.startsWith('.') ? new URL(specifier, location).href : pathToFileURL(createRequire(location).resolve(specifier)).href}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}
function safe(value: unknown, token: string) {
  const text = JSON.stringify(value)
  expect(text.includes(token)).toBe(false)
  expect(text.includes(createHash('sha256').update(token).digest('hex'))).toBe(false)
  expect(/token_hash|tokenHash|"token"|"url"/.test(text)).toBe(false)
}

describe('one-time link administrative OpenAPI contract', () => {
  it('declares authenticated open metadata and strict nested requests', async () => {
    const doc = await openApiDocument(productApp({} as Db))
    expect(responseAndRequestStrictness(doc, [basePath, `${basePath}/{id}`])).toEqual({
      closedResponses: [],
      openRequests: [],
    })
    expect(Object.keys(doc.paths[basePath] ?? {}).sort()).toEqual(['get', 'post'])
    expect(Object.keys(doc.paths[`${basePath}/{id}`] ?? {}).sort()).toEqual(['delete', 'get'])
    for (const endpoint of [basePath, `${basePath}/{id}`])
      for (const operation of Object.values(doc.paths[endpoint] ?? {})) {
        expect(operation.security).toEqual([{ apiKey: [] }, { session: [] }])
        expect(operation.responses).toHaveProperty('401')
        expect(operation.responses).toHaveProperty('403')
      }
    expect(doc.components.schemas.CreateOneTimeBookingLink).toMatchObject({
      properties: {
        prefill: {
          properties: {
            name: { maxLength: ONE_TIME_LINK_PREFILL_NAME_MAX },
            email: { maxLength: ONE_TIME_LINK_PREFILL_EMAIL_MAX },
          },
        },
      },
    })
    expect(doc.paths[basePath]?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'limit',
          schema: expect.objectContaining({ maximum: ONE_TIME_LINK_PAGE_MAX }),
        }),
      ]),
    )
    expect(JSON.stringify(doc.components.schemas.OneTimeBookingLink)).not.toMatch(
      /token_hash|tokenHash|"token"|"url"/,
    )
  })
})

describe.skipIf(!process.env.DATABASE_URL)(
  'one-time link REST administration with Postgres and real API keys',
  () => {
    let owned: TestDatabase
    let db: Db
    let authPool: ReturnType<typeof createAuthPool>
    let auth: Auth
    let app: ReturnType<typeof createApp>
    let fixtures: ReturnType<typeof createFixtures>
    const keys = new Map<string, string>()
    beforeAll(async () => {
      owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
        tag: 'one_time_rest',
      })
      db = createDb(owned.pool)
      fixtures = createFixtures(db)
      const signup = { mode: 'open', allowedDomains: [] } as const
      authPool = createAuthPool(owned.url, signup)
      auth = createAuth({
        pool: authPool,
        db,
        baseURL: publicUrl,
        secret: 'synthetic-one-time-admin-test-secret-000000000000',
        signup,
        mailer: { send: async () => {} },
      })
      app = createApp({
        checkDb: async () => {},
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        publicUrl,
        routes: [Routes.oneTimeLinkRoutes({ db, publicUrl })],
      })
    })
    afterAll(async () => {
      await authPool?.end()
      await owned?.drop()
    })
    async function setup() {
      const user = await createTestUser(db)
      const eventTypeId = await fixtures.eventType(user.principal.organization.id, user.id)
      for (const scope of ['full', 'read', 'bookings']) {
        const key = await auth.api.createApiKey({
          body: {
            userId: user.id,
            metadata: { organizationId: user.principal.organization.id, scope },
          },
        })
        keys.set(`${user.id}:${scope}`, key.key)
      }
      return { user, eventTypeId }
    }
    function request(
      s: Awaited<ReturnType<typeof setup>>,
      scope: string,
      method: string,
      endpoint: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) {
      return app.request(endpoint, {
        method,
        headers: {
          authorization: `Bearer ${keys.get(`${s.user.id}:${scope}`)}`,
          'content-type': 'application/json',
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    }
    it('returns a full path URL once, never tokens or digests on administrative reads/revokes or captured logs', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const s = await setup()
        const created = await request(s, 'full', 'POST', path(s.eventTypeId), {
          prefill: { name: 'Ada', email: 'ADA@example.com' },
        })
        expect(created.status).toBe(201)
        expect(created.headers.get('cache-control')).toBe('no-store')
        expect(created.headers.get('referrer-policy')).toBe('no-referrer')
        const body = (await created.json()) as {
          id: string
          url: string
          prefill: { email: string }
        }
        const url = new URL(body.url)
        expect(url.origin).toBe(publicUrl)
        expect(url.search).toBe('')
        expect(/^\/book\/[A-Za-z0-9_-]{43}$/.test(url.pathname)).toBe(true)
        expect(Object.hasOwn(body, 'token')).toBe(false)
        expect(body.prefill.email).toBe('ada@example.com')
        const token = url.pathname.slice('/book/'.length)
        for (const [method, endpoint] of [
          ['GET', path(s.eventTypeId)],
          ['GET', `${path(s.eventTypeId)}/${body.id}`],
          ['DELETE', `${path(s.eventTypeId)}/${body.id}`],
        ] as const) {
          const response = await request(s, 'full', method, endpoint)
          expect(response.status).toBe(200)
          safe(await response.json(), token)
        }
        const combined = JSON.stringify([log.mock.calls, error.mock.calls, warn.mock.calls])
        expect(combined.includes(token)).toBe(false)
        expect(combined.includes(createHash('sha256').update(token).digest('hex'))).toBe(false)
      } finally {
        log.mockRestore()
        error.mockRestore()
        warn.mockRestore()
      }
    })
    it('enforces every endpoint scope before looking up valid or unknown IDs', async () => {
      const s = await setup()
      const created = await request(s, 'full', 'POST', path(s.eventTypeId), {})
      const link = (await created.json()) as { id: string }
      for (const eventTypeId of [s.eventTypeId, randomUUID()]) {
        for (const scope of ['read']) {
          for (const [method, endpoint, body] of [
            ['POST', path(eventTypeId), {}],
            ['DELETE', `${path(eventTypeId)}/${link.id}`, undefined],
          ] as const) {
            const response = await request(s, scope, method, endpoint, body)
            expect(response.status).toBe(403)
            expect(await response.json()).toMatchObject({ error: 'insufficient_scope' })
          }
        }
        for (const endpoint of [path(eventTypeId), `${path(eventTypeId)}/${link.id}`]) {
          const response = await request(s, 'bookings', 'GET', endpoint)
          expect(response.status).toBe(403)
          expect(await response.json()).toMatchObject({ error: 'insufficient_scope' })
        }
      }
      const bookingWrite = await request(s, 'bookings', 'POST', path(s.eventTypeId), {})
      expect(bookingWrite.status).toBe(201)
      const written = (await bookingWrite.json()) as { id: string }
      expect(
        (await request(s, 'bookings', 'DELETE', `${path(s.eventTypeId)}/${written.id}`)).status,
      ).toBe(200)
      expect((await request(s, 'read', 'GET', path(s.eventTypeId))).status).toBe(200)
      expect((await request(s, 'read', 'GET', `${path(s.eventTypeId)}/${link.id}`)).status).toBe(
        200,
      )
      expect((await app.request(path(s.eventTypeId))).status).toBe(401)
    })
    it('refuses duplicate create keys without minting another token and distinguishes changed arguments', async () => {
      const s = await setup()
      const headers = { 'idempotency-key': randomUUID() }
      const input = { prefill: { name: 'Grace' } }
      expect((await request(s, 'full', 'POST', path(s.eventTypeId), input, headers)).status).toBe(
        201,
      )
      const replay = await request(s, 'full', 'POST', path(s.eventTypeId), input, headers)
      expect(replay.status).toBe(409)
      expect(await replay.json()).toMatchObject({
        error: 'one_time_link_already_created',
        message: expect.stringContaining('cannot be retrieved'),
      })
      const mismatch = await request(
        s,
        'full',
        'POST',
        path(s.eventTypeId),
        { prefill: { name: 'Different' } },
        headers,
      )
      expect(mismatch.status).toBe(409)
      expect(await mismatch.json()).toMatchObject({ error: 'idempotency_key_reused' })
      const listed = (await (await request(s, 'read', 'GET', path(s.eventTypeId))).json()) as {
        data: unknown[]
      }
      expect(listed.data).toHaveLength(1)
    })
    it('accepts service maxima and rejects maximum plus one for pages and prefill', async () => {
      const s = await setup()
      for (const [limit, status] of [
        [ONE_TIME_LINK_PAGE_MAX, 200],
        [ONE_TIME_LINK_PAGE_MAX + 1, 400],
      ]) {
        expect(
          (await request(s, 'read', 'GET', `${path(s.eventTypeId)}?limit=${limit}`)).status,
        ).toBe(status)
      }
      for (const [field, maximum] of [
        ['name', ONE_TIME_LINK_PREFILL_NAME_MAX],
        ['email', ONE_TIME_LINK_PREFILL_EMAIL_MAX],
      ] as const) {
        for (const extra of [0, 1]) {
          const value =
            field === 'name'
              ? 'n'.repeat(maximum + extra)
              : `${'e'.repeat(maximum + extra - '@example.test'.length)}@example.test`
          const response = await request(s, 'full', 'POST', path(s.eventTypeId), {
            prefill: { [field]: value },
          })
          expect(response.status).toBe(extra === 0 ? 201 : 400)
        }
      }
    })
    it('validates prefill and expiry, rejects extra fields, and returns uniform missing revocations', async () => {
      const s = await setup()
      for (const input of [
        { prefill: { email: 'bad' } },
        { prefill: { name: 'new\nline' } },
        { expiresAt: '2000-01-01T00:00:00Z' },
        { expiresAt: 'not-an-instant' },
        { label: 'unsupported' },
        { prefill: { email: 'user@example.com', unknown: true } },
      ]) {
        const response = await request(s, 'full', 'POST', path(s.eventTypeId), input)
        expect(response.status).toBe(400)
      }
      const link = (await (await request(s, 'full', 'POST', path(s.eventTypeId), {})).json()) as {
        id: string
      }
      const first = await (
        await request(s, 'full', 'DELETE', `${path(s.eventTypeId)}/${link.id}`)
      ).json()
      expect(first).toMatchObject({ state: 'revoked' })
      expect(
        await (await request(s, 'full', 'DELETE', `${path(s.eventTypeId)}/${link.id}`)).json(),
      ).toEqual(first)
      const foreign = await setup()
      const foreignLink = (await (
        await request(foreign, 'full', 'POST', path(foreign.eventTypeId), {})
      ).json()) as { id: string }
      for (const id of [randomUUID(), foreignLink.id]) {
        const response = await request(s, 'full', 'DELETE', `${path(s.eventTypeId)}/${id}`)
        expect(response.status).toBe(200)
        expect(await response.json()).toBeNull()
      }
    })
    it('binds session create/revoke writes to the current editor organization', async () => {
      const s = await setup()
      const session = await db
        .insertInto('auth.session')
        .values({
          userId: s.user.id,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 3_600_000),
          activeOrganizationId: s.user.principal.organization.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const principal: Principal = {
        kind: 'session',
        sessionId: session.id,
        user: s.user.principal.user,
        organization: s.user.principal.organization,
      }
      const credential = randomUUID()
      const sessionApp = productApp(db, new Map([[credential, principal]]))
      const send = (method: string, endpoint: string, expected?: string) =>
        sessionApp.request(endpoint, {
          method,
          headers: {
            cookie: syntheticSessionCookie(credential),
            origin: 'http://localhost:3000',
            'content-type': 'application/json',
            ...(expected === undefined ? {} : { 'X-Expected-Organization-Id': expected }),
          },
          ...(method === 'POST' ? { body: '{}' } : {}),
        })
      expect((await send('POST', path(s.eventTypeId))).status).toBe(409)
      const created = await send('POST', path(s.eventTypeId), principal.organization.id)
      expect(created.status).toBe(201)
      const link = (await created.json()) as { id: string }
      expect((await send('DELETE', `${path(s.eventTypeId)}/${link.id}`)).status).toBe(409)
      expect(
        (await send('DELETE', `${path(s.eventTypeId)}/${link.id}`, principal.organization.id))
          .status,
      ).toBe(200)
    })
    async function verifyMemberSession(module = Routes) {
      const owner = await createTestUser(db)
      const member = await createTestUser(db)
      const team = await createTestTeam(db, [
        { user: owner, role: 'owner' },
        { user: member, role: 'member' },
      ])
      const ownEvent = await fixtures.eventType(team.id, member.id)
      const otherEvent = await fixtures.eventType(team.id, owner.id)
      const teamEvent = await fixtures.eventType(team.id, null)
      const session = await db
        .insertInto('auth.session')
        .values({
          userId: member.id,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 3_600_000),
          activeOrganizationId: team.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      const principal: Principal = {
        kind: 'session',
        sessionId: session.id,
        user: member.principal.user,
        organization: team.as(member).organization,
      }
      const credential = randomUUID()
      const sessionApp = productApp(db, new Map([[credential, principal]]), [
        module.oneTimeLinkRoutes({ db, publicUrl: 'http://localhost:3000' }),
      ])
      const send = (method: string, endpoint: string, expected: string | undefined) =>
        sessionApp.request(endpoint, {
          method,
          headers: {
            cookie: syntheticSessionCookie(credential),
            origin: 'http://localhost:3000',
            'content-type': 'application/json',
            ...(expected === undefined ? {} : { 'X-Expected-Organization-Id': expected }),
          },
          ...(method === 'POST' ? { body: '{}' } : {}),
        })
      expect((await send('POST', path(ownEvent), undefined)).status).toBe(409)
      expect((await send('POST', path(ownEvent), member.principal.organization.id)).status).toBe(
        409,
      )
      expect((await send('POST', path(ownEvent), 'malformed')).status).toBe(409)
      const created = await send('POST', path(ownEvent), team.id)
      expect(created.status).toBe(201)
      const link = (await created.json()) as { id: string }
      for (const [event, status] of [
        [otherEvent, 404],
        [teamEvent, 403],
      ] as const) {
        expect((await send('POST', path(event), team.id)).status).toBe(status)
        expect((await send('DELETE', `${path(event)}/${link.id}`, team.id)).status).toBe(status)
      }
      expect((await send('DELETE', `${path(ownEvent)}/${link.id}`, undefined)).status).toBe(409)
      expect(
        (await send('DELETE', `${path(ownEvent)}/${link.id}`, member.principal.organization.id))
          .status,
      ).toBe(409)
      const revoked = await send('DELETE', `${path(ownEvent)}/${link.id}`, team.id)
      expect(revoked.status).toBe(200)
      expect(await revoked.json()).toMatchObject({ state: 'revoked' })
      // A resolved principal cannot bypass a subsequent active-space change.
      await db
        .updateTable('auth.session')
        .set({ activeOrganizationId: member.principal.organization.id })
        .where('id', '=', session.id)
        .execute()
      expect((await send('POST', path(ownEvent), team.id)).status).toBe(409)
      expect((await send('DELETE', `${path(ownEvent)}/${link.id}`, team.id)).status).toBe(409)
    }
    it('allows team members to create/revoke for their own events while enforcing ownership and current space', async () => {
      await verifyMemberSession()
    })
    it.each([
      [
        'missing expectation',
        "if (principal.kind === 'session' && expectation === undefined)",
        'if (false)',
      ],
      [
        'current session context',
        'await bookingWriteAccess(principal, expectation)(db, organizationId)',
        'void 0',
      ],
    ])('mutation: session write binding for %s', async (_, original, replacement) => {
      const module = await sourceCopy([original, replacement])
      await expect(verifyMemberSession(module)).rejects.toMatchObject({ name: 'AssertionError' })
    })
  },
)

describe('one-time link creation response source-copy mutations', () => {
  function verify(module: typeof Routes) {
    const token = 'synthetic-private-capability'
    const result = module.createdOneTimeLinkResponse(
      { token } as Parameters<typeof Routes.createdOneTimeLinkResponse>[0],
      publicUrl,
    )
    expect(Object.hasOwn(result, 'token')).toBe(false)
    expect(new URL(result.url).search).toBe('')
    expect(new URL(result.url).pathname === `/book/${token}`).toBe(true)
  }
  it.each([
    ['raw token response field', 'return { ...metadata, url:', 'return { token, ...metadata, url:'],
    [
      'capability in query string',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation
      'new URL(`/book/${token}`, publicUrl)',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: exact source-copy mutation
      'new URL(`/book?token=${token}`, publicUrl)',
    ],
  ])('mutation: %s', async (_, original, replacement) => {
    verify(Routes)
    const module = await sourceCopy([original, replacement])
    let error: unknown
    try {
      verify(module)
    } catch (failure) {
      error = failure
    }
    expect(error instanceof Error && error.name === 'AssertionError').toBe(true)
  })
})
