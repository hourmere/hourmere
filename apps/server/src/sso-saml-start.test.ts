import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { createAuth, createAuthPool } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { DOMParser } from '@xmldom/xmldom'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { samlProviderValues, ssoFixture } from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { productionSsoCapabilities } from './server.ts'
import type { SsoCapabilities } from './sso.ts'
import { sealSsoProviderConfiguration } from './sso-configuration.ts'
import { authenticationAttemptLifetime } from './sso-oidc-limits.ts'
import { oidcSignInRoutes } from './sso-oidc-sign-in.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const startPath = '/api/auth/sign-in/sso'
const bindingCookie = '__Host-hourmere.sso_binding'
const ssoEndpoint = 'https://login.example.com/saml'
const acsPath = (providerId: string) => `/api/auth/sso/saml2/sp/acs/${providerId}`
const metadataPath = (providerId: string) => `/api/auth/sso/saml2/sp/metadata/${providerId}`
const configurationKey = randomBytes(32)
const secret = randomBytes(32).toString('base64url')
const signup = { mode: 'open', allowedDomains: [] } as const
const samlOnly = { ssoOidcEnabled: false, ssoSamlEnabled: true }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: { origin: publicUrl, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }
}

async function redirectUrl(response: Response) {
  expect(response.status).toBe(200)
  const body = (await response.json()) as { url: string }
  expect(body).toEqual({ url: expect.any(String), redirect: true })
  return new URL(body.url)
}

