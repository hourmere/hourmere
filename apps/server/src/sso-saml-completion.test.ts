import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
  recordSsoAdmissionRemoval,
  type SignupPolicy,
  ssoDelegationStatus,
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
import { type SsoProviderPage, ssoRoutes } from './routes/sso.ts'
import { ssoDelegationRoutes } from './routes/sso-delegation.ts'
import { ssoDomainRoutes } from './routes/sso-domains.ts'
import { ssoDraftRoutes } from './routes/sso-drafts.ts'
import { ssoIdentityRecoveryRoutes } from './routes/sso-link-recovery.ts'
import { ssoPolicyRoutes } from './routes/sso-policy.ts'
import { ssoRecoveryEnrollmentRoutes } from './routes/sso-recovery-enrollment.ts'
import { productionSsoCapabilities } from './server.ts'
import type { SsoCapabilities } from './sso.ts'
import { sealSsoProviderConfiguration } from './sso-configuration.ts'
import { SSO_DELEGATIONS_PATH } from './sso-delegation-proof.ts'
import * as mailboxProofModule from './sso-mailbox-proof.ts'
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
const acceptInvitationPath = '/api/auth/organization/accept-invitation'
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
  forceAuthn: string | null
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
  authnInstant?: string | null
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
    signupPolicy: SignupPolicy = signup,
    database = db,
    removalNotices: string[] = [],
    resolveTxt = async (_name: string): Promise<string[][]> => [],
  ) {
    const deps = {
      db: database,
      capabilities,
      configurationKey,
      session: { secret },
      signup: signupPolicy,
    }
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
        ? createCallerResolver({ auth, db: database })
        : async () => expect.unreachable('SAML completion does not resolve a caller'),
      publicUrl,
      ...(mailboxJobs && {
        routes: [
          ssoRoutes({ db: database, capabilities }),
          ssoDraftRoutes({ ...deps, publicUrl, privateTargets: [] }),
          ssoDomainRoutes({ ...deps, publicUrl, resolveTxt }),
          ssoDelegationRoutes({ ...deps, publicUrl }),
          ssoPolicyRoutes({ ...deps, publicUrl }),
          ssoIdentityRecoveryRoutes({
            ...deps,
            publicUrl,
            notificationQueue: {
              async enqueue(name, payload, options) {
                expect(name).toBe('sso-link-removal-email')
                expect(options.transaction).toMatchObject({ isTransaction: true })
                removalNotices.push(payload.userId)
                return 'link-removal-notice'
              },
            },
          }),
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
        ssoTeamReads: { db: database, capabilities },
        ssoMailboxProof: mailboxProofRoutes({
          db: database,
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
        readSession,
      }),
      ssoSamlSignIn: samlSignInRoutes({ ...deps, readSession }),
    })
  }

  function productionCapabilities(saml?: string, oidc?: string) {
    return productionSsoCapabilities(
      loadConfig({
        DATABASE_URL: owned.url,
        PUBLIC_URL: publicUrl,
        BETTER_AUTH_SECRET: secret,
        SSO_OIDC_ENABLED: oidc,
        SSO_SAML_ENABLED: saml,
      }),
    )
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
    const link = await seedLink(provider, team.member)
    return { ...provider, link }
  }

  async function seedLink(provider: Provider, userId: string, organizationId = team.team) {
    const user = await db
      .selectFrom('auth.user')
      .select('email')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()
    return db
      .insertInto('sso_identity_links')
      .values({
        organization_id: organizationId,
        provider_id: provider.id,
        user_id: userId,
        issuer: provider.issuer,
        subject: provider.subject,
        proven_email: user.email,
        email_proven_at: at(-60),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
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
      forceAuthn: request.getAttribute('ForceAuthn'),
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
      authnInstant,
      signingIdentity,
      responseOnly = false,
    } = options
    const issued = await samlReplay.samlDatabaseNow(db)
    const deadline = issued.add({ seconds: bearerLifetime })
    const sessionDeadline =
      sessionLifetime === undefined ? undefined : issued.add({ seconds: sessionLifetime })
    const sessionBound = sessionDeadline ? ` SessionNotOnOrAfter="${sessionDeadline}"` : ''
    const authnTime = authnInstant === null ? '' : ` AuthnInstant="${authnInstant ?? issued}"`
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
      <saml:AuthnStatement${authnTime}${sessionBound}/>
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

  function requestStepUp(request: App, provider: Provider, attemptId: string, cookies: string[]) {
    return request.request(new URL(startPath, publicUrl), {
      method: 'POST',
      headers: {
        origin: publicUrl,
        cookie: cookies.join('; '),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        providerId: provider.id,
        intent: 'step_up',
        attemptId,
        returnTo: returnPath,
      }),
    })
  }

  async function stepUp(
    request: App,
    provider: Provider,
    attemptId: string,
    cookies: string[],
    options?: SignedResponseOptions,
  ) {
    const attempt = await readStart(
      provider,
      await requestStepUp(request, provider, attemptId, cookies),
      cookies,
    )
    expect(attempt.forceAuthn).toBe('true')
    const signed = await signedResponse(attempt, options)
    const result = await pending(
      await acs(provider.id, signed.encoded, attempt.relayState, request),
      attempt,
    )
    const completed = await complete(result, { request })
    expect(completed.status).toBe(303)
    expect(completed.headers.get('location')).toBe(returnPath)
    expect(
      cookiesFrom(completed).some((cookie) => cookie.includes('better-auth.session_token')),
    ).toBe(false)
    return { cookies: mergeCookies(result.cookies, cookiesFrom(completed)) }
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

  function management(
    organizationId = team.team,
    capabilities: SsoCapabilities = samlOnly,
    signupPolicy: SignupPolicy = signup,
    resolveTxt?: (name: string) => Promise<string[][]>,
  ) {
    const jobs: MailboxProofEmailPayload[] = []
    const removalNotices: string[] = []
    const request = instance(capabilities, jobs, signupPolicy, db, removalNotices, resolveTxt)
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

    return {
      request,
      json,
      jobs,
      removalNotices,
      deliverProof,
      consumeProof,
      mailboxProof,
      withMailbox,
    }
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
  const removeLinkPath = (provider: Provider, linkId: string) =>
    `${providersPath}/${provider.id}/links/${linkId}`

  async function me(request: App, cookies: string[]) {
    const response = await request.request(new URL('/api/v1/me', publicUrl), {
      headers: { cookie: cookies.join('; ') },
    })
    expect(response.status).toBe(200)
    return (await response.json()) as {
      organization: { id: string; name: string }
      sso: Record<string, unknown>
    }
  }

  async function providerInventory(request: App, cookies: string[]) {
    const response = await request.request(new URL(providersPath, publicUrl), {
      headers: { cookie: cookies.join('; ') },
    })
    expect(response.status).toBe(200)
    return (await response.json()) as ReturnType<typeof SsoProviderPage.parse>
  }

  const identityLink = (linkId: string) =>
    db
      .selectFrom('sso_identity_links')
      .selectAll()
      .where('id', '=', linkId)
      .executeTakeFirstOrThrow()

  const linkAudit = (id: string) =>
    db
      .selectFrom('audit_events')
      .select(['actor_id', 'action', 'details'])
      .where('target_id', '=', id)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute()

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

  async function completeLinkedSignIn(provider: Provider, request: App) {
    const attempt = await readStart(provider, await signIn(provider.id, request))
    const signed = await signedResponse(attempt)
    const result = await pending(
      await acs(provider.id, signed.encoded, attempt.relayState, request),
      attempt,
    )
    const response = await complete(result, { request })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(returnPath)
    return response
  }

  describe('SAML step-up ceremony', () => {
    const domainsPath = '/api/v1/team/sso/domains'

    async function oidcTeamSession(
      fixture: SsoFixture,
      claim: { id: string; generation: number },
      ownerMailbox: string,
    ) {
      const oidc = await db
        .insertInto('sso_providers')
        .values({ ...oidcProviderValues(fixture.team), enabled: true })
        .returning(['id', 'issuer'])
        .executeTakeFirstOrThrow()
      await db
        .insertInto('sso_provider_domains')
        .values({ organization_id: fixture.team, provider_id: oidc.id, domain_id: claim.id })
        .execute()
      const link = await seedLink(
        { ...oidc, subject: `oidc-${randomUUID()}`, mailbox: ownerMailbox },
        fixture.owner,
        fixture.team,
      )
      const session = await browserSession(fixture.owner, fixture.team)
      await db
        .insertInto('sso_browser_proofs')
        .values({
          organization_id: fixture.team,
          user_id: fixture.owner,
          member_id: fixture.ownerMember,
          session_id: session.id,
          provider_id: oidc.id,
          link_id: link.id,
          link_generation: link.generation,
          trust_generation: 1,
          domain_id: claim.id,
          domain_generation: claim.generation,
          expires_at: at(300),
        })
        .execute()
      return session.cookies
    }

    async function setup(browserProofProtocol: 'saml' | 'oidc' = 'saml') {
      const fixture = await seedTeam()
      const name = `saml-proof-${randomUUID()}.example.com`
      const ownerMailbox = `owner@${name}`
      await db
        .updateTable('auth.user')
        .set({ email: ownerMailbox })
        .where('id', '=', fixture.owner)
        .execute()
      const claim = await db
        .insertInto('sso_domains')
        .values(claimedDomainValues(fixture.team, name))
        .returning(['id', 'generation'])
        .executeTakeFirstOrThrow()
      const provider = await enabledProvider({
        organizationId: fixture.team,
        domainId: claim.id,
        assertedMailbox: ownerMailbox,
      })
      const link = await seedLink(provider, fixture.owner, fixture.team)
      const useOidcBrowserProof = browserProofProtocol === 'oidc'
      const manager = management(fixture.team, { ...samlOnly, ssoOidcEnabled: useOidcBrowserProof })
      const browser = useOidcBrowserProof
        ? await oidcTeamSession(fixture, claim, ownerMailbox)
        : cookiesFrom(await completeLinkedSignIn(provider, manager.request))
      await db
        .insertInto('sso_policies')
        .values({ organization_id: fixture.team, require_sso: true })
        .execute()
      async function challenge() {
        const body = { domain: `challenge-${randomUUID()}.example.com` }
        const response = await manager.json(domainsPath, browser, body)
        expect(response.status).toBe(403)
        const { attemptId, proofMethods } = (await response.json()) as {
          attemptId: string
          proofMethods: string[]
        }
        expect(proofMethods).toEqual(['sso'])
        return { body, attemptId, cookies: mergeCookies(browser, cookiesFrom(response)) }
      }
      return { fixture, claim, manager, provider, link, challenge }
    }

    const readProof = (id: string) =>
      db
        .selectFrom('sso_attempts')
        .select([
          'step_up_link_id',
          'step_up_provider_id',
          'step_up_authenticated_at',
          'step_up_proof_expires_at',
          'requires_mailbox',
          'mailbox_proven_at',
          'consumed_at',
        ])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()

    it.each([
      { boundary: 'just inside', offsetMs: -1 },
      { boundary: 'just outside', offsetMs: 1 },
    ])('checks a signed AuthnInstant $boundary the future skew limit', async ({ offsetMs }) => {
      const { manager, provider, link, challenge } = await setup()
      const { request } = manager
      const write = await challenge()
      const attempt = await readStart(
        provider,
        await requestStepUp(request, provider, write.attemptId, write.cookies),
        write.cookies,
      )
      const now = Temporal.Instant.fromEpochMilliseconds(
        (await samlReplay.samlDatabaseNow(db)).epochMilliseconds,
      )
      const authnInstant = now.add({ milliseconds: samlClockSkew * 1000 + offsetMs })
      const signed = await signedResponse(attempt, { authnInstant: authnInstant.toString() })
      // Pin the ACS receipt time so handler latency cannot move it across the boundary.
      const clock = vi.spyOn(samlReplay, 'samlDatabaseNow').mockResolvedValue(now)
      const response = await acs(provider.id, signed.encoded, attempt.relayState, request)
      clock.mockRestore()

      if (offsetMs > 0) {
        expectRefusedAcs(response)
        expect(await readProof(write.attemptId)).toMatchObject({
          step_up_authenticated_at: null,
          step_up_link_id: null,
          consumed_at: null,
        })
        return
      }

      const result = await pending(response, attempt)
      const completed = await complete(result, { request })
      expect(completed.status).toBe(303)
      expect(completed.headers.get('location')).toBe(returnPath)
      expect(await readProof(write.attemptId)).toMatchObject({
        step_up_authenticated_at: new Date(authnInstant.epochMilliseconds),
        step_up_link_id: link.id,
        requires_mailbox: false,
      })
    })

    it.each(['fresh', 'missing', 'old'] as const)(
      'uses signed %s AuthnInstant for the original challenge and creates no identity state',
      async (time) => {
        const { manager, provider, link, challenge } = await setup()
        const write = await challenge()
        const now = await samlReplay.samlDatabaseNow(db)
        const authnInstant =
          time === 'missing'
            ? null
            : time === 'old'
              ? now.subtract({ seconds: samlClockSkew + 10 }).toString()
              : now.toString()
        const before = await identityEffects()
        const { cookies } = await stepUp(
          manager.request,
          provider,
          write.attemptId,
          write.cookies,
          { authnInstant },
        )
        const stored = await readProof(write.attemptId)
        expect(stored).toMatchObject({
          step_up_link_id: link.id,
          step_up_provider_id: provider.id,
          step_up_authenticated_at:
            time === 'fresh' ? new Date(now.epochMilliseconds) : expect.any(Date),
          step_up_proof_expires_at: expect.any(Date),
          requires_mailbox: time !== 'fresh',
          mailbox_proven_at: null,
          consumed_at: null,
        })
        expect(await identityEffects()).toEqual(before)
        const retry = () =>
          manager.json(domainsPath, cookies, { ...write.body, proofAttemptId: write.attemptId })
        if (time !== 'fresh') {
          const pendingMailbox = await retry()
          expect(pendingMailbox.status).toBe(403)
          expect(await pendingMailbox.json()).toMatchObject({
            error: 'sso_reauthentication_required',
            attemptId: write.attemptId,
            proofMethods: ['mailbox'],
          })
          const { token } = await manager.deliverProof(write.attemptId, cookies)
          expect((await manager.consumeProof(write.attemptId, cookies, token)).status).toBe(200)
        }
        expect((await retry()).status).toBe(201)
        expect((await readProof(write.attemptId)).consumed_at).toBeInstanceOf(Date)
      },
    )

    it('refuses a different user, browser, provider or subject and validates replay across requests', async () => {
      const { fixture, claim, manager, provider, link, challenge } = await setup()
      const { request } = manager
      const write = await challenge()
      const otherProvider = await enabledProvider({
        organizationId: fixture.team,
        domainId: claim.id,
      })
      const otherSubject = { ...provider, subject: `other-${randomUUID()}` }
      await seedLink(otherSubject, fixture.member, fixture.team)
      const other = await browserSession(fixture.member, fixture.team)
      const wrongUser = mergeCookies(write.cookies, other.cookies)
      const wrongBrowser = mergeCookies(write.cookies, [
        `${bindingCookie}=${randomBytes(32).toString('base64url')}`,
      ])
      for (const [candidate, cookies] of [
        [provider, wrongUser],
        [provider, wrongBrowser],
        [otherProvider, write.cookies],
      ] as const) {
        const refused = await requestStepUp(request, candidate, write.attemptId, cookies)
        expect(refused.status).toBe(404)
        expect(await refused.json()).toEqual({ error: 'sso_not_found' })
      }
      const startAttempt = async () =>
        readStart(
          provider,
          await requestStepUp(request, provider, write.attemptId, write.cookies),
          write.cookies,
        )
      const first = await startAttempt()
      const wrong = await signedResponse(first, { subject: otherSubject.subject })
      expectRefusedAcs(await acs(otherProvider.id, wrong.encoded, first.relayState, request))
      const before = await identityEffects()
      const wrongResult = await pending(
        await acs(provider.id, wrong.encoded, first.relayState, request),
        first,
      )
      await expectRefusedCompletion(await complete(wrongResult, { request }))
      expect((await readProof(write.attemptId)).step_up_link_id).toBeNull()

      const valid = await startAttempt()
      const signed = await signedResponse(valid)
      const result = await pending(
        await acs(provider.id, signed.encoded, valid.relayState, request),
        valid,
      )
      expect((await readProof(write.attemptId)).step_up_link_id).toBeNull()
      await expectRefusedCompletion(
        await complete(result, { request, cookies: mergeCookies(result.cookies, other.cookies) }),
      )
      await expectRefusedCompletion(
        await complete(result, { request, cookies: mergeCookies(result.cookies, wrongBrowser) }),
      )
      const replay = await startAttempt()
      const reusedAssertion = await signedResponse(replay, { assertionId: signed.assertionId })
      expectRefusedAcs(await acs(provider.id, reusedAssertion.encoded, replay.relayState, request))
      expect((await readProof(write.attemptId)).step_up_link_id).toBeNull()
      expect((await complete(result, { request })).status).toBe(303)
      await expectRefusedCompletion(await complete(result, { request }))
      expect((await readProof(write.attemptId)).step_up_link_id).toBe(link.id)
      expect(await identityEffects()).toEqual(before)
    })

    it('leaves an in-flight SAML step-up and replay cache untouched while the SAML setting is off', async () => {
      const {
        manager: { request },
        provider,
        challenge,
      } = await setup()
      const write = await challenge()
      const attempt = await readStart(
        provider,
        await requestStepUp(request, provider, write.attemptId, write.cookies),
        write.cookies,
      )
      const assertion = await signedResponse(attempt)
      const result = await pending(
        await acs(provider.id, assertion.encoded, attempt.relayState, request),
        attempt,
      )
      const off = instance(productionCapabilities('', 'true'))
      const before = await protocolEffects(provider.id)
      const effects = await identityEffects()
      const proof = await readProof(write.attemptId)
      for (const response of [
        await requestStepUp(off, provider, write.attemptId, write.cookies),
        await acs(provider.id, assertion.encoded, attempt.relayState, off),
        await complete(result, { request: off }),
      ]) {
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'sso_disabled' })
        expect(response.headers.getSetCookie()).toEqual([])
      }
      expect(await protocolEffects(provider.id)).toEqual(before)
      expect(await identityEffects()).toEqual(effects)
      expect(await readProof(write.attemptId)).toEqual(proof)
    })

    it('requires new step-up for a protected write while its recorded SAML protocol is off', async () => {
      // Keep ordinary team access through OIDC while exercising the separate fresh-proof gate.
      const { fixture, manager, provider, link, challenge } = await setup('oidc')
      const write = await challenge()
      const { cookies } = await stepUp(manager.request, provider, write.attemptId, write.cookies)
      const proof = await readProof(write.attemptId)
      expect(proof).toMatchObject({
        step_up_link_id: link.id,
        step_up_provider_id: provider.id,
        requires_mailbox: false,
        consumed_at: null,
      })
      const off = management(fixture.team, {
        ssoOidcEnabled: true,
        ssoSamlEnabled: false,
        ssoOperatorSetting: true,
      })
      const input = { ...write.body, proofAttemptId: write.attemptId }
      const refused = await off.json(domainsPath, cookies, input)
      expect(refused.status).toBe(403)
      const replacement = (await refused.json()) as { attemptId: string }
      expect(replacement).toMatchObject({
        error: 'sso_reauthentication_required',
        attemptId: expect.any(String),
        proofMethods: ['sso'],
      })
      expect(replacement.attemptId).not.toBe(write.attemptId)
      expect(await readProof(write.attemptId)).toEqual(proof)
      expect(
        await db
          .selectFrom('sso_domains')
          .select('id')
          .where('organization_id', '=', fixture.team)
          .where('name', '=', write.body.domain)
          .executeTakeFirst(),
      ).toBeUndefined()
    })
  })

  describe('SAML fresh administration', () => {
    const domainsPath = '/api/v1/team/sso/domains'

    it.each([
      ['create provider', 'POST', 201],
      ['update provider', 'PATCH', 200],
      ['delete provider', 'DELETE', 200],
      ['activate provider', 'POST', 200],
      ['deactivate provider', 'POST', 200],
      ['test provider', 'POST', 200],
      ['challenge domain', 'POST', 201],
      ['verify domain', 'POST', 200],
      ['delete domain', 'DELETE', 200],
      ['set policy', 'PUT', 200],
      ['nominate recovery owner', 'POST', 201],
    ] as const)('requires a signed SAML step-up to %s', async (operation, method, status) => {
      const fixture = await seedTeam()
      const organizationId = fixture.team
      const name = `step-up-${randomUUID()}.example.com`
      const ownerMailbox = `owner@${name}`
      await db
        .updateTable('auth.user')
        .set({ email: ownerMailbox })
        .where('id', '=', fixture.owner)
        .execute()
      const claim = await db
        .insertInto('sso_domains')
        .values(claimedDomainValues(organizationId, name))
        .returning('id')
        .executeTakeFirstOrThrow()
      const provider = await enabledProvider({
        organizationId,
        domainId: claim.id,
        assertedMailbox: ownerMailbox,
      })
      const link = await seedLink(provider, fixture.owner, organizationId)
      const records = new Map<string, string>()
      const admin = management(organizationId, samlOnly, signup, async (name) => {
        const value = records.get(name)
        return value ? [[value]] : []
      })
      const browser = cookiesFrom(await completeLinkedSignIn(provider, admin.request))
      const draft =
        operation === 'deactivate provider'
          ? await enabledProvider({ organizationId, domainId: claim.id })
          : await samlDraft(organizationId)
      const providerPath = `${providersPath}/${draft.id}`
      const revision = { expectedRevision: 1 }
      const generation = { expectedGeneration: 1 }
      const domainName = `new-${randomUUID()}.example.com`
      let targetDomain = domain.id
      if (operation === 'activate provider') {
        const { response, cookies } = await admin.withMailbox(
          `${providerPath}/test`,
          browser,
          revision,
        )
        await finishProviderTest(admin.request, await readStart(draft, response, cookies))
        await db
          .insertInto('sso_provider_domains')
          .values({
            organization_id: organizationId,
            domain_id: claim.id,
            provider_id: draft.id,
          })
          .execute()
      }
      if (operation === 'verify domain' || operation === 'delete domain') {
        const { response } = await admin.withMailbox(domainsPath, browser, { domain: domainName })
        expect(response.status).toBe(201)
        const challenge = (await response.json()) as {
          domain: { id: string }
          txtName: string
          txtValue: string
        }
        targetDomain = challenge.domain.id
        records.set(challenge.txtName, challenge.txtValue)
      }
      const targets = {
        'create provider': [
          providersPath,
          {
            protocol: 'saml',
            displayName: 'SAML draft after step-up',
            domainIds: [],
            saml: {
              entityId: `https://login.example.com/${randomUUID()}`,
              ssoUrl: ssoEndpoint,
              signingCertificates: [idp.pem],
            },
          },
        ],
        'update provider': [providerPath, { ...revision, displayName: 'Updated SAML draft' }],
        'delete provider': [providerPath, revision],
        'activate provider': [`${providerPath}/activation`, { ...revision, enabled: true }],
        'deactivate provider': [`${providerPath}/activation`, { ...revision, enabled: false }],
        'test provider': [`${providerPath}/test`, revision],
        'challenge domain': [domainsPath, { domain: domainName }],
        'verify domain': [`${domainsPath}/${targetDomain}/verify`, generation],
        'delete domain': [`${domainsPath}/${targetDomain}`, generation],
        'set policy': [
          '/api/v1/team/sso/policy',
          { ...revision, requireSso: false, admission: 'invitation_only' },
        ],
        'nominate recovery owner': [
          '/api/v1/team/sso/recovery',
          { ...revision, ownerUserId: fixture.coOwner },
        ],
      } as const
      const [path, input] = targets[operation]
      const write = (cookies: string[], proofAttemptId?: string) =>
        admin.json(path, cookies, { ...input, ...(proofAttemptId && { proofAttemptId }) }, method)
      const mailbox = await admin.mailboxProof(await write(browser), browser)
      await db
        .insertInto('sso_policies')
        .values({ organization_id: organizationId, require_sso: true })
        .execute()
      const refusedMailbox = await write(mailbox.cookies, mailbox.attemptId)
      expect(refusedMailbox.status).toBe(403)
      const challenge = (await refusedMailbox.json()) as { attemptId: string }
      expect(challenge).toMatchObject({
        error: 'sso_reauthentication_required',
        proofMethods: ['sso'],
      })
      expect(challenge.attemptId).not.toBe(mailbox.attemptId)
      const { cookies } = await stepUp(
        admin.request,
        provider,
        challenge.attemptId,
        mailbox.cookies,
      )
      expect((await write(cookies, challenge.attemptId)).status).toBe(status)
      const readAttempt = (id: string) =>
        db
          .selectFrom('sso_attempts')
          .select(['consumed_at', 'step_up_link_id'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      expect(await readAttempt(mailbox.attemptId)).toEqual({
        consumed_at: null,
        step_up_link_id: null,
      })
      expect(await readAttempt(challenge.attemptId)).toEqual({
        consumed_at: expect.any(Date),
        step_up_link_id: link.id,
      })
    })
  })

  async function stageMailbox(request: App, provider: Provider, options?: SignedResponseOptions) {
    const attempt = await readStart(provider, await signIn(provider.id, request))
    const signed = await signedResponse(attempt, options)
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
    const cookies = mergeCookies(attempt.cookies, cookiesFrom(response))
    return { id, location, cookies, response }
  }

  type PendingMailbox = Awaited<ReturnType<typeof stageMailbox>>

  async function proveMailbox(
    { deliverProof, consumeProof }: ReturnType<typeof management>,
    { id, cookies }: PendingMailbox,
  ) {
    const { token } = await deliverProof(id, cookies)
    expect((await consumeProof(id, cookies, token)).status).toBe(200)
  }

  function acceptInvitation(
    request: App,
    pending: PendingMailbox,
    invitationId: string,
    cookies = pending.cookies,
  ) {
    return request.request(new URL(acceptInvitationPath, publicUrl), {
      method: 'POST',
      headers: {
        origin: publicUrl,
        'content-type': 'application/json',
        'X-Hourmere-Sso-Attempt': pending.id,
        cookie: cookies.filter((cookie) => !cookie.includes('hourmere.saml_return.')).join('; '),
      },
      body: JSON.stringify({ invitationId }),
    })
  }

  async function invite(
    fixture: SsoFixture,
    email: string,
    changes: {
      organizationId?: string
      inviterId?: string
      expiresAt?: string
      role?: string
    } = {},
  ) {
    const { id } = await db
      .insertInto('auth.invitation')
      .values({
        organizationId: fixture.team,
        inviterId: fixture.owner,
        role: 'member',
        status: 'pending',
        expiresAt: at(300),
        email,
        ...changes,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return id
  }

  it('requires independent mailbox proof and explicit consent in the original SAML linking browser and session', async () => {
    const provider = await enabledProvider()
    const { request, json, mailboxProof } = management()
    const member = await browserSession(team.member)
    const otherSession = await browserSession(team.member)
    const otherMember = await browserSession(team.admin)
    const ownSso = async (cookies: string[], application = request) =>
      (await me(application, cookies)).sso
    const before = await identityEffects()
    const challenge = await json(linkPath(provider), member.cookies, {})
    expect(await protocolEffects(provider.id)).toEqual([[], []])
    expect(await identityEffects()).toEqual(before)
    expect(await ownSso(mergeCookies(member.cookies, cookiesFrom(challenge)))).toMatchObject({
      attempts: [{ phase: 'fresh_proof', mailboxProven: false }],
    })
    const proof = await mailboxProof(challenge, member.cookies)
    const attempt = await readStart(
      provider,
      await json(linkPath(provider), proof.cookies, { proofAttemptId: proof.attemptId }),
      proof.cookies,
    )
    const authorizationId = attempt.requestId.slice(1)
    const authorizationSummary = await ownSso(attempt.cookies)
    expect(authorizationSummary).toMatchObject({
      providers: expect.arrayContaining([
        { id: provider.id, revision: 1, displayName: 'Synthetic AD FS', protocol: 'saml' },
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
    const localized = await request.request(staged.location, {
      headers: {
        cookie: [...staged.cookies, 'hourmere-language=fr'].join('; '),
        'accept-language': 'en',
      },
    })
    expect(localized.status).toBe(200)
    expect(localized.headers.get('vary')).toBe('Accept-Language, Cookie')
    const localizedForm = await localized.text()
    expect(localizedForm).toContain('<html lang="fr">')
    expect(localizedForm).toContain('<button type="submit">Associer le compte</button>')
    expect(await identityEffects()).toEqual(beforeConsent)
    expect(await storedLinks(provider)).toEqual([])
    expect(await ownSso(staged.cookies)).toMatchObject({
      attempts: [
        { id: staged.id, providerId: provider.id, phase: 'completion', mailboxProven: true },
      ],
    })
    const off = management(team.team, { ssoOidcEnabled: true, ssoSamlEnabled: false }).request
    expect(await ownSso(staged.cookies, off)).toMatchObject({ providers: [], attempts: [] })
    const wrongBrowser = mergeCookies(staged.cookies, [
      `${bindingCookie}=${randomBytes(32).toString('base64url')}`,
    ])
    const wrongSession = mergeCookies(staged.cookies, otherSession.cookies)
    const wrongUser = mergeCookies(staged.cookies, otherMember.cookies)
    for (const cookies of [wrongBrowser, wrongSession, wrongUser]) {
      expect(await ownSso(cookies)).toMatchObject({ attempts: [] })
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
    const summary = await ownSso(staged.cookies)
    expect(summary).toMatchObject({
      attempts: [],
      links: [{ id: link?.id, generation: 1, providerId: provider.id }],
      proofs: [],
    })
    expect(JSON.stringify(summary)).not.toContain(provider.subject)
    expect(JSON.stringify(summary)).not.toContain(mailbox)
    expect(await ownSso(wrongUser)).toMatchObject({ links: [], attempts: [] })
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

  it('refuses SAML provider trust additions while the SAML setting is off and OIDC is on', async () => {
    const saml = await samlDraft(team.team)
    const oidc = await db
      .insertInto('sso_providers')
      .values(oidcProviderValues(team.team))
      .returning('id')
      .executeTakeFirstOrThrow()
    const owner = await browserSession(team.owner)
    const { json } = management(team.team, productionCapabilities('false', 'true'))
    const before = await protocolEffects(saml.id)
    const path = `${providersPath}/${saml.id}`
    const signing = { signingCertificates: [rotatedIdp.pem] }
    for (const response of [
      await json(providersPath, owner.cookies, {
        protocol: 'saml',
        displayName: 'Disabled fixture',
        domainIds: [],
        saml: signing,
      }),
      await json(path, owner.cookies, { expectedRevision: 1, saml: signing }, 'PATCH'),
      await json(path, owner.cookies, { expectedRevision: 1, displayName: 'Still off' }, 'PATCH'),
      await json(`${path}/test`, owner.cookies, { expectedRevision: 1 }),
      await json(`${path}/activation`, owner.cookies, { expectedRevision: 1, enabled: true }),
    ]) {
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'sso_disabled' })
    }
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

  it('retains mailbox recovery and trust reductions for an enforced SAML team with both settings off', async () => {
    const fixture = await seedTeam()
    const claim = await db
      .insertInto('sso_domains')
      .values(claimedDomainValues(fixture.team))
      .returning(['id', 'generation'])
      .executeTakeFirstOrThrow()
    const provider = await enabledProvider({ organizationId: fixture.team, domainId: claim.id })
    const owner = await browserSession(fixture.owner, fixture.team)
    const off = management(fixture.team, productionCapabilities())
    await db.insertInto('sso_recovery_owners').values(recoveryOwnerValues(fixture)).execute()
    await db
      .insertInto('sso_policies')
      .values({ organization_id: fixture.team, require_sso: true })
      .execute()
    const providerPath = `${providersPath}/${provider.id}`
    const revision = { expectedRevision: 1 }
    const blocked = await off.json(providerPath, owner.cookies, revision, 'DELETE')
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toEqual({ error: 'sso_required' })
    const { response: grant, cookies } = await off.withMailbox(
      recoveryUsePath,
      owner.cookies,
      revision,
    )
    expect(grant.status).toBe(204)
    expect(await providerInventory(off.request, cookies)).toMatchObject({
      data: [{ id: provider.id, protocol: 'saml', enabled: true }],
    })
    const policyPath = '/api/v1/team/sso/policy'
    const disabled = await off.json(
      policyPath,
      cookies,
      {
        ...revision,
        requireSso: false,
        admission: 'invitation_only',
      },
      'PUT',
    )
    expect(disabled.status).toBe(200)
    expect(await disabled.json()).toMatchObject({ requireSso: false, policyRevision: 2 })

    const oidcOn = management(fixture.team, productionCapabilities('false', 'true'))
    const cannotEnforce = await oidcOn.json(
      policyPath,
      owner.cookies,
      {
        expectedRevision: 2,
        requireSso: true,
        admission: 'invitation_only',
      },
      'PUT',
    )
    expect(cannotEnforce.status).toBe(404)
    expect(await cannotEnforce.json()).toEqual({ error: 'sso_disabled' })
    const deactivation = await off.withMailbox(`${providerPath}/activation`, owner.cookies, {
      ...revision,
      enabled: false,
    })
    expect(deactivation.response.status).toBe(200)
    expect(await deactivation.response.json()).toMatchObject({ provider: { enabled: false } })
    expect(
      (await off.withMailbox(providerPath, owner.cookies, revision, 'DELETE')).response.status,
    ).toBe(200)
    expect(
      (
        await off.withMailbox(
          `/api/v1/team/sso/domains/${claim.id}`,
          owner.cookies,
          {
            expectedGeneration: claim.generation,
          },
          'DELETE',
        )
      ).response.status,
    ).toBe(200)
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

  it('refuses an unstable subject, a different NameID scope or an unverified mailbox domain', async () => {
    const provider = await linkedProvider()
    const before = await identityEffects()
    for (const options of [
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
      const staged = await stageMailbox(request, provider, { mailbox: assertedMailbox })
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

  it.each([
    { flow: 'changed SAML mailbox', phase: 'before the pending insert' },
    { flow: 'changed SAML mailbox', phase: 'during the pending insert' },
    { flow: 'SAML admission', phase: 'during the pending insert' },
  ])(
    'classifies a $flow deadline hit $phase as attempt_expired and rolls back the callback',
    async ({ flow, phase }) => {
      const provider = flow === 'SAML admission' ? await enabledProvider() : await linkedProvider()
      const attempt = await start(provider)
      const before = await identityEffects()
      const state = await protocolEffects(provider.id)
      const waitInInsert = phase === 'during the pending insert'
      if (waitInInsert) {
        // Run before the installed attempt guard, which must refuse the now-expired write.
        await sql`
          CREATE SEQUENCE test_saml_pending_insert;
          CREATE FUNCTION test_wait_for_saml_pending_expiry() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.requires_mailbox THEN
              PERFORM nextval('test_saml_pending_insert');
              PERFORM pg_sleep_until(NEW.expires_at);
            END IF;
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER a_test_wait_for_saml_pending_expiry
          BEFORE INSERT ON sso_attempts FOR EACH ROW
          EXECUTE FUNCTION test_wait_for_saml_pending_expiry();
        `.execute(db)
      }
      try {
        const signed = await signedResponse(attempt, {
          mailbox: `deadline-${randomUUID()}@${verifiedDomain}`,
          sessionLifetime: waitInInsert ? 2 : 60,
        })
        if (!waitInInsert) {
          if (!signed.sessionDeadline) expect.unreachable('Expected a signed session deadline')
          vi.spyOn(mailboxProofModule, 'databaseClock').mockResolvedValueOnce(
            signed.sessionDeadline.toString(),
          )
        }
        expectRefusedAcs(await acs(provider.id, signed.encoded, attempt.relayState))
        if (waitInInsert) {
          // Sequence changes survive rollback, so an earlier refusal cannot satisfy this case.
          const { rows } = await sql<{ is_called: boolean }>`
            SELECT is_called FROM test_saml_pending_insert
          `.execute(db)
          expect(rows).toEqual([{ is_called: true }])
        }
      } finally {
        if (waitInInsert)
          await sql`
            DROP TRIGGER a_test_wait_for_saml_pending_expiry ON sso_attempts;
            DROP FUNCTION test_wait_for_saml_pending_expiry();
            DROP SEQUENCE test_saml_pending_insert;
          `.execute(db)
      }
      expect(await identityEffects()).toEqual(before)
      expect(await protocolEffects(provider.id)).toEqual(state)
      const failure = await db
        .selectFrom('audit_events')
        .select(['details'])
        .where('action', '=', 'sso_authentication.failed')
        .where('target_id', '=', provider.id)
        .executeTakeFirstOrThrow()
      expect(failure.details).toMatchObject({
        method: 'saml',
        reason: 'attempt_expired',
        correlationId: attempt.requestId.slice(1),
      })
    },
  )

  it('gives unlinked SAML subjects the same mailbox handoff with or without an existing account', async () => {
    const email = `unlinked-${randomUUID()}@${verifiedDomain}`
    const provider = await enabledProvider({ assertedMailbox: email })
    const fixture = await seedTeam()
    const { request, jobs, deliverProof, consumeProof } = management()
    const before = await identityEffects()
    const free = await stageMailbox(request, provider)
    await db.updateTable('auth.user').set({ email }).where('id', '=', fixture.otherOwner).execute()
    const existing = await stageMailbox(request, provider)

    async function publicOutcome({ id, response }: PendingMailbox) {
      const setCookie = response.headers.getSetCookie()[0] ?? ''
      expect(setCookie).toMatch(/^__Secure-hourmere\.saml_admission\./)
      expect(setCookie).toContain('Path=/api/auth;')
      expect(setCookie).toContain('HttpOnly; Secure; SameSite=Strict')
      return {
        status: response.status,
        body: await response.text(),
        location: response.headers.get('location')?.replace(id, '<attempt>'),
        contentType: response.headers.get('content-type'),
        cacheControl: response.headers.get('cache-control'),
        referrerPolicy: response.headers.get('referrer-policy'),
        cookieOptions: setCookie
          .slice(setCookie.indexOf(';'))
          .replace(/Expires=[^;]+/i, 'Expires=DATE'),
      }
    }
    expect(await publicOutcome(free)).toEqual(await publicOutcome(existing))
    expect(jobs).toEqual([])
    for (const result of [free, existing])
      await expectRefusedCompletion(await complete(result, { request }))
    expect(await identityEffects()).toEqual(before)

    const freeMail = await deliverProof(free.id, free.cookies)
    const existingMail = await deliverProof(existing.id, existing.cookies)
    const message = (email: typeof freeMail, id: string) => ({
      to: email.to,
      subject: email.subject,
      text: email.text.replaceAll(id, '<attempt>').replaceAll(email.token, '<token>'),
    })
    expect(freeMail.to).toBe(email)
    expect(message(freeMail, free.id)).toEqual(message(existingMail, existing.id))
    for (const [pending, proof] of [
      [free, freeMail],
      [existing, existingMail],
    ] as const) {
      expect((await consumeProof(pending.id, pending.cookies, proof.token)).status).toBe(200)
      const completed = await complete(pending, { request })
      expect(completed.status).toBe(200)
      expect(await completed.json()).toEqual({ status: 'link_required' })
      expect(completed.headers.getSetCookie().join(';')).not.toContain('better-auth.session_token')
      await expectRefusedCompletion(await complete(pending, { request }))
    }
    expect(await identityEffects()).toEqual({
      ...before,
      mailboxTokens: String(Number(before.mailboxTokens) + 2),
    })
    expect(await storedLinks(provider)).toEqual([])
    expect(
      await db.selectFrom('auth.user').select('id').where('email', '=', email).execute(),
    ).toEqual([{ id: fixture.otherOwner }])
  })

  async function jitFixture() {
    const fixture = await seedTeam()
    const name = `jit-${randomUUID()}.example.com`
    const claim = await db
      .insertInto('sso_domains')
      .values(claimedDomainValues(fixture.team, name))
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('sso_policies')
      .values({ organization_id: fixture.team, admission: 'jit' })
      .execute()
    const provider = await enabledProvider({
      organizationId: fixture.team,
      domainId: claim.id,
      assertedMailbox: `admit@${name}`,
    })
    return { fixture, provider }
  }

  it('admits a proved SAML subject through JIT once in its original browser with open signup', async () => {
    const { fixture, provider } = await jitFixture()
    const manager = management(fixture.team)
    const { request } = manager
    const result = await stageMailbox(request, provider)
    await proveMailbox(manager, result)
    const before = await identityEffects()
    const beforeAttempts = await protocolEffects(provider.id)
    const wrongBrowser = mergeCookies(result.cookies, [
      `${bindingCookie}=${randomBytes(32).toString('base64url')}`,
    ])
    await expectRefusedCompletion(await complete(result, { request, cookies: wrongBrowser }))
    const closed = instance(samlOnly, undefined, { mode: 'closed', allowedDomains: [] })
    const denied = await complete(result, { request: closed })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'signup_disabled' })
    expect(denied.headers.getSetCookie()).toEqual([])
    expect(await identityEffects()).toEqual(before)
    expect(await protocolEffects(provider.id)).toEqual(beforeAttempts)

    const attempts = await Promise.all([
      complete(result, { request }),
      complete(result, { request }),
    ])
    expect(attempts.map(({ status }) => status).sort()).toEqual([303, 400])
    const success = attempts.find((response) => response.status === 303)
    const refused = attempts.find((response) => response.status === 400)
    if (!success || !refused) expect.unreachable('One JIT completion should succeed')
    expect(success.headers.get('location')).toBe(returnPath)
    await expectRefusedCompletion(refused)
    const session = cookiesFrom(success).find((cookie) => cookie.includes('session_token='))
    if (!session) expect.unreachable('JIT admission should issue a session')
    const login = await auth.api.getSession({
      headers: new Headers({ cookie: session }),
      query: { disableRefresh: true, disableCookieCache: true },
    })
    if (!login) expect.unreachable('JIT admission should create a valid session')
    expect(login.user).toMatchObject({ email: provider.mailbox, emailVerified: true })
    expect(login.session).toMatchObject({ activeOrganizationId: fixture.team })
    expect(await storedLinks(provider)).toEqual([
      expect.objectContaining({
        user_id: login.user.id,
        issuer: provider.issuer,
        subject: provider.subject,
        proven_email: provider.mailbox,
      }),
    ])
    expect(
      await db
        .selectFrom('sso_browser_proofs')
        .select(['user_id', 'session_id'])
        .where('provider_id', '=', provider.id)
        .execute(),
    ).toEqual([{ user_id: login.user.id, session_id: login.session.id }])
    expect(
      await db
        .selectFrom('auth.member as member')
        .leftJoin(
          'personal_organizations as personal',
          'personal.organization_id',
          'member.organizationId',
        )
        .select(['member.organizationId', 'member.role', 'personal.user_id'])
        .where('member.userId', '=', login.user.id)
        .orderBy('member.role')
        .execute(),
    ).toEqual([
      { organizationId: fixture.team, role: 'member', user_id: null },
      { organizationId: expect.any(String), role: 'owner', user_id: login.user.id },
    ])
    const events = await db
      .selectFrom('audit_events')
      .select(['action', 'details'])
      .where('organization_id', '=', fixture.team)
      .where('details', '@>', JSON.stringify({ correlationId: result.id }))
      .orderBy('action')
      .execute()
    const details = { method: 'saml', providerId: provider.id, correlationId: result.id }
    expect(events).toMatchObject([
      { action: 'sso_authentication.succeeded', details },
      { action: 'sso_jit.admitted', details },
      { action: 'sso_jit.refused', details: { ...details, reason: 'unclassified' } },
      { action: 'sso_link.linked', details },
    ])
  })

  it('excludes another browser’s proved SAML admission from the database result', async () => {
    const provider = await enabledProvider({
      assertedMailbox: `browser-${randomUUID()}@${verifiedDomain}`,
    })
    const manager = management()
    const result = await stageMailbox(manager.request, provider)
    await proveMailbox(manager, result)

    const selectedMailboxes: string[] = []
    const observed = db.withPlugin({
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        for (const row of result.rows) {
          if (row.id === provider.id && row.mailbox === provider.mailbox)
            selectedMailboxes.push(provider.mailbox)
        }
        return result
      },
    })
    const request = instance(samlOnly, undefined, signup, observed)
    const wrongBrowser = mergeCookies(result.cookies, [
      `${bindingCookie}=${randomBytes(32).toString('base64url')}`,
    ])
    await expectRefusedCompletion(await complete(result, { request, cookies: wrongBrowser }))
    expect(selectedMailboxes).toEqual([])

    const matchingBrowser = await complete(result, { request })
    expect(matchingBrowser.status).toBe(409)
    expect(await matchingBrowser.json()).toEqual({ error: 'sso_invitation_required' })
    expect(selectedMailboxes).toEqual([provider.mailbox])
  })

  it('refuses an expired SAML admission result after real mailbox proof', async () => {
    const { fixture, provider } = await jitFixture()
    const manager = management(fixture.team)
    const result = await stageMailbox(manager.request, provider)
    await proveMailbox(manager, result)
    // Age the proved attempt and its consumed token together in the isolated test database.
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx)
      const earlier = sql`interval '10 minutes'`
      await trx
        .updateTable('sso_attempts')
        .set({
          created_at: sql`created_at - ${earlier}`,
          expires_at: sql`expires_at - ${earlier}`,
          mailbox_proven_at: sql`mailbox_proven_at - ${earlier}`,
          mailbox_proof_expires_at: sql`mailbox_proof_expires_at - ${earlier}`,
        })
        .where('id', '=', result.id)
        .execute()
      await trx
        .updateTable('sso_mailbox_tokens')
        .set({
          issued_at: sql`issued_at - ${earlier}`,
          expires_at: sql`expires_at - ${earlier}`,
          consumed_at: sql`consumed_at - ${earlier}`,
        })
        .where('attempt_id', '=', result.id)
        .execute()
    })
    const before = await identityEffects()
    const state = await protocolEffects(provider.id)
    await expectRefusedCompletion(await complete(result, { request: manager.request }))
    expect(await identityEffects()).toEqual(before)
    expect(await protocolEffects(provider.id)).toEqual(state)
  })

  it('accepts only a current matching member invitation explicitly and preserves the closed-signup exception', async () => {
    // Closed signup grants an exception to invitations from the instance's first user.
    await db
      .updateTable('auth.user')
      .set({ createdAt: new Date(0) })
      .where('id', '=', team.owner)
      .execute()
    const provider = await enabledProvider({
      assertedMailbox: `invited-${randomUUID()}@${verifiedDomain}`,
    })
    const manager = management(team.team, samlOnly, { mode: 'closed', allowedDomains: [] })
    const { request } = manager
    const result = await stageMailbox(request, provider)
    const adminInvite = await invite(team, provider.mailbox, { inviterId: team.admin })
    await expectRefusedCompletion(await acceptInvitation(request, result, adminInvite))
    await proveMailbox(manager, result)
    const before = await identityEffects()
    const state = await protocolEffects(provider.id)

    const waiting = await complete(result, { request })
    expect(waiting.status).toBe(409)
    expect(await waiting.json()).toEqual({ error: 'sso_invitation_required' })
    const signupDenied = await acceptInvitation(request, result, adminInvite)
    expect(signupDenied.status).toBe(403)
    expect(await signupDenied.json()).toEqual({ error: 'signup_disabled' })

    const eligible = await invite(team, provider.mailbox)
    const differentBrowser = mergeCookies(result.cookies, [
      `${bindingCookie}=${randomBytes(32).toString('base64url')}`,
    ])
    await expectRefusedCompletion(
      await acceptInvitation(request, result, eligible, differentBrowser),
    )
    const ineligible = [
      await invite(team, provider.mailbox, {
        organizationId: team.otherTeam,
        inviterId: team.otherOwner,
      }),
      await invite(team, provider.mailbox, { inviterId: team.otherOwner }),
      await invite(team, provider.mailbox, { role: 'admin' }),
      await invite(team, provider.mailbox, { expiresAt: at(-10) }),
      await invite(team, `another-${randomUUID()}@${verifiedDomain}`),
    ]
    for (const invitationId of ineligible) {
      const denied = await acceptInvitation(request, result, invitationId)
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({ error: 'team_management_access_denied' })
    }
    expect(await identityEffects()).toEqual(before)
    expect(await protocolEffects(provider.id)).toEqual(state)
    expect(
      await db
        .selectFrom('auth.invitation')
        .select('status')
        .where('id', 'in', [adminInvite, ...ineligible, eligible])
        .where('status', '!=', 'pending')
        .execute(),
    ).toEqual([])

    const accepted = await acceptInvitation(request, result, eligible)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({
      invitation: { id: eligible, status: 'accepted', role: 'member' },
      member: { organizationId: team.team, role: 'member' },
    })
    expect(accepted.headers.getSetCookie().join(';')).toContain('better-auth.session_token')
    expect(await storedLinks(provider)).toEqual([
      expect.objectContaining({ subject: provider.subject, proven_email: provider.mailbox }),
    ])
    await expectRefusedCompletion(await acceptInvitation(request, result, eligible))
    await expectRefusedCompletion(await complete(result, { request }))
  })

  it('waits for concurrent team removal and honors its tombstone after account deletion', async () => {
    const { fixture, provider } = await jitFixture()
    await db
      .updateTable('auth.user')
      .set({ email: provider.mailbox })
      .where('id', '=', fixture.member)
      .execute()
    const staleInvite = await invite(fixture, provider.mailbox)
    const manager = management(fixture.team)
    const { request } = manager
    const result = await stageMailbox(request, provider)
    await proveMailbox(manager, result)
    const state = await protocolEffects(provider.id)
    let completing: Promise<Response> | undefined
    try {
      await db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('auth.user')
          .select('id')
          .where('id', '=', fixture.member)
          .forUpdate()
          .execute()
        await trx
          .selectFrom('auth.organization')
          .select('id')
          .where('id', '=', fixture.team)
          .forUpdate()
          .execute()
        await recordSsoAdmissionRemoval(trx, {
          organizationId: fixture.team,
          userId: fixture.member,
        })
        await trx.deleteFrom('auth.member').where('id', '=', fixture.memberMember).execute()
        await trx.deleteFrom('auth.user').where('id', '=', fixture.member).execute()
        const { pid } = await trx
          .selectNoFrom(sql<number>`pg_backend_pid()`.as('pid'))
          .executeTakeFirstOrThrow()
        completing = Promise.resolve(complete(result, { request }))
        await vi.waitFor(
          async () => {
            const { rows } = await owned.pool.query<{ blocked: boolean }>(
              `SELECT EXISTS (SELECT FROM pg_stat_activity WHERE datname = current_database()
               AND $1 = ANY(pg_blocking_pids(pid))) AS blocked`,
              [pid],
            )
            expect(rows[0]?.blocked).toBe(true)
          },
          { timeout: 2500, interval: 20 },
        )
      })
    } finally {
      await Promise.allSettled([completing])
    }
    if (!completing) expect.unreachable('Expected an admission waiting on removal')
    for (const denied of [await completing, await acceptInvitation(request, result, staleInvite)]) {
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({ error: 'team_management_access_denied' })
      expect(denied.headers.getSetCookie()).toEqual([])
    }
    const tombstone = () =>
      db
        .selectFrom('scim_membership_blocks')
        .select(['cleared_at', 'kind', 'source', 'user_id'])
        .where('organization_id', '=', fixture.team)
        .where('identity_email', '=', provider.mailbox)
        .executeTakeFirstOrThrow()
    expect(await tombstone()).toEqual({
      cleared_at: null,
      kind: 'removal',
      source: 'local',
      user_id: null,
    })
    expect(
      await db.selectFrom('auth.user').select('id').where('email', '=', provider.mailbox).execute(),
    ).toEqual([])
    expect(await storedLinks(provider)).toEqual([])
    expect(await protocolEffects(provider.id)).toEqual(state)

    const freshInvite = await invite(fixture, provider.mailbox)
    expect((await acceptInvitation(request, result, freshInvite)).status).toBe(200)
    expect((await tombstone()).cleared_at).toBeInstanceOf(Date)
  })

  it('keeps the SAML routes off with no writes and OIDC sign-in available', async () => {
    const provider = await linkedProvider()
    const attempt = await start(provider)
    const signed = await signedResponse(attempt)
    const result = await pending(
      await acs(provider.id, signed.encoded, attempt.relayState),
      attempt,
    )
    const fresh = await start(provider)
    const freshResponse = await signedResponse(fresh)
    const capabilities = productionCapabilities('false', 'true')
    const admissionProvider = await enabledProvider({
      assertedMailbox: `off-${randomUUID()}@${verifiedDomain}`,
    })
    const manager = management()
    const admission = await stageMailbox(manager.request, admissionProvider)
    await proveMailbox(manager, admission)
    const invitationId = await invite(team, admissionProvider.mailbox)
    const { request: off, json, withMailbox } = management(team.team, capabilities)
    const member = await browserSession(team.member)
    const before = await identityEffects()
    const state = await protocolEffects(provider.id)
    const admissionState = await protocolEffects(admissionProvider.id)
    const attemptIds = () => db.selectFrom('sso_attempts').select('id').orderBy('id').execute()
    const attemptsBefore = await attemptIds()
    for (const response of [
      await signIn(admissionProvider.id, off),
      await acs(provider.id, freshResponse.encoded, fresh.relayState, off),
      await off.request(result.location, { headers: { cookie: result.cookies.join('; ') } }),
      await complete(result, { request: off }),
      await complete(admission, { request: off }),
      await acceptInvitation(off, admission, invitationId),
      await json(linkPath(provider), member.cookies, {}),
    ]) {
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'sso_disabled' })
      expect(response.headers.getSetCookie()).toEqual([])
    }
    expect(await identityEffects()).toEqual(before)
    expect(await protocolEffects(provider.id)).toEqual(state)
    expect(await protocolEffects(admissionProvider.id)).toEqual(admissionState)
    expect(await attemptIds()).toEqual(attemptsBefore)
    expect(await storedLinks(admissionProvider)).toEqual([])
    expect(
      await db
        .selectFrom('auth.invitation')
        .select('status')
        .where('id', '=', invitationId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'pending' })

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

  it('allows only another owner to retire an owner’s SAML link administratively', async () => {
    const provider = await enabledProvider()
    const link = await seedLink(provider, team.coOwner)
    const admin = await browserSession(team.admin)
    const target = await browserSession(team.coOwner)
    const owner = await browserSession(team.owner)
    const path = removeLinkPath(provider, link.id)
    const body = { expectedLinkGeneration: link.generation }
    const { request, json, withMailbox, removalNotices } = management()
    expect((await providerInventory(request, owner.cookies)).data).toContainEqual(
      expect.objectContaining({
        id: provider.id,
        links: [{ id: link.id, generation: link.generation }],
      }),
    )
    for (const { cookies } of [admin, target]) {
      const refused = await json(path, cookies, body, 'DELETE')
      expect(refused.status).toBe(403)
      expect(await refused.json()).toEqual({ error: 'team_management_access_denied' })
      expect(refused.headers.getSetCookie()).toEqual([])
    }
    expect(await identityLink(link.id)).toEqual(link)
    expect(await linkAudit(link.id)).toEqual([])
    expect(removalNotices).toEqual([])

    const { response } = await withMailbox(path, owner.cookies, body, 'DELETE')
    expect(response.status).toBe(204)
    expect(await identityLink(link.id)).toEqual({
      ...link,
      generation: link.generation + 1,
      retired_at: expect.any(Date),
    })
    expect(await linkAudit(link.id)).toEqual([
      {
        actor_id: team.owner,
        action: 'sso_link.unlinked',
        details: expect.objectContaining({ method: 'saml', providerId: provider.id }),
      },
    ])
    expect(removalNotices).toEqual([team.coOwner])
    expect((await providerInventory(request, owner.cookies)).data).toContainEqual(
      expect.objectContaining({ id: provider.id, links: [] }),
    )
  })

  it('rechecks the exact SAML link generation after waiting for a concurrent team write', async () => {
    const provider = await linkedProvider()
    const member = await browserSession(team.member)
    const { json, mailboxProof, removalNotices } = management()
    const path = linkPath(provider)
    const body = { linkId: provider.link.id, expectedLinkGeneration: provider.link.generation }
    const proof = await mailboxProof(
      await json(path, member.cookies, body, 'DELETE'),
      member.cookies,
    )
    const blocker = await owned.pool.connect()
    let retry: Promise<Response> | undefined
    try {
      await blocker.query('BEGIN')
      const { rows } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await blocker.query('SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE', [team.team])
      await blocker.query(
        'UPDATE sso_identity_links SET generation = generation + 1 WHERE id = $1',
        [provider.link.id],
      )
      retry = Promise.resolve(
        json(path, proof.cookies, { ...body, proofAttemptId: proof.attemptId }, 'DELETE'),
      )
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
    const refused = await retry
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'sso_configuration_changed' })
    expect(await identityLink(provider.link.id)).toEqual({
      ...provider.link,
      generation: body.expectedLinkGeneration + 1,
    })
    expect(
      await db
        .selectFrom('sso_attempts')
        .select('consumed_at')
        .where('id', '=', proof.attemptId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ consumed_at: null })
    expect(await linkAudit(provider.link.id)).toEqual([])
    expect(removalNotices).toEqual([])
  })

  it('revokes only the SAML browser proofs that relied on the caller’s retired link', async () => {
    const provider = await linkedProvider()
    const otherProvider = await linkedProvider()
    const manager = management()
    const fixture = await seedTeam()
    const peer = {
      ...provider,
      subject: `peer-${randomUUID()}`,
      mailbox: `peer-${randomUUID()}@${verifiedDomain}`,
    }
    await db
      .updateTable('auth.user')
      .set({ email: peer.mailbox })
      .where('id', '=', fixture.member)
      .execute()
    await db
      .insertInto('auth.member')
      .values({
        organizationId: team.team,
        userId: fixture.member,
        role: 'member',
        createdAt: at(0),
      })
      .execute()
    const peerLink = await seedLink(peer, fixture.member)
    for (const identity of [provider, provider, peer, otherProvider]) {
      await completeLinkedSignIn(identity, manager.request)
    }
    const proofs = () =>
      db
        .selectFrom('sso_browser_proofs')
        .selectAll()
        .where('provider_id', 'in', [provider.id, otherProvider.id])
        .orderBy('session_id')
        .execute()
    const priorProofs = await proofs()
    expect(priorProofs.map(({ link_id }) => link_id).sort()).toEqual(
      [provider.link.id, provider.link.id, peerLink.id, otherProvider.link.id].sort(),
    )
    const member = await browserSession(team.member)
    const before = await identityEffects()
    const { response } = await manager.withMailbox(
      linkPath(provider),
      member.cookies,
      { linkId: provider.link.id, expectedLinkGeneration: provider.link.generation },
      'DELETE',
    )
    expect(response.status).toBe(204)
    expect(await proofs()).toEqual(
      priorProofs.filter(({ link_id }) => link_id !== provider.link.id),
    )
    expect(await identityLink(peerLink.id)).toEqual(peerLink)
    expect(await identityLink(otherProvider.link.id)).toEqual(otherProvider.link)
    expect(await identityEffects()).toMatchObject({
      sessions: before.sessions,
      members: before.members,
      proofs: String(Number(before.proofs) - 2),
    })
    expect(manager.removalNotices).toEqual([team.member])
  })

  it('keeps a conflicting SAML subject bound until retirement and fresh explicit consent', async () => {
    const provider = await enabledProvider()
    const oldLink = await seedLink(provider, team.admin)
    const manager = management()
    const member = await browserSession(team.member)
    const owner = await browserSession(team.owner)
    const { request } = manager

    const conflicted = await stageLink(request, await startLink(provider, member.cookies, manager))
    await expectRefusedCompletion(await complete(conflicted, { request }))
    expect(await storedLinks(provider)).toEqual([
      expect.objectContaining({ id: oldLink.id, user_id: team.admin }),
    ])
    expect(await identityLink(oldLink.id)).toEqual(oldLink)
    expect(await linkAudit(provider.id)).toContainEqual({
      actor_id: team.member,
      action: 'sso_link.conflicted',
      details: {
        method: 'saml',
        providerId: provider.id,
        revision: 1,
        correlationId: conflicted.id,
      },
    })

    const { response } = await manager.withMailbox(
      removeLinkPath(provider, oldLink.id),
      owner.cookies,
      { expectedLinkGeneration: oldLink.generation },
      'DELETE',
    )
    expect(response.status).toBe(204)
    const retired = await identityLink(oldLink.id)
    expect(retired).toEqual({
      ...oldLink,
      generation: oldLink.generation + 1,
      retired_at: expect.any(Date),
    })
    await expectRefusedCompletion(await complete(conflicted, { request }))
    expect(await storedLinks(provider)).toHaveLength(1)

    const staged = await stageLink(request, await startLink(provider, member.cookies, manager))
    const before = await identityEffects()
    const relinked = await complete(staged, { request })
    expect(relinked.status).toBe(303)
    expect(relinked.headers.get('location')).toBe('/app/settings')
    const links = await storedLinks(provider)
    expect(links).toHaveLength(2)
    expect(links).toContainEqual({
      id: expect.any(String),
      user_id: team.member,
      issuer: provider.issuer,
      subject: oldLink.subject,
      generation: 1,
      proven_email: mailbox,
    })
    expect(await identityLink(oldLink.id)).toEqual(retired)
    expect(await identityEffects()).toEqual({
      ...before,
      links: String(Number(before.links) + 1),
    })
  })

  function createDelegationKey(userId: string, organizationId: string) {
    return db
      .insertInto('auth.apikey')
      .values({
        configId: 'default',
        referenceId: userId,
        key: digest(randomUUID()),
        metadata: JSON.stringify({ scope: 'full', organizationId }),
        enabled: true,
        createdAt: at(0),
        updatedAt: at(0),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  }

  it.each([
    { oidc: 'on', ssoOidcEnabled: true },
    { oidc: 'off', ssoOidcEnabled: false },
  ])(
    'revokes a SAML delegation while SAML is off and OIDC is $oidc',
    async ({ ssoOidcEnabled }) => {
      const fixture = await seedTeam()
      const domainName = `delegations-${randomUUID()}.example.com`
      const memberMailbox = `member@${domainName}`
      await db
        .updateTable('auth.user')
        .set({ email: memberMailbox })
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
        assertedMailbox: memberMailbox,
      })
      await seedLink(provider, fixture.member, fixture.team)
      const oidcSetting = String(ssoOidcEnabled)
      const on = productionCapabilities('true', oidcSetting)
      const { request, json } = management(fixture.team, on)
      const browser = cookiesFrom(await completeLinkedSignIn(provider, request))
      await db
        .insertInto('sso_policies')
        .values({ organization_id: fixture.team, require_sso: true })
        .execute()
      const key = await createDelegationKey(fixture.member, fixture.team)
      const input = { credentialKind: 'api_key', credentialId: key.id, expectedTrustGeneration: 1 }
      const challenge = await json(SSO_DELEGATIONS_PATH, browser, input)
      expect(challenge.status).toBe(403)
      const proof = (await challenge.json()) as { attemptId: string }
      expect(proof).toMatchObject({ error: 'sso_reauthentication_required', proofMethods: ['sso'] })
      const { cookies } = await stepUp(
        request,
        provider,
        proof.attemptId,
        mergeCookies(browser, cookiesFrom(challenge)),
      )
      const bound = await json(SSO_DELEGATIONS_PATH, cookies, {
        ...input,
        proofAttemptId: proof.attemptId,
      })
      expect(bound.status).toBe(201)
      const { id } = (await bound.json()) as { id: string }
      const binding = () =>
        db
          .selectFrom('sso_delegation_bindings')
          .select(['provider_id', 'api_key_id', 'expires_at'])
          .where('id', '=', id)
          .execute()
      const before = await binding()
      expect(before).toEqual([
        { provider_id: provider.id, api_key_id: key.id, expires_at: expect.any(Date) },
      ])

      const offCapabilities = productionCapabilities('false', oidcSetting)
      const off = management(fixture.team, offCapabilities)
      const delegationStatus = (capabilities: SsoCapabilities) =>
        db
          .selectNoFrom(
            ssoDelegationStatus(
              sql<string>`${fixture.team}`,
              sql<string>`${fixture.member}`,
              'api_key',
              sql<string>`${key.id}`,
              capabilities,
            ).as('status'),
          )
          .executeTakeFirstOrThrow()
      const original = await me(request, browser)
      expect(original.sso).toMatchObject({
        requireSso: true,
        proofs: [{ providerId: provider.id, expiresAt: expect.any(String) }],
      })
      expect(await delegationStatus(on)).toEqual({ status: 'valid' })
      expect(await me(off.request, browser)).toMatchObject({
        organization: { id: fixture.team, name: '' },
        sso: { requireSso: true, proofs: [] },
      })
      expect(await delegationStatus(offCapabilities)).toEqual({ status: 'required' })
      expect(await binding()).toEqual(before)
      expect(await delegationStatus(on)).toEqual({ status: 'valid' })
      expect((await me(request, browser)).sso.proofs).toEqual(original.sso.proofs)
      expect(await binding()).toEqual(before)
      const revoked = await off.json(`${SSO_DELEGATIONS_PATH}/${id}`, browser, {}, 'DELETE')
      expect(revoked.status).toBe(204)
      expect(await binding()).toEqual([])
      expect(await linkAudit(id)).toContainEqual({
        actor_id: fixture.member,
        action: 'sso_delegation.revoked',
        details: { method: 'saml', providerId: provider.id, revision: 1 },
      })
    },
  )

  it.each(['self unlink', 'admin removal'] as const)(
    'retires a SAML delegation by %s and permits explicit re-linking while enforcement stays on',
    async (operation) => {
      const fixture = await seedTeam()
      const domainName = `delegations-${randomUUID()}.example.com`
      const claim = await db
        .insertInto('sso_domains')
        .values(claimedDomainValues(fixture.team, domainName))
        .returning(['id', 'generation'])
        .executeTakeFirstOrThrow()
      const memberMailbox = `member@${domainName}`
      const provider = await enabledProvider({
        organizationId: fixture.team,
        domainId: claim.id,
        assertedMailbox: memberMailbox,
      })
      const ownerProvider = {
        ...provider,
        subject: `owner-${randomUUID()}`,
        mailbox: `owner@${domainName}`,
      }
      for (const [id, email] of [
        [fixture.member, memberMailbox],
        [fixture.owner, ownerProvider.mailbox],
      ] as const) {
        await db.updateTable('auth.user').set({ email }).where('id', '=', id).execute()
      }
      const memberLink = await seedLink(provider, fixture.member, fixture.team)
      const ownerLink = await seedLink(ownerProvider, fixture.owner, fixture.team)
      const manager = management(fixture.team)
      const { request, json, mailboxProof } = manager
      const memberCookies = cookiesFrom(await completeLinkedSignIn(provider, request))
      const ownerCookies = cookiesFrom(await completeLinkedSignIn(ownerProvider, request))
      const adminPath = removeLinkPath(provider, memberLink.id)
      const adminInput = { expectedLinkGeneration: memberLink.generation }
      const adminMailbox =
        operation === 'admin removal'
          ? await mailboxProof(
              await json(adminPath, ownerCookies, adminInput, 'DELETE'),
              ownerCookies,
            )
          : undefined
      await db
        .insertInto('sso_policies')
        .values({ organization_id: fixture.team, require_sso: true })
        .execute()

      async function prove(response: Response, identity: Provider, original: string[]) {
        expect(response.status).toBe(403)
        const challenge = (await response.json()) as { attemptId: string }
        expect(challenge).toMatchObject({
          error: 'sso_reauthentication_required',
          attemptId: expect.any(String),
          proofMethods: ['sso'],
        })
        const { cookies } = await stepUp(
          request,
          identity,
          challenge.attemptId,
          mergeCookies(original, cookiesFrom(response)),
        )
        return { cookies, attemptId: challenge.attemptId }
      }

      const bindings = () =>
        db
          .selectFrom('sso_delegation_bindings')
          .selectAll()
          .where('organization_id', '=', fixture.team)
          .orderBy('id')
          .execute()
      async function bind(
        userId: string,
        identity: Provider,
        original: string[],
        mailboxOnlyAttemptId?: string,
      ) {
        const key = await createDelegationKey(userId, fixture.team)
        const input = {
          credentialKind: 'api_key',
          credentialId: key.id,
          expectedTrustGeneration: 1,
        }
        const before = await bindings()
        const pending = await json(SSO_DELEGATIONS_PATH, original, {
          ...input,
          proofAttemptId: mailboxOnlyAttemptId,
        })
        const { cookies, attemptId } = await prove(pending, identity, original)
        expect(attemptId).not.toBe(mailboxOnlyAttemptId)
        expect(await bindings()).toEqual(before)
        const bound = await json(SSO_DELEGATIONS_PATH, cookies, {
          ...input,
          proofAttemptId: attemptId,
        })
        expect(bound.status).toBe(201)
        const { id } = (await bound.json()) as { id: string }
        return { id, keyId: key.id }
      }

      const unlinkPath = linkPath(provider)
      const unlink = { linkId: memberLink.id, ...adminInput }
      const independent = await mailboxProof(
        await json(unlinkPath, memberCookies, unlink, 'DELETE'),
        memberCookies,
      )
      const memberBinding = await bind(
        fixture.member,
        provider,
        independent.cookies,
        independent.attemptId,
      )
      const ownerBinding = await bind(fixture.owner, ownerProvider, ownerCookies)
      const before = await bindings()
      expect(before).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: memberBinding.id,
            api_key_id: memberBinding.keyId,
            user_id: fixture.member,
            link_id: memberLink.id,
            provider_id: provider.id,
            domain_id: claim.id,
          }),
          expect.objectContaining({
            id: ownerBinding.id,
            api_key_id: ownerBinding.keyId,
            user_id: fixture.owner,
            link_id: ownerLink.id,
            provider_id: provider.id,
            domain_id: claim.id,
          }),
        ]),
      )
      expect(before).toHaveLength(2)
      const beforeUnlink = await identityLink(memberLink.id)
      let removed: Response
      if (!adminMailbox) {
        removed = await json(
          unlinkPath,
          independent.cookies,
          { ...unlink, proofAttemptId: independent.attemptId },
          'DELETE',
        )
      } else {
        const { cookies, attemptId } = await prove(
          await json(
            adminPath,
            adminMailbox.cookies,
            { ...adminInput, proofAttemptId: adminMailbox.attemptId },
            'DELETE',
          ),
          ownerProvider,
          adminMailbox.cookies,
        )
        expect(attemptId).not.toBe(adminMailbox.attemptId)
        expect(await bindings()).toEqual(before)
        removed = await json(
          adminPath,
          cookies,
          { ...adminInput, proofAttemptId: attemptId },
          'DELETE',
        )
      }
      expect(removed.status).toBe(204)
      expect(await bindings()).toEqual(before.filter(({ id }) => id === ownerBinding.id))
      const retired = await identityLink(memberLink.id)
      expect(retired).toEqual({
        ...beforeUnlink,
        generation: memberLink.generation + 1,
        retired_at: expect.any(Date),
      })
      expect(await identityLink(ownerLink.id)).toEqual(ownerLink)
      expect(manager.removalNotices).toEqual([fixture.member])

      const nextLink = await stageLink(request, await startLink(provider, memberCookies, manager))
      const relinked = await complete(nextLink, { request })
      expect(relinked.status).toBe(303)
      expect(relinked.headers.get('location')).toBe('/app/settings')
      const links = await storedLinks(provider)
      expect(links).toHaveLength(3)
      expect(
        links.find(({ id, user_id }) => id !== memberLink.id && user_id === fixture.member),
      ).toEqual({
        id: expect.any(String),
        user_id: fixture.member,
        issuer: provider.issuer,
        subject: provider.subject,
        generation: 1,
        proven_email: memberMailbox,
      })
      expect(await identityLink(memberLink.id)).toEqual(retired)
      expect(await bindings()).toEqual(before.filter(({ id }) => id === ownerBinding.id))
      expect(
        await db
          .selectFrom('sso_policies')
          .select(['require_sso', 'trust_generation'])
          .where('organization_id', '=', fixture.team)
          .executeTakeFirstOrThrow(),
      ).toEqual({ require_sso: true, trust_generation: 1 })
    },
  )

  it.each([
    { operation: 'admin removal', target: 'owner', self: false },
    { operation: 'admin removal', target: 'unknown', self: false },
    { operation: 'admin removal', target: 'retired', self: false },
    { operation: 'self unlink', target: 'unknown', self: true },
    { operation: 'self unlink', target: 'retired', self: true },
  ])(
    'refuses $operation for a hard-off SAML $target link before checking the target',
    async ({ target, self }) => {
      const provider = await enabledProvider()
      const affectedUser = target === 'owner' ? team.coOwner : team.member
      const link = await seedLink(provider, affectedUser)
      if (target === 'retired') {
        await db
          .updateTable('sso_identity_links')
          .set({ retired_at: at(0), generation: link.generation + 1 })
          .where('id', '=', link.id)
          .execute()
      }
      const linkId = target === 'unknown' ? randomUUID() : link.id
      const caller = await browserSession(self ? affectedUser : team.admin)
      const off = management(team.team, { ssoOidcEnabled: true, ssoSamlEnabled: false })
      const attempts = () => db.selectFrom('sso_attempts').select('id').orderBy('id').execute()
      const before = await identityEffects()
      const priorAttempts = await attempts()
      const priorLink = await identityLink(link.id)
      const response = await off.json(
        self ? linkPath(provider) : removeLinkPath(provider, linkId),
        caller.cookies,
        { expectedLinkGeneration: priorLink.generation, ...(self && { linkId }) },
        'DELETE',
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'sso_disabled' })
      expect(response.headers.getSetCookie()).toEqual([])
      expect(await identityEffects()).toEqual(before)
      expect(await attempts()).toEqual(priorAttempts)
      expect(await identityLink(link.id)).toEqual(priorLink)
      expect(await linkAudit(link.id)).toEqual([])
      expect(off.jobs).toEqual([])
      expect(off.removalNotices).toEqual([])
    },
  )

  it('keeps known SAML link recovery hard-off before the enforced team proof check', async () => {
    const fixture = await seedTeam()
    const claim = await db
      .insertInto('sso_domains')
      .values(claimedDomainValues(fixture.team))
      .returning('id')
      .executeTakeFirstOrThrow()
    const provider = await enabledProvider({ organizationId: fixture.team, domainId: claim.id })
    const retired = await enabledProvider({ organizationId: fixture.team, domainId: claim.id })
    const link = await seedLink(provider, fixture.owner, fixture.team)
    const retiredLink = await seedLink(retired, fixture.member, fixture.team)
    await db
      .updateTable('sso_providers')
      .set({ enabled: false, retired_at: at(0) })
      .where('id', '=', retired.id)
      .execute()
    await db
      .insertInto('sso_policies')
      .values({ organization_id: fixture.team, require_sso: true })
      .execute()
    const admin = await browserSession(fixture.admin, fixture.team)
    const member = await browserSession(fixture.member, fixture.team)
    const off = management(fixture.team, { ssoOidcEnabled: true, ssoSamlEnabled: false })
    const adminPath = removeLinkPath(provider, link.id)
    const input = { expectedLinkGeneration: link.generation }
    const before = await identityEffects()
    for (const response of [
      await off.json(adminPath, admin.cookies, input, 'DELETE'),
      await off.json(removeLinkPath(retired, retiredLink.id), admin.cookies, input, 'DELETE'),
      await off.json(
        linkPath(retired),
        member.cookies,
        { ...input, linkId: retiredLink.id },
        'DELETE',
      ),
    ]) {
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'sso_disabled' })
      expect(response.headers.getSetCookie()).toEqual([])
    }
    const foreignProvider = await enabledProvider()
    for (const response of [
      await off.json(adminPath, member.cookies, input, 'DELETE'),
      await off.json(removeLinkPath(foreignProvider, link.id), admin.cookies, input, 'DELETE'),
      await off.json(adminPath, admin.cookies, input, 'DELETE', {
        'X-Expected-Organization-Id': fixture.otherTeam,
      }),
    ]) {
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'sso_required' })
      expect(response.headers.getSetCookie()).toEqual([])
    }
    expect(await identityEffects()).toEqual(before)
    expect(await identityLink(link.id)).toEqual(link)
    expect(await identityLink(retiredLink.id)).toEqual(retiredLink)
    expect(await linkAudit(link.id)).toEqual([])
    expect(await linkAudit(retiredLink.id)).toEqual([])
    expect(
      await db
        .selectFrom('sso_attempts')
        .select('id')
        .where('organization_id', '=', fixture.team)
        .execute(),
    ).toEqual([])
    expect(off.jobs).toEqual([])
    expect(off.removalNotices).toEqual([])
  })

  it('keeps OIDC self-unlink available with both settings off', async () => {
    const fixture = await seedTeam()
    const oidc = await db
      .insertInto('sso_providers')
      .values({ ...oidcProviderValues(fixture.team), enabled: true })
      .returning(['id', 'issuer'])
      .executeTakeFirstOrThrow()
    const provider = { ...oidc, subject: `oidc-${randomUUID()}`, mailbox }
    const link = await seedLink(provider, fixture.member, fixture.team)
    const member = await browserSession(fixture.member, fixture.team)
    const off = management(fixture.team, productionCapabilities('false', 'false'))
    const { response } = await off.withMailbox(
      linkPath(provider),
      member.cookies,
      { linkId: link.id, expectedLinkGeneration: link.generation },
      'DELETE',
    )
    expect(response.status).toBe(204)
    expect(await identityLink(link.id)).toEqual({
      ...link,
      generation: link.generation + 1,
      retired_at: expect.any(Date),
    })
    expect(await linkAudit(link.id)).toContainEqual({
      actor_id: fixture.member,
      action: 'sso_link.unlinked',
      details: expect.objectContaining({ method: 'oidc', providerId: provider.id }),
    })
  })

  it.each(['false', 'true'] as const)(
    'keeps SAML link recovery available with SAML off and SSO_OIDC_ENABLED=%s',
    async (oidc) => {
      const fixture = await seedTeam()
      const claim = await db
        .insertInto('sso_domains')
        .values(claimedDomainValues(fixture.team))
        .returning('id')
        .executeTakeFirstOrThrow()
      const provider = await enabledProvider({ organizationId: fixture.team, domainId: claim.id })
      const ownLink = await seedLink(provider, fixture.member, fixture.team)
      const other = { ...provider, subject: `admin-${randomUUID()}` }
      const otherLink = await seedLink(other, fixture.admin, fixture.team)
      const member = await browserSession(fixture.member, fixture.team)
      const owner = await browserSession(fixture.owner, fixture.team)
      const off = management(fixture.team, productionCapabilities('false', oidc))
      const summary = (await me(off.request, member.cookies)).sso
      expect(summary).toEqual({
        requireSso: false,
        providers: [],
        attempts: [],
        links: [
          {
            id: ownLink.id,
            providerId: provider.id,
            generation: ownLink.generation,
            protocol: 'saml',
          },
        ],
        proofs: [],
      })
      const inventory = await providerInventory(off.request, owner.cookies)
      const stored = inventory.data.find(({ id }) => id === provider.id)
      expect(stored).toMatchObject({
        protocol: 'saml',
        links: expect.arrayContaining([
          { id: ownLink.id, generation: ownLink.generation },
          { id: otherLink.id, generation: otherLink.generation },
        ]),
      })
      expect(stored?.links).toHaveLength(2)
      const adminPath = removeLinkPath(provider, otherLink.id)
      const adminBody = { expectedLinkGeneration: otherLink.generation }
      const denied = await off.json(adminPath, member.cookies, adminBody, 'DELETE')
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({ error: 'team_management_access_denied' })
      expect(await identityLink(otherLink.id)).toEqual(otherLink)
      const results = [
        await off.withMailbox(
          linkPath(provider),
          member.cookies,
          {
            linkId: ownLink.id,
            expectedLinkGeneration: ownLink.generation,
          },
          'DELETE',
        ),
        await off.withMailbox(adminPath, owner.cookies, adminBody, 'DELETE'),
      ]
      for (const { response } of results) expect(response.status).toBe(204)
      for (const link of [ownLink, otherLink]) {
        expect(await identityLink(link.id)).toEqual({
          ...link,
          generation: link.generation + 1,
          retired_at: expect.any(Date),
        })
      }
      expect(off.removalNotices).toEqual([fixture.member, fixture.admin])
    },
  )
})
