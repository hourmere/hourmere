// Sign-in, sessions, personal organizations and API keys end to end: the real app, Better
// Auth and migrations, against a throwaway database.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  API_KEY_RATE_LIMIT,
  type Auth,
  type AuthConfig,
  CLIENT_IP_HEADER,
  createAuth,
  createAuthPool,
  createCallerResolver,
  ensurePersonalOrganization,
  type OAuthClient,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { Hono } from 'hono'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { requireCaller } from './caller.ts'

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
  secret: string
}

describe.skipIf(!serverUrl)('sign-in and callers', () => {
  let testDb: TestDatabase
  let db: Db
  let authPool: pg.Pool
  const outbox: MailMessage[] = []

  interface InstanceOptions {
    socialProviders?: { google?: OAuthClient; microsoft?: OAuthClient }
    socialProviderOptions?: AuthConfig['socialProviderOptions']
    trustedProxies?: string[]
  }

  function instance(
    publicUrl: string,
    { socialProviders = {}, socialProviderOptions = {}, trustedProxies = [] }: InstanceOptions = {},
  ): Instance {
    const secret = randomBytes(32).toString('base64')
    const auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      mailer: { send: async (m) => void outbox.push(m) },
      socialProviders,
      socialProviderOptions,
    })
    const app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl,
      trustedProxies,
    })
    return { app, auth, publicUrl, secret }
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

  /** A cookie-authenticated POST from the web app's own origin. */
  const post = (path: string, cookie: string, body: unknown, app = main.app) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  const count = async (sql: string, params: unknown[]) =>
    (await testDb.pool.query<{ n: number }>(sql, params)).rows[0]?.n

  const userId = async (email: string) =>
    (
      await testDb.pool.query<{ id: string }>(`SELECT id FROM auth."user" WHERE email = $1`, [
        email,
      ])
    ).rows[0]?.id as string

  async function createTeam(cookie: string, slug: string) {
    const res = await post('/api/auth/organization/create', cookie, { name: slug, slug })
    expect(res.status).toBe(200)
    return ((await res.json()) as { id: string }).id
  }

  /**
   * An account whose email is not verified, with a signed-in session, as Better Auth keeps
   * one from a sign-in provider that did not vouch for the address (or as old data could
   * hold). The app no longer creates such accounts, so they are made by hand.
   */
  async function unverifiedUser(email: string, i: Instance = main) {
    const user = await testDb.pool.query<{ id: string }>(
      `INSERT INTO auth."user" (name, email, "emailVerified") VALUES ('Mallory', $1, false) RETURNING id`,
      [email],
    )
    const id = user.rows[0]?.id as string
    const organizationId = await ensurePersonalOrganization(db, id)
    const token = randomBytes(24).toString('base64url')
    await testDb.pool.query(
      `INSERT INTO auth.session ("expiresAt", token, "updatedAt", "userId", "activeOrganizationId")
       VALUES ($1, $2, now(), $3, $4)`,
      [new Date(Date.now() + 3_600_000), token, id, organizationId],
    )
    const signature = createHmac('sha256', i.secret).update(token).digest('base64')
    const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
    return { id, organizationId, cookie }
  }

  /** Stores an API key directly, as Better Auth would (only its SHA-256 is kept). */
  async function plantKey(userId: string, organizationId: string) {
    const key = `hm_${randomBytes(48)
      .toString('base64url')
      .replace(/[^A-Za-z]/g, '')
      .padEnd(64, 'x')
      .slice(0, 64)}`
    const row = await testDb.pool.query<{ id: string }>(
      `INSERT INTO auth.apikey ("configId", name, start, "referenceId", prefix, key, enabled,
         "rateLimitEnabled", "requestCount", "createdAt", "updatedAt", metadata)
       VALUES ('default', 'planted', $1, $2, 'hm_', $3, true, false, 0, now(), now(), $4) RETURNING id`,
      [
        key.slice(0, 6),
        userId,
        createHash('sha256').update(key).digest('base64url'),
        JSON.stringify({ organizationId }),
      ],
    )
    return { id: row.rows[0]?.id as string, key }
  }

  /** Captures everything printed while `fn` runs, split into lines. */
  async function printedLines(fn: () => Promise<unknown>): Promise<string[]> {
    const calls: unknown[][] = []
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args) => void calls.push(args)),
    )
    try {
      await fn()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    return calls.flatMap((args) =>
      args
        .map(String)
        .join(' ')
        .split(/\r\n|[\n\r\u2028\u2029\u0085]/),
    )
  }

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

    it('stores only a hash of the token, valid for 5 minutes', async () => {
      // Better Auth computes the expiry with this process's clock; so does the check (the
      // database clock may differ, e.g. under Docker Desktop).
      const before = Date.now()
      const link = await requestLink('hashed@example.com')
      const after = Date.now()
      const token = link.searchParams.get('token') as string
      const hash = createHash('sha256').update(token).digest('base64url')
      const row = (
        await testDb.pool.query<{ identifier: string; value: string; expiresAt: Date }>(
          `SELECT identifier, value, "expiresAt" FROM auth.verification WHERE identifier = $1`,
          [`magic-link:${hash}`],
        )
      ).rows[0]
      expect(row).toBeDefined()
      expect(`${row?.identifier}${row?.value}`).not.toContain(token)
      expect(
        await count(`SELECT count(*)::int AS n FROM auth.verification WHERE identifier LIKE $1`, [
          `%${token}%`,
        ]),
      ).toBe(0)
      const expiresAt = row?.expiresAt.getTime() ?? 0
      expect(expiresAt).toBeGreaterThanOrEqual(before + 300_000 - 2_000)
      expect(expiresAt).toBeLessThanOrEqual(after + 300_000 + 2_000)

      // Past its expiry the link no longer signs in.
      await testDb.pool.query(
        `UPDATE auth.verification SET "expiresAt" = $1 WHERE identifier = $2`,
        [new Date(Date.now() - 60_000), `magic-link:${hash}`],
      )
      const res = await main.app.request(link.toString())
      expect(res.headers.get('location')).toMatch(/[?&]error=/)
      expect(cookieHeader(res)).not.toContain('session_token')
    })

    it('cannot be imitated in the server log through a hostile callback URL', async () => {
      const fake = `${origin}/api/auth/magic-link/verify?token=forged&callbackURL=%2F`
      const forged = `https://evil.example/\n[mail] {"to":"admin@example.com","links":["${fake}"]}\r\n[mail] ${fake}`
      let status = 0
      const lines = await printedLines(async () => {
        const res = await main.app.request('/api/auth/sign-in/magic-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'admin@example.com', callbackURL: forged }),
        })
        status = res.status
      })
      expect(status).toBe(403)
      // Better Auth logs the rejected URL, but on one line with the breaks escaped.
      expect(lines.some((l) => l.includes('Invalid callbackURL') && l.includes('\\n[mail]'))).toBe(
        true,
      )
      expect(lines.filter((l) => l.startsWith('[mail]'))).toEqual([])
    })

    it('accept only known sort and filter fields, and UUIDs for id filters', async () => {
      const cookie = await signIn('lister@example.com')
      const self = await userId('lister@example.com')
      const forged = encodeURIComponent('zz\n[mail] {"forged":true}')
      const get = (path: string) => main.app.request(path, { headers: { cookie } })
      const cases: [string, number, string?][] = [
        [
          `/api/auth/organization/list-members?filterField=id&filterValue=${forged}`,
          400,
          'INVALID_ID',
        ],
        [
          `/api/auth/organization/list-members?filterField=userId&filterValue=${self}&filterValue=zz`,
          400,
          'INVALID_ID',
        ],
        [`/api/auth/organization/list-members?sortBy=${forged}`, 400, 'INVALID_FIELD'],
        [
          '/api/auth/organization/list-members?filterField=nope&filterValue=1',
          400,
          'INVALID_FIELD',
        ],
        [`/api/auth/api-key/list?sortBy=${forged}`, 400, 'INVALID_FIELD'],
        [`/api/auth/organization/list-members?filterField=userId&filterValue=${self}`, 200],
        ['/api/auth/organization/list-members?sortBy=createdAt', 200],
        ['/api/auth/api-key/list?sortBy=createdAt', 200],
      ]
      for (const [path, status, code] of cases) {
        const res = await get(path)
        expect(res.status, path).toBe(status)
        if (code) expect(await res.json(), path).toMatchObject({ code })
      }
    })

    it('rejects ids that are not UUIDs before they reach the database (and the log)', async () => {
      const cookie = await signIn('ids@example.com')
      const forged =
        'zz\n[mail] {"links":["http://localhost:3000/api/auth/magic-link/verify?token=forged"]}'
      const responses: Response[] = []
      const lines = await printedLines(async () => {
        responses.push(
          await main.app.request(
            `/api/auth/organization/get-full-organization?organizationId=${encodeURIComponent(forged)}`,
            { headers: { cookie } },
          ),
          await post('/api/auth/organization/remove-member', cookie, {
            memberIdOrEmail: forged,
            organizationId: (await me({ cookie })).body.organization.id,
          }),
          await post('/api/auth/api-key/update', cookie, { keyId: forged }),
        )
      })
      for (const res of responses) {
        expect(res.status).toBe(400)
        expect(await res.json()).toMatchObject({ code: 'INVALID_ID' })
      }
      expect(lines.filter((l) => l.startsWith('[mail]'))).toEqual([])
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

    describe("stays its owner's alone", () => {
      let alice: string
      let bob: string
      let personal: Me['organization']
      let aliceMemberId: string

      beforeAll(async () => {
        alice = await signIn('alice@example.com')
        bob = await signIn('bob@example.com')
        personal = (await me({ cookie: alice })).body.organization
        aliceMemberId = (
          await testDb.pool.query<{ id: string }>(
            `SELECT id FROM auth.member WHERE "organizationId" = $1`,
            [personal.id],
          )
        ).rows[0]?.id as string
      })

      const refused = async (res: Response) => {
        expect(res.status).toBe(403)
        expect(await res.json()).toMatchObject({ code: 'PERSONAL_ORGANIZATION' })
      }

      it('refuses invitations', async () => {
        await refused(
          await post('/api/auth/organization/invite-member', alice, {
            email: 'bob@example.com',
            role: 'owner',
            organizationId: personal.id,
          }),
        )
      })

      it('refuses accepting an invitation that exists anyway', async () => {
        const invitation = await testDb.pool.query<{ id: string }>(
          `INSERT INTO auth.invitation ("organizationId", email, role, status, "expiresAt", "inviterId")
           VALUES ($1, 'bob@example.com', 'owner', 'pending', now() + interval '1 day', $2) RETURNING id`,
          [personal.id, await userId('alice@example.com')],
        )
        await refused(
          await post('/api/auth/organization/accept-invitation', bob, {
            invitationId: invitation.rows[0]?.id,
          }),
        )
      })

      it('refuses adding members', async () => {
        await expect(
          main.auth.api.addMember({
            body: {
              userId: await userId('bob@example.com'),
              organizationId: personal.id,
              role: 'owner',
            },
          }),
        ).rejects.toMatchObject({ body: { code: 'PERSONAL_ORGANIZATION' } })
      })

      it('keeps its owner even if a second owner exists', async () => {
        // Not possible through the API any more; a row like this could only predate the rule.
        await testDb.pool.query(
          `INSERT INTO auth.member ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, 'owner', now())`,
          [personal.id, await userId('bob@example.com')],
        )
        await refused(
          await post('/api/auth/organization/update-member-role', bob, {
            memberId: aliceMemberId,
            role: 'member',
            organizationId: personal.id,
          }),
        )
        await refused(
          await post('/api/auth/organization/remove-member', bob, {
            memberIdOrEmail: aliceMemberId,
            organizationId: personal.id,
          }),
        )
        // Leaving has no Better Auth hook; with a second owner its own rule would allow it.
        await refused(
          await post('/api/auth/organization/leave', alice, { organizationId: personal.id }),
        )
        expect((await me({ cookie: alice })).body.organization).toEqual(personal)
      })
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

      // Someone else stays a member; only the key's owner leaves.
      await signIn('acme-colleague@example.com')
      await testDb.pool.query(
        `INSERT INTO auth.member ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, 'owner', now())`,
        [team.id, await userId('acme-colleague@example.com')],
      )
      await testDb.pool.query(
        `DELETE FROM auth.member WHERE "organizationId" = $1 AND "userId" = $2`,
        [team.id, await userId('agent-owner@example.com')],
      )
      expect((await me(bearer)).res.status).toBe(401)
    })

    it('cannot be moved to an organization the user does not belong to', async () => {
      const key = (await (await createKey(cookie)).json()) as { id: string; key: string }
      const theirs = (await me({ cookie: await signIn('neighbour@example.com') })).body.organization
      const res = await post('/api/auth/api-key/update', cookie, {
        keyId: key.id,
        metadata: { organizationId: theirs.id },
      })
      expect(res.status).toBe(403)
      expect((await me({ authorization: `Bearer ${key.key}` })).body.organization).toEqual(personal)
    })

    it('accept only { organizationId } as metadata', async () => {
      const raw = (metadata: string) => `{"name":"agent","metadata":${metadata}}`
      for (const metadata of [
        `{"__proto__":{"organizationId":"${personal.id}"}}`,
        `{"organizationId":"${personal.id}","__proto__":{"admin":true}}`,
        '[]',
        `["${personal.id}"]`,
        `{"organizationId":"${personal.id}","note":"x"}`,
        '{"organizationId":"not-a-uuid"}',
        `{"organizationId":"${'a'.repeat(100_000)}"}`,
        '"text"',
      ]) {
        const res = await post('/api/auth/api-key/create', cookie, raw(metadata))
        expect(res.status, metadata.slice(0, 80)).toBe(400)
      }
      const key = (await (await createKey(cookie)).json()) as { id: string }
      const update = await post(
        '/api/auth/api-key/update',
        cookie,
        `{"keyId":"${key.id}","metadata":{"__proto__":{"x":1}}}`,
      )
      expect(update.status).toBe(400)
      // The owner's key list still works.
      const list = await main.app.request('/api/auth/api-key/list', { headers: { cookie } })
      expect(list.status).toBe(200)
      // null means "the personal organization".
      const reset = await post('/api/auth/api-key/update', cookie, {
        keyId: key.id,
        metadata: null,
      })
      expect(reset.status).toBe(200)
      expect(((await reset.json()) as { metadata: unknown }).metadata).toEqual({
        organizationId: personal.id,
      })
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
      const cases: [Record<string, string>, number][] = [
        [{}, 401],
        [{ userId: victim }, 401],
        [{ userId: 'not-a-uuid' }, 400],
      ]
      for (const [body, status] of cases) {
        const res = await main.app.request('/api/auth/api-key/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'anonymous', ...body }),
        })
        expect(res.status, JSON.stringify(body)).toBe(status)
      }
    })

    it('cannot be created or changed by a user whose email is not verified', async () => {
      const mallory = await unverifiedUser('unverified-keys@example.com')
      const created = await post('/api/auth/api-key/create', mallory.cookie, { name: 'mine' })
      expect(created.status).toBe(403)
      expect(await created.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' })
      const planted = await plantKey(mallory.id, mallory.organizationId)
      const updated = await post('/api/auth/api-key/update', mallory.cookie, {
        keyId: planted.id,
        name: 'renamed',
      })
      expect(updated.status).toBe(403)
      expect(
        await count(`SELECT count(*)::int AS n FROM auth.apikey WHERE "referenceId" = $1`, [
          mallory.id,
        ]),
      ).toBe(1)

      // Switching a key off only takes power away, so it is allowed.
      const disabled = await post('/api/auth/api-key/update', mallory.cookie, {
        keyId: planted.id,
        enabled: false,
      })
      expect(disabled.status).toBe(200)
      const row = await testDb.pool.query(`SELECT enabled FROM auth.apikey WHERE id = $1`, [
        planted.id,
      ])
      expect(row.rows).toEqual([{ enabled: false }])
    })

    it("do not authenticate while their owner's email is not verified", async () => {
      const mallory = await unverifiedUser('unverified-bearer@example.com')
      const planted = await plantKey(mallory.id, mallory.organizationId)
      const { res, body } = await me({ authorization: `Bearer ${planted.key}` })
      expect(res.status).toBe(401)
      expect(body).toEqual({ error: 'unauthorized' })
    })

    it('do not survive the owner proving the email while key creation is under way', async () => {
      // The original race: requests from the unverified account's session interleaved with
      // the real owner's email-link sign-in, which revokes that session and verifies the email.
      const mallory = await unverifiedUser('race@example.com')
      const link = await requestLink('race@example.com')
      const creates = Array.from({ length: 10 }, () =>
        post('/api/auth/api-key/create', mallory.cookie, { name: 'racer' }),
      )
      const [verify, ...results] = await Promise.all([
        main.app.request(link.toString()),
        ...creates,
      ])
      expect(verify?.status).toBe(302)
      expect(results.map((r) => r.status).filter((s) => s === 200)).toEqual([])
      expect(
        await count(`SELECT count(*)::int AS n FROM auth.apikey WHERE "referenceId" = $1`, [
          mallory.id,
        ]),
      ).toBe(0)
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

    it('acts in the active organization only while the user is a member of it', async () => {
      const cookie = await signIn('switcher@example.com')
      const personal = (await me({ cookie })).body.organization
      const team = await createTeam(cookie, 'switchers')
      const switched = await post('/api/auth/organization/set-active', cookie, {
        organizationId: team,
      })
      expect(switched.status).toBe(200)
      expect((await me({ cookie })).body.organization.id).toBe(team)

      await signIn('switcher-colleague@example.com')
      await testDb.pool.query(
        `INSERT INTO auth.member ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, 'owner', now())`,
        [team, await userId('switcher-colleague@example.com')],
      )
      await testDb.pool.query(
        `DELETE FROM auth.member WHERE "organizationId" = $1 AND "userId" = $2`,
        [team, await userId('switcher@example.com')],
      )
      expect((await me({ cookie })).body.organization).toEqual(personal)
    })

    describe('writes through requireCaller', () => {
      // A stand-in for future /api/v1 write endpoints.
      let writer: Hono
      beforeAll(() => {
        writer = new Hono()
        const caller = requireCaller(createCallerResolver({ auth: main.auth, db }), {
          allowedOrigin: origin,
        })
        writer.on(['GET', 'POST'], '/write', caller, (c) => c.json({ kind: c.var.principal.kind }))
      })
      const write = (headers: Record<string, string>, method = 'POST') =>
        writer.request('/write', { method, headers })

      it("need the app's own origin when authenticated by the session cookie", async () => {
        const cookie = await signIn('writer@example.com')
        expect((await write({ cookie })).status).toBe(403)
        expect((await write({ cookie, origin: 'https://evil.example' })).status).toBe(403)
        expect((await write({ cookie, origin: 'null' })).status).toBe(403)
        expect(
          (await write({ cookie, origin: 'null', referer: `${origin}/settings` })).status,
        ).toBe(403)
        expect((await write({ cookie, referer: 'https://evil.example/page' })).status).toBe(403)
        expect(
          await (await write({ cookie, origin: 'https://evil.example' })).json(),
        ).toMatchObject({
          error: 'forbidden',
        })
        expect((await write({ cookie, origin })).status).toBe(200)
        expect((await write({ cookie, referer: `${origin}/settings` })).status).toBe(200)
        expect((await write({ cookie }, 'GET')).status).toBe(200)
      })

      it('do not need an origin with an API key', async () => {
        const cookie = await signIn('writer-agent@example.com')
        const key = (await (await createKey(cookie)).json()) as { key: string }
        const res = await write({ authorization: `Bearer ${key.key}` })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ kind: 'api_key' })
      })
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

  describe('unexpected errors', () => {
    it('are logged on one escaped line', async () => {
      const app = createApp({
        checkDb: async () => {},
        authHandler: async () => {
          throw new Error('boom\n[mail] {"forged":true}')
        },
        resolveCaller: createCallerResolver({ auth: main.auth, db }),
        publicUrl: origin,
      })
      let res: Response | undefined
      const lines = await printedLines(async () => {
        res = await app.request('/api/auth/whatever')
      })
      expect(res?.status).toBe(500)
      expect(await res?.json()).toEqual({ error: 'internal_error' })
      expect(lines.filter((l) => l.includes('boom'))).toHaveLength(1)
      expect(lines.filter((l) => l.startsWith('[mail]') || l.startsWith('    at '))).toEqual([])
    })

    it('from Better Auth reach that handler instead of being printed raw', async () => {
      // An SMTP failure inside a Better Auth endpoint, with request-like text in its message.
      const auth = createAuth({
        pool: authPool,
        db,
        baseURL: origin,
        secret: randomBytes(32).toString('base64'),
        mailer: {
          send: async () => {
            throw new Error('smtp down\n[mail] {"forged":true}')
          },
        },
      })
      const app = createApp({
        checkDb: async () => {},
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        publicUrl: origin,
      })
      let res: Response | undefined
      const lines = await printedLines(async () => {
        res = await app.request('/api/auth/sign-in/magic-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'nobody@example.com', callbackURL: '/' }),
        })
      })
      expect(res?.status).toBe(500)
      expect(await res?.json()).toEqual({ error: 'internal_error' })
      expect(lines.some((l) => l.includes('ERROR POST /api/auth/sign-in/magic-link'))).toBe(true)
      expect(
        lines.filter(
          (l) => l.startsWith('    at ') || l.startsWith('[mail]') || l.includes('# SERVER_ERROR'),
        ),
      ).toEqual([])
    })
  })

  describe('social sign-in', () => {
    const providerIds = async (i: Instance) =>
      (await i.auth.$context).socialProviders.map((p) => p.id).sort()

    const client = { clientId: 'id', clientSecret: 'secret' }

    /** A provider whose (already verified) ID token says the user is `profile`. */
    const vouching = (profile: { id: string; email: string; emailVerified: boolean }) => ({
      verifyIdToken: async () => true,
      getUserInfo: async () => ({
        user: { email: profile.email, emailVerified: profile.emailVerified, name: 'From provider' },
        // Only the claims the account key is read from (Microsoft: oid, Google: sub).
        data: { oid: profile.id, sub: profile.id } as never,
      }),
    })

    const socialSignIn = (i: Instance, provider: 'google' | 'microsoft') =>
      i.app.request('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, idToken: { token: 'header.payload.signature' } }),
      })

    it('creates an account when the provider confirms the email address', async () => {
      const google = instance(origin, {
        socialProviders: { google: client },
        socialProviderOptions: {
          google: vouching({ id: 'g-1', email: 'social@example.com', emailVerified: true }),
        },
      })
      const res = await socialSignIn(google, 'google')
      expect(res.status).toBe(200)
      const { body } = await me({ cookie: cookieHeader(res) }, google.app)
      expect(body.user.email).toBe('social@example.com')
      expect(body.organization.personal).toBe(true)
    })

    it('refuses an unconfirmed email address, so nobody can take over its future owner', async () => {
      // Mallory's Microsoft account claims the victim's address without Microsoft confirming it.
      const microsoft = instance(origin, {
        socialProviders: { microsoft: client },
        socialProviderOptions: {
          microsoft: vouching({
            id: 'ms-mallory',
            email: 'victim@example.com',
            emailVerified: false,
          }),
        },
      })
      const first = await socialSignIn(microsoft, 'microsoft')
      expect(first.status).toBe(403)
      expect(await first.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' })
      expect(cookieHeader(first)).not.toContain('session_token')
      expect(await userId('victim@example.com')).toBeUndefined()

      // The victim signs up with an email link; Mallory still cannot get in through Microsoft.
      const victim = await signIn('victim@example.com', microsoft)
      const again = await socialSignIn(microsoft, 'microsoft')
      expect(again.status).toBe(401)
      expect(cookieHeader(again)).not.toContain('session_token')
      expect(
        await count(`SELECT count(*)::int AS n FROM auth.account WHERE "userId" = $1`, [
          await userId('victim@example.com'),
        ]),
      ).toBe(0)
      expect((await me({ cookie: victim }, microsoft.app)).res.status).toBe(200)
    })

    it('revokes API keys made before the owner proved the email address', async () => {
      // An unverified account with a key in it, as Better Auth keeps one from a provider that
      // did not vouch for the address (and as a database could hold from before the rule).
      const mallory = await unverifiedUser('late@example.com')
      const planted = await plantKey(mallory.id, mallory.organizationId)
      const keys = () =>
        count(`SELECT count(*)::int AS n FROM auth.apikey WHERE "referenceId" = $1`, [mallory.id])
      expect(await keys()).toBe(1)

      // The real owner signs in with an email link: Better Auth revokes the unproven access,
      // and the database deletes the key.
      await signIn('late@example.com')
      expect(await keys()).toBe(0)
      expect((await me({ authorization: `Bearer ${planted.key}` })).res.status).toBe(401)
    })

    it('does not let a login of an unverified account outlive its owner proving the email', async () => {
      // An old unverified account with Mallory's Microsoft account linked to it.
      const mallory = await unverifiedUser('inflight@example.com')
      await testDb.pool.query(
        `INSERT INTO auth.account ("accountId", "providerId", "userId", "updatedAt")
         VALUES ('ms-inflight', 'microsoft', $1, now())`,
        [mallory.id],
      )
      // The real owner's email-link sign-in completes while Mallory's login is between loading
      // the account and creating its session: a trigger does what that sign-in does (drop the
      // linked accounts and sessions, mark the email verified) just before the login's session
      // is stored.
      await testDb.pool.query(`
        CREATE FUNCTION test_owner_proves_email() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM auth."user" WHERE id = NEW."userId" AND NOT "emailVerified"
                     AND email = 'inflight@example.com') THEN
            DELETE FROM auth.account WHERE "userId" = NEW."userId";
            DELETE FROM auth.session WHERE "userId" = NEW."userId";
            UPDATE auth."user" SET "emailVerified" = true WHERE id = NEW."userId";
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER test_owner_proves_email BEFORE INSERT ON auth.session
          FOR EACH ROW EXECUTE FUNCTION test_owner_proves_email();`)
      try {
        const microsoft = instance(origin, {
          socialProviders: { microsoft: client },
          socialProviderOptions: {
            microsoft: vouching({
              id: 'ms-inflight',
              email: 'inflight@example.com',
              emailVerified: false,
            }),
          },
        })
        const login = await socialSignIn(microsoft, 'microsoft')
        expect(login.status).toBe(403)
        expect(await login.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' })
        const cookie = cookieHeader(login)
        expect(cookie).not.toContain('session_token')
        const created = await post('/api/auth/api-key/create', cookie, { name: 'x' }, microsoft.app)
        expect(created.status).not.toBe(200)
        expect(
          await count(`SELECT count(*)::int AS n FROM auth.apikey WHERE "referenceId" = $1`, [
            mallory.id,
          ]),
        ).toBe(0)
      } finally {
        await testDb.pool.query(`
          DROP TRIGGER test_owner_proves_email ON auth.session;
          DROP FUNCTION test_owner_proves_email();`)
      }
    })

    it('makes invitations require a proven email address', () => {
      const org = main.auth.options.plugins.find((p) => p.id === 'organization') as {
        options?: { requireEmailVerificationOnInvitation?: boolean }
      }
      expect(org.options?.requireEmailVerificationOnInvitation).toBe(true)
    })

    it('enables only the configured providers', async () => {
      expect(await providerIds(main)).toEqual([])
      expect(await providerIds(instance(origin, { socialProviders: { google: client } }))).toEqual([
        'google',
      ])
      const both = instance(origin, { socialProviders: { google: client, microsoft: client } })
      expect(await providerIds(both)).toEqual(['google', 'microsoft'])
    })
  })
})
