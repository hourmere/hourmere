import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { DOMParser } from '@xmldom/xmldom'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SignedXml } from 'xml-crypto'
import {
  at,
  claimedDomainValues,
  oidcProviderValues,
  recoveryOwnerValues,
  type SsoFixture,
  samlProviderValues,
  ssoFixture,
} from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { ssoDraftRoutes } from './routes/sso-drafts.ts'
import { ssoRecoveryEnrollmentRoutes } from './routes/sso-recovery-enrollment.ts'
import { productionSsoCapabilities } from './server.ts'
import type { SsoCapabilities } from './sso.ts'
import { sealSsoProviderConfiguration } from './sso-configuration.ts'
import {
  databaseClock,
  deliverMailboxProof,
  MAILBOX_PROOF_CONSUME_PATH,
  MAILBOX_PROOF_SEND_PATH,
  MailboxProofEmailPayload,
  mailboxProofRoutes,
} from './sso-mailbox-proof.ts'
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
const providersPath = '/api/v1/team/sso/providers'
const recoveryUsePath = '/api/v1/team/sso/recovery/use'
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
const stableAttribute = 'urn:example:immutable-id'
const assertionNamespace = 'urn:oasis:names:tc:SAML:2.0:assertion'
const protocolNamespace = 'urn:oasis:names:tc:SAML:2.0:protocol'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const cookiesFrom = (response: Response) =>
  response.headers.getSetCookie().map((cookie) => cookie.split(';')[0] ?? '')

