// Sign-in, sessions, personal organizations and API keys end to end: the real app, Better
// Auth and migrations, against a throwaway database.
import { randomBytes } from 'node:crypto'
import {
  API_KEY_RATE_LIMIT,
  type Auth,
  CLIENT_IP_HEADER,
  createAuth,
  createAuthPool,
  createCallerResolver,
  type OAuthClient,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'

const serverUrl = process.env.DATABASE_URL

interface Me {
  user: { id: string; name: string; email: string }
  organization: { id: string; name: string; slug: string; personal: boolean }
  principal: { kind: 'session' | 'api_key'; apiKeyId: string | null }
}

interface Instance {
  app: ReturnType<typeof createApp>
  auth: Auth
  publicUrl: string
}

describe.skipIf(!serverUrl)('sign-in and callers', () => {
  let testDb: TestDatabase
  let db: Db
  let authPool: pg.Pool
  const outbox: MailMessage[] = []

  interface InstanceOptions {
    socialProviders?: { google?: OAuthClient; microsoft?: OAuthClient }
    trustedProxies?: string[]
  }

  function instance(
    publicUrl: string,
    { socialProviders = {}, trustedProxies = [] }: InstanceOptions = {},
  ): Instance {
    const auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret: randomBytes(32).toString('base64'),
      mailer: { send: async (m) => void outbox.push(m) },
      socialProviders,
    })
    const app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      trustedProxies,
    })
    return { app, auth, publicUrl }
  }

  let main: Instance
  const origin = 'http://localhost:3000'

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
    authPool = createAuthPool(testDb.url)
    main = instance(origin)
  })

  afterAll(async () => {
    await authPool?.end()
    await testDb?.drop()
  })

  const cookieHeader = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')

  /** Requests a magic link and returns the URL from the email it sends. */
  async function requestLink(email: string, { app }: Instance = main): Promise<URL> {
    const before = outbox.length
    const res = await app.request('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, callbackURL: '/' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: true })
    const mail = outbox.slice(before).find((m) => m.to === email)
    expect(mail?.subject).toBe('Sign in to Hourmere')
    const link = mail?.text.match(/https?:\/\/\S+/)?.[0]
    expect(link).toBeDefined()
    return new URL(link as string)
  }

  /** Signs in through the emailed link; returns the session cookie. */
  async function signIn(email: string, i: Instance = main): Promise<string> {
    const link = await requestLink(email, i)
    const res = await i.app.request(link.toString())
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`${i.publicUrl}/`)
    const cookie = cookieHeader(res)
    expect(cookie).toContain('better-auth.session_token=')
    return cookie
  }

  async function me(headers: Record<string, string>, app = main.app) {
    const res = await app.request('/api/v1/me', { headers })
    return { res, body: (await res.json()) as Me & { error?: string } }
  }

  async function createKey(cookie: string, body: Record<string, unknown> = {}) {
    return main.app.request('/api/auth/api-key/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: JSON.stringify({ name: 'agent', ...body }),
    })
  }

  const count = async (sql: string, params: unknown[]) =>
    (await testDb.pool.query<{ n: number }>(sql, params)).rows[0]?.n

  describe('magic link', () => {
    it('signs in and reaches /api/v1/me with the session cookie', async () => {
      const link = await requestLink('ada@example.com')
      expect(`${link.origin}${link.pathname}`).toBe(`${origin}/api/auth/magic-link/verify`)
      const res = await main.app.request(link.toString())
      expect(res.status).toBe(302)
      const cookie = cookieHeader(res)

      const { res: meRes, body } = await me({ cookie })
      expect(meRes.status).toBe(200)
      expect(body).toEqual({
        user: { id: expect.any(String), name: '', email: 'ada@example.com' },
        organization: { id: expect.any(String), name: 'ada', slug: 'ada', personal: true },
        principal: { kind: 'session', apiKeyId: null },
      })

      // The personal organization is the session's active organization.
      const session = await testDb.pool.query(
        `SELECT "activeOrganizationId" AS org FROM auth.session WHERE "userId" = $1`,
        [body.user.id],
      )
      expect(session.rows).toEqual([{ org: body.organization.id }])
    })

    it('sends the link as plain text and HTML', async () => {
      await requestLink('html@example.com')
      const mail = outbox.findLast((m) => m.to === 'html@example.com')
      const link = mail?.text.match(/https?:\/\/\S+/)?.[0] as string
      expect(mail?.html).toContain(`href="${link.replaceAll('&', '&amp;')}"`)
    })

    it('works once', async () => {
      const link = await requestLink('once@example.com')
      expect((await main.app.request(link.toString())).status).toBe(302)
      const again = await main.app.request(link.toString())
      expect(again.headers.get('location')).toBe(`${origin}/?error=INVALID_TOKEN`)
      expect(cookieHeader(again)).not.toContain('session_token')
    })

    it('rejects an unknown token', async () => {
      const res = await main.app.request('/api/auth/magic-link/verify?token=nope&callbackURL=/')
      expect(res.headers.get('location')).toBe(`${origin}/?error=INVALID_TOKEN`)
      expect(cookieHeader(res)).not.toContain('session_token')
    })

    it('keeps the token out of the request log', async () => {
      const link = await requestLink('quiet@example.com')
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      try {
        await main.app.request(link.toString())
        const lines = log.mock.calls.map((args) => args.join(' '))
        expect(lines.some((l) => l.includes('/api/auth/magic-link/verify'))).toBe(true)
        expect(lines.join('\n')).not.toContain(link.searchParams.get('token'))
      } finally {
        log.mockRestore()
      }
    })

    it('sets Secure cookies when PUBLIC_URL is https', async () => {
      const https = instance('https://hourmere.example')
      const link = await requestLink('secure@example.com', https)
      const res = await https.app.request(link.toString())
      const session = res.headers.getSetCookie().find((c) => c.includes('session_token='))
      expect(session).toMatch(/^__Secure-better-auth\.session_token=/)
      expect(session).toMatch(/; Secure/i)
      expect(session).toMatch(/; HttpOnly/i)
    })
  })

  describe('personal organization', () => {
    it('is created exactly once per user, with an owner membership and the marker', async () => {
      await signIn('grace@example.com')
      await signIn('grace@example.com')
      const user = await testDb.pool.query<{ id: string }>(
        `SELECT id FROM auth."user" WHERE email = 'grace@example.com'`,
      )
      const userId = user.rows[0]?.id
      expect(
        await count(`SELECT count(*)::int AS n FROM personal_organizations WHERE user_id = $1`, [
          userId,
        ]),
      ).toBe(1)
      const members = await testDb.pool.query(
        `SELECT m.role, o.slug FROM auth.member m JOIN auth.organization o ON o.id = m."organizationId"
          WHERE m."userId" = $1`,
        [userId],
      )
      expect(members.rows).toEqual([{ role: 'owner', slug: 'grace' }])
    })

    it('cannot be deleted, while team organizations can', async () => {
      const cookie = await signIn('keeper@example.com')
      const personal = (await me({ cookie })).body.organization
      const remove = (organizationId: string) =>
        main.app.request('/api/auth/organization/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie, origin },
          body: JSON.stringify({ organizationId }),
        })

      const refused = await remove(personal.id)
      expect(refused.status).toBe(403)
      expect(await refused.json()).toMatchObject({ code: 'PERSONAL_ORGANIZATION' })
      expect((await me({ cookie })).body.organization).toEqual(personal)

      const team = await main.app.request('/api/auth/organization/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin },
        body: JSON.stringify({ name: 'Short-lived', slug: 'short-lived' }),
      })
      expect((await remove(((await team.json()) as { id: string }).id)).status).toBe(200)
    })

    it('gets a different slug when the plain one is taken', async () => {
      const { body } = await me({ cookie: await signIn('ada@another.example') })
      expect(body.organization.name).toBe('ada')
      expect(body.organization.slug).toMatch(/^ada-[a-z0-9]{6}$/)
    })
  })

  describe('API keys', () => {
    let cookie: string
    let personal: Me['organization']

    beforeAll(async () => {
      cookie = await signIn('agent-owner@example.com')
      personal = (await me({ cookie })).body.organization
    })

    it('authenticate /api/v1/me as an api_key principal in the personal organization', async () => {
      const res = await createKey(cookie)
      expect(res.status).toBe(200)
      const key = (await res.json()) as { id: string; key: string; metadata: unknown }
      expect(key.key).toMatch(/^hm_[A-Za-z]{64}$/)
      expect(key.metadata).toEqual({ organizationId: personal.id })

      const { res: meRes, body } = await me({ authorization: `Bearer ${key.key}` })
      expect(meRes.status).toBe(200)
      expect(body.user.email).toBe('agent-owner@example.com')
      expect(body.organization).toEqual(personal)
      expect(body.principal).toEqual({ kind: 'api_key', apiKeyId: key.id })
    })

    it('get a per-key rate limit that normal use stays well within', async () => {
      const key = (await (await createKey(cookie)).json()) as {
        key: string
        rateLimitEnabled: boolean
        rateLimitMax: number
        rateLimitTimeWindow: number
      }
      expect(key).toMatchObject({
        rateLimitEnabled: true,
        rateLimitMax: API_KEY_RATE_LIMIT.maxRequests,
        rateLimitTimeWindow: API_KEY_RATE_LIMIT.timeWindow,
      })
      expect(API_KEY_RATE_LIMIT).toEqual({ maxRequests: 600, timeWindow: 60_000 })
      for (let n = 0; n < 30; n++) {
        expect((await me({ authorization: `Bearer ${key.key}` })).res.status).toBe(200)
      }
    })

    it('log a rejected key as one line, without the key', async () => {
      const bad = `hm_${'q'.repeat(64)}`
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect((await me({ authorization: `Bearer ${bad}` })).res.status).toBe(401)
        expect(error).not.toHaveBeenCalled()
        expect(info.mock.calls).toEqual([['[auth] API key rejected: INVALID_API_KEY']])
      } finally {
        info.mockRestore()
        error.mockRestore()
      }
    })

    it('can be listed without their secret and revoked', async () => {
      const { id, key } = (await (await createKey(cookie, { name: 'revoke-me' })).json()) as {
        id: string
        key: string
      }
      const list = await main.app.request('/api/auth/api-key/list', { headers: { cookie } })
      const listed = JSON.stringify(await list.json())
      expect(listed).toContain(id)
      expect(listed).not.toContain(key)

      const revoked = await main.app.request('/api/auth/api-key/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin },
        body: JSON.stringify({ keyId: id }),
      })
      expect(revoked.status).toBe(200)
      const { res, body } = await me({ authorization: `Bearer ${key}` })
      expect(res.status).toBe(401)
      expect(body).toEqual({ error: 'unauthorized' })
    })

    it('reject invalid and malformed credentials with 401', async () => {
      for (const authorization of [
        `Bearer hm_${'x'.repeat(64)}`,
        'Bearer not-a-hourmere-key',
        'Basic dXNlcjpwYXNz',
        'Bearer',
      ]) {
        const { res, body } = await me({ authorization })
        expect(res.status, authorization).toBe(401)
        expect(body).toEqual({ error: 'unauthorized' })
      }
    })

    it('are judged alone: a bad key does not fall back to the session cookie', async () => {
      const { res } = await me({ cookie, authorization: `Bearer hm_${'x'.repeat(64)}` })
      expect(res.status).toBe(401)
    })

    it('can act in a team organization only while the owner is a member', async () => {
      const created = await main.app.request('/api/auth/organization/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin },
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      })
      expect(created.status).toBe(200)
      const team = (await created.json()) as { id: string }
      const key = (await (
        await createKey(cookie, { metadata: { organizationId: team.id } })
      ).json()) as {
        key: string
      }
      const bearer = { authorization: `Bearer ${key.key}` }
      expect((await me(bearer)).body.organization).toEqual({
        id: team.id,
        name: 'Acme',
        slug: 'acme',
        personal: false,
      })

      await testDb.pool.query(`DELETE FROM auth.member WHERE "organizationId" = $1`, [team.id])
      expect((await me(bearer)).res.status).toBe(401)
    })

    it('cannot be created for an organization the user does not belong to', async () => {
      const other = await signIn('outsider@example.com')
      const theirs = (await me({ cookie: other })).body.organization
      const res = await createKey(cookie, { metadata: { organizationId: theirs.id } })
      expect(res.status).toBe(403)
    })

    it('always use the hm_ prefix', async () => {
      expect((await createKey(cookie, { prefix: 'evil_' })).status).toBe(400)
    })

    it('need a session to be created', async () => {
      const victim = (await me({ cookie })).body.user.id
      for (const body of [{}, { userId: victim }, { userId: 'not-a-uuid' }]) {
        const res = await main.app.request('/api/auth/api-key/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'anonymous', ...body }),
        })
        expect(res.status, JSON.stringify(body)).toBe(401)
      }
    })

    it('answer 429 when their rate limit is used up', async () => {
      const key = (await (await createKey(cookie)).json()) as { id: string; key: string }
      const userId = (await me({ cookie })).body.user.id
      await main.auth.api.updateApiKey({ body: { keyId: key.id, userId, rateLimitMax: 1 } })
      const bearer = { authorization: `Bearer ${key.key}` }
      expect((await me(bearer)).res.status).toBe(200)
      const { res, body } = await me(bearer)
      expect(res.status).toBe(429)
      expect(body).toEqual({ error: 'rate_limited' })
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    })
  })

  describe('session security', () => {
    it('answers 401 without credentials and with a forged cookie', async () => {
      expect(await me({})).toMatchObject({ res: { status: 401 }, body: { error: 'unauthorized' } })
      const forged = await me({ cookie: 'better-auth.session_token=forged.value' })
      expect(forged.res.status).toBe(401)
    })

    it('refuses cookie-authenticated writes from another origin (CSRF)', async () => {
      const cookie = await signIn('csrf@example.com')
      const res = await main.app.request('/api/auth/api-key/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.example' },
        body: JSON.stringify({ name: 'stolen' }),
      })
      expect(res.status).toBe(403)
    })

    it('ends the session on sign-out', async () => {
      const cookie = await signIn('bye@example.com')
      const res = await main.app.request('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin },
        body: '{}',
      })
      expect(res.status).toBe(200)
      expect((await me({ cookie })).res.status).toBe(401)
    })
  })

  describe('client IP', () => {
    /** Signs in with the verify request arriving from `peer`; returns the IP the session records. */
    async function sessionIp(i: Instance, email: string, peer: string | null, headers = {}) {
      const link = await requestLink(email, i)
      const socket = peer === null ? undefined : { incoming: { socket: { remoteAddress: peer } } }
      const res = await i.app.request(link.toString(), { headers }, socket)
      expect(res.status).toBe(302)
      const row = await testDb.pool.query<{ ip: string }>(
        `SELECT s."ipAddress" AS ip FROM auth.session s JOIN auth."user" u ON u.id = s."userId"
          WHERE u.email = $1`,
        [email],
      )
      return row.rows[0]?.ip
    }

    const spoofed = { 'x-forwarded-for': '6.6.6.6', [CLIENT_IP_HEADER]: '7.7.7.7' }

    it('is the TCP peer, whatever an untrusted client claims', async () => {
      expect(await sessionIp(main, 'ip-direct@example.com', '203.0.113.7', spoofed)).toBe(
        '203.0.113.7',
      )
    })

    it('comes from X-Forwarded-For only through a trusted proxy', async () => {
      const proxied = instance(origin, { trustedProxies: ['10.0.0.0/8'] })
      // The proxy appends the client it saw; what the client wrote itself stays on the left.
      const headers = {
        'x-forwarded-for': '6.6.6.6, 198.51.100.9, 10.1.2.3',
        [CLIENT_IP_HEADER]: '7.7.7.7',
      }
      expect(await sessionIp(proxied, 'ip-proxied@example.com', '::ffff:10.0.0.2', headers)).toBe(
        '198.51.100.9',
      )
      // The same headers from a peer that is not a trusted proxy are ignored.
      expect(await sessionIp(proxied, 'ip-bypass@example.com', '203.0.113.8', headers)).toBe(
        '203.0.113.8',
      )
    })

    it('cannot be injected through the internal header, even without a known peer', async () => {
      const injected = { [CLIENT_IP_HEADER]: '7.7.7.7' }
      expect(await sessionIp(main, 'ip-injected@example.com', null, injected)).not.toBe('7.7.7.7')
    })
  })

  describe('social sign-in', () => {
    const providerIds = async (i: Instance) =>
      (await i.auth.$context).socialProviders.map((p) => p.id).sort()

    it('enables only the configured providers', async () => {
      expect(await providerIds(main)).toEqual([])
      const client = { clientId: 'id', clientSecret: 'secret' }
      expect(await providerIds(instance(origin, { socialProviders: { google: client } }))).toEqual([
        'google',
      ])
      const both = instance(origin, { socialProviders: { google: client, microsoft: client } })
      expect(await providerIds(both)).toEqual(['google', 'microsoft'])
    })
  })
})
