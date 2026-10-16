// Sign-up control (SIGNUP, SIGNUP_ALLOWED_DOMAINS) end to end: the real app, Better Auth and
// migrations, against a throwaway database that has no users at the start of each test.
import { randomBytes } from 'node:crypto'
import { createAuth, createAuthPool, createCallerResolver, type SignupPolicy } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createLogMailer, type Mailer, type MailMessage } from '@hourmere/mail'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { pressConfirmButton } from './sign-in-confirm-testing.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:3000'

const OPEN: SignupPolicy = { mode: 'open', allowedDomains: [] }
const FIRST_USER: SignupPolicy = { mode: 'first-user', allowedDomains: ['team.example'] }
const CLOSED: SignupPolicy = { mode: 'closed', allowedDomains: ['team.example'] }

describe.skipIf(!serverUrl)('sign-up control', () => {
  let testDb: TestDatabase
  let db: Db
  const pools: pg.Pool[] = []
  const outbox: MailMessage[] = []

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
  })

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()))
    await testDb?.drop()
  })

  beforeEach(async () => {
    await testDb.pool.query('DELETE FROM auth."user"')
    outbox.length = 0
  })

  /** Better Auth's pool for `signup`, closed after the tests. */
  function authPool(signup: SignupPolicy) {
    const pool = createAuthPool(testDb.url, signup)
    pools.push(pool)
    return pool
  }

  /** A Google sign-in whose (already verified) ID token says the user is `email`. */
  const vouching = (email: string) => ({
    verifyIdToken: async () => true,
    getUserInfo: async () => ({
      user: { email, emailVerified: true, name: 'From Google' },
      data: { sub: `google-${email}` } as never,
    }),
  })

  interface InstanceOptions {
    mailer?: Mailer
    /** Enables Google sign-in, as this account. */
    google?: string
    pool?: pg.Pool
  }

  function instance(signup: SignupPolicy, { mailer, google, pool }: InstanceOptions = {}) {
    const auth = createAuth({
      pool: pool ?? authPool(signup),
      db,
      baseURL: origin,
      secret: randomBytes(32).toString('base64'),
      mailer: mailer ?? { send: async (m) => void outbox.push(m) },
      signup,
      ...(google && {
        socialProviders: { google: { clientId: 'id', clientSecret: 'secret' } },
        socialProviderOptions: { google: vouching(google) },
      }),
    })
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl: origin,
    })
  }

  type App = ReturnType<typeof instance>

  const askForLinkRequest = (app: App, email: string) =>
    app.request('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, callbackURL: '/' }),
    })

  /** Asks for a sign-in link; returns the emailed link, or undefined if no email was sent. */
  async function askForLink(app: App, email: string): Promise<URL | undefined> {
    const before = outbox.length
    const res = await askForLinkRequest(app, email)
    // The same answer whether or not an email was sent.
    expect(res.status, email).toBe(200)
    expect(await res.json(), email).toEqual({ status: true })
    const link = outbox
      .slice(before)
      .find((m) => m.to === email)
      ?.text.match(/https?:\/\/\S+/)?.[0]
    return link === undefined ? undefined : new URL(link)
  }

  /** Presses the button on the page the link opens; returns Better Auth's answer. */
  const useLink = async (app: App, link: URL | undefined) =>
    app.request((await pressConfirmButton(app, link as URL)).toString())

  const hasSession = (res: Response) =>
    res.headers.getSetCookie().some((c) => c.includes('session_token='))

  async function signIn(app: App, email: string) {
    const link = await askForLink(app, email)
    expect(link, email).toBeDefined()
    const res = await useLink(app, link)
    expect(res.status, email).toBe(302)
    expect(res.headers.get('location'), email).toBe(`${origin}/`)
    expect(hasSession(res), email).toBe(true)
  }

  /** A new address gets no link, so no account. */
  async function noLink(app: App, email: string) {
    expect(await askForLink(app, email), email).toBeUndefined()
  }

  /** Better Auth's error redirect for a refused sign-up. */
  function expectSignupDisabled(res: Response) {
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') as string)
    expect(`${location.origin}${location.pathname}`).toBe(`${origin}/`)
    expect(location.searchParams.get('error')).toBe('SIGNUP_DISABLED')
    expect(hasSession(res)).toBe(false)
  }

  const googleSignIn = (app: App) =>
    app.request('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', idToken: { token: 'header.payload.signature' } }),
    })

  const users = async () =>
    (
      await testDb.pool.query<{ email: string }>('SELECT email FROM auth."user" ORDER BY email')
    ).rows.map((r) => r.email)

  const rows = async () =>
    (
      await testDb.pool.query(
        `SELECT (SELECT count(*)::int FROM auth."user") AS users,
                (SELECT count(*)::int FROM auth.account) AS accounts,
                (SELECT count(*)::int FROM auth.session) AS sessions,
                (SELECT count(*)::int FROM auth.organization) AS organizations`,
      )
    ).rows[0]

  describe('open', () => {
    it('lets anyone sign up, and existing users sign in again', async () => {
      const app = instance(OPEN)
      await signIn(app, 'first@one.example')
      await signIn(app, 'second@two.example')
      await signIn(app, 'first@one.example')
      expect((await googleSignIn(instance(OPEN, { google: 'third@three.example' }))).status).toBe(
        200,
      )
      expect(await users()).toEqual([
        'first@one.example',
        'second@two.example',
        'third@three.example',
      ])
    })
  })

  describe('first-user', () => {
    it('lets the first account be created, then only addresses in the allowed domains', async () => {
      const app = instance(FIRST_USER)
      await signIn(app, 'owner@anywhere.example')
      await noLink(app, 'stranger@elsewhere.example')
      await signIn(app, 'colleague@team.example')
      // Domains match regardless of case, but exactly: a subdomain is another domain.
      await signIn(app, 'Shouty@TEAM.Example')
      await noLink(app, 'someone@sub.team.example')
      await noLink(app, 'someone@team.example.org')
      expect(await users()).toEqual([
        'colleague@team.example',
        'owner@anywhere.example',
        'shouty@team.example',
      ])
    })

    it('lets existing users sign in, whatever their domain', async () => {
      const app = instance(FIRST_USER)
      await signIn(app, 'owner@anywhere.example')
      await signIn(app, 'owner@anywhere.example')
      await signIn(app, 'OWNER@Anywhere.example')
      expect(await users()).toEqual(['owner@anywhere.example'])
    })

    it('refuses the link of someone who asked before the first user signed in', async () => {
      const app = instance(FIRST_USER)
      // While nobody has signed up, anyone may: both get a link.
      const owner = await askForLink(app, 'owner@anywhere.example')
      const late = await askForLink(app, 'late@elsewhere.example')
      expect((await useLink(app, owner)).status).toBe(302)
      expectSignupDisabled(await useLink(app, late))
      expect(await users()).toEqual(['owner@anywhere.example'])
    })
  })

  describe('closed', () => {
    it('lets only addresses in the allowed domains sign up, even on an empty instance', async () => {
      const app = instance(CLOSED)
      await noLink(app, 'owner@anywhere.example')
      await signIn(app, 'colleague@team.example')
      await noLink(app, 'someone@sub.team.example')
      expect(await users()).toEqual(['colleague@team.example'])
    })

    it('lets nobody sign up without allowed domains', async () => {
      await noLink(instance({ mode: 'closed', allowedDomains: [] }), 'colleague@team.example')
      expect(await users()).toEqual([])
    })

    it('lets existing users sign in, whatever their domain', async () => {
      await signIn(instance(OPEN), 'early@anywhere.example')
      await signIn(instance(CLOSED), 'early@anywhere.example')
      expect(await users()).toEqual(['early@anywhere.example'])
    })

    it('refuses at sign-in a link sent before sign-up closed', async () => {
      const link = await askForLink(instance(OPEN), 'late@elsewhere.example')
      expectSignupDisabled(await useLink(instance(CLOSED), link))
      expect(await rows()).toEqual({ users: 0, accounts: 0, sessions: 0, organizations: 0 })
    })
  })

  describe('sign-in providers', () => {
    it('refuse a sign-up the policy does not allow, leaving no rows behind', async () => {
      for (const policy of [CLOSED, FIRST_USER]) {
        if (policy === FIRST_USER) await signIn(instance(OPEN), 'owner@anywhere.example')
        const before = await rows()
        const res = await googleSignIn(instance(policy, { google: 'stranger@elsewhere.example' }))
        expect(res.status, policy.mode).toBe(403)
        expect(await res.json(), policy.mode).toMatchObject({ code: 'SIGNUP_DISABLED' })
        expect(hasSession(res), policy.mode).toBe(false)
        expect(await rows(), policy.mode).toEqual(before)
      }
      expect(await users()).toEqual(['owner@anywhere.example'])
      const allowed = await googleSignIn(instance(CLOSED, { google: 'colleague@team.example' }))
      expect(allowed.status).toBe(200)
    })

    it('let existing users sign in, whatever their domain', async () => {
      await signIn(instance(OPEN), 'early@anywhere.example')
      for (const policy of [CLOSED, FIRST_USER]) {
        const res = await googleSignIn(instance(policy, { google: 'early@anywhere.example' }))
        expect(res.status, policy.mode).toBe(200)
        expect(hasSession(res), policy.mode).toBe(true)
      }
      expect(await users()).toEqual(['early@anywhere.example'])
    })
  })

  describe('sign-in link email', () => {
    it('is not sent to, nor printed for, an address that may not sign up', async () => {
      await signIn(instance(OPEN), 'early@anywhere.example')
      // Without SMTP, links are printed instead of sent.
      const app = instance(CLOSED, { mailer: createLogMailer((line) => console.log(line)) })
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const answers: unknown[] = []
      try {
        for (const email of [
          'stranger@elsewhere.example',
          'early@anywhere.example',
          'colleague@team.example',
        ]) {
          const res = await askForLinkRequest(app, email)
          answers.push({
            status: res.status,
            type: res.headers.get('content-type'),
            body: await res.json(),
          })
        }
        const printed = log.mock.calls.map((args) => args.join(' '))
        const mail = printed.filter((l) => l.startsWith('[mail]'))
        expect(mail).toHaveLength(2)
        expect(mail[0]).toContain('"to":"early@anywhere.example"')
        expect(mail[1]).toContain('"to":"colleague@team.example"')
        expect(printed.join('\n')).not.toContain('stranger@elsewhere.example')
      } finally {
        log.mockRestore()
      }
      // Answered alike, so the answer tells nobody whether an address has an account.
      expect(answers[1]).toEqual(answers[0])
      expect(answers[2]).toEqual(answers[0])
    })
  })

  describe('the first user', () => {
    /**
     * A Better Auth pool whose user inserts wait until `n` of them are waiting, then all go
     * ahead together: by then each request has passed the create hook's check while no user
     * existed, the worst interleaving for the first-user rule.
     */
    function userInsertBarrier(signup: SignupPolicy, n: number) {
      const pool = authPool(signup)
      let waiting = 0
      let open = () => {}
      const opened = new Promise<void>((resolve) => {
        open = resolve
      })
      // Fails the test rather than hanging it if fewer inserts ever arrive.
      const timeout = setTimeout(open, 10_000)
      const forward = <T extends object>(target: T, prop: string | symbol) => {
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const holding = (client: pg.PoolClient) =>
        new Proxy(client, {
          get(target, prop) {
            if (prop !== 'query') return forward(target, prop)
            return async (...args: unknown[]) => {
              if (typeof args[0] === 'string' && /^insert into "user"/i.test(args[0])) {
                waiting += 1
                if (waiting === n) open()
                await opened
              }
              return (target.query as (...a: unknown[]) => Promise<unknown>)(...args)
            }
          },
        })
      return {
        pool: new Proxy(pool, {
          get(target, prop) {
            if (prop === 'connect') return async () => holding(await target.connect())
            return forward(target, prop)
          },
        }),
        waiting: () => waiting,
        done: () => clearTimeout(timeout),
      }
    }

    it('is the only account created when several people sign up at the same moment', async () => {
      const policy: SignupPolicy = { mode: 'first-user', allowedDomains: [] }
      const barrier = userInsertBarrier(policy, 3)
      const app = instance(policy, { pool: barrier.pool })
      const google = instance(policy, { pool: barrier.pool, google: 'racer@google.example' })
      const links = [
        await askForLink(app, 'racer@one.example'),
        await askForLink(app, 'racer@two.example'),
      ]
      // The refused requests log their error.
      const quiet = (['log', 'info', 'warn', 'error'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => {}),
      )
      let responses: Response[]
      try {
        responses = await Promise.all([
          useLink(app, links[0]),
          useLink(app, links[1]),
          googleSignIn(google),
        ])
      } finally {
        for (const spy of quiet) spy.mockRestore()
        barrier.done()
      }
      expect(barrier.waiting()).toBe(3)
      expect(responses.filter(hasSession)).toHaveLength(1)
      // The others were refused by the database: an email link with a 500 (the hook had
      // already let it through), Google with Better Auth's "unable to create user".
      const [a, b, g] = responses.map((r) => r.status)
      expect([a, b].every((s) => s === 302 || s === 500)).toBe(true)
      expect([200, 401]).toContain(g)
      const winner = await users()
      expect(winner).toHaveLength(1)
      expect(await rows()).toEqual({
        users: 1,
        accounts: winner[0] === 'racer@google.example' ? 1 : 0,
        sessions: 1,
        organizations: 1,
      })
    })
  })

  describe('database backstop', () => {
    const insert = (pool: pg.Pool, email: string) =>
      pool.query(`INSERT INTO auth."user" (name, email, "emailVerified") VALUES ('', $1, true)`, [
        email,
      ])
    const refused = { code: '42501', message: 'sign-up is not open to this email address' }

    it('applies the policy to inserts on Better Auth connections, and only there', async () => {
      const closed = authPool(CLOSED)
      await expect(insert(closed, 'stranger@elsewhere.example')).rejects.toMatchObject(refused)
      await expect(insert(closed, 'someone@sub.team.example')).rejects.toMatchObject(refused)
      await insert(closed, 'colleague@Team.Example')

      const firstUser = authPool({ mode: 'first-user', allowedDomains: [] })
      await expect(insert(firstUser, 'late@elsewhere.example')).rejects.toMatchObject(refused)
      await testDb.pool.query('DELETE FROM auth."user"')
      await insert(firstUser, 'first@elsewhere.example')
      await expect(insert(firstUser, 'second@elsewhere.example')).rejects.toMatchObject(refused)

      await insert(authPool(OPEN), 'anyone@elsewhere.example')
      // An unknown mode refuses.
      const bogus = new pg.Pool({ connectionString: testDb.url, options: '-c hourmere.signup=x' })
      pools.push(bogus)
      await expect(insert(bogus, 'colleague2@team.example')).rejects.toMatchObject(refused)
      // Connections without the settings (migrations, psql, the application's pool) are not
      // limited.
      await insert(testDb.pool, 'admin@elsewhere.example')
      expect(await users()).toEqual([
        'admin@elsewhere.example',
        'anyone@elsewhere.example',
        'first@elsewhere.example',
      ])
    })
  })
})
