// Sign-up control (SIGNUP, SIGNUP_ALLOWED_DOMAINS) end to end: the real app, Better Auth and
// migrations, against a throwaway database that has no users at the start of each test.
import { randomBytes, randomUUID } from 'node:crypto'
import {
  assertSignupEnforced,
  createAuth,
  createAuthPool,
  createCallerResolver,
  type SignupPolicy,
} from '@hourmere/auth'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createLogMailer, type Mailer, type MailMessage } from '@hourmere/mail'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
    await testDb?.drop()
  })

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((p) => p.end()))
  })

  beforeEach(async () => {
    await testDb.pool.query('DELETE FROM auth.organization')
    await testDb.pool.query('DELETE FROM auth."user"')
    outbox.length = 0
  })

  /** The test database's URL with these query parameters. */
  function urlWith(params: Record<string, string>) {
    const url = new URL(testDb.url)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    return url.toString()
  }

  /** Better Auth's pool for `signup`, closed after each test. */
  function authPool(signup: SignupPolicy, url = testDb.url) {
    const pool = createAuthPool(url, signup)
    pools.push(pool)
    return pool
  }

  /**
   * A provider whose (already verified) ID token, or whose user info after the OAuth redirect,
   * says the user is `email`, confirmed.
   */
  const vouching = (email: string) => ({
    verifyIdToken: async () => true,
    getUserInfo: async () => ({
      user: { email, emailVerified: true, name: 'From provider' },
      // Only the claims the account key is read from (Microsoft: oid, Google: sub).
      data: { oid: `oid-${email}`, sub: `sub-${email}` } as never,
    }),
  })

  const client = { clientId: 'id', clientSecret: 'secret' }

  interface InstanceOptions {
    mailer?: Mailer
    /** Enables Google sign-in, as this account. */
    google?: string
    /** Enables Microsoft sign-in, as this account. */
    microsoft?: string
    pool?: pg.Pool
  }

  function instance(
    signup: SignupPolicy,
    { mailer, google, microsoft, pool }: InstanceOptions = {},
  ) {
    const auth = createAuth({
      pool: pool ?? authPool(signup),
      db,
      baseURL: origin,
      secret: randomBytes(32).toString('base64'),
      mailer: mailer ?? { send: async (m) => void outbox.push(m) },
      signup,
      socialProviders: {
        ...(google && { google: client }),
        ...(microsoft && { microsoft: client }),
      },
      socialProviderOptions: {
        ...(google && { google: vouching(google) }),
        ...(microsoft && { microsoft: vouching(microsoft) }),
      },
    })
    const app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl: origin,
    })
    return Object.assign(app, { auth })
  }

  type App = ReturnType<typeof instance>

  const askForLinkRequest = (app: App, email: string, callbackURL = '/') =>
    app.request('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, callbackURL }),
    })

  /** Waits until a sign-in email has been sent: that happens after the answer. */
  const afterSend = () => new Promise<void>((resolve) => setImmediate(resolve))

  /** Asks for a sign-in link; returns the emailed link, or undefined if no email was sent. */
  async function askForLink(app: App, email: string, callbackURL = '/'): Promise<URL | undefined> {
    const before = outbox.length
    const res = await askForLinkRequest(app, email, callbackURL)
    // The same answer whether or not an email was sent.
    expect(res.status, email).toBe(200)
    expect(await res.json(), email).toEqual({ status: true })
    await afterSend()
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
    return res
  }

  /** A new address gets no link, so no account. */
  async function noLink(app: App, email: string) {
    expect(await askForLink(app, email), email).toBeUndefined()
  }

  /** Better Auth's error redirect for a refused sign-up. */
  function expectSignupDisabled(res: Response) {
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') as string)
    expect(`${location.origin}${location.pathname}`).toBe(`${origin}/sign-in`)
    expect(location.searchParams.get('error')).toBe('SIGNUP_DISABLED')
    expect(hasSession(res)).toBe(false)
  }

  // The public HTTP endpoint starts redirects; trusted server calls keep these synthetic
  // ID-token fixtures focused on registration policy and account hooks.
  const idTokenSignIn = (app: App, provider: 'google' | 'microsoft') =>
    app.auth.api.signInSocial({
      body: { provider, idToken: { token: 'header.payload.signature' } },
      asResponse: true,
    })
  const googleSignIn = (app: App) => idTokenSignIn(app, 'google')

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
                (SELECT count(*)::int FROM auth.organization) AS organizations,
                (SELECT count(*)::int FROM auth.member) AS members,
                (SELECT count(*)::int FROM personal_organizations) AS personal,
                (SELECT count(*)::int FROM auth.apikey) AS apikeys`,
      )
    ).rows[0]

  const NO_ROWS = {
    users: 0,
    accounts: 0,
    sessions: 0,
    organizations: 0,
    members: 0,
    personal: 0,
    apikeys: 0,
  }

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
      expect(await rows()).toEqual(NO_ROWS)
    })
  })

  describe('invited addresses', () => {
    const restricted: SignupPolicy[] = [
      { mode: 'closed', allowedDomains: [] },
      { mode: 'first-user', allowedDomains: [] },
    ]

    /** Exercise the same organization APIs any signed-in account holder can call. */
    async function inviteFromTeam(app: App, signedIn: Response, email: string) {
      const headers = {
        'content-type': 'application/json',
        origin,
        cookie: signedIn.headers
          .getSetCookie()
          .map((c) => c.split(';')[0])
          .join('; '),
      }
      const created = await app.request('/api/auth/organization/create', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Inviting team', slug: randomUUID() }),
      })
      expect(created.status).toBe(200)
      const organization = (await created.json()) as { id: string }
      const invited = await app.request('/api/auth/organization/invite-member', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, role: 'member', organizationId: organization.id }),
      })
      expect(invited.status).toBe(200)
      const invitation = (await invited.json()) as { id: string; status: string }
      expect(invitation.status).toBe('pending')
      return { ...invitation, organizationId: organization.id }
    }

    it.each([CLOSED, FIRST_USER])(
      'allows a domain-admitted inviter but blocks an invitee invitation chain in $mode',
      async (policy) => {
        // Ensure the domain-admitted inviter is not also the first-user exception.
        await signIn(instance(OPEN), 'first@outside.example')
        const app = instance(policy)
        const alice = await signIn(app, 'alice@team.example')
        await noLink(app, 'outsider@gmail.example')
        const invitation = await inviteFromTeam(app, alice, 'outsider@gmail.example')
        const outsider = await signIn(app, 'outsider@gmail.example')
        // Signing up did not accept Alice's invitation or join her team.
        expect(
          await db
            .selectFrom('auth.member')
            .select('id')
            .where('organizationId', '=', invitation.organizationId)
            .execute(),
        ).toHaveLength(1)
        await inviteFromTeam(app, outsider, 'third@elsewhere.example')
        await noLink(app, 'third@elsewhere.example')
        // An already issued link and another verified provider are blocked by the hook too.
        const earlierLink = await askForLink(instance(OPEN), 'third@elsewhere.example')
        expectSignupDisabled(await useLink(app, earlierLink))
        const provider = await googleSignIn(instance(policy, { google: 'third@elsewhere.example' }))
        expect(provider.status).toBe(403)
        expect(await provider.json()).toMatchObject({ code: 'SIGNUP_DISABLED' })
        await expect(
          authPool(policy).query(
            `INSERT INTO auth."user" (name, email, "emailVerified") VALUES ('', 'third@elsewhere.example', true)`,
          ),
        ).rejects.toMatchObject({ code: '42501' })
        expect(await users()).toEqual([
          'alice@team.example',
          'first@outside.example',
          'outsider@gmail.example',
        ])
      },
    )

    it.each(restricted)(
      'allows the first user to invite outside domains without delegating admission in $mode',
      async (policy) => {
        // In closed mode this also covers an instance bootstrapped before signup closed.
        if (policy.mode === 'closed') await signIn(instance(OPEN), 'owner@outside.example')
        const app = instance(policy)
        const owner = await signIn(app, 'owner@outside.example')
        await inviteFromTeam(app, owner, 'guest@outside.example')
        await inviteFromTeam(app, owner, 'db-guest@outside.example')
        await expect(
          authPool(policy).query(
            `INSERT INTO auth."user" (name, email, "emailVerified") VALUES ('', 'db-guest@outside.example', true)`,
          ),
        ).resolves.toBeDefined()
        const guest = await signIn(app, 'guest@outside.example')
        await inviteFromTeam(app, guest, 'next@outside.example')
        await noLink(app, 'next@outside.example')
        await expect(
          authPool(policy).query(
            `INSERT INTO auth."user" (name, email, "emailVerified") VALUES ('', 'next@outside.example', true)`,
          ),
        ).rejects.toMatchObject({ code: '42501' })
        expect(await users()).toEqual([
          'db-guest@outside.example',
          'guest@outside.example',
          'owner@outside.example',
        ])
      },
    )

    async function invite({
      email = 'invitee@outside.example',
      status = 'pending',
      expiresAt = new Date(Date.now() + 86_400_000),
      personal = false,
    } = {}) {
      const owner = await db
        .insertInto('auth.user')
        .values({ email: 'inviter@team.example', name: 'Owner', emailVerified: true })
        .onConflict((oc) => oc.column('email').doUpdateSet({ name: 'Owner' }))
        .returning('id')
        .executeTakeFirstOrThrow()
      const org = await db
        .insertInto('auth.organization')
        .values({ name: 'Inviting team', slug: randomUUID(), createdAt: new Date() })
        .returning('id')
        .executeTakeFirstOrThrow()
      await db
        .insertInto('auth.member')
        .values({ organizationId: org.id, userId: owner.id, role: 'owner', createdAt: new Date() })
        .execute()
      if (personal) {
        await db
          .insertInto('personal_organizations')
          .values({ user_id: owner.id, organization_id: org.id })
          .execute()
      }
      return db
        .insertInto('auth.invitation')
        .values({
          organizationId: org.id,
          inviterId: owner.id,
          email,
          role: 'member',
          status,
          expiresAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
    }

    it.each(restricted)(
      'keeps invitation callbacks and repeated sign-in separate from acceptance in $mode',
      async (policy) => {
        const invitation = await invite()
        const app = instance(policy)
        const callbackURL = `/app/join?invitationId=${invitation.id}`
        const link = await askForLink(app, invitation.email, callbackURL)
        expect(link).toBeDefined()
        const signedIn = await useLink(app, link)
        expect(signedIn.status).toBe(302)
        expect(signedIn.headers.get('location')).toBe(`${origin}${callbackURL}`)
        expect(hasSession(signedIn)).toBe(true)
        await signIn(app, invitation.email)

        const user = await db
          .selectFrom('auth.user')
          .select(['id', 'emailVerified'])
          .where('email', '=', invitation.email)
          .executeTakeFirstOrThrow()
        expect(user.emailVerified).toBe(true)
        expect(
          await db
            .selectFrom('auth.invitation')
            .select('status')
            .where('id', '=', invitation.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ status: 'pending' })
        expect(
          await db
            .selectFrom('auth.member')
            .select('id')
            .where('organizationId', '=', invitation.organizationId)
            .where('userId', '=', user.id)
            .execute(),
        ).toEqual([])
        const personal = await db
          .selectFrom('personal_organizations')
          .select('organization_id')
          .where('user_id', '=', user.id)
          .executeTakeFirstOrThrow()
        const sessions = await db
          .selectFrom('auth.session')
          .select('activeOrganizationId')
          .where('userId', '=', user.id)
          .execute()
        expect(sessions).toHaveLength(2)
        expect(sessions).toEqual([
          { activeOrganizationId: personal.organization_id },
          { activeOrganizationId: personal.organization_id },
        ])
      },
    )

    it.each(restricted)(
      'does not grant signup authority to an arbitrary invitation callback in $mode',
      async (policy) => {
        const open = instance(OPEN)
        await signIn(open, 'first@outside.example')
        const untrusted = await signIn(open, 'untrusted@outside.example')
        const invitation = await inviteFromTeam(open, untrusted, 'next@outside.example')
        const callbackURL = `/app/join?invitationId=${invitation.id}`
        const app = instance(policy)
        // Compare presence only so a failing upgrade never prints a usable sign-in link.
        expect((await askForLink(app, 'next@outside.example', callbackURL)) === undefined).toBe(
          true,
        )
        // Even a previously issued identity link cannot turn an untrusted team invitation
        // into permission to create an account when the registration policy is restricted.
        const earlier = await askForLink(open, 'next@outside.example', callbackURL)
        expect(earlier).toBeDefined()
        expectSignupDisabled(await useLink(app, earlier))
        expect(await users()).toEqual(['first@outside.example', 'untrusted@outside.example'])
        expect(
          await db
            .selectFrom('auth.invitation')
            .select('status')
            .where('id', '=', invitation.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ status: 'pending' })
        expect(
          await db
            .selectFrom('auth.member')
            .select('id')
            .where('organizationId', '=', invitation.organizationId)
            .execute(),
        ).toHaveLength(1)
      },
    )

    it('uses createdAt then id to choose the one first-user inviter', async () => {
      const invitation = await invite()
      const owner = await db
        .selectFrom('auth.user')
        .select('id')
        .where('email', '=', 'inviter@team.example')
        .executeTakeFirstOrThrow()
      // Assign the same whole-millisecond timestamp explicitly: reading Postgres's default
      // timestamp into a JS Date would truncate microseconds and make this an unequal pair.
      const createdAt = new Date('2026-01-01T00:00:00Z')
      await db.updateTable('auth.user').set({ createdAt }).where('id', '=', owner.id).execute()
      const earlier = '00000000-0000-4000-8000-000000000001'
      await db
        .insertInto('auth.user')
        .values({
          id: earlier,
          email: 'earlier@outside.example',
          name: 'Earlier',
          emailVerified: true,
          createdAt,
        })
        .execute()
      const policy = restricted[0] as SignupPolicy
      const app = instance(policy)
      await noLink(app, invitation.email)
      const insert = () =>
        authPool(policy).query(
          `INSERT INTO auth."user" (name, email, "emailVerified") VALUES ('', $1, true)`,
          [invitation.email],
        )
      await expect(insert()).rejects.toMatchObject({ code: '42501' })
      // Creation time takes precedence over the UUID tie-breaker.
      await db
        .updateTable('auth.user')
        .set({ createdAt: new Date(createdAt.getTime() + 60_000) })
        .where('id', '=', earlier)
        .execute()
      expect(await askForLink(app, invitation.email)).toBeDefined()
      await insert()
    })

    it.each(restricted)(
      'allows a live exact-address invitation in $mode, joining only on acceptance',
      async (policy) => {
        const invitation = await invite({ email: 'Invitee@Outside.Example' })
        const app = instance(policy)
        const link = await askForLink(app, 'INVITEE@outside.example')
        expect(link).toBeDefined()
        const signedIn = await useLink(app, link)
        expect(signedIn.status).toBe(302)
        expect(hasSession(signedIn)).toBe(true)
        expect(await users()).toEqual(['invitee@outside.example', 'inviter@team.example'])
        expect(
          await db
            .selectFrom('auth.invitation')
            .select('status')
            .where('id', '=', invitation.id)
            .executeTakeFirst(),
        ).toEqual({ status: 'pending' })
        const membership = () =>
          db
            .selectFrom('auth.member')
            .select('id')
            .where('organizationId', '=', invitation.organizationId)
            .execute()
        expect(await membership()).toHaveLength(1)
        const accepted = await app.request('/api/auth/organization/accept-invitation', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin,
            cookie: signedIn.headers
              .getSetCookie()
              .map((c) => c.split(';')[0])
              .join('; '),
          },
          body: JSON.stringify({ invitationId: invitation.id }),
        })
        expect(accepted.status).toBe(200)
        expect(await membership()).toHaveLength(2)
      },
    )

    it.each(restricted)(
      'allows verified Google sign-up in $mode without granting membership',
      async (policy) => {
        const invitation = await invite()
        const res = await googleSignIn(instance(policy, { google: invitation.email }))
        expect(res.status).toBe(200)
        expect(hasSession(res)).toBe(true)
        expect(
          await db
            .selectFrom('auth.member')
            .select('id')
            .where('organizationId', '=', invitation.organizationId)
            .execute(),
        ).toHaveLength(1)
      },
    )

    it.each([
      { status: 'canceled' },
      { status: 'rejected' },
      { status: 'accepted' },
      { status: 'unknown' },
      { expiresAt: new Date(0) },
      { email: 'other@outside.example' },
      { email: 'prefix-invitee@outside.example' },
      { email: 'invitee@outside.example.evil' },
      { personal: true },
    ])('does not allow an invalid invitation: %j', async (options) => {
      await invite(options)
      for (const policy of restricted) {
        await noLink(instance(policy), 'invitee@outside.example')
        const res = await googleSignIn(instance(policy, { google: 'invitee@outside.example' }))
        expect(res.status).toBe(403)
        expect(await res.json()).toMatchObject({ code: 'SIGNUP_DISABLED' })
        const pool = authPool(policy)
        await expect(
          pool.query(
            `INSERT INTO auth."user" (name, email, "emailVerified") VALUES ('', 'invitee@outside.example', true)`,
          ),
        ).rejects.toMatchObject({ code: '42501' })
      }
      expect(await users()).toEqual(['inviter@team.example'])
    })

    it('rechecks invitation validity when an already emailed link is used', async () => {
      const invitation = await invite()
      const app = instance(restricted[0] as SignupPolicy)
      const link = await askForLink(app, invitation.email)
      expect(link).toBeDefined()
      await db
        .updateTable('auth.invitation')
        .set({ status: 'canceled' })
        .where('id', '=', invitation.id)
        .execute()
      expectSignupDisabled(await useLink(app, link))
      expect(await users()).toEqual(['inviter@team.example'])
      // A different live invitation for the same address is sufficient.
      await invite()
      await signIn(app, invitation.email)
    })

    it('still requires a proven email even with a live invitation', async () => {
      const invitation = await invite()
      const policy = restricted[0] as SignupPolicy
      const auth = createAuth({
        pool: authPool(policy),
        db,
        baseURL: origin,
        secret: randomBytes(32).toString('base64'),
        mailer: { send: async () => {} },
        signup: policy,
        socialProviders: { google: client },
        socialProviderOptions: {
          google: {
            ...vouching(invitation.email),
            getUserInfo: async () => ({
              user: { email: invitation.email, emailVerified: false, name: 'Unverified' },
              data: { sub: 'unverified' } as never,
            }),
          },
        },
      })
      const res = await auth.api.signInSocial({
        body: { provider: 'google', idToken: { token: 'header.payload.signature' } },
        asResponse: true,
      })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' })
      expect(await users()).toEqual(['inviter@team.example'])
    })

    it('serializes insertion and invitation revocation at the database backstop', async () => {
      const invitation = await invite()
      const signingUp = await authPool(restricted[0] as SignupPolicy).connect()
      const revoking = await testDb.pool.connect()
      let revoked: Promise<unknown> | undefined
      try {
        await signingUp.query('BEGIN')
        await signingUp.query(
          `INSERT INTO auth."user" (name, email, "emailVerified") VALUES ('', $1, true)`,
          [invitation.email],
        )
        const backend = await revoking.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        const pid = backend.rows[0]?.pid
        expect(pid).toBeTypeOf('number')
        revoked = revoking.query(`UPDATE auth.invitation SET status = 'canceled' WHERE id = $1`, [
          invitation.id,
        ])
        await vi.waitFor(async () => {
          const { rows } = await testDb.pool.query(
            'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
            [pid],
          )
          expect(rows[0]?.wait_event_type).toBe('Lock')
        })
        await signingUp.query('COMMIT')
        await revoked
        expect(await users()).toContain(invitation.email)
      } finally {
        await signingUp.query('ROLLBACK')
        await revoked
        signingUp.release()
        revoking.release()
      }
    })

    it('rechecks the clock after waiting for an invitation row lock', async () => {
      const invitation = await invite()
      const holding = await testDb.pool.connect()
      const signingUp = await authPool(restricted[0] as SignupPolicy).connect()
      let insertion: Promise<{ error?: { code?: string } }> | undefined
      try {
        await holding.query('BEGIN')
        const { rows } = await holding.query<{ expiresAt: Date }>(
          `UPDATE auth.invitation SET "expiresAt" = clock_timestamp() + interval '1 second'
           WHERE id = $1 RETURNING "expiresAt"`,
          [invitation.id],
        )
        // Publish the expiry, then take a lock without changing the row. Updating it while
        // waiting would make EvalPlanQual recheck the scan predicate and hide this guard.
        await holding.query('COMMIT')
        await holding.query('BEGIN')
        await holding.query('SELECT id FROM auth.invitation WHERE id = $1 FOR UPDATE', [
          invitation.id,
        ])
        const backend = await signingUp.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        insertion = signingUp
          .query(`INSERT INTO auth."user" (name, email, "emailVerified") VALUES ('', $1, true)`, [
            invitation.email,
          ])
          .then(
            () => ({}),
            (error: { code?: string }) => ({ error }),
          )
        await vi.waitFor(async () => {
          const activity = await testDb.pool.query(
            'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
            [backend.rows[0]?.pid],
          )
          expect(activity.rows[0]?.wait_event_type).toBe('Lock')
        })
        await holding.query(
          `SELECT pg_sleep(greatest(0, extract(epoch FROM $1::timestamptz - clock_timestamp())) + 0.02)`,
          [rows[0]?.expiresAt],
        )
        await holding.query('COMMIT')
        expect(await insertion).toMatchObject({ error: { code: '42501' } })
        expect(await users()).toEqual(['inviter@team.example'])
      } finally {
        await holding.query('ROLLBACK')
        await insertion
        holding.release()
        signingUp.release()
      }
    })

    it('locks a domain-admitted inviter against email changes until signup commits', async () => {
      await db
        .insertInto('auth.user')
        .values({ email: 'first@outside.example', name: 'First', emailVerified: true })
        .execute()
      const invitation = await invite()
      const signingUp = await authPool(CLOSED).connect()
      const changing = await testDb.pool.connect()
      let changed: Promise<unknown> | undefined
      try {
        await signingUp.query('BEGIN')
        await signingUp.query(
          `INSERT INTO auth."user" (name, email, "emailVerified") VALUES ('', $1, true)`,
          [invitation.email],
        )
        const backend = await changing.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        changed = changing.query(
          `UPDATE auth."user" SET email = 'inviter@outside.example' WHERE id = $1`,
          [invitation.inviterId],
        )
        await vi.waitFor(async () => {
          const activity = await testDb.pool.query(
            'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
            [backend.rows[0]?.pid],
          )
          expect(activity.rows[0]?.wait_event_type).toBe('Lock')
        })
        await signingUp.query('COMMIT')
        await changed
        expect(await users()).toEqual([
          'first@outside.example',
          'invitee@outside.example',
          'inviter@outside.example',
        ])
      } finally {
        await signingUp.query('ROLLBACK')
        await changed
        signingUp.release()
        changing.release()
      }
    })

    it.each(['canceled', 'expired'])(
      'refuses at insertion if the invitation becomes %s after the application check',
      async (change) => {
        const invitation = await invite()
        const pool = authPool(restricted[0] as SignupPolicy)
        let resume = () => {}
        let reached = () => {}
        const released = new Promise<void>((resolve) => {
          resume = resolve
        })
        const inserting = new Promise<void>((resolve) => {
          reached = resolve
        })
        const timeout = setTimeout(resume, 5_000)
        const forward = (target: object, prop: string | symbol) => {
          const value = Reflect.get(target, prop)
          return typeof value === 'function' ? value.bind(target) : value
        }
        const held = new Proxy(pool, {
          get(target, prop) {
            if (prop !== 'connect') return forward(target, prop)
            return async () =>
              new Proxy(await target.connect(), {
                get(connection, key) {
                  if (key !== 'query') return forward(connection, key)
                  return async (...args: unknown[]) => {
                    if (typeof args[0] === 'string' && /^insert into "user"/i.test(args[0])) {
                      reached()
                      await released
                    }
                    return (connection.query as (...a: unknown[]) => Promise<unknown>)(...args)
                  }
                },
              })
          },
        })
        const request = googleSignIn(
          instance(restricted[0] as SignupPolicy, { pool: held, google: invitation.email }),
        )
        try {
          await Promise.race([
            inserting,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('insert not reached')), 3_000).unref(),
            ),
          ])
          await db
            .updateTable('auth.invitation')
            .set(change === 'canceled' ? { status: 'canceled' } : { expiresAt: new Date(0) })
            .where('id', '=', invitation.id)
            .execute()
          resume()
          const res = await request
          expect(res.status).toBe(401)
          expect(hasSession(res)).toBe(false)
          expect(await users()).toEqual(['inviter@team.example'])
        } finally {
          clearTimeout(timeout)
          resume()
          await request
        }
      },
    )
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

    it('refuse a Microsoft sign-up too, without naming the address', async () => {
      for (const policy of [CLOSED, FIRST_USER]) {
        if (policy === FIRST_USER) await signIn(instance(OPEN), 'owner@anywhere.example')
        const before = await rows()
        const res = await idTokenSignIn(
          instance(policy, { microsoft: 'stranger@elsewhere.example' }),
          'microsoft',
        )
        expect(res.status, policy.mode).toBe(403)
        const body = await res.text()
        expect(JSON.parse(body), policy.mode).toMatchObject({ code: 'SIGNUP_DISABLED' })
        expect(body, policy.mode).not.toContain('stranger')
        expect(hasSession(res), policy.mode).toBe(false)
        expect(await rows(), policy.mode).toEqual(before)
      }
    })

    it('refuse a sign-up through the OAuth redirect, landing on the error callback', async () => {
      const app = instance(CLOSED, { google: 'stranger@elsewhere.example' })
      const started = await app.request('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({
          provider: 'google',
          callbackURL: '/',
          errorCallbackURL: '/sign-in-failed',
        }),
      })
      expect(started.status).toBe(200)
      const state = new URL(((await started.json()) as { url: string }).url).searchParams.get(
        'state',
      )
      const cookie = started.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ')
      // Google's token endpoint answers the code exchange; the user info comes from vouching().
      const realFetch = globalThis.fetch
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input)
        if (!url.startsWith('https://oauth2.googleapis.com/token')) return realFetch(input, init)
        return Response.json({
          access_token: 'access',
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: 'header.payload.signature',
        })
      })
      const before = await rows()
      let res: Response
      let exchanges = 0
      try {
        res = await app.request(`/api/auth/callback/google?code=code&state=${state}`, {
          headers: { cookie },
        })
        exchanges = fetchSpy.mock.calls.length
      } finally {
        fetchSpy.mockRestore()
      }
      expect(exchanges).toBe(1)
      expect(res.status).toBe(302)
      const location = res.headers.get('location') as string
      // Better Auth redirects to the error callback as given (here relative).
      const target = new URL(location, origin)
      expect(`${target.origin}${target.pathname}`).toBe(`${origin}/sign-in-failed`)
      expect(target.searchParams.get('error')).toBe('SIGNUP_DISABLED')
      expect(location).not.toContain('stranger')
      expect(hasSession(res)).toBe(false)
      expect(await rows()).toEqual(before)
      expect(before).toEqual(NO_ROWS)
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
        await afterSend()
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

    it('goes out only after the answer', async () => {
      const sent: string[] = []
      const app = instance(OPEN, { mailer: { send: async (m) => void sent.push(m.to) } })
      expect((await askForLinkRequest(app, 'ada@one.example')).status).toBe(200)
      expect(sent).toEqual([])
      await afterSend()
      expect(sent).toEqual(['ada@one.example'])
    })

    it('is not waited for: answers come at once and alike while SMTP hangs or fails', async () => {
      await signIn(instance(OPEN), 'early@anywhere.example')
      let failedText = ''
      const fail = (err: unknown) => async () => {
        throw err
      }
      const mailers: Record<string, Mailer> = {
        hanging: { send: () => new Promise<void>(() => {}) },
        // As nodemailer reports a refused recipient; the message quotes the envelope and the
        // email, link included.
        smtp: {
          send: async ({ to, text }) => {
            failedText = text
            throw Object.assign(new Error(`550 5.1.1 <${to}> rejected: ${text}`), {
              code: 'EENVELOPE',
              responseCode: 550,
              command: 'RCPT TO',
            })
          },
        },
        // Odd shapes must not make the logging itself throw (an unhandled rejection).
        throwingCode: {
          send: fail(
            Object.defineProperty(new Error('x'), 'code', {
              get: () => {
                throw new Error('no code')
              },
            }),
          ),
        },
        nonStringMessage: { send: fail({ message: { toString: () => 'early@anywhere.example' } }) },
      }
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => void unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const answers: string[] = []
      try {
        for (const [name, mailer] of Object.entries(mailers)) {
          const app = instance(CLOSED, { mailer })
          // No account (no email) and an account (an email that hangs or fails).
          for (const email of ['stranger@elsewhere.example', 'early@anywhere.example']) {
            const started = performance.now()
            const res = await askForLinkRequest(app, email)
            answers.push(JSON.stringify({ status: res.status, body: await res.json() }))
            expect(performance.now() - started, `${name}, ${email}`).toBeLessThan(2_000)
          }
        }
        await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(3))
        await afterSend()
        // Only the code, response code and command: never the message.
        expect(errors.mock.calls.map((args) => args.join(' ')).sort()).toEqual([
          '[auth] sign-in email not sent',
          '[auth] sign-in email not sent (code=EENVELOPE, responseCode=550, command=RCPT TO)',
          '[auth] sign-in email not sent (details unavailable)',
        ])
        expect(failedText).toContain('/sign-in/confirm#token=')
      } finally {
        errors.mockRestore()
        process.off('unhandledRejection', onUnhandled)
      }
      expect(unhandled).toEqual([])
      expect(answers).toEqual(
        Array(8).fill(JSON.stringify({ status: 200, body: { status: true } })),
      )
    })
  })

  describe('the first user', () => {
    /**
     * A Better Auth pool whose user inserts wait until `n` of them are waiting, then all go
     * ahead together: by then each request has passed the create hook's check while no user
     * existed, the worst interleaving for the first-user rule.
     */
    function userInsertBarrier(signup: SignupPolicy, n: number, url?: string) {
      const pool = authPool(signup, url)
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

    // A DATABASE_URL may carry its own connection options (and other parameters); they must
    // not displace the sign-up settings.
    it.each([
      ['a plain URL', () => testDb.url],
      ['options in the URL', () => urlWith({ options: '-c search_path=auth,public' })],
      [
        'options and other parameters in the URL',
        () =>
          urlWith({
            application_name: 'hourmere-test',
            options: '-c search_path=auth,public -c hourmere.signup=open',
          }),
      ],
    ])(
      'is the only account created when several people sign up at once (%s)',
      async (_, url) => {
        const policy: SignupPolicy = { mode: 'first-user', allowedDomains: [] }
        const barrier = userInsertBarrier(policy, 3, url())
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
        expect(
          barrier.waiting(),
          'waiting for all three concurrent user INSERTs to reach the first-user barrier',
        ).toBe(3)
        expect(responses.filter(hasSession)).toHaveLength(1)
        // The others were refused by the database: an email link with a 500 (the hook had
        // already let it through), Google with Better Auth's "unable to create user".
        const [a, b, g] = responses.map((r) => r.status)
        expect([a, b].every((s) => s === 302 || s === 500)).toBe(true)
        expect([200, 401]).toContain(g)
        const winner = await users()
        expect(winner).toHaveLength(1)
        expect(await rows()).toEqual({
          ...NO_ROWS,
          users: 1,
          accounts: winner[0] === 'racer@google.example' ? 1 : 0,
          sessions: 1,
          organizations: 1,
          members: 1,
          personal: 1,
        })
      },
      20_000,
    )
  })

  describe('database backstop', () => {
    const insert = (pool: pg.Pool | pg.PoolClient, email: string) =>
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
      const bogus = createPool(urlWith({ options: '-c hourmere.signup=x' }))
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

    const settings = async (pool: pg.Pool) =>
      (
        await pool.query(
          `SELECT current_setting('search_path') AS search_path,
                  current_setting('application_name') AS application_name,
                  current_setting('hourmere.signup', true) AS signup,
                  current_setting('hourmere.signup_allowed_domains', true) AS domains`,
        )
      ).rows[0]

    it('keeps the sign-up settings when the URL brings its own options', async () => {
      expect(await settings(authPool(CLOSED))).toMatchObject({
        search_path: 'auth',
        signup: 'closed',
        domains: 'team.example',
      })
      // The URL's options and other parameters apply, except where they would change the
      // sign-up settings.
      const url = urlWith({
        application_name: 'hourmere-test',
        options: '-c search_path=auth,public -c hourmere.signup=open',
      })
      expect(await settings(authPool(CLOSED, url))).toEqual({
        search_path: 'auth,public',
        application_name: 'hourmere-test',
        signup: 'closed',
        domains: 'team.example',
      })
    })

    it('is checked before serving: connections without the settings are refused', async () => {
      await assertSignupEnforced(authPool(CLOSED), CLOSED)
      await assertSignupEnforced(authPool(OPEN), OPEN)
      const missing = /does not carry the sign-up policy.*through a pooler that passes/
      // As behind a pooler that drops startup parameters.
      await expect(assertSignupEnforced(testDb.pool, CLOSED)).rejects.toThrow(missing)
      await expect(assertSignupEnforced(testDb.pool, OPEN)).rejects.toThrow(missing)
      // Or carrying another policy.
      await expect(assertSignupEnforced(authPool(FIRST_USER), CLOSED)).rejects.toThrow(missing)
      await expect(
        assertSignupEnforced(authPool(CLOSED), { mode: 'closed', allowedDomains: [] }),
      ).rejects.toThrow(missing)
    })

    it('sets an empty domain list too, so the URL cannot add domains', async () => {
      const policy: SignupPolicy = { mode: 'closed', allowedDomains: [] }
      const pool = authPool(
        policy,
        urlWith({ options: '-c hourmere.signup_allowed_domains=evil.example' }),
      )
      expect(await settings(pool)).toMatchObject({ signup: 'closed', domains: '' })
      await expect(insert(pool, 'mallory@evil.example')).rejects.toMatchObject(refused)
      await assertSignupEnforced(pool, policy)
      expect(await users()).toEqual([])
    })

    it('needs read committed or serializable isolation for first sign-ups', async () => {
      const policy: SignupPolicy = { mode: 'first-user', allowedDomains: [] }
      const pool = authPool(policy)
      const insertAt = async (isolation: string, email: string) => {
        const client = await pool.connect()
        try {
          await client.query(`BEGIN ISOLATION LEVEL ${isolation}`)
          await insert(client, email)
          await client.query('COMMIT')
        } catch (err) {
          await client.query('ROLLBACK')
          throw err
        } finally {
          client.release()
        }
      }
      // Its snapshot would predate the lock, missing a first user committed meanwhile.
      await expect(insertAt('REPEATABLE READ', 'first@elsewhere.example')).rejects.toMatchObject({
        code: '55000',
        message: 'first-user sign-up needs read committed or serializable isolation',
      })
      expect(await users()).toEqual([])
      await insertAt('SERIALIZABLE', 'first@elsewhere.example')
      await expect(insertAt('SERIALIZABLE', 'second@elsewhere.example')).rejects.toMatchObject(
        refused,
      )
      // A connection that defaults to repeatable read is refused at startup in this mode.
      const isolation = (level: string) =>
        urlWith({ options: `-c default_transaction_isolation=${level.replace(' ', '\\ ')}` })
      await expect(
        assertSignupEnforced(authPool(policy, isolation('repeatable read')), policy),
      ).rejects.toThrow(/defaults to repeatable read isolation/)
      await assertSignupEnforced(authPool(policy, isolation('serializable')), policy)
      await assertSignupEnforced(authPool(policy, isolation('read committed')), policy)
      // Outside first-user mode it does not matter.
      await assertSignupEnforced(authPool(CLOSED, isolation('repeatable read')), CLOSED)
    })
  })
})
