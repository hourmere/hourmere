import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { createAuth, createAuthPool } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { DOMParser } from '@xmldom/xmldom'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SignedXml } from 'xml-crypto'
import {
  at,
  claimedDomainValues,
  type SsoFixture,
  samlProviderValues,
  ssoFixture,
} from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { productionSsoCapabilities } from './server.ts'
import type { SsoCapabilities } from './sso.ts'
import { sealSsoProviderConfiguration } from './sso-configuration.ts'
import { oidcSignInRoutes } from './sso-oidc-sign-in.ts'
import { samlSigningIdentity } from './sso-saml-fixtures.ts'
import { samlClockSkew } from './sso-saml-limits.ts'
import * as samlReplay from './sso-saml-replay.ts'
import { samlSignInRoutes } from './sso-saml-sign-in.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const idpOrigin = 'https://login.example.com'
const ssoEndpoint = `${idpOrigin}/saml`
const startPath = '/api/auth/sign-in/sso'
const completePath = '/api/auth/sso/saml2/complete'
const errorPath = '/sign-in?error=unable_to_create_session'
const returnPath = '/app/bookings?tab=next#recent'
const verifiedDomain = 'fixture.example.com'
const mailbox = `linked@${verifiedDomain}`
const bindingCookie = '__Host-hourmere.sso_binding'
const acsPath = (providerId: string) => `/api/auth/sso/saml2/sp/acs/${providerId}`
const configurationKey = randomBytes(32)
const secret = randomBytes(32).toString('base64url')
const signup = { mode: 'open', allowedDomains: [] } as const
const samlOnly = { ssoOidcEnabled: false, ssoSamlEnabled: true }
const persistent = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'
const transient = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient'
const assertionNamespace = 'urn:oasis:names:tc:SAML:2.0:assertion'
const protocolNamespace = 'urn:oasis:names:tc:SAML:2.0:protocol'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const cookiesFrom = (response: Response) =>
  response.headers.getSetCookie().map((cookie) => cookie.split(';')[0] ?? '')

interface Provider {
  id: string
  issuer: string
  subject: string
  mailbox: string
}

interface Start {
  provider: Provider
  requestId: string
  audience: string
  recipient: string
  relayState: string
  cookies: string[]
}

interface SignedResponseOptions {
  assertionId?: string
  responseId?: string
  requestId?: string | null
  subject?: string
  subjectFormat?: string
  nameQualifier?: string
  spNameQualifier?: string
  mailbox?: string
  bearerLifetime?: number
  sessionLifetime?: number
}

type App = ReturnType<typeof createApp>

