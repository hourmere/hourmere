import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createAuth, createAuthPool, createCallerResolver, type SignupPolicy } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { SsoRequest, SsoResponse } from '@hourmere/outbound/sso'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  at,
  claimedDomainValues,
  type SsoFixture,
  ssoFixture,
} from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import { sealSsoProviderConfiguration } from './sso-configuration.ts'
import { oidcSignInRoutes } from './sso-oidc-sign-in.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const startPath = '/api/auth/sign-in/sso'
const callbackPath = (providerId: string) => `/api/auth/sso/callback/${providerId}`
const refusedLocation = '/sign-in?error=unable_to_create_session'
const bindingCookie = '__Host-hourmere.sso_binding'
const secret = randomBytes(32).toString('base64url')
const configurationKey = randomBytes(32)
const signup: SignupPolicy = { mode: 'open', allowedDomains: [] }
const issuer = 'https://idp.example.com/tenant'
const config = {
  issuer,
  clientId: 'hourmere-sign-in-fixture',
  clientSecret: randomBytes(32).toString('base64url'),
  authorizationEndpoint: `${issuer}/authorize`,
  tokenEndpoint: `${issuer}/token`,
  jwksUrl: `${issuer}/keys`,
}
const discoveryUrl = `${issuer}/.well-known/openid-configuration`
const metadata = {
  issuer,
  authorization_endpoint: config.authorizationEndpoint,
  token_endpoint: config.tokenEndpoint,
  jwks_uri: config.jwksUrl,
}
const signingHeader = { alg: 'RS256', kid: 'sign-in-fixture' }
const signInAction = 'sso_authentication.succeeded'
const failureAction = 'sso_authentication.failed'
const replayAction = 'sso_authentication.replay_rejected'
const json = (value: unknown, status = 200): SsoResponse => ({
  status,
  contentType: 'application/json',
  body: Buffer.from(JSON.stringify(value)),
})
const hash = (value: string, encoding: 'hex' | 'base64url') =>
  createHash('sha256').update(value, 'ascii').digest(encoding)

interface Attempt {
  authorization: URL
  providerId: string
  cookie: string
  id: string
}

/** A networkless IdP at the transport boundary, with real PKCE verification and signed tokens. */
function fakeIdp(signingKey: CryptoKey, jwks: SsoResponse, epoch: () => Promise<number>) {
  const codes = new Map<
    string,
    { parameters: URLSearchParams; claims: JWTPayload; beforeToken?: () => Promise<void> }
  >()
  const exchange = vi.fn(async (request: SsoRequest) => {
    expect(request.method).toBe('POST')
    const clientAuthentication = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString(
      'base64',
    )
    expect(request.headers?.authorization === `Basic ${clientAuthentication}`).toBe(true)
    expect(request.headers?.['content-type']).toBe('application/x-www-form-urlencoded')
    const body = new URLSearchParams(request.body)
    const code = body.get('code') ?? ''
    const registered = codes.get(code)
    if (
      !registered ||
      hash(body.get('code_verifier') ?? '', 'base64url') !==
        registered.parameters.get('code_challenge')
    )
      return json({ error: 'invalid_grant' }, 400)
    codes.delete(code)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('redirect_uri')).toBe(registered.parameters.get('redirect_uri'))
    await registered.beforeToken?.()
    const now = await epoch()
    const idToken = await new SignJWT({
      iss: issuer,
      aud: config.clientId,
      iat: now,
      exp: now + 120,
      nonce: registered.parameters.get('nonce'),
      ...registered.claims,
    })
      .setProtectedHeader(signingHeader)
      .sign(signingKey)
    return json({ id_token: idToken, access_token: randomUUID(), refresh_token: randomUUID() })
  })
  const discovery = vi.fn(async () => json(metadata))
  const send = vi.fn(async (request: SsoRequest) => {
    switch (request.url) {
      case discoveryUrl:
        return discovery()
      case config.tokenEndpoint:
        return exchange(request)
      case config.jwksUrl:
        return jwks
      default:
        throw new Error('Unexpected synthetic provider request')
    }
  })
  return {
    discovery,
    exchange,
    send,
    issue(attempt: Attempt, claims: JWTPayload, beforeToken?: () => Promise<void>) {
      const code = randomUUID()
      codes.set(code, {
        parameters: attempt.authorization.searchParams,
        claims,
        ...(beforeToken && { beforeToken }),
      })
      return code
    },
  }
}

