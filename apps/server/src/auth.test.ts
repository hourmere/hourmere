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
  DISPLAY_NAME_MAX_LENGTH,
  ensurePersonalOrganization,
  type OAuthClient,
  type SignupPolicy,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { Hono } from 'hono'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { requireCaller } from './caller.ts'
import { chunkedBody } from './chunked-body.ts'
import { profileRoutes } from './routes/profile.ts'
import { pressConfirmButton } from './sign-in-confirm-testing.ts'

const serverUrl = process.env.DATABASE_URL
// Sign-up control has its own tests (signup.test.ts).
const OPEN: SignupPolicy = { mode: 'open', allowedDomains: [] }
const signUpName = `  Ada\r\nLovelace\u2028${'😀'.repeat(110)}  `
const cleanSignUpName = `Ada Lovelace ${'😀'.repeat(93)}`

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
    pool?: pg.Pool
  }

  function instance(
    publicUrl: string,
    {
      socialProviders = {},
      socialProviderOptions = {},
      trustedProxies = [],
      pool = authPool,
    }: InstanceOptions = {},
  ): Instance {
    const secret = randomBytes(32).toString('base64')
    const auth = createAuth({
      pool,
      db,
      baseURL: publicUrl,
      secret,
      mailer: { send: async (m) => void outbox.push(m) },
      signup: OPEN,
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
    authPool = createAuthPool(testDb.url, OPEN)
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

  /** Waits until a sign-in email has been sent: that happens after the answer. */
  const afterSend = () => new Promise<void>((resolve) => setImmediate(resolve))

  /** Requests a magic link and returns the link in the email it sends. */
  async function emailedLink(email: string, { app }: Instance = main, name?: string): Promise<URL> {
    const before = outbox.length
    const res = await app.request('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, callbackURL: '/', name }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: true })
    await afterSend()
    const mail = outbox.slice(before).find((m) => m.to === email)
    expect(mail?.subject).toBe('Sign in to Hourmere')
    const link = mail?.text.match(/https?:\/\/\S+/)?.[0]
    expect(link).toBeDefined()
    return new URL(link as string)
  }

  /** Requests a magic link and returns what pressing the button on the page it opens requests. */
  async function requestLink(email: string, i: Instance = main): Promise<URL> {
    return pressConfirmButton(i.app, await emailedLink(email, i))
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

  /**
   * A Better Auth pool that can pause a request: once armed with a pattern, the first
   * statement whose SQL matches runs (and commits), then its result is held back until
   * `release()`. Lets a test interleave another request at an exact point.
   */
  function pausingPool() {
    const pool = createAuthPool(testDb.url, OPEN)
    let pattern: RegExp | undefined
    let reached = () => {}
    let release = () => {}
    const paused = new Promise<void>((resolve) => {
      reached = resolve
    })
    const resumed = new Promise<void>((resolve) => {
      release = resolve
    })
    const forward = <T extends object>(target: T, prop: string | symbol) => {
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    }
    const holding = (client: pg.PoolClient) =>
      new Proxy(client, {
        get(target, prop) {
          if (prop !== 'query') return forward(target, prop)
          return async (...args: unknown[]) => {
            const result = await (target.query as (...a: unknown[]) => Promise<unknown>)(...args)
            if (typeof args[0] === 'string' && pattern?.test(args[0])) {
              pattern = undefined
              reached()
              await resumed
            }
            return result
          }
        },
      })
    const proxy = new Proxy(pool, {
      get(target, prop) {
        if (prop === 'connect') return async () => holding(await target.connect())
        return forward(target, prop)
      },
    })
    return {
      pool: proxy,
      arm: (p: RegExp) => {
        pattern = p
      },
      paused,
      release: () => release(),
      end: () => pool.end(),
    }
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
    it('sanitizes a sign-up name before creating the account and personal organization', async () => {
      const email = 'clean-signup-name@example.com'
      const link = await pressConfirmButton(main.app, await emailedLink(email, main, signUpName))
      const response = await main.app.request(link.toString())
      expect(response.status).toBe(302)
      const { res, body } = await me({ cookie: cookieHeader(response) })
      expect(res.status).toBe(200)
      expect(body.user).toMatchObject({ email, name: cleanSignUpName })
      expect(body.organization.name).toBe(cleanSignUpName)
      expect(
        await db
          .selectFrom('auth.user')
          .select('name')
          .where('email', '=', email)
          .executeTakeFirst(),
      ).toEqual({ name: cleanSignUpName })
    })

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

    it('can be requested with a streamed body, within the 64 KB limit', async () => {
      const send = (body: string) =>
        main.app.request('/api/auth/sign-in/magic-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          ...chunkedBody(body).init,
        })
      const before = outbox.length
      const small = await send(JSON.stringify({ email: 'streamed@example.com', callbackURL: '/' }))
      expect(small.status).toBe(200)
      expect(await small.json()).toEqual({ status: true })
      await afterSend()
      expect(outbox.slice(before).map((m) => m.to)).toEqual(['streamed@example.com'])
      const big = await send(
        JSON.stringify({ email: 'big@example.com', callbackURL: `/${'x'.repeat(64 * 1024)}` }),
      )
      expect(big.status).toBe(413)
      expect(await big.json()).toEqual({ error: 'payload_too_large' })
      await afterSend()
      expect(outbox.slice(before).map((m) => m.to)).toEqual(['streamed@example.com'])
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
      expect(again.headers.get('location')).toBe(`${origin}/sign-in?error=INVALID_TOKEN`)
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

    it('accept only known sort and filter fields, exact filters, and UUIDs for id filters', async () => {
      const cookie = await signIn('lister@example.com')
      const self = await userId('lister@example.com')
      const other = '00000000-0000-4000-8000-000000000000'
      const forged = encodeURIComponent('zz\n[mail] {"forged":true}')
      const members = '/api/auth/organization/list-members'
      const cases: [string, number, string?][] = [
        [`${members}?filterField=id&filterValue=${forged}`, 400, 'INVALID_ID'],
        [
          `${members}?filterField=userId&filterOperator=in&filterValue=${self}&filterValue=zz`,
          400,
          'INVALID_ID',
        ],
        [
          `${members}?filterField=userId&filterOperator=in&filterValue=${self}`,
          400,
          'INVALID_FILTER',
        ],
        [
          `${members}?filterField=userId&filterValue=${self}&filterValue=${self}`,
          400,
          'INVALID_FILTER',
        ],
        [
          `${members}?filterField=role&filterOperator=contains&filterValue=own`,
          400,
          'INVALID_FILTER',
        ],
        [`${members}?filterField=role`, 400, 'INVALID_FILTER'],
        [`${members}?filterField=createdAt&filterValue=2026-01-01`, 400, 'INVALID_FIELD'],
        [`${members}?sortBy=${forged}`, 400, 'INVALID_FIELD'],
        [`${members}?filterField=nope&filterValue=1`, 400, 'INVALID_FIELD'],
        [`/api/auth/api-key/list?sortBy=${forged}`, 400, 'INVALID_FIELD'],
        ['/api/auth/api-key/list?filterField=name&filterValue=x', 400, 'INVALID_FIELD'],
        [`${members}?filterField=userId&filterValue=${self}`, 200],
        [
          `${members}?filterField=userId&filterOperator=in&filterValue=${self}&filterValue=${other}`,
          200,
        ],
        [`${members}?sortBy=createdAt&sortDirection=desc`, 200],
        ['/api/auth/api-key/list?sortBy=createdAt', 200],
        [`${members}?offset=abc`, 400, 'INVALID_QUERY'],
        [`${members}?offset=0.5`, 400, 'INVALID_QUERY'],
        [`${members}?limit=-1`, 400, 'INVALID_QUERY'],
        [`${members}?offset=1e3`, 400, 'INVALID_QUERY'],
        ['/api/auth/api-key/list?limit=abc', 400, 'INVALID_QUERY'],
        [`${members}?filterField=role&filterValue=a%00b`, 400, 'INVALID_FILTER'],
        [`${members}?organizationSlug=a%00b`, 400, 'INVALID_QUERY'],
        // A repeated slug is refused rather than answered for some other organization.
        [
          `${members}?organizationSlug=a&organizationSlug=b&filterField=role&filterValue=admin`,
          400,
          'INVALID_QUERY',
        ],
        [`${members}?limit=10&offset=0`, 200],
      ]
      for (const [path, status, code] of cases) {
        const res = await main.app.request(path, { headers: { cookie } })
        expect(res.status, path).toBe(status)
        if (code) expect(await res.json(), path).toMatchObject({ code })
      }

      // Server-side calls pass paging as numbers, which Better Auth accepts too.
      const headers = new Headers({ cookie })
      const paging = { limit: 10, offset: 0 }
      await expect(main.auth.api.listMembers({ headers, query: paging })).resolves.toMatchObject({
        total: 1,
      })
      await expect(main.auth.api.listApiKeys({ headers, query: paging })).resolves.toMatchObject({
        total: 0,
      })
      for (const query of [{ offset: -1 }, { offset: 0.5 }, { limit: 1e9 }]) {
        await expect(
          main.auth.api.listMembers({ headers, query }),
          JSON.stringify(query),
        ).rejects.toMatchObject({ body: { code: 'INVALID_QUERY' } })
      }
    })

    it('list no members (instead of failing) when a filter or offset leaves nothing', async () => {
      const cookie = await signIn('empty-lister@example.com')
      const self = await userId('empty-lister@example.com')
      const other = '00000000-0000-4000-8000-000000000000'
      const members = '/api/auth/organization/list-members'
      const empty: [string, number][] = [
        [`${members}?filterField=role&filterValue=admin`, 0],
        [
          `${members}?filterField=userId&filterOperator=not_in&filterValue=${self}&filterValue=${other}`,
          0,
        ],
        [`${members}?offset=5`, 1],
        // The last member is at offset 0, so offset 1 (= total) is past the end.
        [`${members}?offset=1`, 1],
      ]
      const mine = (await me({ cookie })).body.organization
      empty.push(
        // By slug, and an empty slug counting as absent (as in Better Auth).
        [`${members}?organizationSlug=${mine.slug}&filterField=role&filterValue=admin`, 0],
        [`${members}?organizationId=${mine.id}&organizationSlug=&offset=3`, 1],
      )
      for (const [path, total] of empty) {
        const res = await main.app.request(path, { headers: { cookie } })
        expect(res.status, path).toBe(200)
        expect(await res.json(), path).toEqual({ members: [], total })
      }
      // A team with two members, reached by its slug while the session acts in another
      // organization (creating it makes it active, so switch back first).
      const team = await createTeam(cookie, 'empty-listers')
      await signIn('empty-lister-colleague@example.com')
      await testDb.pool.query(
        `INSERT INTO auth.member ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, 'member', now())`,
        [team, await userId('empty-lister-colleague@example.com')],
      )
      await post('/api/auth/organization/set-active', cookie, { organizationId: mine.id })
      const bySlug = await main.app.request(`${members}?organizationSlug=empty-listers&offset=2`, {
        headers: { cookie },
      })
      expect(await bySlug.json()).toEqual({ members: [], total: 2 })

      // Pages that do hold members are Better Auth's to list.
      const first = await main.app.request(`${members}?offset=0`, { headers: { cookie } })
      expect(((await first.json()) as { members: unknown[]; total: number }).total).toBe(1)

      // Other organizations stay Better Auth's to refuse, and their member counts unknown.
      const theirs = (await me({ cookie: await signIn('not-mine@example.com') })).body.organization
      for (const query of [
        `organizationId=${theirs.id}`,
        `organizationId=${theirs.id}&offset=99`,
        `organizationId=${theirs.id}&filterField=role&filterValue=admin`,
        `organizationSlug=${theirs.slug}&offset=99`,
      ]) {
        const refused = await main.app.request(`${members}?${query}`, { headers: { cookie } })
        expect(refused.status, query).toBe(403)
        expect(JSON.stringify(await refused.json()), query).not.toContain('total')
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
      expect(res.headers.get('location')).toBe(`${origin}/sign-in?error=INVALID_TOKEN`)
      expect(cookieHeader(res)).not.toContain('session_token')
    })

    it.each(['/app/settings', '/welcome?tab=1', ''])(
      'defaults magic-link failure to sign-in instead of the success destination (%s)',
      async (callbackURL) => {
        const query = new URLSearchParams({
          token: 'unknown-token',
          callbackURL,
          errorCallbackURL: '',
        })
        const response = await main.app.request(`/api/auth/magic-link/verify?${query}`)
        expect(response.status).toBe(302)
        expect(response.headers.get('location')).toBe(`${origin}/sign-in?error=INVALID_TOKEN`)
        expect(cookieHeader(response)).not.toContain('session_token')
      },
    )

    it('uses the same default for server-side verification calls', async () => {
      const response = await main.auth.api.magicLinkVerify({
        query: { token: 'unknown-server-token', callbackURL: '/app/settings' },
        headers: new Headers(),
        method: 'GET',
        asResponse: true,
      })
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(`${origin}/sign-in?error=INVALID_TOKEN`)
    })

    it('lands an expired emailed link on sign-in without creating a user or session', async () => {
      const email = 'expired-default-landing@example.com'
      const submit = await requestLink(email)
      const token = submit.searchParams.get('token') as string
      const hash = createHash('sha256').update(token).digest('base64url')
      await testDb.pool.query(
        `UPDATE auth.verification SET "expiresAt" = now() - interval '1 minute' WHERE identifier = $1`,
        [`magic-link:${hash}`],
      )
      const response = await main.app.request(submit.toString())
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(`${origin}/sign-in?error=INVALID_TOKEN`)
      expect(cookieHeader(response)).not.toContain('session_token')
      expect(
        await count('SELECT count(*)::int AS n FROM auth."user" WHERE email = $1', [email]),
      ).toBe(0)
    })

    it('keeps the success destination but sends a replay to the default error page', async () => {
      const submit = await requestLink('used-default-landing@example.com')
      submit.searchParams.set('callbackURL', '/app/settings')
      const first = await main.app.request(submit.toString())
      expect(first.status).toBe(302)
      expect(first.headers.get('location')).toBe(`${origin}/app/settings`)
      const replay = await main.app.request(submit.toString())
      expect(replay.headers.get('location')).toBe(`${origin}/sign-in?error=INVALID_TOKEN`)
      expect(cookieHeader(replay)).not.toContain('session_token')
      expect((await me({ cookie: cookieHeader(first) })).res.status).toBe(200)
    })

    it('still refuses an untrusted explicit error callback before consuming the link', async () => {
      const submit = await requestLink('untrusted-error-landing@example.com')
      submit.searchParams.set('errorCallbackURL', 'https://evil.example/sign-in')
      const refused = await main.app.request(submit.toString())
      expect(refused.status).toBe(403)
      expect(refused.headers.get('location')).toBeNull()
      submit.searchParams.delete('errorCallbackURL')
      const valid = await main.app.request(submit.toString())
      expect(valid.status).toBe(302)
      expect(valid.headers.get('location')).toBe(`${origin}/`)
    })

    it('keeps the token out of the log from the request to the signed-in redirect', async () => {
      let token = ''
      const lines = await printedLines(async () => {
        const link = await emailedLink('quiet@example.com')
        token = new URLSearchParams(link.hash.slice(1)).get('token') as string
        const res = await main.app.request((await pressConfirmButton(main.app, link)).toString())
        expect(res.status).toBe(302)
      })
      expect(token).toMatch(/^[A-Za-z]{32}$/)
      expect(lines.some((l) => l.includes('/api/auth/magic-link/verify'))).toBe(true)
      expect(lines.join('\n')).not.toContain(token)
    })

    describe('confirm page', () => {
      const tokenOf = (link: URL) => new URLSearchParams(link.hash.slice(1)).get('token') as string

      it('is where the email links, with the token only in the fragment', async () => {
        const link = await emailedLink('confirm@example.com')
        expect(`${link.origin}${link.pathname}`).toBe(`${origin}/sign-in/confirm`)
        expect(link.search).toBe('')
        expect(Object.fromEntries(new URLSearchParams(link.hash.slice(1)))).toEqual({
          token: expect.stringMatching(/^[A-Za-z]{32}$/),
          callbackURL: '/',
        })
      })

      it('does not use up the link when opened, as mail scanners do; its button signs in', async () => {
        const link = await emailedLink('scanned@example.com')
        // Requests never carry the fragment.
        for (const method of ['GET', 'HEAD', 'GET']) {
          const res = await main.app.request(`${link.origin}${link.pathname}`, { method })
          expect(res.status, method).toBe(200)
          expect(res.headers.getSetCookie(), method).toEqual([])
        }
        const hash = createHash('sha256').update(tokenOf(link)).digest('base64url')
        expect(
          await count(`SELECT count(*)::int AS n FROM auth.verification WHERE identifier = $1`, [
            `magic-link:${hash}`,
          ]),
        ).toBe(1)

        const res = await main.app.request((await pressConfirmButton(main.app, link)).toString())
        expect(res.status).toBe(302)
        expect(res.headers.get('location')).toBe(`${origin}/`)
        expect((await me({ cookie: cookieHeader(res) })).body.user.email).toBe(
          'scanned@example.com',
        )
      })

      it('passes callbackURL and errorCallbackURL on to Better Auth unchanged', async () => {
        const before = outbox.length
        const requested = await main.app.request('/api/auth/sign-in/magic-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'callbacks@example.com',
            callbackURL: '/welcome?tab=1',
            errorCallbackURL: '/oops',
          }),
        })
        expect(requested.status).toBe(200)
        await afterSend()
        const text = outbox.slice(before).find((m) => m.to === 'callbacks@example.com')?.text
        const submit = await pressConfirmButton(
          main.app,
          new URL(text?.match(/https?:\/\/\S+/)?.[0] as string),
        )
        expect(`${submit.origin}${submit.pathname}`).toBe(`${origin}/api/auth/magic-link/verify`)
        expect(Object.fromEntries(submit.searchParams)).toEqual({
          token: expect.any(String),
          callbackURL: '/welcome?tab=1',
          errorCallbackURL: '/oops',
        })
        const first = await main.app.request(submit.toString())
        expect(first.headers.get('location')).toBe(`${origin}/welcome?tab=1`)
        // A used (or expired) link lands on Better Auth's error redirect, as before.
        const again = await main.app.request(submit.toString())
        expect(again.headers.get('location')).toBe(`${origin}/oops?error=INVALID_TOKEN`)
        expect(cookieHeader(again)).not.toContain('session_token')
      })

      it('shows no button for a link without a token', async () => {
        await expect(
          pressConfirmButton(main.app, new URL(`${origin}/sign-in/confirm#callbackURL=%2F`)),
        ).rejects.toThrow(/no button/)
      })

      it('is self-contained, under a strict CSP, never cached and sending no Referer', async () => {
        const res = await main.app.request('/sign-in/confirm')
        expect(res.headers.get('content-type')).toMatch(/^text\/html/)
        expect(res.headers.get('cache-control')).toBe('no-store')
        expect(res.headers.get('referrer-policy')).toBe('no-referrer')
        const html = await res.text()
        expect(html).toContain('<button type="submit">Sign in to Hourmere</button>')
        // Nothing loaded from elsewhere, and the CSP allows only this page's inline script
        // and style.
        expect(html).not.toMatch(/\s(src|href)=/)
        const sha256 = (source = '') =>
          `'sha256-${createHash('sha256').update(source).digest('base64')}'`
        const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1]
        const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1]
        expect(res.headers.get('content-security-policy')?.split('; ')).toEqual([
          "default-src 'none'",
          `script-src ${sha256(script)}`,
          `style-src ${sha256(style)}`,
          "form-action 'self'",
          "base-uri 'none'",
          "frame-ancestors 'none'",
        ])
      })
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

  describe('organization slugs', () => {
    let cookie: string
    let teamId: string
    let ownerId: string
    beforeAll(async () => {
      cookie = await signIn('slug-owner@example.com')
      ownerId = await userId('slug-owner@example.com')
      teamId = await createTeam(cookie, 'slug-check-team')
    })

    it.each(['admin', 'API', 'sign-in', 'mcp', 'Support', '.well-known'])(
      'refuses reserved slug %s on both create and update',
      async (slug) => {
        const rejected = {
          code: 'ORGANIZATION_SLUG_RESERVED',
          message: 'This organization slug is reserved. Choose another one.',
        }
        const created = await post('/api/auth/organization/create', cookie, {
          name: 'Reserved team',
          slug,
        })
        expect(created.status).toBe(400)
        expect(await created.json()).toEqual(rejected)
        const updated = await post('/api/auth/organization/update', cookie, {
          organizationId: teamId,
          data: { slug, name: 'Must not be saved' },
        })
        expect(updated.status).toBe(400)
        expect(await updated.json()).toEqual(rejected)
        expect(
          await db
            .selectFrom('auth.organization')
            .select(['name', 'slug'])
            .where('id', '=', teamId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ name: 'slug-check-team', slug: 'slug-check-team' })
        expect(
          await count('SELECT count(*)::int AS n FROM auth.organization WHERE slug = $1', [slug]),
        ).toBe(0)
      },
    )

    it('also guards trusted server-side creation and personal slug changes', async () => {
      await expect(
        main.auth.api.createOrganization({
          body: { userId: ownerId, name: 'Server-created team', slug: 'OAUTH' },
        }),
      ).rejects.toMatchObject({
        status: 'BAD_REQUEST',
        body: { code: 'ORGANIZATION_SLUG_RESERVED' },
      })
      const personal = (
        await testDb.pool.query<{ organization_id: string }>(
          'SELECT organization_id FROM personal_organizations WHERE user_id = $1',
          [ownerId],
        )
      ).rows[0]?.organization_id
      const response = await post('/api/auth/organization/update', cookie, {
        organizationId: personal,
        data: { slug: 'CALENDARS' },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'ORGANIZATION_SLUG_RESERVED' })
    })

    it('allows unreserved slugs and ordinary metadata edits', async () => {
      const id = await createTeam(cookie, 'admins')
      const response = await post('/api/auth/organization/update', cookie, {
        organizationId: id,
        data: { slug: 'admin-team', name: 'Updated display name' },
      })
      expect(response.status).toBe(200)
      expect(
        await db
          .selectFrom('auth.organization')
          .select(['name', 'slug'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ name: 'Updated display name', slug: 'admin-team' })
    })

    it('does not rename historical data or prevent display-name-only edits to a legacy slug', async () => {
      const id = await createTeam(cookie, 'legacy-slug-team')
      await db
        .updateTable('auth.organization')
        .set({ slug: 'privacy' })
        .where('id', '=', id)
        .execute()
      const response = await post('/api/auth/organization/update', cookie, {
        organizationId: id,
        data: { name: 'Legacy display name' },
      })
      expect(response.status).toBe(200)
      expect(
        await db
          .selectFrom('auth.organization')
          .select(['name', 'slug'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ name: 'Legacy display name', slug: 'privacy' })
    })
  })

  it('refreshes real sessions and API-key identity after the independent name API', async () => {
    const email = 'display-name-rest@example.com'
    const cookie = await signIn(email)
    const id = await userId(email)
    const app = createApp({
      checkDb: async () => {},
      authHandler: main.auth.handler,
      resolveCaller: createCallerResolver({ auth: main.auth, db }),
      publicUrl: origin,
      routes: [profileRoutes({ db })],
    })
    const response = await app.request('/api/v1/profile/name', {
      method: 'PATCH',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  REST name  ' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: 'REST name' })
    expect((await me({ cookie })).body.user).toMatchObject({ id, email, name: 'REST name' })
    const key = await main.auth.api.createApiKey({ body: { userId: id, name: 'name-api-test' } })
    const changed = await app.request('/api/v1/profile/name', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Agent name' }),
    })
    expect(changed.status).toBe(200)
    expect((await me({ cookie })).body.user.name).toBe('Agent name')
    const laterCookie = await signIn(email)
    expect((await me({ cookie: laterCookie })).body.user.name).toBe('Agent name')
  })

  describe('display name updates', () => {
    let cookie: string
    let id: string
    const email = 'display-name@example.com'
    beforeAll(async () => {
      cookie = await signIn(email)
      id = await userId(email)
    })
    const stored = () =>
      db
        .selectFrom('auth.user')
        .select(['name', 'email'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()

    it('lets a magic-link user set a trimmed Unicode name, preserving identity and later sign-ins', async () => {
      const before = (await me({ cookie })).body
      expect(before.user.name).toBe('')
      const response = await post('/api/auth/update-user', cookie, {
        name: '  Ada Lovelace 👩‍💻  ',
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: true })
      expect(await stored()).toEqual({ name: 'Ada Lovelace 👩‍💻', email })
      const after = (await me({ cookie })).body
      expect(after.user).toEqual({ ...before.user, name: 'Ada Lovelace 👩‍💻' })
      expect(after.organization).toEqual(before.organization)
      const laterCookie = await signIn(email)
      expect((await me({ cookie: laterCookie })).body.user.name).toBe('Ada Lovelace 👩‍💻')
    })

    it.each([
      null,
      false,
      42,
      {},
      [],
      '',
      '   ',
      'A\nB',
      'A\u0000B',
      'A\u0085B',
      'A\u2028B',
      'A\u2029B',
      'A\ud800B',
      'A'.repeat(DISPLAY_NAME_MAX_LENGTH + 1),
    ])('rejects an invalid name without changing data or reflecting it (%#)', async (name) => {
      const before = await stored()
      const response = await post('/api/auth/update-user', cookie, { name })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        code: 'INVALID_DISPLAY_NAME',
        message: `Name must be a single line of text between 1 and ${DISPLAY_NAME_MAX_LENGTH} characters.`,
      })
      expect(await stored()).toEqual(before)
    })

    it('accepts the exact UTF-16 length bound', async () => {
      const name = '😀'.repeat(DISPLAY_NAME_MAX_LENGTH / 2)
      const response = await post('/api/auth/update-user', cookie, { name })
      expect(response.status).toBe(200)
      expect((await stored()).name).toBe(name)
    })

    it('retains session and origin checks, and cannot target another user', async () => {
      expect((await post('/api/auth/update-user', '', { name: 'No session' })).status).toBe(401)
      const key = await plantKey(id, (await me({ cookie })).body.organization.id)
      const apiOnly = await main.app.request('/api/auth/update-user', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key.key}`, origin },
        body: JSON.stringify({ name: 'API only' }),
      })
      expect(apiOnly.status).toBe(401)
      const before = await stored()
      const foreignOrigin = await main.app.request('/api/auth/update-user', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.example' },
        body: JSON.stringify({ name: 'Foreign origin' }),
      })
      expect(foreignOrigin.status).toBe(403)
      expect(await stored()).toEqual(before)
      const otherCookie = await signIn('other-display-name@example.com')
      const other = (await me({ cookie: otherCookie })).body.user
      const response = await post('/api/auth/update-user', cookie, {
        name: 'Only me',
        userId: other.id,
      })
      expect(response.status).toBe(200)
      expect((await stored()).name).toBe('Only me')
      expect((await me({ cookie: otherCookie })).body.user).toEqual(other)
    })

    it('also validates and normalizes server-side auth API calls', async () => {
      const headers = new Headers({ cookie, origin })
      const before = await stored()
      await expect(
        main.auth.api.updateUser({ headers, body: { name: 'A\rB' } }),
      ).rejects.toMatchObject({
        status: 'BAD_REQUEST',
        body: { code: 'INVALID_DISPLAY_NAME' },
      })
      expect(await stored()).toEqual(before)
      await main.auth.api.updateUser({ headers, body: { name: '  Server name  ' } })
      expect((await stored()).name).toBe('Server name')
    })

    it('allows other supported profile updates for an unnamed legacy account', async () => {
      const legacyCookie = await signIn('unnamed-profile@example.com')
      const response = await post('/api/auth/update-user', legacyCookie, { image: null })
      expect(response.status).toBe(200)
      expect((await me({ cookie: legacyCookie })).body.user.name).toBe('')
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
        `{"organizationId":"${'a'.repeat(50_000)}"}`,
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
      // Anything more than switching off is refused.
      for (const body of [
        { keyId: planted.id, enabled: true },
        { keyId: planted.id, enabled: false, name: 'sneaky' },
      ]) {
        const res = await post('/api/auth/api-key/update', mallory.cookie, body)
        expect(res.status, JSON.stringify(body)).toBe(403)
      }
    })

    /**
     * Resolves a bearer key with `during` run after Better Auth has checked the key and
     * before the membership lookup.
     */
    async function resolveKeyWithPause(key: string, during: () => Promise<void>) {
      let reached = () => {}
      let release = () => {}
      const atBarrier = new Promise<void>((resolve) => {
        reached = resolve
      })
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const api = main.auth.api
      const auth = {
        ...main.auth,
        api: {
          ...api,
          verifyApiKey: async (input: unknown) => {
            const result = await api.verifyApiKey(input as never)
            reached()
            await barrier
            return result
          },
        },
      } as unknown as Auth
      const pending = createCallerResolver({ auth, db })(
        new Headers({ authorization: `Bearer ${key}` }),
      )
      await atBarrier
      try {
        await during()
      } finally {
        release()
      }
      return pending
    }

    it('do not authenticate if deleted while they are being checked', async () => {
      // A key in an unverified account; its owner proves the email (which deletes the key)
      // between Better Auth's key check and the membership lookup, then makes a key of their own.
      const mallory = await unverifiedUser('split@example.com')
      const planted = await plantKey(mallory.id, mallory.organizationId)
      const result = await resolveKeyWithPause(planted.key, async () => {
        const owner = await signIn('split@example.com')
        expect((await createKey(owner)).status).toBe(200)
        const keys = await testDb.pool.query<{ id: string }>(
          `SELECT id FROM auth.apikey WHERE "referenceId" = $1`,
          [mallory.id],
        )
        expect(keys.rows.map((r) => r.id)).not.toContain(planted.id)
        expect(keys.rows).toHaveLength(1)
      })
      expect(result).toMatchObject({ ok: false, error: 'unauthorized' })
    })

    it('do not authenticate if disabled while they are being checked', async () => {
      const cookie = await signIn('disabled-midway@example.com')
      const key = (await (await createKey(cookie)).json()) as { id: string; key: string }
      const result = await resolveKeyWithPause(key.key, async () => {
        const off = await post('/api/auth/api-key/update', cookie, {
          keyId: key.id,
          enabled: false,
        })
        expect(off.status).toBe(200)
      })
      expect(result).toMatchObject({ ok: false, error: 'unauthorized' })
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
      // A database failure inside a Better Auth endpoint (the sign-up check before the email),
      // with request-like text in its message.
      const failing = new Proxy(db, {
        get: (target, prop) =>
          prop === 'selectFrom'
            ? () => {
                throw new Error('db down\n[mail] {"forged":true}')
              }
            : Reflect.get(target, prop),
      })
      const auth = createAuth({
        pool: authPool,
        db: failing,
        baseURL: origin,
        secret: randomBytes(32).toString('base64'),
        signup: { mode: 'closed', allowedDomains: [] },
        mailer: { send: async (m) => void outbox.push(m) },
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
    const vouching = (profile: {
      id: string
      email: string
      emailVerified: boolean
      name?: string
    }) => ({
      verifyIdToken: async () => true,
      getUserInfo: async () => ({
        user: {
          email: profile.email,
          emailVerified: profile.emailVerified,
          name: profile.name ?? 'From provider',
        },
        // Only the claims the account key is read from (Microsoft: oid, Google: sub).
        data: { oid: profile.id, sub: profile.id } as never,
      }),
    })

    // HTTP sign-in accepts only the web app's redirect flow. Use Better Auth's trusted
    // server API for synthetic ID-token fixtures while retaining the real account hooks.
    const socialSignIn = (i: Instance, provider: 'google' | 'microsoft') =>
      i.auth.api.signInSocial({
        body: { provider, idToken: { token: 'header.payload.signature' } },
        asResponse: true,
      })

    it.each(['google', 'microsoft'] as const)(
      'sanitizes the %s profile name before creating the account and personal organization',
      async (provider) => {
        const email = `clean-${provider}-name@example.com`
        const social = instance(origin, {
          socialProviders: { [provider]: client },
          socialProviderOptions: {
            [provider]: vouching({
              id: `clean-${provider}-name`,
              email,
              emailVerified: true,
              name: signUpName,
            }),
          },
        })
        const response = await socialSignIn(social, provider)
        expect(response.status).toBe(200)
        const { res, body } = await me({ cookie: cookieHeader(response) }, social.app)
        expect(res.status).toBe(200)
        expect(body.user).toMatchObject({ email, name: cleanSignUpName })
        expect(body.organization.name).toBe(cleanSignUpName)
        expect(
          await db
            .selectFrom('auth.user')
            .select('name')
            .where('email', '=', email)
            .executeTakeFirst(),
        ).toEqual({ name: cleanSignUpName })
      },
    )

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
      const mallory = await unverifiedUser('paused@example.com')
      await testDb.pool.query(
        `INSERT INTO auth.account ("accountId", "providerId", "userId", "updatedAt")
         VALUES ('ms-paused', 'microsoft', $1, now())`,
        [mallory.id],
      )
      const pausing = pausingPool()
      try {
        const microsoft = instance(origin, {
          pool: pausing.pool,
          socialProviders: { microsoft: client },
          socialProviderOptions: {
            microsoft: vouching({
              id: 'ms-paused',
              email: 'paused@example.com',
              emailVerified: false,
            }),
          },
        })
        // Mallory's login loads the account, stores the fresh tokens, and waits there.
        pausing.arm(/^update "account"/i)
        const login = socialSignIn(microsoft, 'microsoft')
        await pausing.paused

        // Meanwhile the real owner signs in with an email link.
        const owner = await signIn('paused@example.com')
        const state = await testDb.pool.query(
          `SELECT u."emailVerified",
                  (SELECT count(*)::int FROM auth.account a WHERE a."userId" = u.id) AS accounts,
                  (SELECT count(*)::int FROM auth.session s WHERE s."userId" = u.id) AS sessions
             FROM auth."user" u WHERE u.id = $1`,
          [mallory.id],
        )
        expect(state.rows).toEqual([{ emailVerified: true, accounts: 0, sessions: 1 }])

        // Mallory's login resumes and gets nothing.
        pausing.release()
        const res = await login
        expect(res.status).toBe(403)
        expect(await res.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' })
        expect(cookieHeader(res)).not.toContain('session_token')
        expect(
          await count(`SELECT count(*)::int AS n FROM auth.session WHERE "userId" = $1`, [
            mallory.id,
          ]),
        ).toBe(1)
        expect((await me({ cookie: owner })).res.status).toBe(200)
      } finally {
        pausing.release()
        await pausing.end()
      }
    })

    it('ends sessions from before the owner proved the email through a verifying provider', async () => {
      // An old unverified account in which Mallory holds a session. The owner's Google
      // account is linked to it (from back when Google did not confirm the address; linking a
      // provider to an unverified account now is refused by Better Auth's
      // requireLocalEmailVerified).
      const mallory = await unverifiedUser('proof@example.com')
      await testDb.pool.query(
        `INSERT INTO auth.account ("accountId", "providerId", "userId", "updatedAt")
         VALUES ('g-proof', 'google', $1, now())`,
        [mallory.id],
      )
      expect((await me({ cookie: mallory.cookie })).res.status).toBe(200)

      // The owner signs in with Google, which now confirms the address: Better Auth marks the
      // email verified, without revoking anything itself.
      const google = instance(origin, {
        socialProviders: { google: client },
        socialProviderOptions: {
          google: vouching({ id: 'g-proof', email: 'proof@example.com', emailVerified: true }),
        },
      })
      const first = await socialSignIn(google, 'google')
      // Better Auth judges this login by the account as it loaded it (still unverified), so
      // this first one is refused; the email is verified from now on.
      expect(first.status).toBe(403)
      const user = await testDb.pool.query(
        `SELECT u."emailVerified",
                (SELECT count(*)::int FROM auth.account a WHERE a."userId" = u.id) AS accounts
           FROM auth."user" u WHERE u.id = $1`,
        [mallory.id],
      )
      expect(user.rows).toEqual([{ emailVerified: true, accounts: 0 }])

      // Mallory's session ended with the proof, so it can neither read nor mint keys.
      expect((await me({ cookie: mallory.cookie })).res.status).toBe(401)
      const minted = await post('/api/auth/api-key/create', mallory.cookie, { name: 'late' })
      expect(minted.status).toBe(401)

      // The owner's next sign-in links Google again and gets a session that works.
      const owner = await socialSignIn(google, 'google')
      expect(owner.status).toBe(200)
      const cookie = cookieHeader(owner)
      expect((await me({ cookie }, google.app)).body.user.email).toBe('proof@example.com')
      expect(
        (await post('/api/auth/api-key/create', cookie, { name: 'owner' }, google.app)).status,
      ).toBe(200)
      expect(
        await count(`SELECT count(*)::int AS n FROM auth.apikey WHERE "referenceId" = $1`, [
          mallory.id,
        ]),
      ).toBe(1)
    })

    it('removes sign-in accounts linked before the owner proved the email', async () => {
      // An old unverified account with Mallory's Microsoft account and the owner's Google
      // account linked to it.
      const mallory = await unverifiedUser('linked@example.com')
      await testDb.pool.query(
        `INSERT INTO auth.account ("accountId", "providerId", "userId", "updatedAt")
         VALUES ('ms-linked', 'microsoft', $1, now()), ('g-linked', 'google', $1, now())`,
        [mallory.id],
      )
      const google = instance(origin, {
        socialProviders: { google: client },
        socialProviderOptions: {
          google: vouching({ id: 'g-linked', email: 'linked@example.com', emailVerified: true }),
        },
      })
      const microsoft = instance(origin, {
        socialProviders: { microsoft: client },
        socialProviderOptions: {
          microsoft: vouching({
            id: 'ms-linked',
            email: 'linked@example.com',
            emailVerified: false,
          }),
        },
      })
      // The owner proves the address through Google.
      expect((await socialSignIn(google, 'google')).status).toBe(403)
      expect(
        await count(`SELECT count(*)::int AS n FROM auth.account WHERE "userId" = $1`, [
          mallory.id,
        ]),
      ).toBe(0)

      // Mallory's Microsoft account no longer signs into what is now the owner's account.
      const again = await socialSignIn(microsoft, 'microsoft')
      expect(again.status).toBe(401)
      expect(cookieHeader(again)).not.toContain('session_token')
      expect(
        await count(`SELECT count(*)::int AS n FROM auth.session WHERE "userId" = $1`, [
          mallory.id,
        ]),
      ).toBe(0)

      // The owner's Google sign-in links Google again.
      expect((await socialSignIn(google, 'google')).status).toBe(200)
    })

    describe('failures Better Auth cannot send back to where the app asked', () => {
      const withGoogle = () => instance(origin, { socialProviders: { google: client } })
      const signInPage = (error: string) => `${origin}/sign-in?error=${error}`

      /** Starts Google sign-in; returns the OAuth state and the cookie that goes with it. */
      async function startGoogle(i: Instance, redirects: Record<string, string>) {
        const res = await i.app.request('/api/auth/sign-in/social', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin },
          body: JSON.stringify({ provider: 'google', ...redirects }),
        })
        expect(res.status).toBe(200)
        const { url } = (await res.json()) as { url: string }
        return { state: new URL(url).searchParams.get('state'), cookie: cookieHeader(res) }
      }

      it("land on the app's sign-in page when the OAuth state is missing or forged", async () => {
        const { app } = withGoogle()
        const lines = await printedLines(async () => {
          for (const [path, error] of [
            ['/api/auth/callback/google?code=abc', 'state_not_found'],
            ['/api/auth/callback/google?state=forged&code=abc', 'state_mismatch'],
            // What the provider says is not believed without a valid state either.
            [
              '/api/auth/callback/google?state=forged&error=access_denied&error_description=%3Cb%3EHi%3C%2Fb%3E',
              'state_mismatch',
            ],
          ] as const) {
            const res = await app.request(path)
            expect(res.status, path).toBe(302)
            expect(res.headers.get('location'), path).toBe(signInPage(error))
            expect(cookieHeader(res), path).not.toContain('session_token')
          }
        })
        // Better Auth logs each, on one line.
        expect(lines.filter((l) => l.includes('[Better Auth]'))).toHaveLength(3)
      })

      it('land on the sign-in page when the OAuth state has expired', async () => {
        const i = withGoogle()
        // An API client that gave no errorCallbackURL: the sign-in page.
        const bare = await startGoogle(i, { callbackURL: '/' })
        // The web app gives one (the sign-in page, remembering where to go): it is used.
        const app = await startGoogle(i, {
          callbackURL: '/bookings',
          errorCallbackURL: '/sign-in?next=%2Fbookings',
        })
        const later = Date.now() + 11 * 60 * 1000
        const now = vi.spyOn(Date, 'now').mockReturnValue(later)
        try {
          await printedLines(async () => {
            const res = await i.app.request(
              `/api/auth/callback/google?state=${bare.state}&code=abc`,
              { headers: { cookie: bare.cookie } },
            )
            expect(res.headers.get('location')).toBe(signInPage('state_mismatch'))
            const fromApp = await i.app.request(
              `/api/auth/callback/google?state=${app.state}&code=abc`,
              { headers: { cookie: app.cookie } },
            )
            expect(fromApp.headers.get('location')).toBe(
              '/sign-in?next=%2Fbookings&error=state_mismatch',
            )
          })
        } finally {
          now.mockRestore()
        }
      })

      it("redirect Better Auth's own error page there, with nothing but a code-like error", async () => {
        const plain = await main.app.request('/api/auth/error?error=state_mismatch')
        expect(plain.status).toBe(302)
        expect(plain.headers.get('location')).toBe(signInPage('state_mismatch'))

        const hostile = await main.app.request(
          '/api/auth/error?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E&error_description=Call+555-0100&errorURL=https%3A%2F%2Fevil.example',
          { headers: { host: 'evil.example' } },
        )
        expect(hostile.status).toBe(302)
        expect(hostile.headers.get('content-type')).toBeNull()
        const location = new URL(hostile.headers.get('location') as string)
        // Always our sign-in page, whatever the request says.
        expect(`${location.origin}${location.pathname}`).toBe(`${origin}/sign-in`)
        expect(location.searchParams.get('error')).toBe('UNKNOWN')
        // The description rides along URL-encoded; the sign-in page never shows it.
        expect([...location.searchParams.keys()]).toEqual(['error', 'error_description'])
      })

      it('get the security headers, as every response does', async () => {
        const res = await main.app.request('/api/auth/callback/google?code=abc')
        expect(res.status).toBe(302)
        expect(res.headers.get('x-content-type-options')).toBe('nosniff')
        expect(res.headers.get('x-frame-options')).toBe('DENY')
        expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
        const session = await main.app.request('/api/auth/get-session')
        expect(session.status).toBe(200)
        expect(session.headers.get('x-content-type-options')).toBe('nosniff')
      })
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