describe.skipIf(!databaseUrl)('SAML sign-in initiation', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let organizationId: string

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'saml_start' })
    db = createDb(owned.pool)
    const seed = await owned.pool.connect()
    try {
      organizationId = (await ssoFixture(seed)).team
    } finally {
      seed.release()
    }
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      mailer: { send: async () => expect.unreachable('SAML start does not send mail') },
    })
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  function appFor(capabilities: SsoCapabilities = samlOnly) {
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: async () => expect.unreachable('SAML start does not resolve a caller'),
      publicUrl,
      ssoOidcSignIn: oidcSignInRoutes({
        db,
        capabilities,
        configurationKey,
        privateTargets: [],
        send: async () => expect.unreachable('Sign-in start uses only configured endpoints'),
        signup,
        session: { secret },
        readSession: async () => expect.unreachable('Sign-in start does not read a session'),
      }),
    })
  }

  async function providerId() {
    const { id } = await db.selectNoFrom(sql<string>`uuidv7()`.as('id')).executeTakeFirstOrThrow()
    return id
  }

  function seal(id: string, config: Record<string, unknown>) {
    return sealSsoProviderConfiguration(
      configurationKey,
      { organizationId, providerId: id, revision: 1 },
      JSON.stringify(config),
    )
  }

  async function samlProvider(endpoint = ssoEndpoint) {
    const id = await providerId()
    await db
      .insertInto('sso_providers')
      .values({
        ...samlProviderValues(organizationId),
        id,
        enabled: true,
        configuration: seal(id, { ssoEndpoint: endpoint }),
      })
      .execute()
    return id
  }

  function attempts(id: string) {
    return db.selectFrom('sso_attempts').selectAll().where('provider_id', '=', id)
  }

  it('commits the correlated attempt before returning an SP-initiated HTTP-Redirect request', async () => {
    const id = await samlProvider()
    const app = appFor()
    const returnTo = '/app/bookings?hint=synthetic-member%40example.test'
    const response = await app.request(
      startPath,
      post({ providerId: id, intent: 'sign_in', returnTo }, { host: 'different.example.test' }),
    )
    const redirect = await redirectUrl(response)
    expect(redirect.origin + redirect.pathname).toBe(ssoEndpoint)
    expect([...redirect.searchParams.keys()].sort()).toEqual(['RelayState', 'SAMLRequest'])
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')

    const relayState = redirect.searchParams.get('RelayState') ?? ''
    expect(relayState).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/)
    const xml = inflateRawSync(
      Buffer.from(redirect.searchParams.get('SAMLRequest') ?? '', 'base64'),
    ).toString('utf8')
    const request = new DOMParser().parseFromString(xml, 'application/xml').documentElement
    expect(request?.localName).toBe('AuthnRequest')
    expect(request?.namespaceURI).toBe('urn:oasis:names:tc:SAML:2.0:protocol')
    expect(request?.getAttribute('Version')).toBe('2.0')
    expect(request?.getAttribute('Destination')).toBe(ssoEndpoint)
    expect(request?.getAttribute('AssertionConsumerServiceURL')).toBe(publicUrl + acsPath(id))
    expect(request?.getAttribute('ProtocolBinding')).toBe(
      'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
    )
    expect(
      request?.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:assertion', 'Issuer')[0]
        ?.textContent,
    ).toBe(publicUrl + metadataPath(id))
    expect(xml).not.toContain('synthetic-member')

    const setBinding = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${bindingCookie}=`))
    const [cookiePair = '', ...attributes] = (setBinding ?? '').split('; ')
    expect(cookiePair).toMatch(/^[^=]+=[A-Za-z0-9_-]{43}$/)
    expect(cookiePair.split('=')[0]).toBe(bindingCookie)
    expect(attributes.sort()).toEqual(['HttpOnly', 'Path=/', 'SameSite=Lax', 'Secure'])
    const binding = cookiePair.slice(bindingCookie.length + 1)

    const rows = await attempts(id).execute()
    expect(rows).toHaveLength(1)
    const attempt = rows[0]
    expect(attempt).toMatchObject({
      kind: 'sign_in',
      operation: 'samlSignIn',
      organization_id: organizationId,
      provider_id: id,
      provider_revision: 1,
      input_digest: digest(relayState),
      browser_binding_digest: digest(binding),
      user_id: null,
      session_id: null,
      mailbox: null,
      consumed_at: null,
    })
    expect(request?.getAttribute('ID')).toBe(`_${attempt?.id}`)
    const [relayKey = '', relaySecret] = relayState.split('.')
    expect(Buffer.from(relayKey, 'base64url').toString('hex')).toBe(attempt?.id.replaceAll('-', ''))
    const lifetime = Number(attempt?.expires_at) - Number(attempt?.created_at)
    expect(lifetime).toBe(authenticationAttemptLifetime * 1000)
    expect(Number.isFinite(Date.parse(request?.getAttribute('IssueInstant') ?? ''))).toBe(true)

    const second = await app.request(
      startPath,
      post({ providerId: id, intent: 'sign_in', returnTo }, { cookie: cookiePair }),
    )
    const secondRedirect = await redirectUrl(second)
    expect(secondRedirect.searchParams.get('RelayState')?.split('.')[1]).not.toBe(relaySecret)
    expect(second.headers.getSetCookie().map((value) => value.split('; ')[0])).toContain(cookiePair)
  })

  it('requires an exact Origin, browser-only credentials and the strict sign-in input', async () => {
    const id = await samlProvider()
    const app = appFor()
    const input = { providerId: id, intent: 'sign_in' }
    for (const [body, headers, status, error] of [
      [input, { origin: 'https://lookalike.example.test', referer: publicUrl }, 403, 'forbidden'],
      [input, { origin: '' }, 403, 'forbidden'],
      [input, { authorization: 'Bearer synthetic' }, 403, 'forbidden'],
      [{ ...input, attemptId: randomUUID() }, {}, 400, 'invalid_request'],
      [{ ...input, returnTo: '//different.example.com' }, {}, 400, 'invalid_request'],
      [{ ...input, returnTo: '/outside-app' }, {}, 400, 'invalid_request'],
      [{ ...input, intent: 'step_up', attemptId: randomUUID() }, {}, 404, 'sso_not_found'],
    ] as const) {
      const response = await app.request(startPath, post(body, headers))
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ error })
      expect(response.headers.getSetCookie()).toEqual([])
    }
    expect(await attempts(id).execute()).toEqual([])
  })

  it.each([samlOnly, { ssoOidcEnabled: true, ssoSamlEnabled: false }])(
    'treats disabled and retired SAML providers as missing with %j',
    async (capabilities) => {
      const disabledId = await samlProvider()
      const retiredId = await samlProvider()
      await db
        .updateTable('sso_providers')
        .set({ enabled: false })
        .where('id', '=', disabledId)
        .execute()
      await db
        .updateTable('sso_providers')
        .set({ enabled: false, retired_at: sql`clock_timestamp()` })
        .where('id', '=', retiredId)
        .execute()
      const app = appFor(capabilities)
      for (const providerId of [disabledId, retiredId]) {
        const response = await app.request(startPath, post({ providerId, intent: 'sign_in' }))
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'sso_not_found' })
        expect(response.headers.getSetCookie()).toEqual([])
        expect(await attempts(providerId).execute()).toEqual([])
      }
    },
  )

  it('refuses an IdP endpoint that supplies a reserved redirect parameter', async () => {
    const id = await samlProvider(`${ssoEndpoint}?relaystate=synthetic`)
    const response = await appFor().request(startPath, post({ providerId: id, intent: 'sign_in' }))
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'sso_not_found' })
    expect(response.headers.getSetCookie()).toEqual([])
    expect(await attempts(id).execute()).toEqual([])
  })

  it('leaves GET on the sign-in start route inert', async () => {
    const id = await samlProvider()
    const app = appFor()
    const get = await app.request(`${startPath}?providerId=${id}&intent=sign_in`, {
      headers: { origin: publicUrl },
    })
    expect(get.status).toBe(405)
    expect(get.headers.getSetCookie()).toEqual([])
    expect(await attempts(id).execute()).toEqual([])
    expect(await db.selectFrom('auth.session').select('id').execute()).toEqual([])
  })

  it('keeps SAML off while the OIDC setting enables OIDC sign-in', async () => {
    const samlId = await samlProvider()
    const oidcId = await providerId()
    const oidcIssuer = 'https://login.example.com/oidc'
    const config = {
      issuer: oidcIssuer,
      clientId: 'synthetic-hourmere-client',
      clientSecret: randomBytes(32).toString('base64url'),
      authorizationEndpoint: `${oidcIssuer}/authorize`,
      tokenEndpoint: `${oidcIssuer}/token`,
      jwksUrl: `${oidcIssuer}/keys`,
    }
    await db
      .insertInto('sso_providers')
      .values({
        id: oidcId,
        organization_id: organizationId,
        protocol: 'oidc',
        display_name: 'Synthetic OIDC',
        issuer: config.issuer,
        client_id: config.clientId,
        configuration: seal(oidcId, config),
        enabled: true,
      })
      .execute()
    const env = {
      DATABASE_URL: owned.url,
      PUBLIC_URL: publicUrl,
      BETTER_AUTH_SECRET: secret,
      SSO_SAML_ENABLED: 'false',
    }
    const oidcOff = appFor(productionSsoCapabilities(loadConfig(env)))
    const defaults = await oidcOff.request(
      startPath,
      post({ providerId: oidcId, intent: 'sign_in' }),
    )
    expect(defaults.status).toBe(404)
    expect(await defaults.json()).toEqual({ error: 'sso_disabled' })
    expect(await attempts(oidcId).execute()).toEqual([])

    const app = appFor(productionSsoCapabilities(loadConfig({ ...env, SSO_OIDC_ENABLED: 'true' })))
    const disabled = await app.request(startPath, post({ providerId: samlId, intent: 'sign_in' }))
    expect(disabled.status).toBe(404)
    expect(await disabled.json()).toEqual({ error: 'sso_disabled' })
    expect(disabled.headers.getSetCookie()).toEqual([])
    for (let i = 0; i < 31; i++) {
      const stepUp = await app.request(
        startPath,
        post({ providerId: samlId, intent: 'step_up', attemptId: randomUUID() }),
      )
      expect(stepUp.status).toBe(404)
      expect(await stepUp.json()).toEqual({ error: 'sso_disabled' })
      expect(stepUp.headers.getSetCookie()).toEqual([])
    }
    expect(await attempts(samlId).execute()).toEqual([])

    const redirect = await redirectUrl(
      await app.request(startPath, post({ providerId: oidcId, intent: 'sign_in' })),
    )
    expect(redirect.origin + redirect.pathname).toBe(config.authorizationEndpoint)
    expect(redirect.searchParams.get('client_id')).toBe(config.clientId)
    expect(redirect.searchParams.get('redirect_uri')).toBe(
      `${publicUrl}/api/auth/sso/callback/${oidcId}`,
    )
    expect(redirect.searchParams.get('code_challenge_method')).toBe('S256')
    expect(await attempts(oidcId).execute()).toHaveLength(1)
  })

  it('rolls back an attempt that has expired before the redirect can be issued', async () => {
    const id = await samlProvider()
    // This owned DB's trigger runs after sso_attempts_guard, simulating a lapse after insert
    // validation without a sleep or a change to the ordinary expiry policy.
    await sql`
      CREATE FUNCTION test_expire_saml_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.expires_at := clock_timestamp() - interval '1 second';
        NEW.created_at := NEW.expires_at - interval '1 second';
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER sso_attempts_test_expiry BEFORE INSERT ON sso_attempts
        FOR EACH ROW EXECUTE FUNCTION test_expire_saml_attempt()
    `.execute(db)
    try {
      const response = await appFor().request(
        startPath,
        post({ providerId: id, intent: 'sign_in' }),
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'sso_not_found' })
      expect(response.headers.getSetCookie()).toEqual([])
      expect(await attempts(id).execute()).toEqual([])
    } finally {
      await sql`DROP TRIGGER sso_attempts_test_expiry ON sso_attempts`.execute(db)
      await sql`DROP FUNCTION test_expire_saml_attempt()`.execute(db)
    }
  })

  it('withholds the redirect and binding cookie when the attempt cannot commit', async () => {
    const id = await samlProvider()
    await sql`
      CREATE FUNCTION test_fail_saml_attempt_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'synthetic SAML attempt commit error';
      END;
      $$;
      CREATE CONSTRAINT TRIGGER sso_attempts_test_commit AFTER INSERT ON sso_attempts
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_fail_saml_attempt_commit()
    `.execute(db)
    try {
      const response = await appFor().request(
        startPath,
        post({ providerId: id, intent: 'sign_in' }),
      )
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'internal_error' })
      expect(response.headers.getSetCookie()).toEqual([])
      expect(response.headers.get('location')).toBeNull()
      expect(await attempts(id).execute()).toEqual([])
    } finally {
      await sql`DROP TRIGGER sso_attempts_test_commit ON sso_attempts`.execute(db)
      await sql`DROP FUNCTION test_fail_saml_attempt_commit()`.execute(db)
    }
  })
})
