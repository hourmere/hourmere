import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { OpenAPIHono } from '@hono/zod-openapi'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { provisioningTokenRoutes } from './routes/provisioning-tokens.ts'
import { productRoutes } from './server.ts'

const origin = 'http://localhost'
const signingSecret = 'synthetic-scim-http-cookie-signing-secret'
async function sourceCopy<T>(file: string, mutation?: [string, string]): Promise<T> {
  const location = new URL(file, import.meta.url)
  let source = readFileSync(location, 'utf8')
  if (mutation) {
    expect(source.includes(mutation[0])).toBe(true)
    source = source.replace(...mutation)
  }
  const javascript = stripTypeScriptTypes(source).replace(
    /((?:from|import)\s*)'([^']+)'/g,
    (_, prefix: string, specifier: string) =>
      `${prefix}'${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
}

it('requires explicit SCIM operator opt-in', () => {
  const env = {
    DATABASE_URL: 'postgres://unused@localhost/unused',
    BETTER_AUTH_SECRET: signingSecret,
  }
  expect(loadConfig(env).SCIM_PROVISIONING_ENABLED).toBe(false)
  expect(loadConfig({ ...env, SCIM_PROVISIONING_ENABLED: 'false' }).SCIM_PROVISIONING_ENABLED).toBe(
    false,
  )
  expect(loadConfig({ ...env, SCIM_PROVISIONING_ENABLED: 'true' }).SCIM_PROVISIONING_ENABLED).toBe(
    true,
  )
  expect(() => loadConfig({ ...env, SCIM_PROVISIONING_ENABLED: 'yes' })).toThrow()
})

describe.skipIf(!process.env.DATABASE_URL)('SCIM credential HTTP boundaries', () => {
  let owned: TestDatabase, db: Db, auth: Auth, authPool: ReturnType<typeof createAuthPool>
  let owner: Awaited<ReturnType<typeof createTestUser>>, organizationId: string, foreignId: string
  let cookie: string, memberCookie: string, apiKey: string
  const path = () => `/api/v1/organizations/${organizationId}/provisioning-tokens`
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'scim_http',
    })
    db = createDb(owned.pool)
    const f = createFixtures(db)
    owner = await createTestUser(db)
    const member = await createTestUser(db)
    organizationId = await f.organization('scim-http')
    foreignId = await f.organization('scim-foreign')
    await f.member(owner.id, organizationId, 'owner')
    await f.member(member.id, organizationId, 'member')
    const signup = { mode: 'open', allowedDomains: [] } as const
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      signup,
      baseURL: origin,
      secret: signingSecret,
      mailer: { send: async () => {} },
    })
    const session = async (userId: string) => {
      const token = randomBytes(24).toString('base64url')
      await db
        .insertInto('auth.session')
        .values({
          userId,
          token,
          activeOrganizationId: organizationId,
          expiresAt: new Date(Date.now() + 3600000),
          updatedAt: new Date(),
        })
        .execute()
      return `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac('sha256', signingSecret).update(token).digest('base64')}`)}`
    }
    cookie = await session(owner.id)
    memberCookie = await session(member.id)
    apiKey = (
      await auth.api.createApiKey({ body: { userId: owner.id, metadata: { organizationId } } })
    ).key
  })
  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })
  function app(enabled = true, factory = provisioningTokenRoutes, appFactory = createApp) {
    return appFactory({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl: origin,
      scim: { db, enabled },
      routes: [factory({ db, enabled })],
      mcp: mcpEndpoint({ tools: [] }),
    })
  }
  function request(
    application: ReturnType<typeof app>,
    target = path(),
    method = 'GET',
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    return application.request(target, {
      method,
      headers: {
        cookie,
        origin,
        'x-expected-organization-id': organizationId,
        'content-type': 'application/json',
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  async function issue(application = app()) {
    const response = await request(application, path(), 'POST', { name: 'Synthetic IdP' })
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toContain('no-store')
    return (await response.json()) as { token: { id: string }; secret: string }
  }
  it('shows credentials once, lists metadata only, rotates and revokes both generations', async () => {
    const application = app()
    const issued = await issue(application)
    const listed = await request(application)
    expect(listed.status).toBe(200)
    const text = await listed.text()
    expect(text.includes(issued.secret)).toBe(false)
    expect(/token_hash|previous_token_hash|"secret"/.test(text)).toBe(false)
    const rotated = await request(application, `${path()}/${issued.token.id}/rotate`, 'POST', {
      overlapSeconds: 3600,
    })
    expect(rotated.status).toBe(200)
    const replacement = (await rotated.json()) as { secret: string }
    const target = `/scim/v2/${organizationId}/Users`
    for (const credential of [issued.secret, replacement.secret]) {
      const response = await application.request(target, {
        headers: { authorization: `Bearer ${credential}` },
      })
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).toContain('application/scim+json')
    }
    const revoke = await request(application, `${path()}/${issued.token.id}`, 'DELETE')
    expect(revoke.status).toBe(200)
    for (const credential of [issued.secret, replacement.secret])
      expect(
        (await application.request(target, { headers: { authorization: `Bearer ${credential}` } }))
          .status,
      ).toBe(401)
  })
  it('separates REST, MCP and SCIM credentials, even with valid cookies', async () => {
    const application = app()
    const issued = await issue(application)
    expect(
      (
        await request(application, '/api/v1/me', 'GET', undefined, {
          authorization: `Bearer ${issued.secret}`,
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await request(
          application,
          '/mcp',
          'POST',
          { jsonrpc: '2.0', id: 1, method: 'tools/list' },
          {
            authorization: `Bearer ${issued.secret}`,
            accept: 'application/json, text/event-stream',
          },
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await request(application, `/scim/v2/${organizationId}/Users`, 'GET', undefined, {
          authorization: `Bearer ${apiKey}`,
        })
      ).status,
    ).toBe(401)
    expect((await request(application, `/scim/v2/${organizationId}/Users`)).status).toBe(401)
    expect(
      (
        await request(application, `/scim/v2/${foreignId}/Users`, 'GET', undefined, {
          authorization: `Bearer ${issued.secret}`,
        })
      ).status,
    ).toBe(401)
    for (const bearer of [apiKey, issued.secret, 'invalid'])
      expect(
        (
          await request(
            application,
            path(),
            'POST',
            { name: 'Refused' },
            { authorization: `Bearer ${bearer}` },
          )
        ).status,
      ).toBe(bearer === issued.secret ? 401 : 403)
  })
  it('checks role, active organization, expected context and origin before writes', async () => {
    const application = app()
    expect(
      (await request(application, path(), 'POST', { name: 'Refused' }, { cookie: memberCookie }))
        .status,
    ).toBe(403)
    expect(
      (await request(application, `/api/v1/organizations/${foreignId}/provisioning-tokens`)).status,
    ).toBe(403)
    expect(
      (
        await request(
          application,
          path(),
          'POST',
          { name: 'Refused' },
          { 'x-expected-organization-id': foreignId },
        )
      ).status,
    ).toBe(409)
    expect(
      (
        await request(
          application,
          path(),
          'POST',
          { name: 'Refused' },
          { origin: 'https://foreign.test' },
        )
      ).status,
    ).toBe(403)
  })
  async function verifyDisabled(factory = provisioningTokenRoutes) {
    expect((await request(app(false, factory), path(), 'POST', { name: 'Disabled' })).status).toBe(
      404,
    )
  }
  async function verifyHeader(factory = provisioningTokenRoutes) {
    const response = await request(
      app(true, factory),
      path(),
      'POST',
      { name: 'Refused' },
      { authorization: `Bearer ${apiKey}` },
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'session_required' })
  }
  async function verifyExpected(factory = provisioningTokenRoutes) {
    expect(
      (
        await request(
          app(true, factory),
          path(),
          'POST',
          { name: 'Refused' },
          { 'x-expected-organization-id': foreignId },
        )
      ).status,
    ).toBe(409)
  }
  it('keeps disabled and unknown SCIM paths off the SPA', async () => {
    await verifyDisabled()
    for (const target of ['/scim/v2', '/scim/v2/Users', `/scim/v2/${organizationId}/Users`]) {
      const response = await request(app(false), target)
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).toContain('application/scim+json')
    }
    const application = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl: origin,
      routes: productRoutes({
        db,
        socialProviders: {},
        invitationMailLimits: { secret: signingSecret },
        scimProvisioningEnabled: true,
      }),
    })
    expect(await (await application.request('/api/v1/instance')).json()).toHaveProperty(
      'scimProvisioningEnabled',
      true,
    )
    expect((await request(application, path(), 'POST', { name: 'Production wiring' })).status).toBe(
      201,
    )
  })
  it('redacts credential-shaped validation input and unexpected driver failures', async () => {
    const issued = await issue()
    const application = app()
    const messages: unknown[][] = []
    const spies = ['log', 'warn', 'error'].map((level) =>
      vi.spyOn(console, level as 'log').mockImplementation((...args) => {
        messages.push(args)
      }),
    )
    try {
      const response = await request(application, path(), 'POST', {
        name: 'Bad input',
        [issued.secret]: true,
      })
      expect(response.status).toBe(400)
      expect((await response.text()).includes(issued.secret)).toBe(false)
      expect(JSON.stringify(messages).includes(issued.secret)).toBe(false)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
  it('never falls back to cookies on native auth or public metadata with a provisioning bearer', async () => {
    const issued = await issue()
    const verify = async (factory = createApp) => {
      const application = app(true, provisioningTokenRoutes, factory)
      for (const target of ['/api/auth/get-session', '/api/v1/instance', '/api/health']) {
        expect(
          (
            await request(application, target, 'GET', undefined, {
              authorization: `Bearer ${issued.secret}`,
            })
          ).status,
        ).toBe(401)
      }
    }
    await verify()
    const mutant = await sourceCopy<typeof import('./app.ts')>('./app.ts', [
      "!c.req.path.startsWith('/scim/v2/')",
      'false',
    ])
    await expect(verify(mutant.createApp)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('never logs credentials placed in malformed SCIM URLs or query parameters', async () => {
    const issued = await issue()
    const messages: unknown[][] = []
    const spies = ['log', 'warn', 'error'].map((level) =>
      vi.spyOn(console, level as 'log').mockImplementation((...args) => {
        messages.push(args)
      }),
    )
    try {
      const application = app()
      for (const target of [
        `/scim/v2/${issued.secret}`,
        `/scim/v2/${organizationId}/Users?token=${issued.secret}`,
      ]) {
        const response = await application.request(target)
        expect((await response.text()).includes(issued.secret)).toBe(false)
      }
      expect(JSON.stringify(messages).includes(issued.secret)).toBe(false)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
  it('limits SCIM authentication attempts per client address', async () => {
    const application = app()
    for (let i = 0; i < 120; i++)
      expect((await application.request(`/scim/v2/${organizationId}/Users`)).status).toBe(401)
    const response = await application.request(`/scim/v2/${organizationId}/Users`)
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBeTruthy()
  })
  it('detects a weakened SCIM request budget in a source copy', async () => {
    const verify = async (mount: typeof import('./scim.ts').mountScim) => {
      const application = new OpenAPIHono()
      mount(application, { db, enabled: true })
      for (let i = 0; i < 120; i++) await application.request(`/scim/v2/${organizationId}/Users`)
      expect((await application.request(`/scim/v2/${organizationId}/Users`)).status).toBe(429)
    }
    const control = await sourceCopy<typeof import('./scim.ts')>('./scim.ts')
    await verify(control.mountScim)
    const mutant = await sourceCopy<typeof import('./scim.ts')>('./scim.ts', [
      'limit: 120',
      'limit: 121',
    ])
    await expect(verify(mutant.mountScim)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('suppresses unexpected diagnostics and detects removal of the log privacy guard', async () => {
    const issued = await issue()
    const location = new URL('./routes/provisioning-tokens.ts', import.meta.url)
    const original = readFileSync(location, 'utf8')
    const module = await sourceCopy<typeof import('./routes/provisioning-tokens.ts')>(
      './routes/provisioning-tokens.ts',
      ['      await next()', `      throw new Error(${JSON.stringify(issued.secret)})`],
    )
    const verify = async (factory = createApp) => {
      const messages: unknown[][] = []
      const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
        messages.push(args)
      })
      try {
        const response = await request(app(true, module.provisioningTokenRoutes, factory))
        expect(response.status).toBe(500)
        expect((await response.text()).includes(issued.secret)).toBe(false)
        expect(JSON.stringify(messages).includes(issued.secret)).toBe(false)
      } finally {
        spy.mockRestore()
      }
    }
    await verify()
    const mutant = await sourceCopy<typeof import('./app.ts')>('./app.ts', [
      "const message = c.req.path.includes('/provisioning-tokens')",
      'const message = false',
    ])
    await expect(verify(mutant.createApp)).rejects.toMatchObject({ name: 'AssertionError' })
    expect(readFileSync(location, 'utf8')).toBe(original)
  })
  it('source-copy controls kill disabled, credential-header and stale-context guard mutations', async () => {
    const control = await sourceCopy<typeof import('./routes/provisioning-tokens.ts')>(
      './routes/provisioning-tokens.ts',
    )
    await verifyDisabled(control.provisioningTokenRoutes)
    await verifyHeader(control.provisioningTokenRoutes)
    await verifyExpected(control.provisioningTokenRoutes)
    for (const [mutation, verify] of [
      [['if (!enabled)', 'if (false)'], verifyDisabled],
      [["if (c.req.raw.headers.has('authorization'))", 'if (false)'], verifyHeader],
      [
        ["c.req.header('x-expected-organization-id') !== principal.organization.id", 'false'],
        verifyExpected,
      ],
    ] as [[string, string], typeof verifyDisabled][]) {
      const mutant = await sourceCopy<typeof import('./routes/provisioning-tokens.ts')>(
        './routes/provisioning-tokens.ts',
        mutation,
      )
      await expect(verify(mutant.provisioningTokenRoutes)).rejects.toMatchObject({
        name: 'AssertionError',
      })
    }
  })
})
