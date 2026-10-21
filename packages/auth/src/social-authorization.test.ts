import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAuth, createAuthPool } from './index.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:43827'
const signup = { mode: 'open', allowedDomains: [] } as const
const client = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' }
const rejection = {
  code: 'UNSUPPORTED_SOCIAL_AUTHORIZATION_PARAMETERS',
  message: 'Custom social authorization parameters are not supported',
}
const unsupportedBodies = [
  { scopes: ['https://www.googleapis.com/auth/calendar'] },
  { scopes: ['Calendars.Read', 'offline_access'] },
  { scopes: [] },
  { scopes: null },
  { additionalParams: { include_granted_scopes: 'true', access_type: 'offline' } },
  { additionalParams: { hd: 'synthetic.example', login_hint: 'synthetic@example.test' } },
  { additionalParams: {} },
  { additionalParams: null },
  { loginHint: 'synthetic@example.test' },
  { requestSignUp: false },
  { additionalData: { synthetic: 'untrusted' } },
  { idToken: { token: 'synthetic.header.signature' } },
  { hd: 'synthetic.example' },
  { login_hint: 'synthetic@example.test' },
  { include_granted_scopes: 'true' },
  { access_type: 'offline' },
  { futureAuthorizationOption: 'synthetic-untrusted-value' },
]

describe.skipIf(!serverUrl)('social authorization request boundary', () => {
  let owned: TestDatabase
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let reachableLink: ReturnType<typeof createAuth>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    authPool = createAuthPool(owned.url, signup)
    const fixture = () =>
      createAuth({
        pool: authPool,
        db: createDb(owned.pool),
        baseURL: origin,
        secret: 'synthetic-authorization-test-secret-at-least-32-characters',
        signup,
        mailer: { send: async () => {} },
        socialProviders: { google: client, microsoft: client },
      })
    auth = fixture()
    reachableLink = fixture()
    // Production keeps this endpoint disabled. Exercise the before hook as well, so
    // enabling linking in a future configuration cannot reintroduce custom grants.
    reachableLink.options.disabledPaths = reachableLink.options.disabledPaths?.filter(
      (path) => path !== '/link-social',
    )
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  function post(
    path: string,
    body: object,
    headers: Record<string, string> = { origin },
    selected = auth,
  ) {
    return selected.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    )
  }

  describe.each(['google', 'microsoft'] as const)('%s', (provider) => {
    it.each(unsupportedBodies.map((body) => [Object.keys(body)[0], body] as const))(
      'rejects the presence of %s without echoing caller data',
      async (_field, extra) => {
        const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected fetch'))
        for (const [path, selected] of [
          ['/sign-in/social', auth],
          ['/link-social', reachableLink],
        ] as const) {
          const response = await post(path, { provider, ...extra }, { origin }, selected)
          expect(response.status).toBe(400)
          expect(await response.json()).toEqual(rejection)
          expect(response.headers.has('location')).toBe(false)
          expect(response.headers.getSetCookie()).toEqual([])
        }
        expect(fetch).not.toHaveBeenCalled()
      },
    )

    it.each(['scopes', 'additionalParams', 'loginHint', 'futureAuthorizationOption'])(
      'rejects query field %s',
      async (field) => {
        for (const [path, selected] of [
          ['/sign-in/social', auth],
          ['/link-social', reachableLink],
        ] as const) {
          const response = await post(
            `${path}?${field}=synthetic-untrusted-value`,
            { provider },
            { origin },
            selected,
          )
          expect(response.status).toBe(400)
          expect(await response.json()).toEqual(rejection)
        }
      },
    )

    it.each([false, true])(
      'accepts the web redirect fields, disableRedirect=%s',
      async (disabled) => {
        const response = await post('/sign-in/social', {
          provider,
          callbackURL: '/app',
          errorCallbackURL: '/sign-in',
          newUserCallbackURL: '/app/settings',
          disableRedirect: disabled,
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as { url: string; redirect: boolean }
        expect(new URL(body.url).searchParams.get('redirect_uri')).toBe(
          `${origin}/api/auth/callback/${provider}`,
        )
        expect(body.redirect).toBe(!disabled)
      },
    )

    it.each([
      [{}, 'MISSING_OR_NULL_ORIGIN'],
      [{ origin: 'null' }, 'MISSING_OR_NULL_ORIGIN'],
      [{ origin: 'https://foreign.example' }, 'INVALID_ORIGIN'],
      [{ origin: `${origin}.foreign.example` }, 'INVALID_ORIGIN'],
    ] as const)('requires the app Origin without cookies: %j', async (headers, code) => {
      for (const [path, selected] of [
        ['/sign-in/social', auth],
        ['/link-social', reachableLink],
      ] as const) {
        const response = await post(path, { provider }, headers, selected)
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({
          code,
          message: 'A same-origin request is required',
        })
        expect(response.headers.getSetCookie()).toEqual([])
      }
    })

    it('keeps explicit linking disabled over HTTP', async () => {
      const response = await post('/link-social', { provider, scopes: ['offline_access'] })
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('Not Found')
    })

    it('does not initiate provider authorization through a stateless callback', async () => {
      const response = await auth.handler(
        new Request(
          `${origin}/api/auth/callback/${provider}?code=synthetic-code&login_hint=synthetic`,
        ),
      )
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(`${origin}/sign-in?error=state_not_found`)
    })
  })
})
