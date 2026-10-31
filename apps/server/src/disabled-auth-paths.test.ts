// Exercise Better Auth's public HTTP surface through Hourmere's production app composition.
import { randomBytes } from 'node:crypto'
import {
  type AuthConfig,
  createAuth,
  createAuthPool,
  createCallerResolver,
  type SignupPolicy,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { pressConfirmButton } from './sign-in-confirm-testing.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:3000'
const signup: SignupPolicy = { mode: 'open', allowedDomains: [] }
const providerClient = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' }
const disabledRequests = [
  { path: '/account-info', method: 'GET', account: 'query' },
  { path: '/get-access-token', method: 'POST', account: 'body' },
  { path: '/refresh-token', method: 'POST', account: 'body' },
  { path: '/link-social', method: 'POST', body: { provider: 'google', callbackURL: '/' } },
  { path: '/list-accounts', method: 'GET' },
] as const

const sessionCookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')

describe.skipIf(!serverUrl)('unused Better Auth endpoints in the production app', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: pg.Pool

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    // Reuse this pool across configurations and tests rather than opening one per app.
    authPool = createAuthPool(owned.url, signup)
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  describe.each([false, true])('with MCP OAuth enabled: %s', (mcpOAuth) => {
    let app: ReturnType<typeof createApp>
    let auth: ReturnType<typeof createAuth>
    let cookie: string
    let organizationId: string
    let accountId: string
    const outbox: MailMessage[] = []
    const email = (provider: string) => `${provider}-mcp-${mcpOAuth}@example.com`

    const post = (path: string, body: unknown, session = cookie) =>
      app.request(`/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, cookie: session },
        body: JSON.stringify(body),
      })

    const me = (headers: Record<string, string>) => app.request('/api/v1/me', { headers })

    async function socialSignIn(provider: 'google' | 'microsoft') {
      // Direct ID tokens are reserved for trusted server calls. The public HTTP
      // redirect flow is exercised separately by the sign-in authorization tests.
      const response = await auth.api.signInSocial({
        body: {
          provider,
          idToken: {
            token: 'synthetic.header.signature',
            accessToken: 'synthetic-provider-access',
            refreshToken: 'synthetic-provider-refresh',
          },
        },
        asResponse: true,
      })
      expect(response.status).toBe(200)
      const session = sessionCookie(response)
      expect(session.includes('better-auth.session_token=')).toBe(true)
      return session
    }

    beforeAll(async () => {
      const socialProviderOptions: AuthConfig['socialProviderOptions'] = {}
      for (const provider of ['google', 'microsoft'] as const) {
        socialProviderOptions[provider] = {
          // Replace only the provider boundary. Sessions, account encryption and HTTP
          // handling remain real, including when a mutation restores a disabled route.
          verifyIdToken: async () => true,
          getUserInfo: async () => ({
            user: { email: email(provider), emailVerified: true, name: 'Synthetic person' },
            data: { sub: `${provider}-${mcpOAuth}`, oid: `${provider}-${mcpOAuth}` } as never,
          }),
          refreshAccessToken: async () => ({
            accessToken: 'synthetic-refreshed-access',
            refreshToken: 'synthetic-refreshed-refresh',
            accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
          }),
        }
      }
      auth = createAuth({
        pool: authPool,
        db,
        baseURL: origin,
        secret: randomBytes(32).toString('base64'),
        mailer: { send: async (mail) => void outbox.push(mail) },
        signup,
        socialProviders: { google: providerClient, microsoft: providerClient },
        socialProviderOptions,
        mcpOAuth,
      })
      app = createApp({
        checkDb: async () => {},
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        publicUrl: origin,
      })
      cookie = await socialSignIn('microsoft')
      const response = await me({ cookie })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        user: { id: string; email: string }
        organization: { id: string; personal: boolean }
        principal: { kind: string }
      }
      expect(body.user.email).toBe(email('microsoft'))
      expect(body.organization.personal).toBe(true)
      expect(body.principal.kind).toBe('session')
      organizationId = body.organization.id
      // Direct ID-token sign-in does not persist a refresh token. Microsoft linking
      // retains an encrypted one, so restored HTTP token routes can reach the fake
      // provider successfully; Google deliberately discards it even on linking.
      await auth.api.linkSocialAccount({
        headers: new Headers({ cookie, origin }),
        body: {
          provider: 'microsoft',
          idToken: {
            token: 'synthetic.header.signature',
            accessToken: 'synthetic-provider-access',
            refreshToken: 'synthetic-provider-refresh',
          },
        },
      })
      const account = await db
        .selectFrom('auth.account')
        .select(['id', 'refreshToken'])
        .where('userId', '=', body.user.id)
        .where('providerId', '=', 'microsoft')
        .executeTakeFirstOrThrow()
      accountId = account.id
      expect(Boolean(account.refreshToken)).toBe(true)
      expect(account.refreshToken === 'synthetic-provider-refresh').toBe(false)
    })

    it.each(disabledRequests)('returns the exact disabled response for $path', async (request) => {
      const selected = 'account' in request ? { accountId } : undefined
      const query = 'account' in request && request.account === 'query'
      const path = query ? `${request.path}?${new URLSearchParams(selected)}` : request.path
      const body = 'body' in request ? request.body : query ? undefined : selected
      const response = await app.request(`/api/auth${path}`, {
        method: request.method,
        headers: { 'content-type': 'application/json', origin, cookie },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('Not Found')
    })

    it('still signs in through the emailed magic-link confirmation page', async () => {
      const address = email('magic-link')
      const response = await post('/sign-in/magic-link', { email: address, callbackURL: '/' }, '')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: true })
      await new Promise<void>((resolve) => setImmediate(resolve))
      const message = outbox.find((mail) => mail.to === address)
      expect(message?.subject).toBe('Sign in to Hourmere')
      const link = message?.text.match(/https?:\/\/\S+/)?.[0]
      expect(link !== undefined).toBe(true)
      const verification = await pressConfirmButton(app, new URL(link as string))
      const signedIn = await app.request(verification.toString())
      expect(signedIn.status).toBe(302)
      expect(signedIn.headers.get('location')).toBe(`${origin}/`)
      const current = await me({ cookie: sessionCookie(signedIn) })
      expect(current.status).toBe(200)
      expect(await current.json()).toMatchObject({
        user: { email: address },
        principal: { kind: 'session' },
      })
    })

    it.each(['google', 'microsoft'] as const)(
      'still authenticates sessions from trusted fake %s provider sign-in',
      async (provider) => {
        const current = await me({ cookie: await socialSignIn(provider) })
        expect(current.status).toBe(200)
        expect(await current.json()).toMatchObject({
          user: { email: email(provider) },
          principal: { kind: 'session' },
        })
      },
    )

    it('still creates, lists, authenticates and deletes API keys', async () => {
      const created = await post('/api-key/create', { name: 'Synthetic integration' })
      expect(created.status).toBe(200)
      const key = (await created.json()) as { id: string; key: string }
      const bearer = { authorization: `Bearer ${key.key}` }
      const current = await me(bearer)
      expect(current.status).toBe(200)
      expect(await current.json()).toMatchObject({
        user: { email: email('microsoft') },
        principal: { kind: 'api_key', apiKeyScope: 'full' as const, apiKeyId: key.id },
      })
      const listed = await app.request('/api/auth/api-key/list', { headers: { cookie } })
      expect(listed.status).toBe(200)
      const listing = JSON.stringify(await listed.json())
      expect(listing.includes(key.id)).toBe(true)
      expect(listing.includes(key.key)).toBe(false)
      const deleted = await post('/api-key/delete', { keyId: key.id })
      expect(deleted.status).toBe(200)
      expect((await me(bearer)).status).toBe(401)
    })

    it("still lists the signed-in user's organizations", async () => {
      const response = await app.request('/api/auth/organization/list', { headers: { cookie } })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: organizationId })]),
      )
    })

    it('still signs out and revokes the session', async () => {
      const response = await post('/sign-out', {})
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true })
      expect((await me({ cookie })).status).toBe(401)
    })
  })
})