describe.skipIf(!databaseUrl)('SAML ACS and browser completion', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let team: SsoFixture
  let app: App
  let domain: { id: string; generation: number }
  let idp: ReturnType<typeof samlSigningIdentity>

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'saml_completion' })
    db = createDb(owned.pool)
    const seed = await owned.pool.connect()
    try {
      team = await ssoFixture(seed)
    } finally {
      seed.release()
    }
    await db
      .updateTable('auth.user')
      .set({ email: mailbox })
      .where('id', '=', team.member)
      .execute()
    domain = await db
      .insertInto('sso_domains')
      .values(claimedDomainValues(team.team, verifiedDomain))
      .returning(['id', 'generation'])
      .executeTakeFirstOrThrow()
    idp = samlSigningIdentity('login.example.com')
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      mailer: { send: async () => expect.unreachable('SAML completion sends no email') },
    })
    app = instance()
  })

  afterEach(() => vi.restoreAllMocks())

  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  function instance(capabilities: SsoCapabilities = samlOnly) {
    const deps = { db, capabilities, configurationKey, session: { secret } }
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: async () => expect.unreachable('SAML completion does not resolve a caller'),
      publicUrl,
      ssoOidcSignIn: oidcSignInRoutes({
        ...deps,
        privateTargets: [],
        send: async () => expect.unreachable('The IdP uses a local signed fixture'),
        signup,
        readSession: async () => expect.unreachable('Sign-in does not read a session'),
      }),
      ssoSamlSignIn: samlSignInRoutes(deps),
    })
  }

  async function providerId() {
    return (await db.selectNoFrom(sql<string>`uuidv7()`.as('id')).executeTakeFirstOrThrow()).id
  }

  function seal(providerId: string, configuration: unknown) {
    return sealSsoProviderConfiguration(
      configurationKey,
      { organizationId: team.team, providerId, revision: 1 },
      JSON.stringify(configuration),
    )
  }

  async function linkedProvider() {
    const id = await providerId()
    const values = samlProviderValues(team.team)
    await db
      .insertInto('sso_providers')
      .values({
        ...values,
        id,
        enabled: true,
        configuration: seal(id, { ssoEndpoint, signingCertificates: [idp.pem] }),
      })
      .execute()
    await db
      .insertInto('sso_provider_domains')
      .values({ organization_id: team.team, provider_id: id, domain_id: domain.id })
      .execute()
    const subject = `fixture-subject-${randomUUID()}`
    const link = await db
      .insertInto('sso_identity_links')
      .values({
        organization_id: team.team,
        provider_id: id,
        user_id: team.member,
        issuer: values.issuer,
        subject,
        proven_email: mailbox,
        email_proven_at: at(-60),
      })
      .returning(['id', 'generation'])
      .executeTakeFirstOrThrow()
    return { id, issuer: values.issuer, subject, mailbox, link }
  }

  function signIn(providerId: string, request: App) {
    return request.request(new URL(startPath, publicUrl), {
      method: 'POST',
      headers: { origin: publicUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId, intent: 'sign_in', returnTo: returnPath }),
    })
  }

  async function start(provider: Provider): Promise<Start> {
    const response = await signIn(provider.id, app)
    expect(response.status).toBe(200)
    const { url } = (await response.json()) as { url: string }
    const redirect = new URL(url)
    const relayState = redirect.searchParams.get('RelayState')
    const encodedRequest = redirect.searchParams.get('SAMLRequest')
    if (!relayState || !encodedRequest) throw new Error('Missing SAML start parameters')
    const xml = inflateRawSync(Buffer.from(encodedRequest, 'base64')).toString('utf8')
    const request = new DOMParser().parseFromString(xml, 'application/xml').documentElement
    const requestId = request?.getAttribute('ID')
    const recipient = request?.getAttribute('AssertionConsumerServiceURL')
    const audience = request?.getElementsByTagNameNS(assertionNamespace, 'Issuer')[0]?.textContent
    if (!requestId || !recipient || !audience) throw new Error('Missing AuthnRequest fields')
    return { provider, requestId, relayState, audience, recipient, cookies: cookiesFrom(response) }
  }

  function sign(xml: string, element: 'Assertion' | 'Response') {
    const canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#'
    const signer = new SignedXml({
      privateKey: idp.privateKey,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm,
    })
    const xpath = `//*[local-name(.)='${element}']`
    signer.addReference({
      xpath,
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        canonicalizationAlgorithm,
      ],
    })
    signer.computeSignature(xml, {
      location: { reference: `${xpath}/*[local-name(.)='Issuer']`, action: 'after' },
    })
    return signer.getSignedXml()
  }

  async function signedResponse(
    {
      provider,
      requestId,
      audience,
      recipient,
    }: Pick<Start, 'provider' | 'requestId' | 'audience' | 'recipient'>,
    options: SignedResponseOptions = {},
  ) {
    const {
      assertionId = `_${randomUUID()}`,
      responseId = `_${randomUUID()}`,
      requestId: correlatedId = requestId,
      subject = provider.subject,
      subjectFormat = persistent,
      nameQualifier,
      spNameQualifier,
      mailbox = provider.mailbox,
      bearerLifetime = 300,
      sessionLifetime,
    } = options
    const issued = await samlReplay.samlDatabaseNow(db)
    const deadline = issued.add({ seconds: bearerLifetime })
    const sessionDeadline =
      sessionLifetime === undefined ? undefined : issued.add({ seconds: sessionLifetime })
    const sessionBound = sessionDeadline ? ` SessionNotOnOrAfter="${sessionDeadline}"` : ''
    const correlation = correlatedId === null ? '' : ` InResponseTo="${correlatedId}"`
    const nameScope = nameQualifier ? ` NameQualifier="${nameQualifier}"` : ''
    const spScope = spNameQualifier ? ` SPNameQualifier="${spNameQualifier}"` : ''
    const assertion = sign(
      `<saml:Assertion xmlns:saml="${assertionNamespace}" ID="${assertionId}" Version="2.0" IssueInstant="${issued}">
      <saml:Issuer>${provider.issuer}</saml:Issuer>
      <saml:Subject>
        <saml:NameID Format="${subjectFormat}"${nameScope}${spScope}>${subject}</saml:NameID>
        <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
          <saml:SubjectConfirmationData${correlation} Recipient="${recipient}" NotOnOrAfter="${deadline}"/>
        </saml:SubjectConfirmation>
      </saml:Subject>
      <saml:Conditions NotBefore="${issued.subtract({ seconds: 1 })}" NotOnOrAfter="${issued.add({ seconds: 720 })}">
        <saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>
      </saml:Conditions>
      <saml:AuthnStatement AuthnInstant="${issued}"${sessionBound}/>
      <saml:AttributeStatement>
        <saml:Attribute Name="email"><saml:AttributeValue>${mailbox}</saml:AttributeValue></saml:Attribute>
      </saml:AttributeStatement>
    </saml:Assertion>`,
      'Assertion',
    )
    const xml = sign(
      `<samlp:Response xmlns:samlp="${protocolNamespace}" ID="${responseId}" Version="2.0" IssueInstant="${issued}" Destination="${recipient}"${correlation}>
      <saml:Issuer xmlns:saml="${assertionNamespace}">${provider.issuer}</saml:Issuer>
      <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
      ${assertion}
    </samlp:Response>`,
      'Response',
    )
    return {
      encoded: Buffer.from(xml).toString('base64'),
      assertionId,
      responseId,
      deadline,
      sessionDeadline,
    }
  }

  function acs(
    providerId: string,
    encoded: string,
    relayState: string | null,
    request = app,
    cookies: string[] = [],
  ) {
    const body = new URLSearchParams({ SAMLResponse: encoded })
    if (relayState !== null) body.set('RelayState', relayState)
    return request.request(new URL(acsPath(providerId), publicUrl), {
      method: 'POST',
      headers: { origin: idpOrigin, cookie: cookies.join('; ') },
      body,
    })
  }

  function expectRefusedAcs(response: Response) {
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(errorPath)
    expect(response.headers.getSetCookie()).toEqual([])
  }

  async function pending(accepted: Response, attempt: Start) {
    expect(accepted.status).toBe(303)
    const location = new URL(accepted.headers.get('location') ?? '', publicUrl)
    expect(location.origin + location.pathname).toBe(publicUrl + completePath)
    expect([...location.searchParams.keys()]).toEqual(['attemptId'])
    const id = location.searchParams.get('attemptId')
    if (!id) throw new Error('Missing pending SAML handle')
    const cookies = accepted.headers.getSetCookie()
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toContain('HttpOnly')
    expect(cookies[0]).toContain('Secure')
    expect(cookies[0]).not.toContain('better-auth.session_token')
    expect(accepted.headers.get('cache-control')).toBe('no-store')
    expect(accepted.headers.get('referrer-policy')).toBe('no-referrer')
    return { id, location, cookies: [...attempt.cookies, ...cookiesFrom(accepted)] }
  }

  function complete(
    result: Awaited<ReturnType<typeof pending>>,
    { request = app, cookies = result.cookies, origin = publicUrl } = {},
  ) {
    return request.request(new URL(completePath, publicUrl), {
      method: 'POST',
      headers: { origin, cookie: cookies.join('; ') },
      body: new URLSearchParams({ attemptId: result.id }),
    })
  }

  async function expectRefusedCompletion(response: Response) {
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'sso_saml_completion_invalid' })
    expect(
      response.headers
        .getSetCookie()
        .some((cookie) => cookie.includes('better-auth.session_token')),
    ).toBe(false)
  }

  const identityEffects = () =>
    db
      .selectNoFrom([
        sql<string>`(select count(*) from auth."user")`.as('users'),
        sql<string>`(select count(*) from auth.account)`.as('accounts'),
        sql<string>`(select count(*) from auth.member)`.as('members'),
        sql<string>`(select count(*) from auth.session)`.as('sessions'),
        sql<string>`(select count(*) from sso_identity_links)`.as('links'),
        sql<string>`(select count(*) from sso_browser_proofs)`.as('proofs'),
        sql<string>`(select count(*) from sso_mailbox_tokens)`.as('mailboxTokens'),
      ])
      .executeTakeFirstOrThrow()

  function protocolEffects(providerId: string) {
    return Promise.all([
      db
        .selectFrom('sso_attempts')
        .select(['id', 'consumed_at'])
        .where('provider_id', '=', providerId)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('sso_replay_cache')
        .select(['kind', 'key_digest'])
        .where('provider_id', '=', providerId)
        .orderBy('kind')
        .orderBy('key_digest')
        .execute(),
    ])
  }

  it('only issues the linked native session and browser proof at the original browser POST', async () => {
    const provider = await linkedProvider()
    const attempt = await start(provider)
    const signed = await signedResponse(attempt, { sessionLifetime: 180 })
    const before = await identityEffects()
    const accepted = await acs(provider.id, signed.encoded, attempt.relayState)
    const result = await pending(accepted, attempt)
    expect(await identityEffects()).toEqual(before)
    const state = await protocolEffects(provider.id)

    const confirm = await app.request(result.location, {
      headers: { cookie: result.cookies.join('; ') },
    })
    expect(confirm.status).toBe(200)
    expect(confirm.headers.get('content-type')).toContain('text/html')
    expect(confirm.headers.get('cache-control')).toBe('no-store')
    expect(confirm.headers.getSetCookie()).toEqual([])
    const html = await confirm.text()
    expect(html).toMatch(/<form\b[^>]*method=["']?post/i)
    expect(html).toContain(result.id)
    expect(await identityEffects()).toEqual(before)
    expect(await protocolEffects(provider.id)).toEqual(state)

    const completed = await complete(result)
    expect(completed.status).toBe(303)
    expect(completed.headers.get('location')).toBe(returnPath)
    const cookie = cookiesFrom(completed).join('; ')
    const nativeSession = await app.request(new URL('/api/auth/get-session', publicUrl), {
      headers: { cookie },
    })
    expect(nativeSession.status).toBe(200)
    const proof = await db
      .selectFrom('sso_browser_proofs')
      .selectAll()
      .where('provider_id', '=', provider.id)
      .executeTakeFirstOrThrow()
    expect(await nativeSession.json()).toMatchObject({
      user: { id: team.member },
      session: { id: proof.session_id },
    })
    expect(proof).toMatchObject({
      organization_id: team.team,
      provider_id: provider.id,
      member_id: team.memberMember,
      user_id: team.member,
      link_id: provider.link.id,
      link_generation: provider.link.generation,
      domain_id: domain.id,
      domain_generation: domain.generation,
      trust_generation: 1,
    })
    expect(proof.expires_at.getTime()).toBe(signed.sessionDeadline?.epochMilliseconds)
    expect(await identityEffects()).toEqual({
      ...before,
      sessions: String(Number(before.sessions) + 1),
      proofs: String(Number(before.proofs) + 1),
    })
  })

  it('refuses a missing binding and a different initiating browser without spending the pending result', async () => {
    const provider = await linkedProvider()
    const attempt = await start(provider)
    const otherBrowser = await start(provider)
    const signed = await signedResponse(attempt)
    const before = await identityEffects()
    const accepted = await acs(
      provider.id,
      signed.encoded,
      attempt.relayState,
      app,
      attempt.cookies,
    )
    const result = await pending(accepted, attempt)
    const state = await protocolEffects(provider.id)
    for (const replacement of [
      [],
      otherBrowser.cookies.filter((cookie) => cookie.startsWith(`${bindingCookie}=`)),
    ]) {
      const cookies = [
        ...result.cookies.filter((cookie) => !cookie.startsWith(`${bindingCookie}=`)),
        ...replacement,
      ]
      await expectRefusedCompletion(await complete(result, { cookies }))
      expect(await identityEffects()).toEqual(before)
      expect(await protocolEffects(provider.id)).toEqual(state)
    }
    const foreignOrigin = await complete(result, { origin: idpOrigin })
    expect(foreignOrigin.status).toBe(403)
    expect(await foreignOrigin.json()).toEqual({ error: 'forbidden' })
    expect(await identityEffects()).toEqual(before)
    expect(await protocolEffects(provider.id)).toEqual(state)
    expect((await complete(result)).status).toBe(303)
  })

  it('requires the exact issued RelayState even with a valid signed InResponseTo', async () => {
    const provider = await linkedProvider()
    const attempt = await start(provider)
    const other = await start(provider)
    const signed = await signedResponse(attempt)
    const forged = `${attempt.relayState.split('.')[0]}.${randomBytes(32).toString('base64url')}`
    const before = await identityEffects()
    const state = await protocolEffects(provider.id)
    for (const relayState of [null, forged, other.relayState]) {
      expectRefusedAcs(await acs(provider.id, signed.encoded, relayState))
      expect(await protocolEffects(provider.id)).toEqual(state)
    }
    expect(await identityEffects()).toEqual(before)
    await pending(await acs(provider.id, signed.encoded, attempt.relayState), attempt)
  })

  it('accepts only one concurrent delivery and refuses replay of each consumed SAML ID', async () => {
    const provider = await linkedProvider()
    const attempt = await start(provider)
    const signed = await signedResponse(attempt)
    const otherApp = instance()
    const deliveries = await Promise.all(
      [app, otherApp].map((request) =>
        acs(provider.id, signed.encoded, attempt.relayState, request),
      ),
    )
    const [accepted, refused] = deliveries.sort(
      (a, b) =>
        Number(a.headers.get('location') === errorPath) -
        Number(b.headers.get('location') === errorPath),
    ) as [Response, Response]
    const result = await pending(accepted, attempt)
    expectRefusedAcs(refused)
    const [, cache] = await protocolEffects(provider.id)
    expect(cache).toEqual([
      { kind: 'saml_assertion', key_digest: digest(signed.assertionId) },
      { kind: 'saml_request', key_digest: digest(attempt.requestId) },
      { kind: 'saml_response', key_digest: digest(signed.responseId) },
    ])

    const state = await protocolEffects(provider.id)
    const newIds = await signedResponse(attempt)
    expectRefusedAcs(await acs(provider.id, newIds.encoded, attempt.relayState))
    expect(await protocolEffects(provider.id)).toEqual(state)
    const fresh = await start(provider)
    const freshState = await protocolEffects(provider.id)
    for (const options of [
      { assertionId: signed.assertionId },
      { responseId: signed.responseId },
    ]) {
      const reused = await signedResponse(fresh, options)
      expectRefusedAcs(await acs(provider.id, reused.encoded, fresh.relayState))
      expect(await protocolEffects(provider.id)).toEqual(freshState)
    }

    const completions = await Promise.all(
      [app, otherApp].map((request) => complete(result, { request })),
    )
    expect(completions.map(({ status }) => status).sort()).toEqual([303, 400])
    const loser = completions.find((response) => response.status === 400)
    if (!loser) throw new Error('Expected a refused duplicate completion')
    await expectRefusedCompletion(loser)
  })

  it('rechecks the signed acceptance deadline at completion while the pending result is still live', async () => {
    const provider = await linkedProvider()
    const attempt = await start(provider)
    const signed = await signedResponse(attempt, { bearerLifetime: 20 })
    const result = await pending(
      await acs(provider.id, signed.encoded, attempt.relayState),
      attempt,
    )
    const before = await identityEffects()
    const state = await protocolEffects(provider.id)
    const expires = signed.deadline.add({ seconds: samlClockSkew })
    const attemptRow = await db
      .selectFrom('sso_attempts')
      .select('expires_at')
      .where('id', '=', result.id)
      .executeTakeFirstOrThrow()
    expect(
      Temporal.Instant.compare(
        expires,
        Temporal.Instant.fromEpochMilliseconds(attemptRow.expires_at.getTime()),
      ),
    ).toBeLessThan(0)
    const clock = vi.spyOn(samlReplay, 'samlDatabaseNow').mockResolvedValue(expires)
    await expectRefusedCompletion(await complete(result))
    expect(await identityEffects()).toEqual(before)
    expect(await protocolEffects(provider.id)).toEqual(state)

    clock.mockResolvedValueOnce(expires.subtract({ microseconds: 1 }))
    await expectRefusedCompletion(await complete(result))
    expect(await identityEffects()).toEqual(before)
    expect(await protocolEffects(provider.id)).toEqual(state)
    clock.mockRestore()
    expect((await complete(result)).status).toBe(303)
  })

  it('refuses signed unsolicited login and leaves SLO unmounted', async () => {
    const provider = await linkedProvider()
    const unsolicited = await signedResponse(
      {
        provider,
        requestId: '',
        audience: `${publicUrl}/api/auth/sso/saml2/sp/metadata/${provider.id}`,
        recipient: publicUrl + acsPath(provider.id),
      },
      { requestId: null },
    )
    const before = await identityEffects()
    expectRefusedAcs(await acs(provider.id, unsolicited.encoded, null))

    const slo = new URL(`/api/auth/sso/saml2/sp/slo/${provider.id}`, publicUrl)
    for (const method of ['GET', 'POST']) {
      const response = await app.request(slo, { method, headers: { origin: publicUrl } })
      expect(response.status).toBe(404)
      expect(response.headers.getSetCookie()).toEqual([])
    }
    expect(
      app.routes.some(
        ({ path }) => path.startsWith('/api/auth/sso/saml2/') && /logout|\/slo\b/i.test(path),
      ),
    ).toBe(false)
    expect(await protocolEffects(provider.id)).toEqual([[], []])
    expect(await identityEffects()).toEqual(before)
  })

  it('refuses a different subject, NameID scope or asserted mailbox', async () => {
    const provider = await linkedProvider()
    const before = await identityEffects()
    for (const options of [
      { subject: `unlinked-${randomUUID()}` },
      { subjectFormat: transient },
      { nameQualifier: 'https://other-idp.example.com' },
      { spNameQualifier: 'https://other-sp.example.com' },
      { mailbox: 'different@example.test' },
    ]) {
      const attempt = await start(provider)
      const signed = await signedResponse(attempt, options)
      expectRefusedAcs(await acs(provider.id, signed.encoded, attempt.relayState))
      expect(await identityEffects()).toEqual(before)
    }
  })

  it('keeps the SAML routes hard-off with no writes and OIDC sign-in available', async () => {
    const provider = await linkedProvider()
    const attempt = await start(provider)
    const signed = await signedResponse(attempt)
    const result = await pending(
      await acs(provider.id, signed.encoded, attempt.relayState),
      attempt,
    )
    const fresh = await start(provider)
    const freshResponse = await signedResponse(fresh)
    const off = instance(
      productionSsoCapabilities(
        loadConfig({
          DATABASE_URL: owned.url,
          PUBLIC_URL: publicUrl,
          BETTER_AUTH_SECRET: secret,
          SSO_OIDC_ENABLED: 'true',
          SSO_SAML_ENABLED: 'true',
        }),
      ),
    )
    const before = await identityEffects()
    const state = await protocolEffects(provider.id)
    for (const response of [
      await acs(provider.id, freshResponse.encoded, fresh.relayState, off),
      await off.request(result.location, { headers: { cookie: result.cookies.join('; ') } }),
      await complete(result, { request: off }),
    ]) {
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'sso_disabled' })
      expect(response.headers.getSetCookie()).toEqual([])
    }
    expect(await identityEffects()).toEqual(before)
    expect(await protocolEffects(provider.id)).toEqual(state)

    const oidc = await providerId()
    const issuer = `${idpOrigin}/oidc`
    const config = {
      issuer,
      clientId: 'synthetic-oidc-client',
      clientSecret: randomBytes(32).toString('base64url'),
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
      jwksUrl: `${issuer}/keys`,
    }
    await db
      .insertInto('sso_providers')
      .values({
        id: oidc,
        organization_id: team.team,
        protocol: 'oidc',
        display_name: 'Synthetic OIDC',
        issuer,
        client_id: config.clientId,
        configuration: seal(oidc, config),
        enabled: true,
      })
      .execute()
    const oidcStart = await signIn(oidc, off)
    expect(oidcStart.status).toBe(200)
    const { url } = (await oidcStart.json()) as { url: string }
    const authorization = new URL(url)
    expect(authorization.origin + authorization.pathname).toBe(config.authorizationEndpoint)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
  })
})
