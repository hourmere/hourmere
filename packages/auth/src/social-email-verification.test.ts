import { randomUUID } from 'node:crypto'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAuth, createAuthPool } from './index.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:43827'
const signup = { mode: 'open', allowedDomains: [] } as const
const client = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' }
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')

describe.skipIf(!serverUrl)('social callback email verification', () => {
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

  describe.each(['google', 'microsoft'] as const)('%s', (provider) => {
    describe.each([
      { label: 'boolean false', value: false },
      { label: 'string false', value: 'false' },
    ])('email_verified=$label', ({ value: emailVerified }) => {
      it.each(['new', 'unverified', 'verified'] as const)(
        'rejects an unverified provider email for a %s local account',
        async (localAccount) => {
          const identity = randomUUID()
          const email = `${identity}@example.test`
          if (localAccount !== 'new') {
            await owned.pool.query(
              'INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, $4)',
              [identity, 'Existing account', email, localAccount === 'verified'],
            )
          }
          const auth = createAuth({
            pool: authPool,
            db: createDb(owned.pool),
            baseURL: origin,
            secret: 'synthetic-email-verification-test-secret-at-least-32-characters',
            signup,
            mailer: { send: async () => {} },
            socialProviders: { [provider]: client },
            // Replace only signature verification: the real provider decodes the claims,
            // and Better Auth normalizes email verification before linking or creating users.
            socialProviderOptions: {
              [provider]: {
                verifyIdToken: async () => true,
              },
            },
          })
          const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = input instanceof Request ? input.url : String(input)
            const tokenUrl =
              provider === 'google'
                ? 'https://oauth2.googleapis.com/token'
                : 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
            if (url !== tokenUrl) throw new Error('Unexpected provider request')
            return Response.json({
              access_token: 'synthetic-access',
              id_token: `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.${Buffer.from(
                JSON.stringify({
                  sub: identity,
                  oid: identity,
                  email,
                  name: 'Untrusted provider account',
                  email_verified: emailVerified,
                }),
              ).toString('base64url')}.synthetic`,
              token_type: 'Bearer',
              expires_in: 3600,
              scope: 'openid profile email',
            })
          })
          const started = await auth.handler(
            new Request(`${origin}/api/auth/sign-in/social`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', origin },
              body: JSON.stringify({ provider, callbackURL: '/app', errorCallbackURL: '/sign-in' }),
            }),
          )
          expect(started.status).toBe(200)
          const { url } = (await started.json()) as { url: string }
          const state = new URL(url).searchParams.get('state')
          expect(state !== null).toBe(true)
          const response = await auth.handler(
            new Request(`${origin}/api/auth/callback/${provider}?code=synthetic&state=${state}`, {
              headers: { cookie: cookies(started) },
            }),
          )
          expect(fetch).toHaveBeenCalledTimes(1)
          expect(response.status).toBe(302)
          const destination = new URL(response.headers.get('location') as string, origin)
          expect(destination.pathname).toBe('/sign-in')
          expect(destination.searchParams.has('error')).toBe(true)
          expect(cookies(response).includes('session_token')).toBe(false)
          const users = await owned.pool.query(
            'SELECT id, name, "emailVerified" FROM auth."user" WHERE email = $1',
            [email],
          )
          expect(users.rows).toEqual(
            localAccount === 'new'
              ? []
              : [
                  {
                    id: identity,
                    name: 'Existing account',
                    emailVerified: localAccount === 'verified',
                  },
                ],
          )
          const accounts = await owned.pool.query(
            'SELECT id FROM auth.account WHERE "userId" = $1',
            [identity],
          )
          expect(accounts.rows).toEqual([])
          const sessions = await owned.pool.query(
            'SELECT id FROM auth.session WHERE "userId" = $1',
            [identity],
          )
          expect(sessions.rows).toEqual([])
          const session = await auth.api.getSession({
            headers: new Headers({ cookie: cookies(response) }),
          })
          expect(session).toBeNull()
        },
      )
    })
  })
})