describe.skipIf(!databaseUrl)('OIDC sign-in for linked identities', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let keys: Awaited<ReturnType<typeof generateKeyPair>>
  let jwks: SsoResponse
  let fixture: SsoFixture
  let idp: ReturnType<typeof fakeIdp>
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'oidc_sign_in' })
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      mailer: { send: async () => expect.unreachable('OIDC sign-in must not send mail') },
    })
    keys = await generateKeyPair('RS256')
    jwks = json({ keys: [{ ...(await exportJWK(keys.publicKey)), ...signingHeader }] })
  })

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  beforeEach(async () => {
    const client = await owned.pool.connect()
    try {
      fixture = await ssoFixture(client)
    } finally {
      client.release()
    }
    idp = fakeIdp(keys.privateKey, jwks, async () =>
      Math.floor(
        (
          await db.selectNoFrom(sql<Date>`clock_timestamp()`.as('now')).executeTakeFirstOrThrow()
        ).now.getTime() / 1000,
      ),
    )
    app = instance()
  })

  function instance({ enabled = true, expiresIn }: { enabled?: boolean; expiresIn?: number } = {}) {
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl,
      ssoOidcSignIn: oidcSignInRoutes({
        db,
        capabilities: { ssoOidcEnabled: enabled, ssoSamlEnabled: false },
        configurationKey,
        privateTargets: [],
        send: idp.send,
        session: { secret, ...(expiresIn !== undefined && { expiresIn }) },
      }),
    })
  }

  function configuration(providerId: string, revision: number, discovery = false) {
    const { issuer, clientId, clientSecret } = config
    return sealSsoProviderConfiguration(
      configurationKey,
      { organizationId: fixture.team, providerId, revision },
      JSON.stringify(discovery ? { issuer, clientId, clientSecret } : config),
    )
  }

  async function provider({
    enabled = true,
    domainExpiresIn,
    discovery = false,
  }: {
    enabled?: boolean
    domainExpiresIn?: number
    discovery?: boolean
  } = {}) {
    const { id: providerId } = await db
      .selectNoFrom(sql<string>`uuidv7()`.as('id'))
      .executeTakeFirstOrThrow()
    await db
      .insertInto('sso_providers')
      .values({
        id: providerId,
        organization_id: fixture.team,
        protocol: 'oidc',
        display_name: 'Synthetic OIDC',
        issuer,
        client_id: config.clientId,
        configuration: configuration(providerId, 1, discovery),
        enabled,
      })
      .execute()
    const domain = `team-${randomUUID().slice(0, 8)}.example.com`
    const domainValues = {
      ...claimedDomainValues(fixture.team, domain),
      ...(domainExpiresIn !== undefined && { verification_expires_at: at(domainExpiresIn) }),
    }
    const claim = await db
      .insertInto('sso_domains')
      .values(domainValues)
      .returningAll()
      .executeTakeFirstOrThrow()
    await db
      .insertInto('sso_provider_domains')
      .values({
        organization_id: fixture.team,
        provider_id: providerId,
        domain_id: claim.id,
      })
      .execute()
    return { providerId, claim, email: `linked@${domain}` }
  }

  async function linked(options?: Parameters<typeof provider>[0]) {
    const configured = await provider(options)
    await db
      .updateTable('auth.user')
      .set({ email: configured.email })
      .where('id', '=', fixture.member)
      .execute()
    const subject = 'Exact Subject'
    const link = await db
      .insertInto('sso_identity_links')
      .values({
        organization_id: fixture.team,
        provider_id: configured.providerId,
        user_id: fixture.member,
        issuer,
        subject,
        proven_email: configured.email,
        email_proven_at: at(-60),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return { ...configured, link, claims: { sub: subject, email: configured.email } }
  }

  function post(body: unknown, request = app, headers: Record<string, string> = {}) {
    return request.request(new URL(startPath, publicUrl), {
      method: 'POST',
      headers: { origin: publicUrl, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }

  async function start(
    providerId: string,
    request = app,
    returnTo = '/app/bookings?tab=next#recent',
  ) {
    const response = await post({ providerId, intent: 'sign_in', returnTo }, request)
    expect(response.status).toBe(200)
    const { url, redirect } = (await response.json()) as { url: string; redirect: boolean }
    expect(redirect).toBe(true)
    const authorization = new URL(url)
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${bindingCookie}=`))
    expect(cookie).toMatch(/; HttpOnly/i)
    expect(cookie).toMatch(/; Secure/i)
    expect(cookie).toMatch(/; SameSite=Lax/i)
    return {
      authorization,
      providerId,
      cookie: (cookie as string).split(';')[0] as string,
      id: authorization.searchParams.get('state')?.split('.')[0] as string,
    }
  }

  function callback(
    attempt: Attempt,
    code: string,
    options: {
      request?: typeof app
      cookie?: string
      providerId?: string
      state?: string
    } = {},
  ) {
    const url = new URL(callbackPath(options.providerId ?? attempt.providerId), publicUrl)
    url.search = new URLSearchParams({
      state: options.state ?? attempt.authorization.searchParams.get('state') ?? '',
      code,
    }).toString()
    return (options.request ?? app).request(url, {
      headers: { cookie: options.cookie ?? attempt.cookie },
    })
  }

  async function refusal(response: Response) {
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(refusedLocation)
    expect(response.headers.getSetCookie()).toEqual([])
    return response.text()
  }

  const attemptRow = (attempt: Attempt) =>
    db.selectFrom('sso_attempts').selectAll().where('id', '=', attempt.id).executeTakeFirstOrThrow()

  const effects = () =>
    db
      .selectNoFrom([
        sql<string>`(select count(*) from auth."user")`.as('users'),
        sql<string>`(select count(*) from auth.account)`.as('accounts'),
        sql<string>`(select count(*) from auth.member)`.as('memberships'),
        sql<string>`(select count(*) from auth.session)`.as('sessions'),
        sql<string>`(select count(*) from sso_identity_links)`.as('links'),
        sql<string>`(select count(*) from sso_browser_proofs)`.as('proofs'),
        sql<string>`(select count(*) from sso_mailbox_tokens)`.as('mailboxTokens'),
      ])
      .executeTakeFirstOrThrow()

  const audit = () =>
    db
      .selectFrom('audit_events')
      .selectAll()
      .where('organization_id', '=', fixture.team)
      .orderBy('id')
      .execute()

  function proof(providerId: string) {
    return db
      .selectFrom('sso_browser_proofs')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirstOrThrow()
  }

  it('hard-disables both auth-protocol endpoints before looking up the request', async () => {
    const off = instance({ enabled: false })
    const { providerId } = await linked()
    for (const provider of [providerId, randomUUID(), 'invalid']) {
      const responses = [
        await post({ providerId: provider, intent: 'sign_in' }, off),
        await off.request(new URL(`${callbackPath(provider)}?code=ignored`, publicUrl)),
      ]
      for (const response of responses) {
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'sso_disabled' })
        expect(response.headers.getSetCookie()).toEqual([])
      }
    }
    expect(idp.send).not.toHaveBeenCalled()
    expect(
      await db
        .selectFrom('sso_attempts')
        .select('id')
        .where('organization_id', '=', fixture.team)
        .execute(),
    ).toEqual([])
    expect(await audit()).toEqual([])
  })

  it('requires an exact origin and strict sign-in input, refuses drafts and prevents external redirects', async () => {
    const { providerId } = await linked()
    const draft = await provider({ enabled: false })
    const body = { providerId, intent: 'sign_in' }
    expect((await post(body, app, { origin: 'https://other.example.test' })).status).toBe(403)
    expect((await post(body, app, { authorization: 'Bearer synthetic' })).status).toBe(403)
    for (const extra of [
      { intent: 'step_up' },
      { attemptId: randomUUID() },
      { redirect_uri: 'https://other.example.test' },
      { returnTo: 'https://other.example.test/app' },
      { returnTo: '//other.example.test/app' },
      { returnTo: '/app/%2e%2e/sign-in' },
      { returnTo: '/app/%5cfoo' },
    ]) {
      const response = await post({ ...body, ...extra })
      expect(response.status).toBe(400)
      expect(response.headers.get('location')).toBeNull()
      expect(response.headers.getSetCookie()).toEqual([])
    }
    const disabled = await post({ ...body, providerId: draft.providerId })
    expect(disabled.status).toBeGreaterThanOrEqual(400)
    expect(disabled.headers.get('location')).toBeNull()
    expect(disabled.headers.getSetCookie()).toEqual([])
    expect(idp.send).not.toHaveBeenCalled()
    expect(
      await db
        .selectFrom('sso_attempts')
        .select('id')
        .where('organization_id', '=', fixture.team)
        .execute(),
    ).toEqual([])
  })

  it('issues a native session and an immutable team proof for the exact linked identity', async () => {
    const f = await linked()
    const attempt = await start(f.providerId)
    const params = attempt.authorization.searchParams
    expect(`${attempt.authorization.origin}${attempt.authorization.pathname}`).toBe(
      config.authorizationEndpoint,
    )
    expect(params.get('redirect_uri')).toBe(`${publicUrl}${callbackPath(f.providerId)}`)
    expect(params.get('response_type')).toBe('code')
    expect(params.get('client_id')).toBe(config.clientId)
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('scope')?.split(' ').sort()).toEqual(['email', 'openid', 'profile'])
    const before = await effects()
    const code = idp.issue(attempt, { ...f.claims, email: f.email.toUpperCase() })
    const response = await callback(attempt, code)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/app/bookings?tab=next#recent')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    const cookies = response.headers.getSetCookie()
    expect(cookies.join('; ')).not.toContain(code)
    const headers = { cookie: cookies.map((value) => value.split(';')[0]).join('; ') }
    const signedIn = await app.request(new URL('/api/auth/get-session', publicUrl), { headers })
    expect(signedIn.status).toBe(200)
    const issued = await proof(f.providerId)
    expect(await signedIn.json()).toMatchObject({
      user: { id: fixture.member },
      session: { id: issued.session_id },
    })
    expect(issued).toMatchObject({
      organization_id: fixture.team,
      user_id: fixture.member,
      member_id: fixture.memberMember,
      link_id: f.link.id,
      link_generation: f.link.generation,
      domain_id: f.claim.id,
      domain_generation: f.claim.generation,
      trust_generation: 1,
    })
    // The short-lived ID token is for callback acceptance. There is no IdP session deadline here.
    expect(issued.expires_at.getTime() - issued.created_at.getTime()).toBe(28_800_000)
    expect(await effects()).toEqual({
      ...before,
      sessions: String(Number(before.sessions) + 1),
      proofs: String(Number(before.proofs) + 1),
    })
    expect(await audit()).toEqual([
      expect.objectContaining({
        action: signInAction,
        actor_id: fixture.member,
        details: {
          method: 'oidc',
          providerId: f.providerId,
          revision: 1,
          correlationId: attempt.id,
        },
      }),
    ])

    const rolling = await db
      .updateTable('auth.session')
      .set({ expiresAt: sql`clock_timestamp() + interval '5 days'` })
      .where('id', '=', issued.session_id)
      .returning('expiresAt')
      .executeTakeFirstOrThrow()
    const refreshed = await app.request(new URL('/api/auth/get-session', publicUrl), { headers })
    expect(refreshed.status).toBe(200)
    const afterRefresh = await db
      .selectFrom('auth.session')
      .select('expiresAt')
      .where('id', '=', issued.session_id)
      .executeTakeFirstOrThrow()
    expect(afterRefresh.expiresAt.getTime()).toBeGreaterThan(rolling.expiresAt.getTime())
    expect((await proof(f.providerId)).expires_at).toEqual(issued.expires_at)
  })

  it('uses pinned-issuer discovery when the optional endpoints are absent', async () => {
    const f = await linked({ discovery: true })
    idp.discovery.mockResolvedValueOnce(json({ ...metadata, issuer: `${issuer}/other` }))
    const mismatch = await post({ providerId: f.providerId, intent: 'sign_in' })
    expect(mismatch.status).toBe(404)
    expect(mismatch.headers.getSetCookie()).toEqual([])
    expect(
      await db
        .selectFrom('sso_attempts')
        .select('id')
        .where('provider_id', '=', f.providerId)
        .execute(),
    ).toEqual([])

    const attempt = await start(f.providerId)
    expect(`${attempt.authorization.origin}${attempt.authorization.pathname}`).toBe(
      metadata.authorization_endpoint,
    )
    const response = await callback(attempt, idp.issue(attempt, f.claims))
    expect(response.headers.get('location')).toBe('/app/bookings?tab=next#recent')
    expect(idp.send.mock.calls.some(([request]) => request.url === metadata.jwks_uri)).toBe(true)
    expect((await proof(f.providerId)).user_id).toBe(fixture.member)

    const pending = await start(f.providerId)
    idp.discovery.mockResolvedValueOnce(
      json({ ...metadata, token_endpoint: 'https://other.example.com/token' }),
    )
    const before = await effects()
    const outboundBefore = idp.send.mock.calls.length
    await refusal(await callback(pending, idp.issue(pending, f.claims)))
    expect(idp.send.mock.calls.slice(outboundBefore).map(([request]) => request.url)).toEqual([
      discoveryUrl,
    ])
    expect(await effects()).toEqual(before)
  })

  it.each(['session', 'domain', 'IdP'] as const)(
    'caps browser proof at the earlier %s deadline',
    async (deadline) => {
      const f = await linked(deadline === 'domain' ? { domainExpiresIn: 90 } : undefined)
      const request = instance(deadline === 'session' ? { expiresIn: 90 } : undefined)
      const attempt = await start(f.providerId, request)
      const idpDeadline = Math.floor(new Date(at(75)).getTime() / 1000)
      const code = idp.issue(attempt, {
        ...f.claims,
        ...(deadline === 'IdP' && { session_expires_at: idpDeadline }),
      })
      const response = await callback(attempt, code, { request })
      expect(response.headers.get('location')).toBe('/app/bookings?tab=next#recent')
      const issued = await proof(f.providerId)
      const session = await db
        .selectFrom('auth.session')
        .select('expiresAt')
        .where('id', '=', issued.session_id)
        .executeTakeFirstOrThrow()
      expect(issued.expires_at).toEqual(
        {
          session: session.expiresAt,
          domain: f.claim.verification_expires_at,
          IdP: new Date(idpDeadline * 1000),
        }[deadline],
      )
    },
  )

  it('rejects another browser or provider, then exchanges a state only once across two apps', async () => {
    const f = await linked()
    const peer = await provider()
    const attempt = await start(f.providerId)
    const otherBrowser = await start(f.providerId)
    const firstCode = idp.issue(attempt, f.claims, async () => {
      expect((await attemptRow(attempt)).consumed_at).toBeInstanceOf(Date)
    })
    const secondCode = idp.issue(attempt, f.claims, async () => {
      expect((await attemptRow(attempt)).consumed_at).toBeInstanceOf(Date)
    })
    await refusal(await callback(attempt, firstCode, { cookie: otherBrowser.cookie }))
    await refusal(await callback(attempt, firstCode, { providerId: peer.providerId }))
    await refusal(await callback(attempt, firstCode, { state: `${attempt.id}.forged` }))
    expect(idp.exchange).toHaveBeenCalledTimes(0)
    expect((await attemptRow(attempt)).consumed_at).toBeNull()
    const responses = await Promise.all([
      callback(attempt, firstCode),
      callback(attempt, secondCode, { request: instance() }),
    ])
    expect(responses.map((response) => response.headers.get('location')).sort()).toEqual([
      '/app/bookings?tab=next#recent',
      refusedLocation,
    ])
    expect(idp.exchange).toHaveBeenCalledTimes(1)
    const events = await audit()
    expect(events.filter((event) => event.action === signInAction)).toHaveLength(1)
    expect(events.filter((event) => event.action === replayAction)).toEqual([
      expect.objectContaining({
        details: {
          method: 'oidc',
          providerId: f.providerId,
          revision: 1,
          correlationId: attempt.id,
        },
      }),
    ])
  })

  it('rejects code reuse in a different attempt and leaves its failed state consumed', async () => {
    const f = await linked()
    const first = await start(f.providerId)
    const second = await start(f.providerId)
    const properSecondCode = idp.issue(second, f.claims)
    const firstCode = idp.issue(first, f.claims)
    const before = await effects()
    await refusal(await callback(second, firstCode))
    expect((await attemptRow(second)).consumed_at).toBeInstanceOf(Date)
    expect(await effects()).toEqual(before)
    await refusal(await callback(second, properSecondCode, { request: instance() }))
    expect(idp.exchange).toHaveBeenCalledTimes(1)
    expect((await callback(first, firstCode)).headers.get('location')).toBe(
      '/app/bookings?tab=next#recent',
    )
    const third = await start(f.providerId)
    await refusal(await callback(third, firstCode))
    expect((await audit()).filter((event) => event.action === signInAction)).toHaveLength(1)
  })

  it('refuses provider revision changes during token exchange before creating a session', async () => {
    const f = await linked()
    const attempt = await start(f.providerId)
    const before = await effects()
    const code = idp.issue(attempt, f.claims, async () => {
      await db
        .updateTable('sso_providers')
        .set({ revision: 2, configuration: configuration(f.providerId, 2) })
        .where('id', '=', f.providerId)
        .execute()
    })
    await refusal(await callback(attempt, code))
    expect((await attemptRow(attempt)).consumed_at).toBeInstanceOf(Date)
    expect(await effects()).toEqual(before)
    expect((await audit()).map(({ action }) => action)).toEqual([failureAction])
  })

  it('rolls back the session and proof when the success event cannot commit', async () => {
    const f = await linked()
    const attempt = await start(f.providerId)
    const code = idp.issue(attempt, f.claims)
    const before = await effects()
    await sql`ALTER TABLE audit_events ADD CONSTRAINT fixture_no_sign_in_success
      CHECK (action <> 'sso_authentication.succeeded') NOT VALID`.execute(db)
    try {
      const response = await callback(attempt, code)
      expect(response.status).toBe(500)
      expect(response.headers.getSetCookie()).toEqual([])
      expect(await response.json()).toEqual({ error: 'internal_error' })
    } finally {
      await sql`ALTER TABLE audit_events DROP CONSTRAINT fixture_no_sign_in_success`.execute(db)
    }
    expect(await effects()).toEqual(before)
    expect((await attemptRow(attempt)).consumed_at).toBeInstanceOf(Date)
    expect((await audit()).some(({ action }) => action === signInAction)).toBe(false)
  })

  it.each(['membership', 'link', 'domain'] as const)(
    'rechecks the %s at commit time before creating a session',
    async (authority) => {
      const f = await linked()
      const attempt = await start(f.providerId)
      const before = await effects()
      const code = idp.issue(attempt, f.claims, async () => {
        switch (authority) {
          case 'membership':
            await db.deleteFrom('auth.member').where('id', '=', fixture.memberMember).execute()
            break
          case 'link':
            await db
              .updateTable('sso_identity_links')
              .set({ retired_at: sql`clock_timestamp()`, generation: 2 })
              .where('id', '=', f.link.id)
              .execute()
            break
          case 'domain':
            await db
              .updateTable('sso_domains')
              .set({ verification_expires_at: sql`clock_timestamp()` })
              .where('id', '=', f.claim.id)
              .execute()
            break
        }
      })
      await refusal(await callback(attempt, code))
      expect((await attemptRow(attempt)).consumed_at).toBeInstanceOf(Date)
      const after = await effects()
      expect(after.sessions).toBe(before.sessions)
      expect(after.proofs).toBe(before.proofs)
      expect((await audit()).map(({ action }) => action)).toEqual([failureAction])
    },
  )

  it('gives unlinked subjects one generic outcome without storing identity data', async () => {
    const f = await linked()
    const before = await effects()
    const outcomes = []
    for (const email of [f.email, `unknown@${f.claim.name}`]) {
      for (const verified of [undefined, false, true]) {
        const attempt = await start(f.providerId)
        const claims = {
          sub: 'exact subject',
          email,
          ...(verified !== undefined && { email_verified: verified }),
        }
        const code = idp.issue(attempt, claims)
        outcomes.push(await refusal(await callback(attempt, code)))
        const stored = await attemptRow(attempt)
        expect(stored).toMatchObject({
          consumed_at: expect.any(Date),
          mailbox: null,
          user_id: null,
          session_id: null,
          requires_mailbox: false,
          mailbox_proven_at: null,
        })
        for (const sensitive of [claims.sub, email, code])
          expect(JSON.stringify(stored)).not.toContain(sensitive)
      }
    }
    expect(new Set(outcomes).size).toBe(1)
    expect(idp.exchange).toHaveBeenCalledTimes(6)
    expect(await effects()).toEqual(before)
    const events = await audit()
    expect(events).toHaveLength(6)
    expect(new Set(events.map(({ action }) => action))).toEqual(new Set([failureAction]))
    expect(new Set(events.map(({ details }) => (details as { reason: string }).reason)).size).toBe(
      1,
    )
    expect(JSON.stringify(events)).not.toContain(f.email)
    expect(JSON.stringify(events)).not.toContain('exact subject')
  })

  it('rejects changed linked mailboxes and mismatching signed issuer or nonce without issuing a session', async () => {
    const f = await linked()
    const before = await effects()
    for (const claims of [
      { ...f.claims, email: `changed@${f.claim.name}`, email_verified: true },
      { ...f.claims, iss: `${issuer}/other` },
      { ...f.claims, nonce: randomBytes(32).toString('base64url') },
      { ...f.claims, session_expires_at: Math.floor(new Date(at(-1)).getTime() / 1000) },
    ]) {
      const attempt = await start(f.providerId)
      await refusal(await callback(attempt, idp.issue(attempt, claims)))
      expect(await attemptRow(attempt)).toMatchObject({
        consumed_at: expect.any(Date),
        mailbox: null,
      })
    }
    expect(await effects()).toEqual(before)
  })
})
