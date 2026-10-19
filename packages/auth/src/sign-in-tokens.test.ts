import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAuth, createAuthPool } from './index.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:43827'
const signup = { mode: 'open', allowedDomains: [] } as const
const providers = ['google', 'microsoft'] as const
type Provider = (typeof providers)[number]
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')

describe.skipIf(!serverUrl)('sign-in token minimisation', () => {
  let owned: TestDatabase
  let authPool: ReturnType<typeof createAuthPool>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    authPool = createAuthPool(owned.url, signup)
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  function fixture(provider: Provider, scenario: string) {
    const identity = `${provider}-${scenario}`
    let version = 0
    let refreshedWithExpectedToken = false
    const access = () => `synthetic-access-${identity}-${version}`
    const refresh = () => `synthetic-refresh-${identity}-${version}`
    const idToken = 'synthetic.header.signature'
    const options = {
      verifyIdToken: async () => true,
      getUserInfo: async (tokens: { idToken?: string }) => {
        // The fresh token is available for authentication before the database hook runs.
        expect(tokens.idToken === idToken).toBe(true)
        return {
          user: {
            name: 'Synthetic sign-in user',
            email: `${identity}@example.test`,
            emailVerified: true,
          },
          data: { sub: identity, oid: identity } as never,
        }
      },
    }
    const auth = createAuth({
      pool: authPool,
      db: createDb(owned.pool),
      baseURL: origin,
      secret: 'synthetic-sign-in-token-test-secret-at-least-32-characters',
      signup,
      mailer: { send: async () => {} },
      socialProviders: {
        google: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' },
        microsoft: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' },
      },
      socialProviderOptions: { google: options, microsoft: options },
    })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      const allowed = [
        'https://oauth2.googleapis.com/token',
        'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      ]
      if (!allowed.includes(url)) throw new Error('Unexpected provider request in sign-in fixture')
      const body = new URLSearchParams(String(init?.body))
      if (body.get('grant_type') === 'refresh_token')
        refreshedWithExpectedToken = body.get('refresh_token') === refresh()
      version++
      return Response.json({
        access_token: access(),
        refresh_token: refresh(),
        id_token: idToken,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid profile email',
      })
    })
    const post = (path: string, body: object, cookie = '') =>
      auth.handler(
        new Request(`${origin}/api/auth${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin, cookie },
          body: JSON.stringify(body),
        }),
      )
    // HTTP linking/token endpoints are disabled; use server APIs to retain hook and
    // encryption coverage while sign-in and provider callbacks still use the handler.
    const headers = (cookie: string) => new Headers({ origin, cookie })
    const direct = (cookie = '', selected = provider, linking = false) => {
      const body = {
        provider: selected,
        idToken: { token: idToken, accessToken: access(), refreshToken: refresh() },
      }
      return linking
        ? auth.api.linkSocialAccount({ body, headers: headers(cookie), asResponse: true })
        : post('/sign-in/social', body, cookie)
    }
    const redirect = async (cookie = '', linking = false) => {
      const body = { provider, callbackURL: '/app' }
      const started = linking
        ? await auth.api.linkSocialAccount({ body, headers: headers(cookie), asResponse: true })
        : await post('/sign-in/social', body, cookie)
      expect(started.status).toBe(200)
      const { url } = (await started.json()) as { url: string }
      const state = new URL(url).searchParams.get('state')
      expect(state !== null).toBe(true)
      const response = await auth.handler(
        new Request(`${origin}/api/auth/callback/${provider}?code=synthetic-code&state=${state}`, {
          headers: { cookie: `${cookie}; ${cookies(started)}` },
        }),
      )
      expect(response.status).toBe(302)
      expect(new URL(response.headers.get('location') as string, origin).pathname).toBe('/app')
      return response
    }
    const account = async () => {
      const result = await owned.pool.query<{
        id: string
        userId: string
        idToken: string | null
        accessToken: string | null
        refreshToken: string | null
      }>('SELECT * FROM auth.account WHERE "providerId" = $1 AND "accountId" = $2', [
        provider,
        identity,
      ])
      expect(result.rowCount).toBe(1)
      return result.rows[0] as NonNullable<(typeof result.rows)[number]>
    }
    const stored = async (hasRefresh = true) => {
      const row = await account()
      expect(row.idToken === null).toBe(true)
      // Inspect actual persisted ciphertext, then decrypt via Better Auth's server API.
      expect(Boolean(row.accessToken) && row.accessToken !== access()).toBe(true)
      expect(row.refreshToken === null || row.refreshToken !== refresh()).toBe(true)
      if (hasRefresh) expect(Boolean(row.refreshToken)).toBe(true)
      const result = await auth.api.getAccessToken({
        body: { accountId: row.id, userId: row.userId },
      })
      expect(result.accessToken === access()).toBe(true)
      expect(result.idToken === undefined).toBe(true)
      return row
    }
    return {
      auth,
      direct,
      redirect,
      account,
      stored,
      fetch,
      access,
      refresh,
      refreshed: () => refreshedWithExpectedToken,
    }
  }

  it.each(providers)(
    'discards %s callback tokens on first/repeat sign-in and implicit linking',
    async (provider) => {
      const f = fixture(provider, 'callback')
      await f.redirect()
      const first = await f.stored()
      await f.redirect()
      expect((await f.stored()).id).toBe(first.id)
      await owned.pool.query('DELETE FROM auth.account WHERE id = $1', [first.id])
      await f.redirect()
      expect((await f.stored()).userId).toBe(first.userId)
      expect(f.fetch).toHaveBeenCalledTimes(3)
    },
  )

  it.each(providers)(
    'discards %s callback tokens when explicitly linking and relinking',
    async (provider) => {
      const f = fixture(provider, 'link')
      const signedIn = await f.direct('', provider === 'google' ? 'microsoft' : 'google')
      expect(signedIn.status).toBe(200)
      const cookie = cookies(signedIn)
      await f.redirect(cookie, true)
      const first = await f.stored()
      await f.redirect(cookie, true)
      expect((await f.stored()).id).toBe(first.id)
    },
  )

  it.each(providers)(
    'discards %s direct ID tokens on sign-in, repeat sign-in, link and relink',
    async (provider) => {
      const f = fixture(provider, 'direct')
      const signedIn = await f.direct()
      expect(signedIn.status).toBe(200)
      const first = await f.stored(false)
      expect((await f.direct()).status).toBe(200)
      expect((await f.stored(false)).id).toBe(first.id)
      await owned.pool.query('DELETE FROM auth.account WHERE id = $1', [first.id])
      const cookie = cookies(signedIn)
      expect((await f.direct(cookie, provider, true)).status).toBe(200)
      const linked = await f.stored()
      expect(linked.userId).toBe(first.userId)
      expect((await f.direct(cookie, provider, true)).status).toBe(200)
      expect((await f.stored()).id).toBe(linked.id)
      expect(f.fetch).not.toHaveBeenCalled()
    },
  )

  it.each(providers)(
    'discards %s ID tokens on explicit/automatic refresh and partial updates',
    async (provider) => {
      const f = fixture(provider, 'refresh')
      const signedIn = await f.redirect()
      const first = await f.stored()
      const headers = new Headers({ origin, cookie: cookies(signedIn) })
      const refreshed = await f.auth.api.refreshToken({
        body: { accountId: first.id },
        headers,
        asResponse: true,
      })
      expect(refreshed.status).toBe(200)
      expect(f.refreshed()).toBe(true)
      const tokens = (await refreshed.json()) as { accessToken: string; refreshToken: string }
      expect(tokens.accessToken === f.access() && tokens.refreshToken === f.refresh()).toBe(true)
      await f.stored()
      await owned.pool.query(
        'UPDATE auth.account SET "accessTokenExpiresAt" = now() - interval \'1 minute\' WHERE id = $1',
        [first.id],
      )
      const automatic = await f.auth.api.getAccessToken({
        body: { accountId: first.id },
        headers,
        asResponse: true,
      })
      expect(automatic.status).toBe(200)
      expect(f.refreshed()).toBe(true)
      expect(((await automatic.json()) as { accessToken: string }).accessToken === f.access()).toBe(
        true,
      )
      await f.stored()
      // Even an update without idToken must clear a legacy value rather than preserve it.
      await owned.pool.query('UPDATE auth.account SET "idToken" = $1 WHERE id = $2', [
        'synthetic-legacy-id-token',
        first.id,
      ])
      await (await f.auth.$context).internalAdapter.updateAccount(first.id, {
        scope: 'openid email',
      })
      await f.stored()
      expect(f.fetch).toHaveBeenCalledTimes(3)
    },
  )
})