function mergeCookies(...groups: string[][]) {
  const cookies = new Map<string, string>()
  for (const cookie of groups.flat()) cookies.set(cookie.split('=', 1)[0] ?? '', cookie)
  return [...cookies.values()]
}

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
  subjectAttributeValues?: readonly string[]
  bearerLifetime?: number
  sessionLifetime?: number
  signingIdentity?: ReturnType<typeof samlSigningIdentity>
  responseOnly?: boolean
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
  let rotatedIdp: ReturnType<typeof samlSigningIdentity>

  async function seedTeam() {
    const client = await owned.pool.connect()
    return ssoFixture(client).finally(() => client.release())
  }

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'saml_completion' })
    db = createDb(owned.pool)
    team = await seedTeam()
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
    rotatedIdp = samlSigningIdentity('login.example.com')
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

  function instance(
    capabilities: SsoCapabilities = samlOnly,
    mailboxJobs?: MailboxProofEmailPayload[],
  ) {
    const deps = { db, capabilities, configurationKey, session: { secret } }
    const readSession = async (headers: Headers) =>
      (
        await auth.api.getSession({
          headers,
          query: { disableRefresh: true, disableCookieCache: true },
        })
      )?.session
    return createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: mailboxJobs
        ? createCallerResolver({ auth, db })
        : async () => expect.unreachable('SAML completion does not resolve a caller'),
      publicUrl,
      ...(mailboxJobs && {
        routes: [
          ssoDraftRoutes({ ...deps, publicUrl, privateTargets: [] }),
          ssoRecoveryEnrollmentRoutes({
            ...deps,
            publicUrl,
            notificationQueue: {
              async enqueue(_name, _payload, options) {
                expect(options.transaction).toMatchObject({ isTransaction: true })
                return 'recovery-notice'
              },
            },
          }),
        ],
        ssoTeamReads: { db, capabilities },
        ssoMailboxProof: mailboxProofRoutes({
          db,
          capabilities,
          queue: {
            async enqueue(_name, payload) {
              mailboxJobs.push(MailboxProofEmailPayload.parse(payload))
              return 'mailbox-proof'
            },
          },
        }),
      }),
      ssoOidcSignIn: oidcSignInRoutes({
        ...deps,
        privateTargets: [],
        send: async () => expect.unreachable('The IdP uses a local signed fixture'),
        signup,
        readSession: async () => expect.unreachable('Sign-in does not read a session'),
      }),
      ssoSamlSignIn: samlSignInRoutes({ ...deps, readSession }),
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

  async function enabledProvider({
    organizationId = team.team,
    domainId = domain.id,
    subjectAttribute,
    assertedMailbox = mailbox,
  }: {
    organizationId?: string
    domainId?: string
    subjectAttribute?: string
    assertedMailbox?: string
  } = {}) {
    const id = await providerId()
    const values = samlProviderValues(organizationId)
    await db
      .insertInto('sso_providers')
      .values({
        ...values,
        id,
        enabled: true,
        configuration: sealSsoProviderConfiguration(
          configurationKey,
          { organizationId, providerId: id, revision: 1 },
          JSON.stringify({ ssoEndpoint, signingCertificates: [idp.pem], subjectAttribute }),
        ),
      })
      .execute()
    await db
      .insertInto('sso_provider_domains')
      .values({ organization_id: organizationId, provider_id: id, domain_id: domainId })
      .execute()
    return {
      id,
      issuer: values.issuer,
      subject: `fixture-subject-${randomUUID()}`,
      mailbox: assertedMailbox,
    }
  }

  async function linkedProvider() {
    const provider = await enabledProvider()
    const link = await db
      .insertInto('sso_identity_links')
      .values({
        organization_id: team.team,
        provider_id: provider.id,
        user_id: team.member,
        issuer: provider.issuer,
        subject: provider.subject,
        proven_email: mailbox,
        email_proven_at: at(-60),
      })
      .returning(['id', 'generation'])
      .executeTakeFirstOrThrow()
    return { ...provider, link }
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
    return readStart(provider, response)
  }

  async function readStart(provider: Provider, response: Response, cookies: string[] = []) {
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
    return {
      provider,
      requestId,
      relayState,
      audience,
      recipient,
      cookies: mergeCookies(cookies, cookiesFrom(response)),
    }
  }

  function sign(xml: string, element: 'Assertion' | 'Response', signingIdentity = idp) {
    const canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#'
    const signer = new SignedXml({
      privateKey: signingIdentity.privateKey,
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
      subjectAttributeValues,
      bearerLifetime = 300,
      sessionLifetime,
      signingIdentity,
      responseOnly = false,
    } = options
    const issued = await samlReplay.samlDatabaseNow(db)
    const deadline = issued.add({ seconds: bearerLifetime })
    const sessionDeadline =
      sessionLifetime === undefined ? undefined : issued.add({ seconds: sessionLifetime })
    const sessionBound = sessionDeadline ? ` SessionNotOnOrAfter="${sessionDeadline}"` : ''
    const correlation = correlatedId === null ? '' : ` InResponseTo="${correlatedId}"`
    const nameScope = nameQualifier ? ` NameQualifier="${nameQualifier}"` : ''
    const spScope = spNameQualifier ? ` SPNameQualifier="${spNameQualifier}"` : ''
    const immutableAttribute = subjectAttributeValues
      ? `<saml:Attribute Name="${stableAttribute}">${subjectAttributeValues
          .map((value) => `<saml:AttributeValue>${value}</saml:AttributeValue>`)
          .join('')}</saml:Attribute>`
      : ''
    const assertion = `<saml:Assertion xmlns:saml="${assertionNamespace}" ID="${assertionId}" Version="2.0" IssueInstant="${issued}">
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
        ${immutableAttribute}
      </saml:AttributeStatement>
    </saml:Assertion>`
    const xml = sign(
      `<samlp:Response xmlns:samlp="${protocolNamespace}" ID="${responseId}" Version="2.0" IssueInstant="${issued}" Destination="${recipient}"${correlation}>
      <saml:Issuer xmlns:saml="${assertionNamespace}">${provider.issuer}</saml:Issuer>
      <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
      ${responseOnly ? assertion : sign(assertion, 'Assertion', signingIdentity)}
    </samlp:Response>`,
      'Response',
      signingIdentity,
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

  async function pending(accepted: Response, attempt: Start, intent?: 'link') {
    expect(accepted.status).toBe(303)
    const location = new URL(accepted.headers.get('location') ?? '', publicUrl)
    expect(location.origin + location.pathname).toBe(publicUrl + completePath)
    expect([...location.searchParams.keys()].sort()).toEqual(
      intent ? ['attemptId', 'intent'] : ['attemptId'],
    )
    expect(location.searchParams.get('intent')).toBe(intent ?? null)
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
    {
      request = app,
      cookies = result.cookies,
      origin = publicUrl,
      intent = result.location.searchParams.get('intent'),
    } = {},
  ) {
    const body = new URLSearchParams({ attemptId: result.id })
    if (intent) body.set('intent', intent)
    return request.request(new URL(completePath, publicUrl), {
      method: 'POST',
      headers: { origin, cookie: cookies.join('; ') },
      body,
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

  async function browserSession(userId: string, organizationId = team.team) {
    const session = await db
      .transaction()
      .execute(async (trx) =>
        createBrowserSession(
          trx,
          { publicUrl, secret },
          { userId, organizationId, now: await databaseClock(trx), headers: new Headers() },
        ),
      )
    return { id: session.id, cookies: [session.cookie.split(';')[0] ?? ''] }
  }

  async function samlDraft(organizationId: string) {
    const id = await providerId()
    const values = samlProviderValues(organizationId)
    const configuration = sealSsoProviderConfiguration(
      configurationKey,
      { organizationId, providerId: id, revision: 1 },
      JSON.stringify({ ssoEndpoint, signingCertificates: [idp.pem] }),
    )
    await db
      .insertInto('sso_providers')
      .values({ ...values, id, configuration })
      .execute()
    return {
      id,
      issuer: values.issuer,
      subject: `new-saml-test-subject-${randomUUID()}`,
      mailbox: `unenrolled-${randomUUID()}@${verifiedDomain}`,
    }
  }

  function management(organizationId = team.team, capabilities: SsoCapabilities = samlOnly) {
    const jobs: MailboxProofEmailPayload[] = []
    const request = instance(capabilities, jobs)
    const json = (
      path: string,
      cookies: string[],
      body: Record<string, unknown>,
      method = 'POST',
      headers: Record<string, string> = {},
    ) =>
      request.request(new URL(path, publicUrl), {
        method,
        headers: {
          origin: publicUrl,
          cookie: cookies.join('; '),
          'X-Expected-Organization-Id': organizationId,
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
      })

    async function deliverProof(attemptId: string, cookies: string[]) {
      const accepted = await json(MAILBOX_PROOF_SEND_PATH, cookies, { attemptId })
      expect(accepted.status).toBe(202)
      expect(await accepted.json()).toEqual({ status: 'queued' })
      const job = jobs.shift()
      if (!job) throw new Error('Missing queued mailbox proof')
      let delivery: { token: string; subject: string; text: string; to: string } | undefined
      await deliverMailboxProof(
        {
          db,
          capabilities,
          publicUrl,
          secret,
          mailMaxPerHour: 0,
          signInMailMaxPerHour: 20,
          mailer: {
            async send(message) {
              const text = message.text ?? ''
              const token = /[#&]token=([A-Za-z0-9_-]{43})/.exec(text)?.[1]
              if (token) delivery = { token, subject: message.subject, text, to: message.to }
            },
          },
        },
        job,
      )
      if (!delivery) throw new Error('Missing token in captured mailbox proof message')
      return delivery
    }

    const consumeProof = (attemptId: string, cookies: string[], token: string) =>
      json(MAILBOX_PROOF_CONSUME_PATH, cookies, { attemptId, token })

    async function mailboxProof(response: Response, original: string[]) {
      expect(response.status).toBe(403)
      const challenge = (await response.json()) as { attemptId: string }
      expect(challenge).toMatchObject({
        error: 'sso_reauthentication_required',
        attemptId: expect.any(String),
        proofMethods: ['mailbox'],
      })
      const cookies = mergeCookies(original, cookiesFrom(response))
      const { attemptId } = challenge
      const { token } = await deliverProof(attemptId, cookies)
      expect((await consumeProof(attemptId, cookies, token)).status).toBe(200)
      return { attemptId, cookies }
    }

    async function withMailbox(
      path: string,
      original: string[],
      body: Record<string, unknown>,
      method = 'POST',
    ) {
      const { attemptId, cookies } = await mailboxProof(
        await json(path, original, body, method),
        original,
      )
      return {
        response: await json(path, cookies, { ...body, proofAttemptId: attemptId }, method),
        cookies,
      }
    }

    return { request, json, deliverProof, consumeProof, mailboxProof, withMailbox }
  }

  const receipts = (id: string) =>
    db
      .selectFrom('audit_events')
      .select(['actor_id', 'credential_id', 'target_type', 'details'])
      .where('action', '=', 'sso_provider.tested')
      .where('target_id', '=', id)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute()

  async function finishProviderTest(request: App, attempt: Start, options?: SignedResponseOptions) {
    const response = await signedResponse(attempt, options)
    expect(Buffer.from(response.encoded, 'base64').toString('utf8')).not.toContain('KeyInfo')
    const result = await pending(
      await acs(attempt.provider.id, response.encoded, attempt.relayState, request),
      attempt,
    )
    const completed = await complete(result, { request })
    expect(completed.status).toBe(303)
    expect(completed.headers.get('location')).toBe('/app/settings')
  }

  const linkPath = (provider: Provider) => `${providersPath}/${provider.id}/link`

  function storedLinks(provider: Provider) {
    return db
      .selectFrom('sso_identity_links')
      .select(['id', 'user_id', 'issuer', 'subject', 'generation', 'proven_email'])
      .where('provider_id', '=', provider.id)
      .execute()
  }

  async function startLink(
    provider: Provider,
    browser: string[],
    { withMailbox }: ReturnType<typeof management>,
  ) {
    const { response, cookies } = await withMailbox(linkPath(provider), browser, {})
    return readStart(provider, response, cookies)
  }

  async function stageLink(request: App, attempt: Start, options?: SignedResponseOptions) {
    const signed = await signedResponse(attempt, options)
    return pending(
      await acs(attempt.provider.id, signed.encoded, attempt.relayState, request),
      attempt,
      'link',
    )
  }

  it('requires independent mailbox proof and explicit consent in the original SAML linking browser and session', async () => {
    const provider = await enabledProvider()
    const { request, json, mailboxProof } = management()
    const member = await browserSession(team.member)
    const otherSession = await browserSession(team.member)
    const otherMember = await browserSession(team.admin)
    const me = async (cookies: string[], application = request) => {
      const response = await application.request(new URL('/api/v1/me', publicUrl), {
        headers: { cookie: cookies.join('; ') },
      })
      expect(response.status).toBe(200)
      return ((await response.json()) as { sso: Record<string, unknown> }).sso
    }
    const before = await identityEffects()
    const challenge = await json(linkPath(provider), member.cookies, {})
    expect(await protocolEffects(provider.id)).toEqual([[], []])
    expect(await identityEffects()).toEqual(before)
    expect(await me(mergeCookies(member.cookies, cookiesFrom(challenge)))).toMatchObject({
      attempts: [{ phase: 'fresh_proof', mailboxProven: false }],
    })
    const proof = await mailboxProof(challenge, member.cookies)
    const attempt = await readStart(
      provider,
      await json(linkPath(provider), proof.cookies, { proofAttemptId: proof.attemptId }),
      proof.cookies,
    )
    const authorizationId = attempt.requestId.slice(1)
    const authorizationSummary = await me(attempt.cookies)
    expect(authorizationSummary).toMatchObject({
      providers: expect.arrayContaining([
        { id: provider.id, revision: 1, displayName: 'Synthetic AD FS' },
      ]),
      attempts: [
        {
          id: authorizationId,
          providerId: provider.id,
          phase: 'authorization',
          mailboxProven: true,
          expiresAt: expect.any(String),
        },
      ],
    })
    const staged = await stageLink(request, attempt)
    const beforeConsent = await identityEffects()
    expect(beforeConsent).toEqual({
      ...before,
      mailboxTokens: String(Number(before.mailboxTokens) + 1),
    })
    const page = await request.request(staged.location, {
      headers: { cookie: staged.cookies.join('; '), 'accept-language': 'en' },
    })
    expect(page.status).toBe(200)
    const form = await page.text()
    expect(form).toContain('Link account')
    expect(form).toContain('name="intent" value="link"')
    expect(await identityEffects()).toEqual(beforeConsent)
    expect(await storedLinks(provider)).toEqual([])
    expect(await me(staged.cookies)).toMatchObject({
      attempts: [
        { id: staged.id, providerId: provider.id, phase: 'completion', mailboxProven: true },
      ],
    })
    const off = management(team.team, { ssoOidcEnabled: true, ssoSamlEnabled: false }).request
    expect(await me(staged.cookies, off)).toMatchObject({ providers: [], attempts: [] })
    const wrongBrowser = mergeCookies(staged.cookies, [
      `${bindingCookie}=${randomBytes(32).toString('base64url')}`,
    ])
    const wrongSession = mergeCookies(staged.cookies, otherSession.cookies)
    const wrongUser = mergeCookies(staged.cookies, otherMember.cookies)
    for (const cookies of [wrongBrowser, wrongSession, wrongUser]) {
      expect(await me(cookies)).toMatchObject({ attempts: [] })
      await expectRefusedCompletion(await complete(staged, { request, cookies }))
    }
    await expectRefusedCompletion(await complete(staged, { request, intent: null }))
    expect(await identityEffects()).toEqual(beforeConsent)

    const consent = await complete(staged, { request })
    expect(consent.status).toBe(303)
    expect(consent.headers.get('location')).toBe('/app/settings')
    await expectRefusedCompletion(await complete(staged, { request }))
    expect(await identityEffects()).toEqual({
      ...beforeConsent,
      links: String(Number(beforeConsent.links) + 1),
    })
    const [link] = await storedLinks(provider)
    expect(link).toEqual({
      id: expect.any(String),
      user_id: team.member,
      issuer: provider.issuer,
      subject: provider.subject,
      generation: 1,
      proven_email: mailbox,
    })
    const summary = await me(staged.cookies)
    expect(summary).toMatchObject({
      attempts: [],
      links: [{ id: link?.id, generation: 1, providerId: provider.id }],
      proofs: [],
    })
    expect(JSON.stringify(summary)).not.toContain(provider.subject)
    expect(JSON.stringify(summary)).not.toContain(mailbox)
    expect(await me(wrongUser)).toMatchObject({ links: [], attempts: [] })
  })

  it('refuses transient NameID, uses only a single pinned immutable attribute and still needs a matching mailbox', async () => {
    const manager = management()
    const { request } = manager
    const member = await browserSession(team.member)
    const unpinned = await enabledProvider()
    const pinned = await enabledProvider({ subjectAttribute: stableAttribute })
    const stableSubject = `immutable-${randomUUID()}`
    for (const [provider, options] of [
      [unpinned, { subjectFormat: transient, subjectAttributeValues: [stableSubject] }],
      [pinned, {}],
      [pinned, { subjectAttributeValues: [stableSubject, 'second-value'] }],
      [pinned, { subjectAttributeValues: [stableSubject], mailbox: `other@${verifiedDomain}` }],
    ] as const) {
      const attempt = await startLink(provider, member.cookies, manager)
      const signed = await signedResponse(attempt, options)
      expectRefusedAcs(await acs(provider.id, signed.encoded, attempt.relayState, request))
      expect(await storedLinks(provider)).toEqual([])
    }

    const staged = await stageLink(request, await startLink(pinned, member.cookies, manager), {
      subjectAttributeValues: [stableSubject],
    })
    expect((await complete(staged, { request })).status).toBe(303)
    expect(await storedLinks(pinned)).toEqual([
      expect.objectContaining({ subject: stableSubject, user_id: team.member }),
    ])
    const signedIn = await signIn(pinned.id, request)
    const attempt = await readStart(pinned, signedIn)
    const assertion = await signedResponse(attempt, {
      subject: 'different-persistent-name-id',
      subjectAttributeValues: [stableSubject],
    })
    const result = await pending(
      await acs(pinned.id, assertion.encoded, attempt.relayState, request),
      attempt,
    )
    expect((await complete(result, { request })).status).toBe(303)
  })

  it('refuses an expired SAML link intent without consuming it or creating a link', async () => {
    const provider = await enabledProvider()
    const manager = management()
    const member = await browserSession(team.member)
    const { request } = manager
    const result = await stageLink(request, await startLink(provider, member.cookies, manager), {
      sessionLifetime: 2,
    })
    await vi.waitFor(
      async () => {
        const row = await db
          .selectFrom('sso_attempts')
          .select(sql<boolean>`expires_at <= clock_timestamp()`.as('expired'))
          .where('id', '=', result.id)
          .executeTakeFirstOrThrow()
        expect(row.expired).toBe(true)
      },
      { timeout: 2500, interval: 50 },
    )
    const before = await protocolEffects(provider.id)
    await expectRefusedCompletion(await complete(result, { request }))
    expect(await storedLinks(provider)).toEqual([])
    expect(await protocolEffects(provider.id)).toEqual(before)
  })

  it('refuses link consent when a concurrent team membership removal commits first', async () => {
    const fixture = await seedTeam()
    const domainName = `removal-${randomUUID()}.example.com`
    const assertedMailbox = `member@${domainName}`
    await db
      .updateTable('auth.user')
      .set({ email: assertedMailbox })
      .where('id', '=', fixture.member)
      .execute()
    const claim = await db
      .insertInto('sso_domains')
      .values(claimedDomainValues(fixture.team, domainName))
      .returning('id')
      .executeTakeFirstOrThrow()
    const provider = await enabledProvider({
      organizationId: fixture.team,
      domainId: claim.id,
      assertedMailbox,
    })
    const manager = management(fixture.team)
    const member = await browserSession(fixture.member, fixture.team)
    const { request } = manager
    const result = await stageLink(request, await startLink(provider, member.cookies, manager))
    const before = await protocolEffects(provider.id)
    const blocker = await owned.pool.connect()
    let completing: Promise<Response> | undefined
    try {
      await blocker.query('BEGIN')
      const { rows } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await blocker.query('SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE', [
        fixture.team,
      ])
      await blocker.query('DELETE FROM auth.member WHERE id = $1', [fixture.memberMember])
      completing = Promise.resolve(complete(result, { request }))
      await vi.waitFor(
        async () => {
          const waiting = await owned.pool.query<{ blocked: boolean }>(
            `SELECT EXISTS (SELECT FROM pg_stat_activity WHERE datname = current_database()
             AND $1 = ANY(pg_blocking_pids(pid))) AS blocked`,
            [rows[0]?.pid],
          )
          expect(waiting.rows[0]?.blocked).toBe(true)
        },
        { timeout: 2500, interval: 10 },
      )
      await blocker.query('COMMIT')
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
    }
    await expectRefusedCompletion(await completing)
    expect(await storedLinks(provider)).toEqual([])
    expect(await protocolEffects(provider.id)).toEqual(before)
  })

  it('refuses SAML link consent for a directory-suspended child member even after SCIM is disabled', async () => {
    const fixture = await seedTeam()
    const domainName = `directory-${randomUUID()}.example.com`
    const assertedMailbox = `member@${domainName}`
    await db
      .updateTable('auth.user')
      .set({ email: assertedMailbox })
      .where('id', '=', fixture.member)
      .execute()
    const claim = await db
      .insertInto('sso_domains')
      .values(claimedDomainValues(fixture.team, domainName))
      .returning('id')
      .executeTakeFirstOrThrow()
    const provider = await enabledProvider({
      organizationId: fixture.team,
      domainId: claim.id,
      assertedMailbox,
    })
    const manager = management(fixture.team, { ...samlOnly, scimResourcesEnabled: true })
    const member = await browserSession(fixture.member, fixture.team)
    const { request } = manager
    const result = await stageLink(request, await startLink(provider, member.cookies, manager))
    const before = await protocolEffects(provider.id)

    const connection = await db
      .insertInto('scim_connections')
      .values({ organization_id: fixture.otherTeam })
      .returning('id')
      .executeTakeFirstOrThrow()
    const mapping = await db
      .insertInto('scim_team_mappings')
      .values({
        parent_organization_id: fixture.otherTeam,
        child_organization_id: fixture.team,
        connection_id: connection.id,
        external_id: 'roster',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('scim_team_managed_memberships')
      .values({
        member_id: fixture.memberMember,
        mapping_id: mapping.id,
        child_organization_id: fixture.team,
        user_id: fixture.member,
        suspended_at: sql`clock_timestamp()`,
      })
      .execute()

    await expectRefusedCompletion(await complete(result, { request }))
    await expectRefusedCompletion(await complete(result, { request: instance() }))
    expect(await storedLinks(provider)).toEqual([])
    expect(await protocolEffects(provider.id)).toEqual(before)

    await db
      .updateTable('scim_team_managed_memberships')
      .set({ suspended_at: null })
      .where('member_id', '=', fixture.memberMember)
      .execute()
    const completed = await complete(result, { request: instance() })
    expect(completed.status).toBe(303)
    expect(completed.headers.get('location')).toBe('/app/settings')
    expect(await storedLinks(provider)).toEqual([
      expect.objectContaining({ user_id: fixture.member, subject: provider.subject }),
    ])
  })

  it('binds a draft test to fresh administration, its original session and browser, and its exact revision', async () => {
    const provider = await samlDraft(team.team)
    const { json, mailboxProof, request, withMailbox } = management()
    const testPath = `${providersPath}/${provider.id}/test`
    const owner = await browserSession(team.owner)
    const secondSession = await browserSession(team.owner)
    const member = await browserSession(team.member)
    const outsider = await browserSession(team.otherOwner, team.otherTeam)
    const input = { expectedRevision: 1 }
    for (const response of [
      await json(testPath, member.cookies, input),
      await json(testPath, outsider.cookies, input),
      await json(testPath, owner.cookies, input, 'POST', { origin: idpOrigin }),
    ]) {
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'team_management_access_denied' })
    }
    const proofRequired = await json(testPath, owner.cookies, input)
    expect(await protocolEffects(provider.id)).toEqual([[], []])
    const proof = await mailboxProof(proofRequired, owner.cookies)
    const attempt = await readStart(
      provider,
      await json(testPath, proof.cookies, { ...input, proofAttemptId: proof.attemptId }),
      proof.cookies,
    )
    const signed = await signedResponse(attempt)
    const before = await identityEffects()
    const result = await pending(
      await acs(provider.id, signed.encoded, attempt.relayState, request),
      attempt,
    )
    expect(await receipts(provider.id)).toEqual([])
    const confirmation = await request.request(result.location, {
      headers: { cookie: result.cookies.join('; ') },
    })
    expect(confirmation.status).toBe(200)
    expect(await receipts(provider.id)).toEqual([])
    const withoutBinding = result.cookies.filter(
      (cookie) => !cookie.startsWith(`${bindingCookie}=`),
    )
    await expectRefusedCompletion(await complete(result, { request, cookies: withoutBinding }))
    await expectRefusedCompletion(
      await complete(result, {
        request,
        cookies: mergeCookies(result.cookies, secondSession.cookies),
      }),
    )
    expect(await receipts(provider.id)).toEqual([])

    const completed = await complete(result, { request })
    expect(completed.status).toBe(303)
    expect(completed.headers.get('location')).toBe('/app/settings')
    expect(await receipts(provider.id)).toEqual([
      {
        actor_id: team.owner,
        credential_id: owner.id,
        target_type: 'sso_provider_owner_test',
        details: {
          method: 'saml',
          providerId: provider.id,
          revision: 1,
          correlationId: attempt.requestId.slice(1),
          outcome: 'passed',
        },
      },
    ])
    await expectRefusedCompletion(await complete(result, { request }))
    expect(await identityEffects()).toEqual(before)

    const second = await withMailbox(testPath, proof.cookies, input)
    const inFlight = await readStart(provider, second.response, second.cookies)
    const later = await signedResponse(inFlight)
    const staged = await pending(
      await acs(provider.id, later.encoded, inFlight.relayState, request),
      inFlight,
    )
    const update = await withMailbox(
      `${providersPath}/${provider.id}`,
      proof.cookies,
      { ...input, displayName: 'Renamed while a test was pending' },
      'PATCH',
    )
    expect(update.response.status).toBe(200)
    expect(await update.response.json()).toMatchObject({
      provider: { id: provider.id, revision: 2, testStatus: 'unknown' },
    })
    await expectRefusedCompletion(await complete(staged, { request }))
    expect(await receipts(provider.id)).toHaveLength(1)
  })

  it('tests overlapping signing certificates without KeyInfo and refuses removed certificates and response-only signatures', async () => {
    const fixture = await seedTeam()
    const provider = await samlDraft(fixture.team)
    const { request, withMailbox } = management(fixture.team)
    const owner = await browserSession(fixture.owner, fixture.team)
    const path = `${providersPath}/${provider.id}`
    const update = (revision: number, signingCertificates: string[]) =>
      withMailbox(
        path,
        owner.cookies,
        { expectedRevision: revision, saml: { signingCertificates } },
        'PATCH',
      )
    async function runTest(revision: number, options: SignedResponseOptions) {
      const { response, cookies } = await withMailbox(`${path}/test`, owner.cookies, {
        expectedRevision: revision,
      })
      await finishProviderTest(request, await readStart(provider, response, cookies), options)
    }
    const overlap = await update(1, [idp.pem, rotatedIdp.pem])
    expect(overlap.response.status).toBe(200)
    await runTest(2, { signingIdentity: idp })
    await runTest(2, { signingIdentity: rotatedIdp })
    expect((await receipts(provider.id)).map(({ details }) => details)).toMatchObject([
      { revision: 2, outcome: 'passed' },
      { revision: 2, outcome: 'passed' },
    ])

    const rotated = await update(2, [rotatedIdp.pem])
    expect(rotated.response.status).toBe(200)
    expect(await rotated.response.json()).toMatchObject({
      provider: { revision: 3, testStatus: 'unknown' },
    })
    await runTest(3, { signingIdentity: idp })
    await runTest(3, { signingIdentity: rotatedIdp, responseOnly: true })
    await runTest(3, { signingIdentity: rotatedIdp })
    expect((await receipts(provider.id)).slice(2).map(({ details }) => details)).toMatchObject([
      { revision: 3, outcome: 'failed', reason: 'signature_invalid' },
      { revision: 3, outcome: 'failed', reason: 'signature_invalid' },
      { revision: 3, outcome: 'passed' },
    ])
  })

  it('requires a distinct fresh recovery grant to update, test, and re-enable a SAML provider', async () => {
    const fixture = await seedTeam()
    const provider = await samlDraft(fixture.team)
    const { json, request, withMailbox } = management(fixture.team)
    const owner = await browserSession(fixture.owner, fixture.team)
    const claim = await db
      .insertInto('sso_domains')
      .values(claimedDomainValues(fixture.team))
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('sso_provider_domains')
      .values({ organization_id: fixture.team, provider_id: provider.id, domain_id: claim.id })
      .execute()
    await db.insertInto('sso_recovery_owners').values(recoveryOwnerValues(fixture)).execute()
    await db
      .insertInto('sso_policies')
      .values({ organization_id: fixture.team, require_sso: true })
      .execute()

    async function recovery(cookies: string[]) {
      const grant = await withMailbox(recoveryUsePath, cookies, { expectedRevision: 1 })
      expect(grant.response.status).toBe(204)
      return grant.cookies
    }

    const path = `${providersPath}/${provider.id}`
    const first = await recovery(owner.cookies)
    const updated = await json(
      path,
      first,
      {
        expectedRevision: 1,
        saml: { signingCertificates: [rotatedIdp.pem] },
      },
      'PATCH',
    )
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      provider: { id: provider.id, revision: 2, enabled: false, testStatus: 'unknown' },
    })
    const testPath = `${path}/test`
    const activationPath = `${path}/activation`
    const testInput = { expectedRevision: 2 }
    const activateInput = { ...testInput, enabled: true }
    const reusedFirst = await json(testPath, first, testInput)
    expect(reusedFirst.status).toBe(403)
    expect(await reusedFirst.json()).toEqual({ error: 'sso_required' })

    const second = await recovery(first)
    const untested = await json(activationPath, second, activateInput)
    expect(untested.status).toBe(409)
    expect(await untested.json()).toEqual({ error: 'sso_test_required' })
    const attempt = await readStart(provider, await json(testPath, second, testInput), second)
    const before = await identityEffects()
    await finishProviderTest(request, attempt, { signingIdentity: rotatedIdp })
    expect(await identityEffects()).toEqual(before)
    const reusedSecond = await json(activationPath, second, activateInput)
    expect(reusedSecond.status).toBe(403)
    expect(await reusedSecond.json()).toEqual({ error: 'sso_required' })

    const third = await recovery(second)
    const activated = await json(activationPath, third, activateInput)
    expect(activated.status).toBe(200)
    expect(await activated.json()).toMatchObject({
      provider: { id: provider.id, revision: 2, enabled: true, testStatus: 'passed' },
    })
    const reusedThird = await json(activationPath, third, activateInput)
    expect(reusedThird.status).toBe(403)
    expect(await reusedThird.json()).toEqual({ error: 'sso_required' })
    const uses = await db
      .selectFrom('audit_events')
      .select('details')
      .where('organization_id', '=', fixture.team)
      .where('action', '=', 'sso_recovery.used')
      .execute()
    expect(uses).toHaveLength(3)
    expect(new Set(uses.map(({ details }) => JSON.stringify(details))).size).toBe(3)
  })

  it('refuses tests of a hard-off SAML provider before writing while OIDC administration still requests proof', async () => {
    const saml = await samlDraft(team.team)
    const oidc = await db
      .insertInto('sso_providers')
      .values(oidcProviderValues(team.team))
      .returning('id')
      .executeTakeFirstOrThrow()
    const owner = await browserSession(team.owner)
    const { json } = management(team.team, {
      ssoOidcEnabled: true,
      ssoSamlEnabled: false,
      ssoOperatorSetting: true,
    })
    const before = await protocolEffects(saml.id)
    const response = await json(`${providersPath}/${saml.id}/test`, owner.cookies, {
      expectedRevision: 1,
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'sso_disabled' })
    expect(await protocolEffects(saml.id)).toEqual(before)
    expect(await receipts(saml.id)).toEqual([])
    const challenge = await json(`${providersPath}/${oidc.id}/test`, owner.cookies, {
      expectedRevision: 1,
    })
    expect(challenge.status).toBe(403)
    expect(await challenge.json()).toMatchObject({
      error: 'sso_reauthentication_required',
      proofMethods: ['mailbox'],
    })
  })

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

  it('requires the same changed-email proof with and without an account for the new mailbox', async () => {
    const provider = await linkedProvider()
    const { request, deliverProof, consumeProof } = management()
    const assertedMailbox = `changed-${randomUUID()}@${verifiedDomain}`
    const fixture = await seedTeam()
    const account = await db
      .selectFrom('auth.user')
      .select('email')
      .where('id', '=', fixture.otherOwner)
      .executeTakeFirstOrThrow()
    const before = await identityEffects()
    const oldLink = await storedLinks(provider)
    const setOtherMailbox = (email: string) =>
      db.updateTable('auth.user').set({ email }).where('id', '=', fixture.otherOwner).execute()

    async function changedMailbox() {
      const attempt = await readStart(provider, await signIn(provider.id, request))
      const signed = await signedResponse(attempt, { mailbox: assertedMailbox })
      const response = await acs(provider.id, signed.encoded, attempt.relayState, request)
      expect(response.status).toBe(303)
      const location = new URL(response.headers.get('location') ?? '', publicUrl)
      expect(location.origin + location.pathname).toBe(`${publicUrl}/app/mailbox-proof`)
      expect(location.search).toBe('')
      const fragment = new URLSearchParams(location.hash.slice(1))
      const id = fragment.get('attempt')
      if (!id) throw new Error('Missing pending mailbox attempt')
      expect([...fragment.keys()].sort()).toEqual(['attempt', 'saml'])
      expect(fragment.get('saml')).toBe('1')
      expect(response.headers.getSetCookie()).toHaveLength(1)
      const staged = { id, location, cookies: mergeCookies(attempt.cookies, cookiesFrom(response)) }
      expect(await identityEffects()).toEqual(before)
      expect(await storedLinks(provider)).toEqual(oldLink)
      await expectRefusedCompletion(await complete(staged, { request }))
      expect(await identityEffects()).toEqual(before)
      return staged
    }

    const free = await changedMailbox()
    await setOtherMailbox(assertedMailbox)
    const taken = await changedMailbox()
    const freeMail = await deliverProof(free.id, free.cookies)
    const takenMail = await deliverProof(taken.id, taken.cookies)
    const normalizeMail = (email: typeof freeMail, attemptId: string) => ({
      to: email.to,
      subject: email.subject,
      text: email.text.replace(attemptId, '<attempt>').replace(email.token, '<token>'),
    })
    expect(freeMail.to).toBe(assertedMailbox)
    expect(normalizeMail(freeMail, free.id)).toEqual(normalizeMail(takenMail, taken.id))
    expect((await consumeProof(taken.id, taken.cookies, takenMail.token)).status).toBe(200)
    const collision = await complete(taken, { request })
    expect(collision.status).toBe(409)
    expect(await collision.json()).toEqual({ error: 'sso_email_collision' })
    expect(collision.headers.getSetCookie().join(';')).not.toContain('better-auth.session_token')
    expect(await storedLinks(provider)).toEqual(oldLink)
    expect(await protocolEffects(provider.id)).toEqual([
      expect.not.arrayContaining([expect.objectContaining({ id: taken.id })]),
      expect.any(Array),
    ])

    await setOtherMailbox(account.email)
    expect((await consumeProof(free.id, free.cookies, freeMail.token)).status).toBe(200)
    const completed = await complete(free, { request })
    expect(completed.status).toBe(303)
    expect(completed.headers.get('location')).toBe(returnPath)
    expect(completed.headers.getSetCookie().join(';')).toContain('better-auth.session_token')
    expect(await storedLinks(provider)).toEqual([
      expect.objectContaining({
        id: provider.link.id,
        generation: provider.link.generation + 1,
        subject: provider.subject,
        proven_email: assertedMailbox,
      }),
    ])
    await expectRefusedCompletion(await complete(free, { request }))
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
    const capabilities = productionSsoCapabilities(
      loadConfig({
        DATABASE_URL: owned.url,
        PUBLIC_URL: publicUrl,
        BETTER_AUTH_SECRET: secret,
        SSO_OIDC_ENABLED: 'true',
        SSO_SAML_ENABLED: 'true',
      }),
    )
    const { request: off, json, withMailbox } = management(team.team, capabilities)
    const member = await browserSession(team.member)
    const before = await identityEffects()
    const state = await protocolEffects(provider.id)
    const attemptIds = () => db.selectFrom('sso_attempts').select('id').orderBy('id').execute()
    const attemptsBefore = await attemptIds()
    for (const response of [
      await acs(provider.id, freshResponse.encoded, fresh.relayState, off),
      await off.request(result.location, { headers: { cookie: result.cookies.join('; ') } }),
      await complete(result, { request: off }),
      await json(linkPath(provider), member.cookies, {}),
    ]) {
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'sso_disabled' })
      expect(response.headers.getSetCookie()).toEqual([])
    }
    expect(await identityEffects()).toEqual(before)
    expect(await protocolEffects(provider.id)).toEqual(state)
    expect(await attemptIds()).toEqual(attemptsBefore)

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
    await db
      .insertInto('sso_provider_domains')
      .values({ organization_id: team.team, provider_id: oidc, domain_id: domain.id })
      .execute()
    const oidcStart = await signIn(oidc, off)
    expect(oidcStart.status).toBe(200)
    const { url } = (await oidcStart.json()) as { url: string }
    const authorization = new URL(url)
    expect(authorization.origin + authorization.pathname).toBe(config.authorizationEndpoint)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')

    const oidcLink = await withMailbox(`${providersPath}/${oidc}/link`, member.cookies, {})
    expect(oidcLink.response.status).toBe(200)
    const link = (await oidcLink.response.json()) as { url: string; attemptId: string }
    expect(new URL(link.url).pathname).toBe(authorization.pathname)
    expect(
      await db
        .selectFrom('sso_attempts')
        .select('kind')
        .where('id', '=', link.attemptId)
        .executeTakeFirst(),
    ).toEqual({ kind: 'link' })
  })
})
