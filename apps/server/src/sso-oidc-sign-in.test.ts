import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
  liveSsoDelegationSummaries,
  MCP_OAUTH_CONSENT_LIFETIME_MS,
  recordSsoAdmissionRemoval,
  type SignupPolicy,
  scimClaimCompletion,
  teamMembershipLimit,
} from '@hourmere/auth'
import { decryptCredential } from '@hourmere/calendars'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { Mailer, MailMessage } from '@hourmere/mail'
import type { SsoRequest, SsoResponse } from '@hourmere/outbound/sso'
import { createFixtures } from '@hourmere/scheduling/testing'
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { suspendScimMember } from '../../../packages/db/src/scim-suspension-fixtures.ts'
import {
  at,
  claimedDomainValues,
  oidcProviderValues,
  type SsoFixture,
  samlProviderValues,
  ssoFixture,
} from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import { nativeTeamLeave } from './native-team-leave.ts'
import { eventTypeRoutes } from './routes/event-types.ts'
import { ssoRoutes } from './routes/sso.ts'
import { ssoDelegationRoutes } from './routes/sso-delegation.ts'
import { ssoDomainRoutes } from './routes/sso-domains.ts'
import { ssoDraftRoutes } from './routes/sso-drafts.ts'
import { ssoIdentityRecoveryRoutes } from './routes/sso-link-recovery.ts'
import { sealSsoProviderConfiguration, ssoProviderConfigurationAad } from './sso-configuration.ts'
import { ssoLinkRemovalEmailJob } from './sso-link-recovery.ts'
import {
  databaseClock,
  deliverMailboxProof,
  MAILBOX_PROOF_CONSUME_PATH,
  MAILBOX_PROOF_SEND_PATH,
  MailboxProofEmailPayload,
  mailboxProofRoutes,
} from './sso-mailbox-proof.ts'
import { oidcSignInRoutes } from './sso-oidc-sign-in.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'https://hourmere.example.test'
const startPath = '/api/auth/sign-in/sso'
const callbackPath = (providerId: string) => `/api/auth/sso/callback/${providerId}`
const completePath = '/api/auth/sso/oidc/complete'
const acceptInvitationPath = '/api/auth/organization/accept-invitation'
const providersPath = '/api/v1/team/sso/providers'
const domainsPath = '/api/v1/team/sso/domains'
const delegationsPath = '/api/v1/team/sso/delegations'
const providerTestPath = (providerId: string) => `${providersPath}/${providerId}/test`
const linkPath = (providerId: string) => `${providersPath}/${providerId}/link`
const removeLinkPath = (providerId: string, linkId: string) =>
  `${providersPath}/${providerId}/links/${linkId}`
const providerTestLocation = '/app/settings'
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
const testedAction = 'sso_provider.tested'
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

interface PendingAttempt extends Attempt {
  completionCookie: string
}

/** A networkless IdP at the transport boundary, with real PKCE verification and signed tokens. */
function fakeIdp(signingKey: CryptoKey, jwks: SsoResponse, epoch: () => Promise<number>) {
  const codes = new Map<
    string,
    { parameters: URLSearchParams; claims: JWTPayload; beforeToken?: () => Promise<void> }
  >()
  let issuedSecrets: string[] = []
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
    const accessToken = randomUUID()
    const refreshToken = randomUUID()
    issuedSecrets = [code, body.get('code_verifier') ?? '', idToken, accessToken, refreshToken]
    return json({ id_token: idToken, access_token: accessToken, refresh_token: refreshToken })
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
    get issuedSecrets() {
      return issuedSecrets
    },
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

describe.skipIf(!databaseUrl)('OIDC sign-in, provider tests, self-linking and admission', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let oidcAuth: ReturnType<typeof createAuth>
  // Native acceptance with SCIM claim completion, as the resource test flag wires it.
  let scimAuth: ReturnType<typeof createAuth>
  let keys: Awaited<ReturnType<typeof generateKeyPair>>
  let jwks: SsoResponse
  let fixture: SsoFixture
  let idp: ReturnType<typeof fakeIdp>
  let app: ReturnType<typeof createApp>
  let mailboxJobs: MailboxProofEmailPayload[]
  let recoveryJobs: { name: string; payload: unknown }[]

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'oidc_sign_in' })
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
    const authOptions = {
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      mailer: { send: async () => expect.unreachable('OIDC sign-in must not send mail') },
    }
    const nativeTeamOptions = {
      ...authOptions,
      leaveTeamMember: nativeTeamLeave(db, recordSsoAdmissionRemoval),
    }
    auth = createAuth(nativeTeamOptions)
    oidcAuth = createAuth({
      ...nativeTeamOptions,
      ssoCapabilities: { ssoOidcEnabled: true, ssoSamlEnabled: false },
    })
    scimAuth = createAuth({
      ...authOptions,
      scimClaims: scimClaimCompletion,
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
    mailboxJobs = []
    recoveryJobs = []
    app = instance()
  })

  function instance({
    enabled = true,
    expiresIn,
    signupPolicy = signup,
    scimClaims = false,
    failRecoveryNotification = false,
    nativeAuth,
  }: {
    enabled?: boolean
    expiresIn?: number
    signupPolicy?: SignupPolicy
    scimClaims?: boolean
    failRecoveryNotification?: boolean
    nativeAuth?: typeof auth
  } = {}) {
    const capabilities = { ssoOidcEnabled: enabled, ssoSamlEnabled: false }
    const authentication = nativeAuth ?? (scimClaims ? scimAuth : auth)
    return createApp({
      checkDb: async () => {},
      authHandler: authentication.handler,
      resolveCaller: createCallerResolver({ auth: authentication, db }),
      publicUrl,
      routes: [
        eventTypeRoutes({ db }),
        ssoRoutes({ db, capabilities }),
        ssoDomainRoutes({ db, publicUrl, capabilities }),
        ssoDelegationRoutes({ db, publicUrl, capabilities, configurationKey }),
        ssoIdentityRecoveryRoutes({
          db,
          publicUrl,
          capabilities,
          notificationQueue: {
            async enqueue(name, payload, options) {
              expect(options.transaction).toMatchObject({ isTransaction: true })
              if (failRecoveryNotification) return null
              recoveryJobs.push({ name, payload })
              return 'job'
            },
          },
        }),
        ssoDraftRoutes({
          db,
          publicUrl,
          capabilities,
          configurationKey,
          privateTargets: [],
          send: idp.send,
        }),
      ],
      ssoTeamReads: { db, capabilities },
      ssoMailboxProof: mailboxProofRoutes({
        db,
        capabilities,
        queue: {
          async enqueue(_name, payload) {
            mailboxJobs.push(MailboxProofEmailPayload.parse(payload))
            return 'job'
          },
        },
      }),
      ssoOidcSignIn: oidcSignInRoutes({
        db,
        capabilities,
        configurationKey,
        privateTargets: [],
        send: idp.send,
        signup: signupPolicy,
        ...(scimClaims && { scimClaims: scimClaimCompletion }),
        readSession: async (headers) =>
          (
            await authentication.api.getSession({
              headers,
              query: { disableRefresh: true, disableCookieCache: true },
            })
          )?.session,
        session: { secret, ...(expiresIn !== undefined && { expiresIn }) },
      }),
    })
  }

  function configuration(
    providerId: string,
    revision: number,
    discovery = false,
    organizationId = fixture.team,
  ) {
    const { issuer, clientId, clientSecret } = config
    return sealSsoProviderConfiguration(
      configurationKey,
      { organizationId, providerId, revision },
      JSON.stringify(discovery ? { issuer, clientId, clientSecret } : config),
    )
  }

  async function provider({
    enabled = true,
    domainExpiresIn,
    discovery = false,
    domain = `team-${randomUUID().slice(0, 8)}.example.com`,
    organizationId = fixture.team,
  }: {
    enabled?: boolean
    domainExpiresIn?: number
    discovery?: boolean
    domain?: string
    organizationId?: string
  } = {}) {
    const { id: providerId } = await db
      .selectNoFrom(sql<string>`uuidv7()`.as('id'))
      .executeTakeFirstOrThrow()
    await db
      .insertInto('sso_providers')
      .values({
        id: providerId,
        organization_id: organizationId,
        protocol: 'oidc',
        display_name: 'Synthetic OIDC',
        issuer,
        client_id: config.clientId,
        configuration: configuration(providerId, 1, discovery, organizationId),
        enabled,
      })
      .execute()
    const domainValues = {
      ...claimedDomainValues(organizationId, domain),
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
        organization_id: organizationId,
        provider_id: providerId,
        domain_id: claim.id,
      })
      .execute()
    return { providerId, claim, email: `linked@${domain}` }
  }

  async function enrollment(options?: Parameters<typeof provider>[0]) {
    const configured = await provider(options)
    await db
      .updateTable('auth.user')
      .set({ email: configured.email })
      .where('id', '=', fixture.member)
      .execute()
    const subject = 'Exact Subject'
    return { ...configured, claims: { sub: subject, email: configured.email } }
  }

  async function linked(options?: Parameters<typeof provider>[0]) {
    const configured = await enrollment(options)
    const link = await db
      .insertInto('sso_identity_links')
      .values({
        organization_id: fixture.team,
        provider_id: configured.providerId,
        user_id: fixture.member,
        issuer,
        subject: configured.claims.sub,
        proven_email: configured.email,
        email_proven_at: at(-60),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return { ...configured, link }
  }

  function post(
    body: unknown,
    request = app,
    headers: Record<string, string> = {},
    path = startPath,
  ) {
    return request.request(new URL(path, publicUrl), {
      method: 'POST',
      headers: { origin: publicUrl, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }

  async function start(
    providerId: string,
    request = app,
    returnTo = '/app/bookings?tab=next#recent',
    cookie?: string,
  ) {
    const response = await post(
      { providerId, intent: 'sign_in', returnTo },
      request,
      cookie ? { cookie } : {},
    )
    expect(response.status).toBe(200)
    const result = (await response.json()) as { url: string; redirect: boolean }
    expect(result).toEqual({ url: expect.any(String), redirect: true })
    const { url } = result
    const authorization = new URL(url)
    const binding = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${bindingCookie}=`))
    expect(binding).toMatch(/; HttpOnly/i)
    expect(binding).toMatch(/; Secure/i)
    expect(binding).toMatch(/; SameSite=Lax/i)
    return {
      authorization,
      providerId,
      cookie: (binding as string).split(';')[0] as string,
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

  const attemptRow = (attempt: Pick<Attempt, 'id'>) =>
    db.selectFrom('sso_attempts').selectAll().where('id', '=', attempt.id).executeTakeFirstOrThrow()

  function complete(
    attempt: PendingAttempt,
    extra: Record<string, unknown> = {},
    request = app,
    headers: Record<string, string> = {},
  ) {
    return post(
      { attemptId: attempt.id, ...extra },
      request,
      { cookie: `${attempt.cookie}; ${attempt.completionCookie}`, ...headers },
      completePath,
    )
  }

  async function expectCompletionRefused(response: Response) {
    expect(response.status).toBe(400)
    expect(response.headers.getSetCookie()).toEqual([])
    expect(await response.json()).toEqual({ error: 'sso_oidc_completion_invalid' })
  }

  function acceptInvitation(pending: PendingAttempt, invitationId: string, request = app) {
    return post(
      { invitationId },
      request,
      {
        cookie: `${pending.cookie}; ${pending.completionCookie}`,
        'X-Hourmere-Sso-Attempt': pending.id,
      },
      acceptInvitationPath,
    )
  }

  async function pendingAdmission(
    f: Awaited<ReturnType<typeof provider>>,
    claims: JWTPayload = {},
  ) {
    const attempt = await start(f.providerId)
    const code = idp.issue(attempt, { sub: 'New OIDC subject', email: f.email, ...claims })
    const response = await callback(attempt, code)
    expect(response.status).toBe(302)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    const location = response.headers.get('location') ?? ''
    expect(location).toMatch(/^\/app\/mailbox-proof#attempt=[0-9a-f-]+$/)
    const id = location.split('=').at(-1) as string
    const cookies = response.headers.getSetCookie()
    expect(cookies).toHaveLength(1)
    const [completion] = cookies as [string]
    expect(completion).toMatch(/^__Secure-hourmere\.oidc_admission\./)
    expect(completion).toContain('Path=/api/auth;')
    expect(completion).toContain('HttpOnly; Secure; SameSite=Strict')
    const completionCookie = completion.split(';')[0] as string
    const outcome = {
      status: response.status,
      body: await response.text(),
      location: location.replace(id, 'ATTEMPT'),
      contentType: response.headers.get('content-type'),
      cookieOptions: completion
        .slice(completion.indexOf(';'))
        .replace(/Expires=[^;]+/i, 'Expires=DATE'),
    }
    return { pending: { ...attempt, id, completionCookie }, outcome, code }
  }

  function selectJit() {
    return db
      .insertInto('sso_policies')
      .values({ organization_id: fixture.team, admission: 'jit' })
      .execute()
  }

  async function pendingMailbox(
    f: Awaited<ReturnType<typeof linked>>,
    email = `changed@${f.claim.name}`,
    claims: JWTPayload = {},
    cookie?: string,
  ) {
    const attempt = await start(f.providerId, app, undefined, cookie)
    const response = await callback(attempt, idp.issue(attempt, { ...f.claims, ...claims, email }))
    expect(response.status).toBe(302)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const cookies = response.headers.getSetCookie()
    expect(cookies).toHaveLength(1)
    const [completion] = cookies as [string]
    expect(completion).toContain(`Path=${completePath}`)
    expect(completion).toMatch(/; HttpOnly/i)
    expect(completion).toMatch(/; Secure/i)
    const completionCookie = completion.split(';')[0] as string
    const location = response.headers.get('location') ?? ''
    expect(location).toMatch(/^\/app\/mailbox-proof#attempt=[0-9a-f-]+$/)
    const id = location.split('=').at(-1) as string
    const outcome = {
      status: response.status,
      body: await response.text(),
      location: location.replace(id, 'ATTEMPT'),
      type: response.headers.get('content-type'),
      cookieOptions: completion
        .slice(completion.indexOf(';'))
        .replace(/Expires=[^;]+/i, 'Expires=DATE'),
    }
    expect(await attemptRow(attempt)).toMatchObject({
      consumed_at: expect.any(Date),
      mailbox: null,
    })
    return { pending: { ...attempt, id, completionCookie }, outcome }
  }

  type MailboxAttempt = Pick<Attempt, 'id' | 'cookie'>

  async function mailboxMessage(attempt: MailboxAttempt, tokenLifetimeSeconds?: number) {
    const response = await post(
      { attemptId: attempt.id },
      app,
      { cookie: attempt.cookie },
      MAILBOX_PROOF_SEND_PATH,
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ status: 'queued' })
    const job = mailboxJobs.shift()
    expect(job).toBeDefined()
    const messages: MailMessage[] = []
    await deliverMailboxProof(
      {
        capabilities: { ssoOidcEnabled: true, ssoSamlEnabled: false },
        db,
        mailer: {
          send: async (message) => {
            messages.push(message)
          },
        },
        publicUrl,
        secret,
        mailMaxPerHour: 0,
        ...(tokenLifetimeSeconds !== undefined && { limits: { tokenLifetimeSeconds } }),
      },
      job as MailboxProofEmailPayload,
    )
    expect(messages).toHaveLength(1)
    const [message] = messages as [MailMessage]
    const token = /#attempt=[0-9a-f-]+&token=([A-Za-z0-9_-]+)/.exec(message.text ?? '')?.[1]
    expect(token).toBeDefined()
    return { message, token: token as string }
  }

  function consumeMailbox(attempt: MailboxAttempt, token: string) {
    return post(
      { attemptId: attempt.id, token },
      app,
      { cookie: attempt.cookie },
      MAILBOX_PROOF_CONSUME_PATH,
    )
  }

  async function proveMailbox(attempt: MailboxAttempt, tokenLifetimeSeconds?: number) {
    const { token } = await mailboxMessage(attempt, tokenLifetimeSeconds)
    const response = await consumeMailbox(attempt, token)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'proven' })
  }

  async function browserSession(userId: string, organizationId = fixture.team) {
    const session = await db.transaction().execute(async (trx) =>
      createBrowserSession(
        trx,
        { publicUrl, secret },
        {
          userId,
          organizationId,
          now: await databaseClock(trx),
          headers: new Headers(),
        },
      ),
    )
    return { id: session.id, cookie: session.cookie.split(';')[0] as string }
  }

  function sessionCookie(response: Response) {
    const session = response.headers
      .getSetCookie()
      .find((cookie) => cookie.includes('session_token='))
    if (!session) expect.unreachable('SSO issued a session')
    return (session as string).split(';')[0] as string
  }

  function readEvents(cookie: string) {
    return app.request(new URL('/api/v1/event-types', publicUrl), { headers: { cookie } })
  }

  async function expectSsoRequired(cookie: string) {
    const response = await readEvents(cookie)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'sso_required' })
  }

  function testRequest(
    providerId: string,
    cookie: string,
    body: Record<string, unknown> = { expectedRevision: 1 },
    extra: Record<string, string> = {},
  ) {
    return post(
      body,
      app,
      {
        cookie,
        'X-Expected-Organization-Id': fixture.team,
        ...extra,
      },
      providerTestPath(providerId),
    )
  }

  async function freshProofChallenge(
    response: Response,
    cookies: string,
    proofMethods = ['mailbox'],
  ): Promise<MailboxAttempt> {
    expect(response.status).toBe(403)
    const challenge = (await response.json()) as { attemptId: string }
    expect(challenge).toMatchObject({
      error: 'sso_reauthentication_required',
      attemptId: expect.any(String),
      proofMethods,
    })
    const binding = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${bindingCookie}=`))
    return {
      id: challenge.attemptId,
      cookie: binding ? `${cookies}; ${binding.split(';')[0]}` : cookies,
    }
  }

  async function startProviderTest(
    providerId: string,
    challenge: MailboxAttempt,
  ): Promise<Attempt> {
    const response = await testRequest(providerId, challenge.cookie, {
      expectedRevision: 1,
      proofAttemptId: challenge.id,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const { url, attemptId } = (await response.json()) as { url: string; attemptId: string }
    const authorization = new URL(url)
    expect(authorization.origin + authorization.pathname).toBe(config.authorizationEndpoint)
    expect(authorization.searchParams.get('state')?.split('.')[0]).toBe(attemptId)
    expect(authorization.searchParams.get('redirect_uri')).toBe(
      new URL(callbackPath(providerId), publicUrl).href,
    )
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    const binding = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${bindingCookie}=`))
    expect(binding).toMatch(/; SameSite=Lax/i)
    expect(challenge.cookie).toContain(binding?.split(';')[0])
    return { id: attemptId, providerId, authorization, cookie: challenge.cookie }
  }

  async function providerTestStatus(providerId: string, cookie: string) {
    const response = await app.request(new URL(providersPath, publicUrl), {
      headers: { cookie, 'X-Expected-Organization-Id': fixture.team },
    })
    expect(response.status).toBe(200)
    const { data } = (await response.json()) as {
      data: { id: string; revision: number; testStatus: string; enabled: boolean }[]
    }
    return data.find(({ id }) => id === providerId)
  }

  function linkRequest(
    providerId: string,
    cookie: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    return post(
      body,
      app,
      { cookie, 'X-Expected-Organization-Id': fixture.team, ...headers },
      linkPath(providerId),
    )
  }

  const requestLinkProof = async (providerId: string, cookie: string) =>
    freshProofChallenge(await linkRequest(providerId, cookie), cookie)

  function recoveryRequest(
    path: string,
    cookie: string,
    body: Record<string, unknown>,
    {
      request = app,
      headers = {},
    }: { request?: typeof app; headers?: Record<string, string> } = {},
  ) {
    return request.request(new URL(path, publicUrl), {
      method: 'DELETE',
      headers: {
        cookie,
        origin: publicUrl,
        'content-type': 'application/json',
        'X-Expected-Organization-Id': fixture.team,
        ...headers,
      },
      body: JSON.stringify({ expectedLinkGeneration: 1, ...body }),
    })
  }

  async function recoveryProof(path: string, cookie: string, body: Record<string, unknown> = {}) {
    const challenge = await freshProofChallenge(await recoveryRequest(path, cookie, body), cookie)
    await proveMailbox(challenge)
    return challenge
  }

  function storedLink(id: string) {
    return db.selectFrom('sso_identity_links').selectAll().where('id', '=', id).executeTakeFirst()
  }

  async function recoveryTarget(
    f: { providerId: string; claim: { name: string } },
    userId: string,
    subject = `Recovery subject ${randomUUID()}`,
  ) {
    const email = `${userId}@${f.claim.name}`
    await db.updateTable('auth.user').set({ email }).where('id', '=', userId).execute()
    const link = await db
      .insertInto('sso_identity_links')
      .values({
        organization_id: fixture.team,
        provider_id: f.providerId,
        user_id: userId,
        issuer,
        subject,
        proven_email: email,
        email_proven_at: at(-60),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return { link, claims: { sub: subject, email } }
  }

  async function createRecoveryProofs(
    f: { providerId: string; claim: { id: string; generation: number } },
    target: Awaited<ReturnType<typeof recoveryTarget>>,
    memberId: string,
  ) {
    const attempt = await start(f.providerId)
    const result = await callback(attempt, idp.issue(attempt, target.claims))
    expect(result.status).toBe(302)
    expect(result.headers.get('location')).toBe('/app/bookings?tab=next#recent')
    const issued = await db
      .selectFrom('sso_browser_proofs')
      .selectAll()
      .where('link_id', '=', target.link.id)
      .executeTakeFirstOrThrow()
    const grant = await db
      .insertInto('mcp_oauth_grants')
      .values({
        user_id: target.link.user_id,
        organization_id: fixture.team,
        client_id: `synthetic-client-${randomUUID()}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const delegated = await db
      .insertInto('sso_delegation_bindings')
      .values({
        organization_id: fixture.team,
        provider_id: f.providerId,
        member_id: memberId,
        user_id: target.link.user_id,
        oauth_grant_id: grant.id,
        link_id: target.link.id,
        link_generation: target.link.generation,
        trust_generation: 1,
        domain_id: f.claim.id,
        domain_generation: f.claim.generation,
        expires_at: at(300),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return { issued, delegated }
  }

  async function startLink(providerId: string, challenge: MailboxAttempt): Promise<Attempt> {
    const response = await linkRequest(providerId, challenge.cookie, {
      proofAttemptId: challenge.id,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const { url, attemptId } = (await response.json()) as { url: string; attemptId: string }
    const authorization = new URL(url)
    expect(authorization.origin + authorization.pathname).toBe(config.authorizationEndpoint)
    expect(authorization.searchParams.get('state')?.split('.')[0]).toBe(attemptId)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    return { id: attemptId, providerId, authorization, cookie: challenge.cookie }
  }

  async function pendingLink(attempt: Attempt, code: string): Promise<PendingAttempt> {
    const response = await callback(attempt, code)
    expect(response.status).toBe(302)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const location = response.headers.get('location') ?? ''
    expect(location).toMatch(/^\/app\/settings#sso-link=[0-9a-f-]+$/)
    const id = location.split('=').at(-1) as string
    const cookies = response.headers.getSetCookie()
    expect(cookies).toHaveLength(1)
    const [completion] = cookies as [string]
    expect(completion).toContain(`Path=${completePath}`)
    expect(completion).toMatch(/; HttpOnly/i)
    const completionCookie = completion.split(';')[0] as string
    return { ...attempt, id, completionCookie }
  }

  async function prepareLink(f: Awaited<ReturnType<typeof enrollment>>, sessionCookie?: string) {
    const cookie = sessionCookie ?? (await browserSession(fixture.member)).cookie
    const challenge = await requestLinkProof(f.providerId, cookie)
    await proveMailbox(challenge)
    const attempt = await startLink(f.providerId, challenge)
    return pendingLink(attempt, idp.issue(attempt, f.claims))
  }

  async function expectProviderTestRedirect(response: Response) {
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(providerTestLocation)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.getSetCookie()).toEqual([])
    return response.text()
  }

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

  async function waitForBlocked(pid: number | undefined) {
    expect(pid).toEqual(expect.any(Number))
    await vi.waitFor(
      async () => {
        const { rows } = await owned.pool.query<{ blocked: boolean }>(
          'SELECT EXISTS (SELECT FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))) AS blocked',
          [pid],
        )
        expect(rows[0]?.blocked).toBe(true)
      },
      { timeout: 2500, interval: 10 },
    )
  }

  async function enforceSso() {
    await db
      .insertInto('sso_policies')
      .values({ organization_id: fixture.team, require_sso: true })
      .execute()
  }

  function domainChallenge(cookie: string, body: Record<string, unknown>) {
    return post(body, app, { cookie, 'X-Expected-Organization-Id': fixture.team }, domainsPath)
  }

  async function stepUpFixture(options?: Parameters<typeof provider>[0]) {
    const f = await provider(options)
    const identity = await recoveryTarget(f, fixture.owner)
    const owner = await browserSession(fixture.owner)
    // Existing session proof authorizes access to the team's write entry point. The
    // fresh-proof ceremony must still independently prove the exact operation.
    await db
      .insertInto('sso_browser_proofs')
      .values({
        organization_id: fixture.team,
        user_id: fixture.owner,
        member_id: fixture.ownerMember,
        session_id: owner.id,
        provider_id: f.providerId,
        link_id: identity.link.id,
        link_generation: identity.link.generation,
        trust_generation: 1,
        domain_id: f.claim.id,
        domain_generation: f.claim.generation,
        expires_at: at(300),
      })
      .execute()
    return { ...f, ...identity, owner }
  }

  function initiateStepUp(
    providerId: string,
    pending: MailboxAttempt,
    extra: Record<string, unknown> = {},
  ) {
    return post({ providerId, intent: 'step_up', attemptId: pending.id, ...extra }, app, {
      cookie: pending.cookie,
    })
  }

  const stepUpReturnTo = '/app/settings?tab=sso#fresh-proof'

  async function startStepUp(providerId: string, pending: MailboxAttempt): Promise<Attempt> {
    const response = await initiateStepUp(providerId, pending, { returnTo: stepUpReturnTo })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const { url, redirect } = (await response.json()) as { url: string; redirect: boolean }
    expect(redirect).toBe(true)
    const authorization = new URL(url)
    expect(authorization.origin + authorization.pathname).toBe(config.authorizationEndpoint)
    expect(authorization.searchParams.getAll('prompt')).toEqual(['login'])
    expect(authorization.searchParams.getAll('max_age')).toEqual(['0'])
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    const binding = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${bindingCookie}=`))
    expect(binding).toMatch(/; SameSite=Lax/i)
    expect(pending.cookie).toContain(binding?.split(';')[0])
    return {
      id: authorization.searchParams.get('state')?.split('.')[0] as string,
      providerId,
      authorization,
      cookie: pending.cookie,
    }
  }

  function expectStepUpRedirect(response: Response) {
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(stepUpReturnTo)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.getSetCookie()).toEqual([])
  }

  async function stepUpDomainProof(cookie: string, body: Record<string, unknown>) {
    return freshProofChallenge(await domainChallenge(cookie, body), cookie, ['sso'])
  }

  const authTime = async () => Math.floor(Date.parse(await databaseClock(db)) / 1000)

  async function delegationKey(userId: string, organizationId: string | null, expiresAt?: string) {
    return (
      await db
        .insertInto('auth.apikey')
        .values({
          configId: 'default',
          referenceId: userId,
          key: randomBytes(32).toString('hex'),
          metadata: JSON.stringify({ scope: 'full', ...(organizationId && { organizationId }) }),
          enabled: true,
          createdAt: at(0),
          updatedAt: at(0),
          expiresAt: expiresAt ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
  }

  async function delegationGrant(userId: string, organizationId: string, createdAt = at(0)) {
    const clientId = randomUUID()
    await db
      .insertInto('auth.oauthClient')
      .values({ clientId, redirectUris: JSON.stringify(['https://client.example.test/callback']) })
      .execute()
    const { id } = await db
      .insertInto('mcp_oauth_grants')
      .values({ user_id: userId, organization_id: organizationId, client_id: clientId })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('auth.oauthConsent')
      .values({
        clientId,
        userId,
        referenceId: id,
        scopes: JSON.stringify(['mcp:tools', 'offline_access']),
        resources: JSON.stringify([`${publicUrl}/mcp`]),
        createdAt,
        updatedAt: createdAt,
      })
      .execute()
    return id
  }

  function delegationRequest(
    cookie: string,
    credentialId: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    return post(
      { credentialKind: 'api_key', credentialId, expectedTrustGeneration: 1, ...extra },
      app,
      { cookie, 'X-Expected-Organization-Id': fixture.team, ...headers },
      delegationsPath,
    )
  }

  function revokeDelegation(cookie: string, bindingId: string) {
    return app.request(new URL(`${delegationsPath}/${bindingId}`, publicUrl), {
      method: 'DELETE',
      headers: { origin: publicUrl, cookie, 'X-Expected-Organization-Id': fixture.team },
    })
  }

  async function completeDelegationStepUp(
    f: Awaited<ReturnType<typeof linked>>,
    challenge: MailboxAttempt,
    claims: Record<string, unknown> = {},
  ) {
    const attempt = await startStepUp(f.providerId, challenge)
    const response = await callback(
      attempt,
      idp.issue(attempt, { ...f.claims, auth_time: await authTime(), ...claims }),
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(stepUpReturnTo)
    const receipt = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`__Secure-hourmere.sso_delegation.${challenge.id}=`))
    expect(receipt).toMatch(/; HttpOnly/i)
    expect(receipt).toMatch(/; SameSite=Strict/i)
    return `${challenge.cookie}; ${receipt?.split(';')[0]}`
  }

  async function prepareDelegation(
    f: Awaited<ReturnType<typeof linked>>,
    cookie: string,
    credentialId: string,
    extra: Record<string, unknown> = {},
    claims: Record<string, unknown> = {},
    organizationId = fixture.team,
  ) {
    const headers = { 'X-Expected-Organization-Id': organizationId }
    const challenge = await freshProofChallenge(
      await delegationRequest(cookie, credentialId, extra, headers),
      cookie,
      ['sso'],
    )
    const proved = await completeDelegationStepUp(f, challenge, claims)
    return {
      challenge,
      submit: () =>
        delegationRequest(
          proved,
          credentialId,
          { ...extra, proofAttemptId: challenge.id },
          headers,
        ),
    }
  }

  async function bindingResponse(response: Response) {
    expect(response.status).toBe(201)
    const result = (await response.json()) as { id: string; expiresAt: string }
    expect(result).toEqual({ id: expect.any(String), expiresAt: expect.any(String) })
    return result
  }

  async function delegationBrowserProof(
    f: Awaited<ReturnType<typeof linked>>,
    sessionId: string,
    expiresAt = at(300),
  ) {
    await db
      .insertInto('sso_browser_proofs')
      .values({
        organization_id: fixture.team,
        user_id: fixture.member,
        member_id: fixture.memberMember,
        session_id: sessionId,
        provider_id: f.providerId,
        link_id: f.link.id,
        link_generation: f.link.generation,
        trust_generation: 1,
        domain_id: f.claim.id,
        domain_generation: f.claim.generation,
        expires_at: expiresAt,
      })
      .execute()
  }

  it('challenges only for owned active same-team credentials and refuses bearer authorization', async () => {
    const f = await linked()
    await enforceSso()
    const { id, cookie } = await browserSession(fixture.member)
    await delegationBrowserProof(f, id)
    await db
      .insertInto('auth.member')
      .values({
        organizationId: fixture.otherTeam,
        userId: fixture.member,
        role: 'member',
        createdAt: at(0),
      })
      .execute()
    const expired = at(-30)
    const rejected = [
      [randomUUID(), 'api_key'],
      [await delegationKey(fixture.admin, fixture.team), 'api_key'],
      [await delegationKey(fixture.member, fixture.otherTeam), 'api_key'],
      [await delegationKey(fixture.member, null), 'api_key'],
      [await delegationKey(fixture.member, fixture.team, expired), 'api_key'],
      [await delegationGrant(fixture.admin, fixture.team), 'oauth_grant'],
      [await delegationGrant(fixture.member, fixture.otherTeam), 'oauth_grant'],
      [await delegationGrant(fixture.member, fixture.team, at(-31 * 86400)), 'oauth_grant'],
    ]
    for (const [id, credentialKind] of rejected) {
      const response = await delegationRequest(cookie, id as string, { credentialKind })
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'sso_not_found' })
    }
    const own = await delegationKey(fixture.member, fixture.team)
    const bearer = await delegationRequest(cookie, own, {}, { authorization: 'Bearer fixture' })
    expect(bearer.status).toBe(403)
    expect(await bearer.json()).toEqual({ error: 'team_management_access_denied' })
    const stale = await delegationRequest(cookie, own, { expectedTrustGeneration: 2 })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'sso_configuration_changed' })
    expect(
      await db
        .selectFrom('sso_attempts')
        .select('id')
        .where('organization_id', '=', fixture.team)
        .execute(),
    ).toEqual([])
  })

  it('requires the exact SSO step-up before enforcement and never accepts mailbox proof alone', async () => {
    const f = await linked()
    const { cookie } = await browserSession(fixture.member)
    const key = await delegationKey(fixture.member, fixture.team)
    const newChallenge = await freshProofChallenge(await delegationRequest(cookie, key), cookie, [
      'sso',
    ])
    const proved = await completeDelegationStepUp(f, newChallenge, { auth_time: undefined })
    const pending = await freshProofChallenge(
      await delegationRequest(proved, key, { proofAttemptId: newChallenge.id }),
      proved,
      ['mailbox'],
    )
    expect(pending.id).toBe(newChallenge.id)
    await proveMailbox(pending)
    const missingReceipt = await delegationRequest(newChallenge.cookie, key, {
      proofAttemptId: newChallenge.id,
    })
    expect(missingReceipt.status).toBe(400)
    expect(await missingReceipt.json()).toEqual({ error: 'sso_oidc_completion_invalid' })
    expect((await attemptRow(newChallenge)).consumed_at).toBeNull()
    const different = await delegationKey(fixture.member, fixture.team)
    const changedInput = await delegationRequest(proved, different, {
      proofAttemptId: newChallenge.id,
    })
    expect((await freshProofChallenge(changedInput, proved, ['sso'])).id).not.toBe(newChallenge.id)
    const bound = await bindingResponse(
      await delegationRequest(proved, key, { proofAttemptId: newChallenge.id.toUpperCase() }),
    )
    const row = await db
      .selectFrom('sso_delegation_bindings')
      .selectAll()
      .where('id', '=', bound.id)
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({
      organization_id: fixture.team,
      member_id: fixture.memberMember,
      link_id: f.link.id,
      link_generation: f.link.generation,
      domain_id: f.claim.id,
      domain_generation: f.claim.generation,
      trust_generation: 1,
    })
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(30 * 86400 * 1000)
    await enforceSso()
    const capabilities = { ssoOidcEnabled: true, ssoSamlEnabled: false }
    expect(
      (await liveSsoDelegationSummaries(db, capabilities, fixture.member, 'api_key', [key])).get(
        key,
      ),
    ).toEqual(bound)
  })

  it('caps each lease at the credential or signed IdP deadline and preserves it through domain renewal', async () => {
    const f = await linked({ domainExpiresIn: 180 })
    await enforceSso()
    const actor = await browserSession(fixture.member)
    await db
      .updateTable('auth.session')
      .set({ expiresAt: at(120) })
      .where('id', '=', actor.id)
      .execute()
    await delegationBrowserProof(f, actor.id, at(90))
    const keyExpiry = at(300)
    const key = await delegationKey(fixture.member, fixture.team, keyExpiry)
    const boundedKey = await prepareDelegation(f, actor.cookie, key)
    const first = await bindingResponse(await boundedKey.submit())
    expect(first.expiresAt).toBe(new Date(keyExpiry).toISOString())
    const createdAt = at(-MCP_OAUTH_CONSENT_LIFETIME_MS / 1000 + 600)
    const grant = await delegationGrant(fixture.member, fixture.team, createdAt)
    const boundedGrant = await prepareDelegation(f, actor.cookie, grant, {
      credentialKind: 'oauth_grant',
    })
    const second = await bindingResponse(await boundedGrant.submit())
    expect(second.expiresAt).toBe(
      new Date(Date.parse(createdAt) + MCP_OAUTH_CONSENT_LIFETIME_MS).toISOString(),
    )
    const uncappedKey = await delegationKey(fixture.member, fixture.team)
    const deadline = (await authTime()) + 900
    const boundedIdp = await prepareDelegation(
      f,
      actor.cookie,
      uncappedKey,
      {},
      { session_expires_at: deadline },
    )
    const third = await bindingResponse(await boundedIdp.submit())
    expect(third.expiresAt).toBe(new Date(deadline * 1000).toISOString())

    const capabilities = { ssoOidcEnabled: true, ssoSamlEnabled: false }
    const summaries = () =>
      liveSsoDelegationSummaries(db, capabilities, fixture.member, 'api_key', [key])
    expect((await summaries()).get(key)).toEqual(first)
    await db
      .updateTable('sso_domains')
      .set({ verification_expires_at: at(1200) })
      .where('id', '=', f.claim.id)
      .execute()
    expect((await summaries()).get(key)).toEqual(first)
    await db
      .updateTable('sso_domains')
      .set({ verification_expires_at: at(-1) })
      .where('id', '=', f.claim.id)
      .execute()
    expect((await summaries()).size).toBe(0)
    await expect(
      db
        .updateTable('sso_domains')
        .set({ verification_expires_at: at(1200) })
        .where('id', '=', f.claim.id)
        .execute(),
    ).rejects.toMatchObject({ constraint: 'sso_domains_generation_lapse' })
  })

  it('revokes only the member’s exact owned binding without live browser proof on an enforced team', async () => {
    const f = await linked()
    await enforceSso()
    const { id, cookie } = await browserSession(fixture.member)
    await delegationBrowserProof(f, id)
    const other = await browserSession(fixture.coOwner)
    const key = await delegationKey(fixture.member, fixture.team)
    const prepared = await prepareDelegation(f, cookie, key)
    const binding = await bindingResponse(await prepared.submit())
    await db.deleteFrom('sso_browser_proofs').where('session_id', '=', id).execute()
    await expectSsoRequired(cookie)
    for (const response of [
      await revokeDelegation(other.cookie, binding.id),
      await revokeDelegation(cookie, randomUUID()),
    ]) {
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'sso_not_found' })
    }
    const revoked = await revokeDelegation(cookie, binding.id.toUpperCase())
    expect(revoked.status).toBe(204)
    expect(await revoked.text()).toBe('')
    expect(revoked.headers.get('cache-control')).toBe('no-store')
    expect((await revokeDelegation(cookie, binding.id)).status).toBe(404)
    await expectSsoRequired(cookie)
    const entries = (await audit()).filter((entry) => entry.action.startsWith('sso_delegation.'))
    expect(entries.map(({ action, target_id }) => ({ action, target_id }))).toEqual([
      { action: 'sso_delegation.bound', target_id: binding.id },
      { action: 'sso_delegation.revoked', target_id: binding.id },
    ])
    expect(entries[1]?.details).toEqual({ method: 'oidc', providerId: f.providerId, revision: 1 })
  })

  it.each([true, false])(
    'serializes exact revocation and rebinding across transactions (bind first: %s)',
    async (bindFirst) => {
      const f = await linked()
      await enforceSso()
      const actor = await browserSession(fixture.member)
      await delegationBrowserProof(f, actor.id)
      const key = await delegationKey(fixture.member, fixture.team)
      const initial = await prepareDelegation(f, actor.cookie, key)
      const old = await bindingResponse(await initial.submit())
      const rebound = await prepareDelegation(f, actor.cookie, key)
      const revoke = () => revokeDelegation(actor.cookie, old.id)
      const blocker = await owned.pool.connect()
      let bindResult: Promise<Response> | undefined
      let revokeResult: Promise<Response> | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE', [
          fixture.team,
        ])
        const { rows } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        if (bindFirst) bindResult = Promise.resolve(rebound.submit())
        else revokeResult = Promise.resolve(revoke())
        await waitForBlocked(rows[0]?.pid)
        if (bindFirst) revokeResult = Promise.resolve(revoke())
        else bindResult = Promise.resolve(rebound.submit())
        await vi.waitFor(
          async () => {
            const { rows: waiters } = await owned.pool.query<{ count: string }>(
              'SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0',
            )
            expect(waiters[0]?.count).toBe('2')
          },
          { timeout: 2500, interval: 10 },
        )
      } finally {
        await blocker.query('ROLLBACK')
        blocker.release()
      }
      const fresh = await bindingResponse(await (bindResult as Promise<Response>))
      expect((await revokeResult)?.status).toBe(bindFirst ? 404 : 204)
      expect(fresh.id).not.toBe(old.id)
      const entries = (await audit()).filter((entry) => entry.action.startsWith('sso_delegation.'))
      expect(entries.map(({ action, target_id }) => ({ action, target_id }))).toEqual([
        { action: 'sso_delegation.bound', target_id: old.id },
        { action: 'sso_delegation.revoked', target_id: old.id },
        { action: 'sso_delegation.bound', target_id: fresh.id },
      ])
      expect(
        await db
          .selectFrom('sso_delegation_bindings')
          .select('id')
          .where('api_key_id', '=', key)
          .execute(),
      ).toEqual([{ id: fresh.id }])
    },
  )

  it('ends a bound member’s lease on unlink while preserving another member’s lease', async () => {
    const f = await linked()
    const other = await recoveryTarget(f, fixture.coOwner)
    const otherProofs = await createRecoveryProofs(f, other, fixture.coOwnerMember)
    const actor = await browserSession(fixture.member)
    const key = await delegationKey(fixture.member, fixture.team)
    const prepared = await prepareDelegation(f, actor.cookie, key)
    const binding = await bindingResponse(await prepared.submit())
    const path = linkPath(f.providerId)
    const unlink = { linkId: f.link.id, expectedLinkGeneration: f.link.generation }
    const mailbox = await recoveryProof(path, actor.cookie, unlink)
    const response = await recoveryRequest(path, mailbox.cookie, {
      ...unlink,
      proofAttemptId: mailbox.id,
    })
    expect(response.status).toBe(204)
    expect((await revokeDelegation(actor.cookie, binding.id)).status).toBe(404)
    expect(
      await db
        .selectFrom('sso_delegation_bindings')
        .select('id')
        .where('provider_id', '=', f.providerId)
        .execute(),
    ).toEqual([{ id: otherProofs.delegated.id }])
  })

  it('replaces a previous lease after the owner changes the key’s team', async () => {
    const f = await linked()
    const actor = await browserSession(fixture.member)
    const key = await delegationKey(fixture.member, fixture.team)
    const bound = await bindingResponse(
      await (await prepareDelegation(f, actor.cookie, key)).submit(),
    )
    await db
      .insertInto('auth.member')
      .values({
        organizationId: fixture.otherTeam,
        userId: fixture.member,
        role: 'member',
        createdAt: at(0),
      })
      .execute()
    const other = await provider({ organizationId: fixture.otherTeam })
    const link = await db
      .insertInto('sso_identity_links')
      .values({
        organization_id: fixture.otherTeam,
        provider_id: other.providerId,
        user_id: fixture.member,
        issuer,
        subject: f.claims.sub,
        proven_email: other.email,
        email_proven_at: at(-60),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const moved = await app.request(new URL('/api/auth/api-key/update', publicUrl), {
      method: 'POST',
      headers: { cookie: actor.cookie, origin: publicUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ keyId: key, metadata: { organizationId: fixture.otherTeam } }),
    })
    expect(moved.status).toBe(200)
    expect(
      await db
        .selectFrom('sso_delegation_bindings')
        .select('id')
        .where('api_key_id', '=', key)
        .execute(),
    ).toEqual([])
    expect((await audit()).filter((entry) => entry.action === 'sso_delegation.revoked')).toEqual([
      expect.objectContaining({
        actor_type: 'user',
        actor_id: fixture.member,
        credential_type: 'session',
        credential_id: actor.id,
        target_type: 'sso_delegation',
        target_id: bound.id,
        details: {
          method: 'oidc',
          providerId: f.providerId,
          revision: 1,
          reason: 'key_moved_team',
        },
      }),
    ])
    expect(
      await db
        .selectFrom('audit_events')
        .select('id')
        .where('organization_id', '=', fixture.otherTeam)
        .where('action', '=', 'sso_delegation.revoked')
        .execute(),
    ).toEqual([])
    const oldTeam = await delegationRequest(actor.cookie, key)
    expect(oldTeam.status).toBe(404)
    const otherSession = await browserSession(fixture.member, fixture.otherTeam)
    const retry = await prepareDelegation(
      { ...other, link, claims: { ...f.claims, email: other.email } },
      otherSession.cookie,
      key,
      {},
      {},
      fixture.otherTeam,
    )
    const rebound = await bindingResponse(await retry.submit())
    expect(rebound.id).not.toBe(bound.id)
    expect(
      await db
        .selectFrom('sso_delegation_bindings')
        .select(['id', 'organization_id'])
        .where('api_key_id', '=', key)
        .execute(),
    ).toEqual([{ id: rebound.id, organization_id: fixture.otherTeam }])
  })

  it('hard-disables OIDC auth-protocol endpoints before looking up the request', async () => {
    const off = instance({ enabled: false })
    const { providerId, link } = await linked()
    for (const [provider, linkId] of [
      [providerId, link.id],
      [randomUUID(), randomUUID()],
      ['invalid', 'invalid'],
    ] as const) {
      const responses = [
        await post({ providerId: provider, intent: 'sign_in' }, off),
        await post({ providerId: provider, intent: 'step_up', attemptId: linkId }, off),
        await off.request(new URL(`${callbackPath(provider)}?code=ignored`, publicUrl)),
        await post({ attemptId: provider }, off, {}, completePath),
        await post(
          { expectedRevision: 'invalid' },
          off,
          { origin: '' },
          providerTestPath(provider),
        ),
        await recoveryRequest(linkPath(provider), '', { linkId }, { request: off }),
        await recoveryRequest(removeLinkPath(provider, linkId), '', {}, { request: off }),
      ]
      for (const response of responses) {
        expect(response.status).toBe(404)
        expect(await response.text()).toBe('{"error":"sso_disabled"}')
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
    expect(recoveryJobs).toEqual([])
  })

  it.each([
    ['provider draft', 201],
    ['domain challenge', 201],
    ['provider test', 200],
    ['admin link removal', 204],
  ] as const)('requires OIDC step-up for an enforced team %s write', async (operation, status) => {
    const f = await stepUpFixture()
    const draft = await provider({ enabled: false, discovery: operation === 'provider test' })
    const target = await recoveryTarget(f, fixture.member)
    const requestWrite = (cookie: string, proofAttemptId?: string) => {
      const proof = proofAttemptId ? { proofAttemptId } : {}
      const writes = {
        'provider draft': () =>
          post(
            {
              protocol: 'oidc',
              displayName: 'Step-up draft',
              domainIds: [],
              oidc: config,
              ...proof,
            },
            app,
            { cookie, 'X-Expected-Organization-Id': fixture.team },
            providersPath,
          ),
        'domain challenge': () =>
          domainChallenge(cookie, { domain: 'new-org.example.com', ...proof }),
        'provider test': () =>
          testRequest(draft.providerId, cookie, { expectedRevision: 1, ...proof }),
        'admin link removal': () =>
          recoveryRequest(removeLinkPath(f.providerId, target.link.id), cookie, proof),
      }
      return writes[operation]()
    }

    const mailbox = await freshProofChallenge(await requestWrite(f.owner.cookie), f.owner.cookie)
    await proveMailbox(mailbox)
    await enforceSso()
    const pending = await freshProofChallenge(
      await requestWrite(mailbox.cookie, mailbox.id),
      mailbox.cookie,
      ['sso'],
    )
    expect(pending.id).not.toBe(mailbox.id)
    expect((await attemptRow(mailbox)).consumed_at).toBeNull()

    const attempt = await startStepUp(f.providerId, pending)
    const authenticatedAt = await authTime()
    const before = await effects()
    const code = idp.issue(attempt, { ...f.claims, auth_time: authenticatedAt })
    expectStepUpRedirect(await callback(attempt, code))
    expect(await effects()).toEqual(before)
    expect(await attemptRow(pending)).toMatchObject({
      consumed_at: null,
      requires_mailbox: false,
      step_up_provider_id: f.providerId,
      step_up_link_id: f.link.id,
      step_up_authenticated_at: new Date(authenticatedAt * 1000),
      step_up_proof_expires_at: new Date((authenticatedAt + 300) * 1000),
      step_up_trust_generation: 1,
    })
    expect((await audit()).some(({ action }) => action === signInAction)).toBe(false)

    if (operation === 'provider test') {
      idp.discovery.mockImplementation(async () => {
        await assertStepUpRowsUnlocked(pending.id)
        return json(metadata)
      })
    }
    expect((await requestWrite(pending.cookie, pending.id)).status).toBe(status)
    if (operation === 'provider test') expect(idp.discovery).toHaveBeenCalledOnce()
    expect((await attemptRow(pending)).consumed_at).toBeInstanceOf(Date)
    if (operation === 'admin link removal') {
      expect((await storedLink(target.link.id))?.retired_at).toBeInstanceOf(Date)
      expect(recoveryJobs).toHaveLength(1)
    }
  })

  it('adds mailbox proof to an OIDC step-up without signed auth_time', async () => {
    const f = await stepUpFixture()
    await enforceSso()
    const body = { domain: 'fallback-org.example.com' }
    const pending = await stepUpDomainProof(f.owner.cookie, body)
    const attempt = await startStepUp(f.providerId, pending)
    const before = await effects()
    // The fake signs a current iat even when the provider omits auth_time.
    expectStepUpRedirect(await callback(attempt, idp.issue(attempt, f.claims)))
    expect(await effects()).toEqual(before)
    expect(await attemptRow(pending)).toMatchObject({
      requires_sso: true,
      requires_mailbox: true,
      mailbox_proven_at: null,
      step_up_link_id: f.link.id,
      consumed_at: null,
    })
    const retry = { ...body, proofAttemptId: pending.id }
    expect(
      await freshProofChallenge(await domainChallenge(pending.cookie, retry), pending.cookie),
    ).toEqual(pending)
    const { message, token } = await mailboxMessage(pending)
    expect(message.to).toBe(f.claims.email)
    expect((await consumeMailbox(pending, token)).status).toBe(200)
    expect((await domainChallenge(pending.cookie, retry)).status).toBe(201)
    expect((await attemptRow(pending)).consumed_at).toBeInstanceOf(Date)
  })

  it.each([
    ['stale', -45],
    ['future', 60],
    ['silent SSO', -3600],
  ] as const)('refuses OIDC step-up with %s signed auth_time', async (_case, offset) => {
    const f = await stepUpFixture()
    await enforceSso()
    const body = { domain: 'fresh-org.example.com' }
    const pending = await stepUpDomainProof(f.owner.cookie, body)
    const attempt = await startStepUp(f.providerId, pending)
    const before = await effects()
    const code = idp.issue(attempt, { ...f.claims, auth_time: (await authTime()) + offset })
    await refusal(await callback(attempt, code))
    expect(await effects()).toEqual(before)
    expect(await attemptRow(pending)).toMatchObject({
      requires_mailbox: false,
      step_up_link_id: null,
      consumed_at: null,
    })
    expect(
      await stepUpDomainProof(pending.cookie, { ...body, proofAttemptId: pending.id }),
    ).toEqual(pending)
  })

  it('binds OIDC step-up to the exact pending attempt, browser session and team', async () => {
    const f = await stepUpFixture()
    const differentProvider = await provider()
    const otherTeamProvider = await provider({ organizationId: fixture.otherTeam })
    const otherUser = await browserSession(fixture.admin)
    const otherSession = await browserSession(fixture.owner)
    await enforceSso()
    const body = { domain: 'bound-org.example.com' }
    const pending = await stepUpDomainProof(f.owner.cookie, body)
    const otherPending = await stepUpDomainProof(pending.cookie, {
      domain: 'other-org.example.com',
    })
    const binding = pending.cookie.split('; ').find((part) => part.startsWith(`${bindingCookie}=`))
    expect(binding).toBeDefined()
    const otherUserCookie = `${otherUser.cookie}; ${binding}`
    const otherSessionCookie = `${otherSession.cookie}; ${binding}`
    const otherBrowserCookie = `${f.owner.cookie}; ${bindingCookie}=${randomBytes(32).toString('base64url')}`
    const { id: unknownId } = await db
      .selectNoFrom(sql<string>`uuidv7()`.as('id'))
      .executeTakeFirstOrThrow()
    for (const response of [
      await initiateStepUp(f.providerId, { ...pending, id: unknownId }),
      await initiateStepUp(f.providerId, { ...pending, cookie: otherUserCookie }),
      await initiateStepUp(f.providerId, { ...pending, cookie: otherSessionCookie }),
      await initiateStepUp(f.providerId, { ...pending, cookie: otherBrowserCookie }),
      await initiateStepUp(differentProvider.providerId, pending),
      await initiateStepUp(otherTeamProvider.providerId, pending),
    ]) {
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'sso_not_found' })
      expect(response.headers.getSetCookie()).toEqual([])
    }

    const attempt = await startStepUp(f.providerId, pending)
    const concurrent = await startStepUp(f.providerId, pending)
    const before = await effects()
    const claims = { ...f.claims, auth_time: await authTime() }
    const code = idp.issue(attempt, claims)
    for (const wrong of [
      { cookie: otherUserCookie },
      { cookie: otherSessionCookie },
      { cookie: otherBrowserCookie },
      { providerId: differentProvider.providerId },
      { providerId: otherTeamProvider.providerId },
    ])
      await refusal(await callback(attempt, code, wrong))
    expect(idp.exchange).not.toHaveBeenCalled()
    expect((await attemptRow(pending)).step_up_link_id).toBeNull()

    expectStepUpRedirect(await callback(attempt, code))
    await refusal(await callback(attempt, code))
    expect(idp.exchange).toHaveBeenCalledTimes(1)
    expect(await effects()).toEqual(before)
    expect((await attemptRow(otherPending)).step_up_link_id).toBeNull()

    const changed = await stepUpDomainProof(pending.cookie, {
      domain: 'changed-org.example.com',
      proofAttemptId: pending.id,
    })
    expect(changed.id).not.toBe(pending.id)
    expect((await attemptRow(pending)).consumed_at).toBeNull()
    expect(
      (await domainChallenge(pending.cookie, { ...body, proofAttemptId: pending.id })).status,
    ).toBe(201)
    expect((await attemptRow(pending)).consumed_at).toBeInstanceOf(Date)
    await refusal(await callback(concurrent, idp.issue(concurrent, claims)))
    expect(idp.exchange).toHaveBeenCalledTimes(1)
    const consumed = await initiateStepUp(f.providerId, pending)
    expect(consumed.status).toBe(404)
    expect(await consumed.json()).toEqual({ error: 'sso_not_found' })
  })

  it('refuses OIDC step-up when the signed subject links to another person', async () => {
    const f = await stepUpFixture()
    const other = await recoveryTarget(f, fixture.admin)
    await enforceSso()
    const pending = await stepUpDomainProof(f.owner.cookie, { domain: 'subject-org.example.com' })
    const attempt = await startStepUp(f.providerId, pending)
    const before = await effects()
    const code = idp.issue(attempt, { ...other.claims, auth_time: await authTime() })
    await refusal(await callback(attempt, code))
    expect(await effects()).toEqual(before)
    expect((await attemptRow(pending)).step_up_link_id).toBeNull()
    expect(await storedLink(other.link.id)).toEqual(other.link)
  })

  const assertStepUpRowsUnlocked = (id: string) =>
    db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM auth.organization WHERE id = ${fixture.team} FOR UPDATE NOWAIT`.execute(
        trx,
      )
      await sql`SELECT id FROM sso_attempts WHERE id = ${id} FOR UPDATE NOWAIT`.execute(trx)
    })

  it('keeps provider I/O outside database locks and refuses a pending attempt that expires during exchange', async () => {
    const f = await stepUpFixture({ discovery: true })
    await enforceSso()
    const pending = await stepUpDomainProof(f.owner.cookie, { domain: 'expiry-org.example.com' })
    const { id: _id, ...values } = await attemptRow(pending)
    const { id } = await db
      .insertInto('sso_attempts')
      .values({ ...values, expires_at: sql`clock_timestamp() + interval '2 seconds'` })
      .returning('id')
      .executeTakeFirstOrThrow()
    const expiring = { ...pending, id }
    const unlockedDiscovery = async () => {
      await assertStepUpRowsUnlocked(id)
      return json(metadata)
    }
    idp.discovery.mockImplementation(unlockedDiscovery)
    const attempt = await startStepUp(f.providerId, expiring)
    const before = await effects()
    let exchangeUnlocked = false
    const code = idp.issue(attempt, { ...f.claims, auth_time: await authTime() }, async () => {
      await assertStepUpRowsUnlocked(id)
      exchangeUnlocked = true
      await vi.waitFor(
        async () => {
          const row = await db
            .selectFrom('sso_attempts')
            .select(sql<boolean>`expires_at <= clock_timestamp()`.as('expired'))
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
          expect(row.expired).toBe(true)
        },
        { timeout: 3000 },
      )
    })
    await refusal(await callback(attempt, code))
    expect(idp.discovery).toHaveBeenCalledTimes(2)
    expect(idp.exchange).toHaveBeenCalledTimes(1)
    expect(exchangeUnlocked).toBe(true)
    expect(await effects()).toEqual(before)
    expect((await attemptRow(expiring)).step_up_link_id).toBeNull()
    expect((await attemptRow(pending)).step_up_link_id).toBeNull()
    const expired = await initiateStepUp(f.providerId, expiring)
    expect(expired.status).toBe(404)
    expect(await expired.json()).toEqual({ error: 'sso_not_found' })
  })

  it('rejects provider tests without the expected team, exact origin and authorized browser role', async () => {
    const draft = await provider({ enabled: false, discovery: true })
    const enabled = await provider()
    const saml = await db
      .insertInto('sso_providers')
      .values(samlProviderValues(fixture.team))
      .returning('id')
      .executeTakeFirstOrThrow()
    const owner = await browserSession(fixture.owner)
    const member = await browserSession(fixture.member)
    const outsider = await browserSession(fixture.otherOwner, fixture.otherTeam)
    for (const response of [
      await testRequest(draft.providerId, member.cookie),
      await testRequest(draft.providerId, outsider.cookie),
      await testRequest(draft.providerId, owner.cookie, undefined, { origin: '' }),
      await testRequest(draft.providerId, owner.cookie, undefined, {
        authorization: 'Bearer synthetic',
      }),
    ]) {
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'team_management_access_denied' })
    }
    for (const [result, status, error] of [
      [
        await post(
          { expectedRevision: 1 },
          app,
          { cookie: owner.cookie },
          providerTestPath(draft.providerId),
        ),
        409,
        'organization_context_changed',
      ],
      [
        await testRequest(draft.providerId, owner.cookie, { expectedRevision: 2 }),
        409,
        'sso_configuration_changed',
      ],
      [await testRequest(enabled.providerId, owner.cookie), 404, 'sso_not_found'],
      [await testRequest(saml.id, owner.cookie), 404, 'sso_disabled'],
      [
        await testRequest(draft.providerId, owner.cookie, {
          expectedRevision: 1,
          returnTo: '/app',
        }),
        400,
        'invalid_request',
      ],
    ] as const) {
      expect(result.status).toBe(status)
      expect(await result.json()).toMatchObject({ error })
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

  it('records a one-time owner test only after mailbox proof and the initiating browser and session', async () => {
    const { providerId, email } = await provider({ enabled: false, discovery: true })
    await db
      .insertInto('sso_policies')
      .values({ organization_id: fixture.team, admission: 'jit' })
      .execute()
    const owner = await browserSession(fixture.owner)
    const otherSession = await browserSession(fixture.owner)
    const admin = await browserSession(fixture.admin)
    const challenge = await freshProofChallenge(
      await testRequest(providerId, owner.cookie),
      owner.cookie,
    )
    const binding = challenge.cookie
      .split('; ')
      .find((part) => part.startsWith(`${bindingCookie}=`))
    expect(binding).toBeDefined()
    const retry = { expectedRevision: 1, proofAttemptId: challenge.id }
    expect(
      await freshProofChallenge(
        await testRequest(providerId, challenge.cookie, retry),
        challenge.cookie,
      ),
    ).toEqual(challenge)
    expect(idp.send).not.toHaveBeenCalled()
    expect(await audit()).toEqual([])
    await proveMailbox(challenge)
    const otherBrowser = `${bindingCookie}=${randomBytes(32).toString('base64url')}`
    const wrongProof = await testRequest(providerId, `${owner.cookie}; ${otherBrowser}`, retry)
    expect((await freshProofChallenge(wrongProof, `${owner.cookie}; ${otherBrowser}`)).id).not.toBe(
      challenge.id,
    )
    const attempt = await startProviderTest(providerId, challenge)
    expect((await attemptRow(challenge)).consumed_at).toBeInstanceOf(Date)
    expect(await attemptRow(attempt)).toMatchObject({
      kind: 'test',
      organization_id: fixture.team,
      provider_id: providerId,
      provider_revision: 1,
      user_id: fixture.owner,
      session_id: owner.id,
      mailbox: null,
      consumed_at: null,
    })
    const before = await effects()
    const claims = { sub: 'provider-test-unlinked-subject', email, email_verified: true }
    const code = idp.issue(attempt, claims)
    for (const cookie of [
      `${owner.cookie}; ${otherBrowser}`,
      `${otherSession.cookie}; ${binding}`,
      `${admin.cookie}; ${binding}`,
      binding as string,
    ])
      await refusal(await callback(attempt, code, { cookie }))
    expect(idp.exchange).not.toHaveBeenCalled()
    expect((await attemptRow(attempt)).consumed_at).toBeNull()
    await expectProviderTestRedirect(await callback(attempt, code))
    await refusal(await callback(attempt, code))
    expect(idp.exchange).toHaveBeenCalledTimes(1)
    expect((await attemptRow(attempt)).consumed_at).toBeInstanceOf(Date)
    expect(await effects()).toEqual(before)
    expect(await providerTestStatus(providerId, owner.cookie)).toMatchObject({
      enabled: false,
      testStatus: 'passed',
    })
    const events = await audit()
    expect(events.filter(({ action }) => action === testedAction)).toMatchObject([
      {
        action: testedAction,
        actor_type: 'user',
        actor_id: fixture.owner,
        credential_type: 'session',
        credential_id: owner.id,
        target_type: 'sso_provider_owner_test',
        target_id: providerId,
        details: {
          method: 'oidc',
          providerId,
          revision: 1,
          outcome: 'passed',
          correlationId: attempt.id,
        },
      },
    ])
    expect(events.some(({ action }) => action === signInAction)).toBe(false)
    const representations = JSON.stringify([await attemptRow(attempt), events])
    expect(
      [...idp.issuedSecrets, claims.sub, email].every((value) => !representations.includes(value)),
    ).toBe(true)
  })

  it('records only a redacted admin failure for a signed response with the wrong nonce', async () => {
    const { providerId } = await provider({ enabled: false })
    const admin = await browserSession(fixture.admin)
    const challenge = await freshProofChallenge(
      await testRequest(providerId, admin.cookie),
      admin.cookie,
    )
    await proveMailbox(challenge)
    const attempt = await startProviderTest(providerId, challenge)
    const before = await effects()
    const claims = {
      sub: 'private-failed-test-idp-subject',
      nonce: randomBytes(32).toString('base64url'),
    }
    await expectProviderTestRedirect(await callback(attempt, idp.issue(attempt, claims)))
    expect(await effects()).toEqual(before)
    expect(await providerTestStatus(providerId, admin.cookie)).toMatchObject({
      testStatus: 'failed',
    })
    const events = await audit()
    expect(events).toMatchObject([
      {
        action: testedAction,
        actor_id: fixture.admin,
        target_type: 'sso_provider',
        target_id: providerId,
        details: {
          method: 'oidc',
          providerId,
          revision: 1,
          outcome: 'failed',
          correlationId: attempt.id,
          reason: 'response_malformed',
        },
      },
    ])
    expect(
      [...idp.issuedSecrets, claims.sub, claims.nonce].every(
        (value) => !JSON.stringify(events).includes(value),
      ),
    ).toBe(true)
  })

  it('keeps the old test in the audit journal but clears current status after a display-name edit', async () => {
    const { providerId } = await provider({ enabled: false })
    const owner = await browserSession(fixture.owner)
    const challenge = await freshProofChallenge(
      await testRequest(providerId, owner.cookie),
      owner.cookie,
    )
    await proveMailbox(challenge)
    const passed = await startProviderTest(providerId, challenge)
    const claims = { sub: 'private-provider-test-subject' }
    await expectProviderTestRedirect(await callback(passed, idp.issue(passed, claims)))
    expect(await providerTestStatus(providerId, owner.cookie)).toMatchObject({
      revision: 1,
      testStatus: 'passed',
    })

    const anotherChallenge = await freshProofChallenge(
      await testRequest(providerId, challenge.cookie),
      challenge.cookie,
    )
    await proveMailbox(anotherChallenge)
    const stale = await startProviderTest(providerId, anotherChallenge)
    const edit = (proofAttemptId?: string) =>
      app.request(new URL(`${providersPath}/${providerId}`, publicUrl), {
        method: 'PATCH',
        headers: {
          cookie: challenge.cookie,
          origin: publicUrl,
          'content-type': 'application/json',
          'X-Expected-Organization-Id': fixture.team,
        },
        body: JSON.stringify({
          expectedRevision: 1,
          displayName: 'Renamed OIDC draft',
          proofAttemptId,
        }),
      })
    const editChallenge = await freshProofChallenge(await edit(), challenge.cookie)
    await proveMailbox(editChallenge)
    expect((await edit(editChallenge.id)).status).toBe(200)

    expect(await providerTestStatus(providerId, owner.cookie)).toMatchObject({
      revision: 2,
      testStatus: 'unknown',
    })
    await refusal(await callback(stale, idp.issue(stale, claims)))
    expect(idp.exchange).toHaveBeenCalledTimes(1)
    expect((await audit()).filter(({ action }) => action === testedAction)).toMatchObject([
      {
        details: { revision: 1, outcome: 'passed', correlationId: passed.id },
      },
    ])
  })

  it.each(['membership', 'revision'] as const)(
    'rechecks the provider test %s after the token exchange',
    async (revoked) => {
      const { providerId } = await provider({ enabled: false })
      const admin = await browserSession(fixture.admin)
      const challenge = await freshProofChallenge(
        await testRequest(providerId, admin.cookie),
        admin.cookie,
      )
      await proveMailbox(challenge)
      const attempt = await startProviderTest(providerId, challenge)
      const code = idp.issue(attempt, { sub: 'provider-test-race-subject' }, async () => {
        if (revoked === 'membership')
          await db.deleteFrom('auth.member').where('id', '=', fixture.adminMember).execute()
        else
          await db
            .updateTable('sso_providers')
            .set({ revision: 2, configuration: configuration(providerId, 2) })
            .where('id', '=', providerId)
            .execute()
      })
      const before = await effects()
      await refusal(await callback(attempt, code))
      expect(idp.exchange).toHaveBeenCalledTimes(1)
      expect((await attemptRow(attempt)).consumed_at).toBeInstanceOf(Date)
      const after = await effects()
      expect(after).toEqual({
        ...before,
        ...(revoked === 'membership' && { memberships: String(Number(before.memberships) - 1) }),
      })
      expect((await audit()).filter(({ action }) => action === testedAction)).toEqual([])
    },
  )

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
      { returnTo: '/oauth/consent?sig=synthetic&exp=123' },
      { returnTo: '/oauth/authorize?client_id=synthetic' },
      { returnTo: '/oauth/authorize?sig=synthetic&exp=123#intent=other-session' },
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
    const existingBinding = `${bindingCookie}=${randomBytes(32).toString('base64url')}`
    const restarted = await post(body, app, { cookie: existingBinding })
    const [cookie] = restarted.headers.getSetCookie()
    expect(restarted.status).toBe(200)
    expect(cookie?.startsWith(`${existingBinding};`) === true).toBe(true)
    expect(cookie).toContain('SameSite=Lax')
  })

  it('returns to the exact first-party OAuth authorization request after SSO sign-in', async () => {
    const f = await linked()
    const destination =
      '/oauth/authorize?client_id=synthetic&redirect_uri=https%3A%2F%2Fclient.example.test%2Fcallback&sig=synthetic&exp=123'
    const attempt = await start(f.providerId, app, destination)
    const response = await callback(attempt, idp.issue(attempt, f.claims))
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(destination)
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
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

  it.each(['membership', 'SCIM suspension', 'link', 'domain'] as const)(
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
          case 'SCIM suspension':
            await suspendScimMember(db, fixture.team, fixture.member)
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

  it('gives unlinked subjects identical pending outcomes and mail without an account lookup', async () => {
    const f = await linked()
    const before = await effects()
    const outcomes = []
    const messages = []
    const deliveries = []
    const accountLock = await owned.pool.connect()
    let staging: ReturnType<typeof pendingAdmission> | undefined
    try {
      await accountLock.query('BEGIN')
      await accountLock.query('LOCK TABLE auth."user" IN ACCESS EXCLUSIVE MODE')
      const finished = vi.fn()
      staging = pendingAdmission(f, { email_verified: true })
      void staging.then(finished, finished)
      await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce(), { timeout: 2500 })
    } finally {
      await accountLock.query('ROLLBACK')
      accountLock.release()
    }
    for (const email of [f.email, `unknown@${f.claim.name}`]) {
      for (const verified of [undefined, false, true]) {
        const result =
          email === f.email && verified === true && staging
            ? await staging
            : await pendingAdmission(f, {
                email,
                ...(verified !== undefined && { email_verified: verified }),
              })
        const { pending, outcome, code } = result
        outcomes.push(outcome)
        const stored = await attemptRow(pending)
        expect(stored).toMatchObject({
          consumed_at: null,
          mailbox: email,
          user_id: null,
          session_id: null,
          requires_mailbox: true,
          mailbox_proven_at: null,
        })
        for (const sensitive of ['New OIDC subject', code, ...idp.issuedSecrets])
          expect(JSON.stringify(stored)).not.toContain(sensitive)
        await expectCompletionRefused(await complete(pending))
        expect(mailboxJobs).toEqual([])
        const { message, token } = await mailboxMessage(pending)
        expect(message.to).toBe(email)
        const normalize = (value: string | undefined) =>
          value?.replaceAll(pending.id, 'ATTEMPT').replaceAll(token, 'TOKEN')
        messages.push({
          ...message,
          to: 'RECIPIENT',
          text: normalize(message.text),
          html: normalize(message.html),
        })
        deliveries.push({ pending, token })
      }
    }
    for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0])
    for (const message of messages) expect(message).toEqual(messages[0])
    expect(idp.exchange).toHaveBeenCalledTimes(6)
    const first = deliveries[0]
    if (!first) expect.unreachable('The existing mailbox received a proof')
    expect((await consumeMailbox(first.pending, first.token)).status).toBe(200)
    const link = await complete(first.pending)
    expect(link.status).toBe(200)
    expect(await link.json()).toEqual({ status: 'link_required' })
    expect(link.headers.getSetCookie().every((cookie) => !cookie.includes('session_token'))).toBe(
      true,
    )
    await expectCompletionRefused(await complete(first.pending))
    expect(await audit()).toEqual([])
    expect(await effects()).toEqual({
      ...before,
      mailboxTokens: String(Number(before.mailboxTokens) + 6),
    })
  })

  it('uses one proved admission in the original browser to create a new member and personal space', async () => {
    const f = await provider()
    await selectJit()
    const { pending } = await pendingAdmission(f, { email_verified: false, role: 'owner' })
    await expectCompletionRefused(await complete(pending))
    await proveMailbox(pending)
    const before = await effects()
    await expectCompletionRefused(
      await complete(pending, {}, app, {
        cookie: `${bindingCookie}=${randomBytes(32).toString('base64url')}; ${pending.completionCookie}`,
      }),
    )
    expect(await effects()).toEqual(before)

    const outcomes = await Promise.all([complete(pending), complete(pending)])
    expect(outcomes.map((value) => value.status).sort()).toEqual([302, 400])
    const winner = outcomes.find((value) => value.status === 302)
    const loser = outcomes.find((value) => value.status === 400)
    if (!winner || !loser) expect.unreachable('Exactly one completion succeeded')
    expect(winner.headers.get('location')).toBe('/app/bookings?tab=next#recent')
    await expectCompletionRefused(loser)
    const sessionCookie = winner.headers
      .getSetCookie()
      .find((cookie) => cookie.includes('session_token='))
    if (!sessionCookie) expect.unreachable('Admission issued a session')
    const login = await auth.api.getSession({
      headers: new Headers({ cookie: sessionCookie.split(';')[0] as string }),
      query: { disableRefresh: true, disableCookieCache: true },
    })
    expect(login?.user).toMatchObject({ email: f.email, emailVerified: true })
    expect(login?.session).toMatchObject({ activeOrganizationId: fixture.team })
    const browserProof = await proof(f.providerId)
    expect(browserProof).toMatchObject({ user_id: login?.user.id, session_id: login?.session.id })
    const memberships = await db
      .selectFrom('auth.member as member')
      .leftJoin(
        'personal_organizations as personal',
        'personal.organization_id',
        'member.organizationId',
      )
      .select(['member.organizationId', 'member.role', 'personal.user_id'])
      .where('member.userId', '=', browserProof.user_id)
      .orderBy('member.role')
      .execute()
    expect(memberships).toEqual([
      { organizationId: fixture.team, role: 'member', user_id: null },
      { organizationId: expect.any(String), role: 'owner', user_id: browserProof.user_id },
    ])
    expect((await audit()).map(({ action }) => action).sort()).toEqual([
      signInAction,
      'sso_jit.admitted',
      'sso_link.linked',
    ])
    expect(idp.exchange).toHaveBeenCalledOnce()
  })

  it('refuses an expired admission result even when this browser proved its mailbox', async () => {
    const f = await provider()
    await selectJit()
    const { pending } = await pendingAdmission(f, {
      session_expires_at: Math.floor(new Date(at(4)).getTime() / 1000),
    })
    await proveMailbox(pending)
    await vi.waitFor(
      async () => {
        const row = await db
          .selectFrom('sso_attempts')
          .select(sql<boolean>`expires_at <= clock_timestamp()`.as('expired'))
          .where('id', '=', pending.id)
          .executeTakeFirstOrThrow()
        expect(row.expired).toBe(true)
      },
      { timeout: 4500, interval: 40 },
    )
    const before = await effects()
    await expectCompletionRefused(await complete(pending))
    expect(await effects()).toEqual(before)
  })

  it('checks signup eligibility without making a denied new account or supplying its session', async () => {
    const f = await provider()
    await selectJit()
    const { pending } = await pendingAdmission(f, { email_verified: true })
    await proveMailbox(pending)
    const before = await effects()
    const closed = instance({ signupPolicy: { mode: 'closed', allowedDomains: [] } })
    const response = await complete(pending, {}, closed)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'signup_disabled' })
    expect(response.headers.getSetCookie()).toEqual([])
    expect(await effects()).toEqual(before)
    expect((await attemptRow(pending)).consumed_at).toBeNull()
  })

  it('uses the database first-user guard across different teams and provisions only one account', async () => {
    const empty = await createTestDatabase(databaseUrl as string, undefined, {
      tag: 'oidc_first_user',
    })
    const original = { db, auth, fixture, app }
    const signupPolicy = { mode: 'first-user', allowedDomains: [] } as const
    let firstUserPool: ReturnType<typeof createAuthPool> | undefined
    try {
      db = createDb(empty.pool)
      firstUserPool = createAuthPool(empty.url, signupPolicy)
      auth = createAuth({
        pool: firstUserPool,
        db,
        baseURL: publicUrl,
        secret,
        signup: signupPolicy,
        mailer: { send: async () => expect.unreachable('OIDC uses queued proof mail') },
      })
      app = instance({ signupPolicy })
      const attempts: PendingAttempt[] = []
      for (const slug of ['first-user-team-one', 'first-user-team-two']) {
        const team = await db
          .insertInto('auth.organization')
          .values({ name: 'First signup team', slug, createdAt: at(-60) })
          .returning('id')
          .executeTakeFirstOrThrow()
        fixture = { ...fixture, team: team.id }
        await selectJit()
        const { pending } = await pendingAdmission(await provider())
        await proveMailbox(pending)
        attempts.push(pending)
      }
      let completions: Promise<Response[]> | undefined
      await db.transaction().execute(async (trx) => {
        // Let both advisory-gated inserts reach the trigger before either can win.
        await sql`SELECT pg_advisory_xact_lock(7340173)`.execute(trx)
        completions = Promise.all(attempts.map((pending) => complete(pending)))
        await vi.waitFor(
          async () => {
            const { rows } = await sql<{ waiting: string }>`SELECT count(*) AS waiting
            FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'`.execute(
              db,
            )
            expect(Number(rows[0]?.waiting)).toBe(2)
          },
          { timeout: 2500 },
        )
      })
      if (!completions) expect.unreachable('Both first-user requests reached the signup trigger')
      const outcomes = await completions
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([302, 403])
      expect(await outcomes.find((outcome) => outcome.status === 403)?.json()).toEqual({
        error: 'signup_disabled',
      })
      expect(await effects()).toMatchObject({
        users: '1',
        memberships: '2',
        links: '1',
        sessions: '1',
        proofs: '1',
      })
      expect(await db.selectFrom('personal_organizations').select('user_id').execute()).toEqual([
        { user_id: expect.any(String) },
      ])
    } finally {
      db = original.db
      auth = original.auth
      fixture = original.fixture
      app = original.app
      await firstUserPool?.end()
      await empty.drop()
    }
  })

  it('waits for removal and honors the mailbox tombstone after deletion of the old account', async () => {
    const f = await provider()
    await selectJit()
    await db
      .updateTable('auth.user')
      .set({ email: f.email })
      .where('id', '=', fixture.member)
      .execute()
    const { pending } = await pendingAdmission(f)
    await proveMailbox(pending)
    let completion: Promise<Response> | undefined
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
      await recordSsoAdmissionRemoval(trx, { organizationId: fixture.team, userId: fixture.member })
      await trx.deleteFrom('auth.member').where('id', '=', fixture.memberMember).execute()
      await trx.deleteFrom('auth.user').where('id', '=', fixture.member).execute()
      const { pid } = await trx
        .selectNoFrom(sql<number>`pg_backend_pid()`.as('pid'))
        .executeTakeFirstOrThrow()
      completion = Promise.resolve(complete(pending))
      await waitForBlocked(pid)
    })
    const response = await completion
    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({ error: 'team_management_access_denied' })
    expect(
      await db.selectFrom('auth.user').select('id').where('email', '=', f.email).execute(),
    ).toEqual([])
    expect(
      await db
        .selectFrom('sso_identity_links')
        .select('id')
        .where('provider_id', '=', f.providerId)
        .execute(),
    ).toEqual([])
    expect((await attemptRow(pending)).consumed_at).toBeNull()
    expect(idp.exchange).toHaveBeenCalledOnce()
  })

  it('refuses JIT admission for a mailbox with a retained SCIM suspension', async () => {
    const f = await enrollment()
    await selectJit()
    const { pending } = await pendingAdmission(f)
    await proveMailbox(pending)
    const block = await suspendScimMember(db, fixture.team, fixture.member)
    await db.deleteFrom('auth.user').where('id', '=', fixture.member).execute()
    expect(
      await db
        .selectFrom('scim_membership_blocks')
        .select(['user_id', 'identity_email', 'cleared_at'])
        .where('id', '=', block.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ user_id: null, identity_email: f.email, cleared_at: null })

    const before = await effects()
    const denied = await complete(pending)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'team_management_access_denied' })
    expect(denied.headers.getSetCookie()).toEqual([])
    expect(await effects()).toEqual(before)
    expect((await attemptRow(pending)).consumed_at).toBeNull()
  })

  it('rechecks JIT domain verification and limits concurrent admissions to the final slot', async () => {
    const f = await provider()
    await selectJit()
    const attempts = [
      (await pendingAdmission(f)).pending,
      (await pendingAdmission(f, { sub: 'Other subject', email: `other@${f.claim.name}` })).pending,
    ] as const
    for (const attempt of attempts) await proveMailbox(attempt)
    const setOutcome = (last_check_outcome: 'failed' | 'positive') =>
      db
        .updateTable('sso_domains')
        .set({ last_check_outcome, last_checked_at: sql`clock_timestamp()` })
        .where('id', '=', f.claim.id)
        .execute()
    await setOutcome('failed')
    const before = await effects()
    const frozen = await complete(attempts[0])
    expect(frozen.status).toBe(409)
    expect(await frozen.json()).toEqual({ error: 'sso_domain_unverified' })
    expect(await effects()).toEqual(before)
    expect((await attemptRow(attempts[0])).consumed_at).toBeNull()
    await setOutcome('positive')
    await sql`
      WITH users AS (
        INSERT INTO auth."user" (name, email, "emailVerified")
        SELECT 'Capacity fixture', ${randomUUID()} || n || '@example.test', true
        FROM generate_series(1, ${teamMembershipLimit - 5}) AS n RETURNING id
      )
      INSERT INTO auth.member ("organizationId", "userId", role, "createdAt")
      SELECT ${fixture.team}, id, 'member', clock_timestamp() FROM users`.execute(db)
    const outcomes = await Promise.all(attempts.map((attempt) => complete(attempt)))
    expect(outcomes.map((value) => value.status).sort()).toEqual([302, 403])
    expect(await outcomes.find((value) => value.status === 403)?.json()).toEqual({
      error: 'organization_membership_limit_reached',
    })
    const count = await db
      .selectFrom('auth.member')
      .select((eb) => eb.fn.countAll().as('total'))
      .where('organizationId', '=', fixture.team)
      .executeTakeFirstOrThrow()
    expect(Number(count.total)).toBe(teamMembershipLimit)
    expect(idp.exchange).toHaveBeenCalledTimes(2)
  })

  it('requires explicit invitation acceptance and preserves role, expiry, team and inviter checks', async () => {
    const f = await provider()
    const { pending } = await pendingAdmission(f, { role: 'admin' })
    await proveMailbox(pending)
    const before = await effects()
    const waiting = await complete(pending)
    expect(waiting.status).toBe(409)
    expect(await waiting.json()).toEqual({ error: 'sso_invitation_required' })
    const createInvite = async (
      changes: {
        organizationId?: string
        inviterId?: string
        role?: string
        expiresAt?: string
      } = {},
    ) =>
      db
        .insertInto('auth.invitation')
        .values({
          organizationId: fixture.team,
          inviterId: fixture.owner,
          role: 'member',
          status: 'pending',
          expiresAt: at(300),
          email: f.email,
          ...changes,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
    for (const changes of [
      { organizationId: fixture.otherTeam, inviterId: fixture.otherOwner },
      { role: 'admin' },
      { expiresAt: at(-10) },
      { inviterId: fixture.otherOwner },
    ]) {
      const invite = await createInvite(changes)
      const response = await acceptInvitation(pending, invite.id)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'team_management_access_denied' })
      await db.deleteFrom('auth.invitation').where('id', '=', invite.id).execute()
    }
    expect(await effects()).toEqual(before)
    expect((await attemptRow(pending)).consumed_at).toBeNull()
    const invite = await createInvite()
    const off = await acceptInvitation(pending, invite.id, instance({ enabled: false }))
    expect(off.status).toBe(404)
    expect(await off.json()).toEqual({ error: 'sso_disabled' })
    const closed = instance({ signupPolicy: { mode: 'closed', allowedDomains: ['example.test'] } })
    const accepted = await acceptInvitation(pending, invite.id, closed)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({
      invitation: { id: invite.id, status: 'accepted', role: 'member' },
      member: { organizationId: fixture.team, role: 'member' },
    })
    expect(
      accepted.headers.getSetCookie().some((cookie) => cookie.includes('session_token=')),
    ).toBe(true)
    expect((await audit()).map(({ action }) => action)).toContain('membership.accepted')
    await expectCompletionRefused(await acceptInvitation(pending, invite.id, closed))
    await expectCompletionRefused(await complete(pending))
  })

  it('keeps an existing team proof through another person’s invitation, JIT admission, role change and departure', async () => {
    app = instance({ nativeAuth: oidcAuth })
    const f = await linked()
    await enforceSso()
    const eventId = await createFixtures(db).eventType(fixture.team, null, {
      hosts: [{ userId: fixture.owner }],
    })
    const signIn = await start(f.providerId)
    const signedIn = await callback(signIn, idp.issue(signIn, f.claims))
    expect(signedIn.status).toBe(302)
    const survivor = sessionCookie(signedIn)
    const assertReadable = async () => {
      const response = await readEvents(survivor)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ data: [{ id: eventId }] })
    }
    await assertReadable()

    const invitedEmail = `invited@${f.claim.name}`
    const { pending: invited } = await pendingAdmission({ ...f, email: invitedEmail })
    await proveMailbox(invited)
    const invitation = await db
      .insertInto('auth.invitation')
      .values({
        organizationId: fixture.team,
        inviterId: fixture.owner,
        role: 'member',
        status: 'pending',
        expiresAt: at(300),
        email: invitedEmail,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await assertReadable()
    const accepted = await acceptInvitation(invited, invitation.id)
    expect(accepted.status).toBe(200)
    await assertReadable()

    await db
      .updateTable('sso_policies')
      .set({ admission: 'jit', policy_revision: 2 })
      .where('organization_id', '=', fixture.team)
      .execute()
    const { pending: joining } = await pendingAdmission(
      { ...f, email: `jit@${f.claim.name}` },
      { sub: 'JIT subject' },
    )
    await proveMailbox(joining)
    const admitted = await complete(joining)
    expect(admitted.status).toBe(302)
    await assertReadable()

    const owner = await recoveryTarget(f, fixture.owner)
    const ownerSignIn = await start(f.providerId)
    const signedInOwner = await callback(ownerSignIn, idp.issue(ownerSignIn, owner.claims))
    expect(signedInOwner.status).toBe(302)
    const postToTeam = (operation: string, cookie: string, input: Record<string, unknown>) =>
      post(
        { organizationId: fixture.team, ...input },
        app,
        {
          cookie,
          'X-Expected-Organization-Id': fixture.team,
        },
        `/api/auth/organization/${operation}`,
      )
    const changed = await postToTeam('update-member-role', sessionCookie(signedInOwner), {
      memberId: fixture.adminMember,
      role: 'member',
    })
    expect(changed.status).toBe(200)
    await assertReadable()
    const departed = await postToTeam('leave', sessionCookie(admitted), {})
    expect(departed.status).toBe(200)
    await assertReadable()
  })

  /** Lock the team and record a local removal as the OIDC-on removal paths do. */
  async function removeMember(userId: string, deleteAccount = false) {
    await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('auth.organization')
        .select('id')
        .where('id', '=', fixture.team)
        .forUpdate()
        .execute()
      await recordSsoAdmissionRemoval(trx, { organizationId: fixture.team, userId })
      await trx
        .deleteFrom('auth.member')
        .where('organizationId', '=', fixture.team)
        .where('userId', '=', userId)
        .execute()
      if (deleteAccount) await trx.deleteFrom('auth.user').where('id', '=', userId).execute()
    })
  }

  /** A pending member invitation, optionally issued by SCIM provisioning with its bound claim. */
  async function issueInvitation(email: string, scim: boolean) {
    const invitation = await db
      .insertInto('auth.invitation')
      .values({
        organizationId: fixture.team,
        inviterId: fixture.owner,
        role: 'member',
        status: 'pending',
        expiresAt: at(300),
        email,
        createdAt: sql<Date>`clock_timestamp()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    if (!scim) return { invitationId: invitation.id, entryId: undefined }
    const connection =
      (await db
        .selectFrom('scim_connections')
        .select('id')
        .where('organization_id', '=', fixture.team)
        .executeTakeFirst()) ??
      (await db
        .insertInto('scim_connections')
        .values({ organization_id: fixture.team })
        .returning('id')
        .executeTakeFirstOrThrow())
    const entry = await db
      .insertInto('scim_users')
      .values({
        organization_id: fixture.team,
        connection_id: connection.id,
        user_name: email,
        work_email: email,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('scim_user_claims')
      .values({
        organization_id: fixture.team,
        connection_id: connection.id,
        scim_user_id: entry.id,
        invitation_id: invitation.id,
        work_email: email,
        expires_at: at(300),
      })
      .execute()
    return { invitationId: invitation.id, entryId: entry.id }
  }

  async function claimLinked(entryId: string | undefined) {
    if (!entryId) return null
    const entry = await db
      .selectFrom('scim_users')
      .select('linked_user_id')
      .where('id', '=', entryId)
      .executeTakeFirstOrThrow()
    return entry.linked_user_id !== null
  }

  it.each([
    { scim: false, removed: false },
    { scim: false, removed: true },
    { scim: true, removed: false },
    { scim: true, removed: true },
  ])(
    'decides invitation kind %o identically through native and SSO acceptance',
    async ({ scim, removed }) => {
      const scimApp = instance({ scimClaims: true })
      const f = await provider()
      const { pending } = await pendingAdmission(f)
      await proveMailbox(pending)

      // Native: an existing account outside the team, removed earlier or never a member.
      const nativeMailbox = await db
        .selectFrom('auth.user')
        .select('email')
        .where('id', '=', fixture.member)
        .executeTakeFirstOrThrow()
      if (removed) await removeMember(fixture.member)
      else
        await db
          .deleteFrom('auth.member')
          .where('organizationId', '=', fixture.team)
          .where('userId', '=', fixture.member)
          .execute()
      // SSO: the proved mailbox's earlier account was removed and deleted, or never existed.
      if (removed) {
        const earlier = await db
          .insertInto('auth.user')
          .values({ name: 'Earlier account', email: f.email, emailVerified: true })
          .returning('id')
          .executeTakeFirstOrThrow()
        await db
          .insertInto('auth.member')
          .values({
            organizationId: fixture.team,
            userId: earlier.id,
            role: 'member',
            createdAt: new Date(),
          })
          .execute()
        await removeMember(earlier.id, true)
      }
      const blocks = await db
        .selectFrom('scim_membership_blocks')
        .select('identity_email')
        .where('organization_id', '=', fixture.team)
        .where('cleared_at', 'is', null)
        .orderBy('identity_email')
        .execute()
      expect(blocks.map(({ identity_email }) => identity_email)).toEqual(
        removed ? [f.email, nativeMailbox.email].sort() : [],
      )

      const native = await issueInvitation(nativeMailbox.email, scim)
      const sso = await issueInvitation(f.email, scim)
      const session = await browserSession(fixture.member)
      const nativeResponse = await post(
        { invitationId: native.invitationId },
        scimApp,
        {
          cookie: session.cookie,
        },
        acceptInvitationPath,
      )
      const ssoResponse = await acceptInvitation(pending, sso.invitationId, scimApp)

      const refused = scim && removed
      const outcome = (response: Response, entryId: string | undefined) =>
        Promise.resolve(claimLinked(entryId)).then((claimed) => ({
          status: response.status,
          claimed,
        }))
      const expected = { status: refused ? 403 : 200, claimed: scim ? !refused : null }
      expect({
        native: await outcome(nativeResponse, native.entryId),
        sso: await outcome(ssoResponse, sso.entryId),
      }).toEqual({ native: expected, sso: expected })
      if (refused) {
        expect(await ssoResponse.json()).toEqual({ error: 'team_management_access_denied' })
        expect(
          await db.selectFrom('auth.user').select('id').where('email', '=', f.email).execute(),
        ).toEqual([])
        expect((await attemptRow(pending)).consumed_at).toBeNull()
      }
      if (scim && !refused) {
        const joined = await db
          .selectFrom('auth.user')
          .select('id')
          .where('email', '=', f.email)
          .executeTakeFirstOrThrow()
        const entry = await db
          .selectFrom('scim_users')
          .select(['linked_user_id', 'linked_member_id'])
          .where('id', '=', sso.entryId as string)
          .executeTakeFirstOrThrow()
        expect(entry).toEqual({ linked_user_id: joined.id, linked_member_id: expect.any(String) })
        expect(
          (await audit()).filter(
            ({ action, target_id }) => action === 'scim_user.claimed' && target_id === sso.entryId,
          ),
        ).toHaveLength(1)
      }
    },
  )

  it('honors a removal made before the team configured OIDC or JIT', async () => {
    const domain = `team-${randomUUID().slice(0, 8)}.example.com`
    const email = `linked@${domain}`
    await db.updateTable('auth.user').set({ email }).where('id', '=', fixture.member).execute()
    // Neither an OIDC provider nor a JIT policy exists when the member is removed.
    await removeMember(fixture.member, true)
    const f = await provider({ domain })
    expect(f.email).toBe(email)
    await selectJit()
    const { pending } = await pendingAdmission(f)
    await proveMailbox(pending)
    const response = await complete(pending)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'team_management_access_denied' })
    expect(
      await db.selectFrom('auth.user').select('id').where('email', '=', email).execute(),
    ).toEqual([])
  })

  it('rejects missing mailboxes, mismatching signed issuer or nonce, and expired IdP sessions', async () => {
    const f = await linked()
    const before = await effects()
    for (const claims of [
      { sub: f.claims.sub },
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

  it('finishes exactly one verified mailbox change for the original link and exchanges no further code', async () => {
    const f = await linked()
    const before = await effects()
    const email = `changed@${f.claim.name}`
    const { pending, outcome } = await pendingMailbox(f, email, {
      email_verified: true,
      name: 'private-idp-profile-fixture',
    })
    const stored = await attemptRow(pending)
    expect(stored).toMatchObject({
      kind: 'sign_in',
      organization_id: fixture.team,
      provider_id: f.providerId,
      provider_revision: 1,
      mailbox: email,
      requires_mailbox: true,
      mailbox_proven_at: null,
      consumed_at: null,
    })
    const envelope = pending.completionCookie.slice(pending.completionCookie.indexOf('=') + 1)
    const browserBinding = pending.cookie.slice(pending.cookie.indexOf('=') + 1)
    const projection = decryptCredential(
      configurationKey,
      JSON.stringify([
        'hourmere-oidc-completion-v1',
        ssoProviderConfigurationAad({
          organizationId: fixture.team,
          providerId: f.providerId,
          revision: 1,
        }),
        pending.id,
        hash(browserBinding, 'hex'),
      ]),
      Buffer.from(envelope, 'base64url'),
    )
    const representations = JSON.stringify([stored, projection, outcome, await audit()])
    expect(idp.issuedSecrets).toHaveLength(5)
    expect(
      [...idp.issuedSecrets, 'private-idp-profile-fixture'].every(
        (value) => !representations.includes(value),
      ),
    ).toBe(true)
    expect(await effects()).toEqual(before)

    await expectCompletionRefused(await complete(pending))
    const { token } = await mailboxMessage(pending)
    const tokenRow = await db
      .selectFrom('sso_mailbox_tokens')
      .select('token_digest')
      .where('attempt_id', '=', pending.id)
      .executeTakeFirstOrThrow()
    expect(tokenRow.token_digest === hash(token, 'hex')).toBe(true)
    expect((await consumeMailbox(pending, token)).status).toBe(200)

    expect(
      (await complete(pending, {}, app, { origin: 'https://other.example.test' })).status,
    ).toBe(403)
    expect((await complete(pending, {}, app, { authorization: 'Bearer synthetic' })).status).toBe(
      403,
    )
    const otherBrowser = `${bindingCookie}=${randomBytes(32).toString('base64url')}`
    await expectCompletionRefused(
      await complete(pending, {}, app, { cookie: `${otherBrowser}; ${pending.completionCookie}` }),
    )
    await expectCompletionRefused(await complete(pending, {}, app, { cookie: pending.cookie }))
    const suppliedClaims = await complete(pending, {
      email: f.email,
      sub: f.claims.sub,
      returnTo: '/app/other',
    })
    expect(suppliedClaims.status).toBe(400)
    expect(await suppliedClaims.json()).toEqual({ error: 'invalid_request' })

    const responses = await Promise.all([complete(pending), complete(pending, {}, instance())])
    expect(responses.map(({ status }) => status).sort()).toEqual([302, 400])
    const accepted = responses.find(({ status }) => status === 302) as Response
    const denied = responses.find(({ status }) => status === 400) as Response
    await expectCompletionRefused(denied)
    expect(accepted.headers.get('location')).toBe('/app/bookings?tab=next#recent')
    const cookie = accepted.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    const signedIn = await app.request(new URL('/api/auth/get-session', publicUrl), {
      headers: { cookie },
    })
    const issued = await proof(f.providerId)
    expect(await signedIn.json()).toMatchObject({
      user: { id: fixture.member, email: f.email },
      session: { id: issued.session_id },
    })
    expect(issued).toMatchObject({ link_id: f.link.id, link_generation: f.link.generation + 1 })
    expect(
      await db
        .selectFrom('sso_identity_links')
        .selectAll()
        .where('id', '=', f.link.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      user_id: fixture.member,
      generation: f.link.generation + 1,
      proven_email: email,
    })
    expect((await effects()).sessions).toBe(String(Number(before.sessions) + 1))
    expect((await effects()).proofs).toBe(String(Number(before.proofs) + 1))
    expect(idp.exchange).toHaveBeenCalledTimes(1)
    const later = await start(f.providerId)
    expect(
      (await callback(later, idp.issue(later, { ...f.claims, email }))).headers.get('location'),
    ).toBe('/app/bookings?tab=next#recent')
  })

  it('delivers the same pending outcome and message for a collision and discloses it only after proof', async () => {
    const f = await linked()
    const collidingEmail = `occupied@${f.claim.name}`
    const freeEmail = `free@${f.claim.name}`
    await db
      .updateTable('auth.user')
      .set({ email: collidingEmail })
      .where('id', '=', fixture.otherOwner)
      .execute()
    const before = await effects()
    const free = await pendingMailbox(f, freeEmail, { email_verified: false })
    const occupied = await pendingMailbox(f, collidingEmail, { email_verified: true })
    expect(occupied.outcome).toEqual(free.outcome)
    for (const { pending } of [free, occupied])
      await expectCompletionRefused(await complete(pending))

    const delivery = await mailboxMessage(free.pending)
    const otherDelivery = await mailboxMessage(occupied.pending)
    expect([delivery.message.to, otherDelivery.message.to]).toEqual([freeEmail, collidingEmail])
    function messageShape({ message, token }: typeof delivery, pending: PendingAttempt) {
      const normalize = (value: string | undefined) =>
        value?.replaceAll(pending.id, 'ATTEMPT').replaceAll(token, 'TOKEN')
      return {
        ...message,
        to: 'RECIPIENT',
        text: normalize(message.text),
        html: normalize(message.html),
      }
    }
    expect(messageShape(otherDelivery, occupied.pending)).toEqual(
      messageShape(delivery, free.pending),
    )
    expect((await consumeMailbox(occupied.pending, otherDelivery.token)).status).toBe(200)
    const collision = await complete(occupied.pending)
    expect(collision.status).toBe(409)
    expect(await collision.json()).toEqual({ error: 'sso_email_collision' })
    await expectCompletionRefused(await complete(occupied.pending))
    expect(
      await db
        .selectFrom('sso_attempts')
        .select('id')
        .where('id', '=', occupied.pending.id)
        .executeTakeFirst(),
    ).toBeUndefined()
    expect(
      await db
        .selectFrom('sso_mailbox_tokens')
        .select('attempt_id')
        .where('attempt_id', '=', occupied.pending.id)
        .executeTakeFirst(),
    ).toBeUndefined()
    expect(
      await db
        .selectFrom('sso_identity_links')
        .selectAll()
        .where('id', '=', f.link.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(f.link)
    expect(await effects()).toEqual({
      ...before,
      mailboxTokens: String(Number(before.mailboxTokens) + 1),
    })
    expect(JSON.stringify(await audit()).includes(collidingEmail)).toBe(false)
  })

  it('will use only a proof recorded for its own attempt, even with one browser and mailbox', async () => {
    const f = await linked()
    const { pending: first } = await pendingMailbox(f)
    const { pending: second } = await pendingMailbox(f, undefined, {}, first.cookie)
    const { token } = await mailboxMessage(first)
    const wrongProof = await consumeMailbox(second, token)
    expect(wrongProof.status).toBe(400)
    expect(await wrongProof.json()).toEqual({ error: 'sso_mailbox_proof_invalid' })
    expect((await consumeMailbox(first, token)).status).toBe(200)
    await expectCompletionRefused(await complete(second))
    await expectCompletionRefused(
      await complete(second, {}, app, { cookie: `${first.cookie}; ${first.completionCookie}` }),
    )
    expect((await attemptRow(second)).mailbox_proven_at).toBeNull()
    await proveMailbox(second)
    const cookieName = first.completionCookie.split('=')[0]
    const otherEnvelope = second.completionCookie.slice(second.completionCookie.indexOf('=') + 1)
    await expectCompletionRefused(
      await complete(first, {}, app, { cookie: `${first.cookie}; ${cookieName}=${otherEnvelope}` }),
    )
    expect((await complete(first)).status).toBe(302)
  })

  it.each(['mailbox proof', 'pending result'] as const)(
    'refuses completion after its %s expires',
    async (expiry) => {
      const f = await linked()
      const deadline = Math.floor(new Date(at(3)).getTime() / 1000)
      const { pending } = await pendingMailbox(
        f,
        undefined,
        expiry === 'pending result' ? { session_expires_at: deadline } : {},
      )
      if (expiry === 'pending result')
        expect((await attemptRow(pending)).expires_at).toEqual(new Date(deadline * 1000))
      await proveMailbox(pending, expiry === 'mailbox proof' ? 2 : undefined)
      await vi.waitFor(
        async () => {
          const row = await db
            .selectFrom('sso_attempts')
            .select([
              sql<boolean>`mailbox_proof_expires_at <= clock_timestamp()`.as('proof_expired'),
              sql<boolean>`expires_at <= clock_timestamp()`.as('attempt_expired'),
            ])
            .where('id', '=', pending.id)
            .executeTakeFirstOrThrow()
          expect(expiry === 'mailbox proof' ? row.proof_expired : row.attempt_expired).toBe(true)
        },
        { timeout: 3500, interval: 50 },
      )
      const before = await effects()
      await expectCompletionRefused(await complete(pending))
      expect(await effects()).toEqual(before)
    },
  )

  it.each(['member removal', 'provider retirement', 'provider deletion'] as const)(
    'refuses completion when concurrent %s commits first',
    async (revocation) => {
      const f = await linked()
      const { pending } = await pendingMailbox(f)
      await proveMailbox(pending)
      const before = await effects()
      const blocker = await owned.pool.connect()
      let completion: Promise<Response> | undefined
      try {
        await blocker.query('BEGIN')
        const { rows } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        if (revocation === 'member removal') {
          await blocker.query('DELETE FROM auth.member WHERE id = $1', [fixture.memberMember])
        } else if (revocation === 'provider retirement') {
          await blocker.query('SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE', [
            fixture.team,
          ])
          await blocker.query(
            `UPDATE sso_providers SET retired_at = clock_timestamp(), enabled = false,
             revision = 2, configuration = $2 WHERE id = $1`,
            [f.providerId, configuration(f.providerId, 2)],
          )
        } else {
          // The provider guard allows hard deletion only through its owning team's deletion.
          await blocker.query('DELETE FROM auth.organization WHERE id = $1', [fixture.team])
        }
        completion = Promise.resolve(complete(pending))
        await waitForBlocked(rows[0]?.pid)
        await blocker.query('COMMIT')
      } finally {
        await blocker.query('ROLLBACK')
        blocker.release()
      }
      await expectCompletionRefused(await completion)
      const after = await effects()
      expect(after.sessions).toBe(before.sessions)
      expect(after.proofs).toBe(before.proofs)
      if (revocation === 'provider retirement') {
        expect((await attemptRow(pending)).consumed_at).toBeNull()
      }
      expect(idp.exchange).toHaveBeenCalledTimes(1)
    },
  )

  it('self-links only after independent mailbox proof, the original session and explicit completion', async () => {
    const f = await enrollment({ discovery: true })
    const actor = await browserSession(fixture.member, fixture.team.toUpperCase())
    const secondSession = await browserSession(fixture.member)
    await db
      .insertInto('sso_policies')
      .values({ organization_id: fixture.team, require_sso: true })
      .execute()
    await expectSsoRequired(actor.cookie)
    const before = await effects()

    // A verified IdP email cannot substitute for the Hourmere mailbox challenge.
    const linkedClaims = { ...f.claims, email: f.email.toUpperCase(), email_verified: true }
    const { pending: ordinarySignIn } = await pendingAdmission(f, linkedClaims)
    await expectCompletionRefused(await complete(ordinarySignIn))
    expect(await effects()).toEqual(before)
    idp.send.mockClear()
    idp.exchange.mockClear()

    const challenge = await requestLinkProof(f.providerId, actor.cookie)
    const me = await app.request(new URL('/api/v1/me', publicUrl), {
      headers: { cookie: challenge.cookie },
    })
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual({
      user: { id: fixture.member, name: expect.any(String), email: f.email },
      personalOrganizationId: null,
      organization: { id: fixture.team, name: '', slug: '', personal: false },
      principal: { kind: 'session', apiKeyId: null },
      sso: {
        requireSso: true,
        providers: [{ id: f.providerId, revision: 1, displayName: 'Synthetic OIDC' }],
        attempts: [
          {
            id: challenge.id,
            providerId: null,
            phase: 'fresh_proof',
            mailboxProven: false,
            expiresAt: expect.any(String),
          },
        ],
        links: [],
        proofs: [],
      },
    })
    const retry = { proofAttemptId: challenge.id }
    expect(
      await freshProofChallenge(
        await linkRequest(f.providerId, challenge.cookie, retry),
        challenge.cookie,
      ),
    ).toEqual(challenge)
    expect(idp.send).not.toHaveBeenCalled()
    const { message, token } = await mailboxMessage(challenge)
    expect(message.to).toBe(f.email)
    const binding = challenge.cookie
      .split('; ')
      .find((part) => part.startsWith(`${bindingCookie}=`))
    expect(binding).toBeDefined()
    const wrongSessionCookie = `${secondSession.cookie}; ${binding}`
    const wrongProof = await consumeMailbox({ ...challenge, cookie: wrongSessionCookie }, token)
    expect(wrongProof.status).toBe(400)
    expect(await wrongProof.json()).toEqual({ error: 'sso_mailbox_proof_invalid' })
    const consumed = await consumeMailbox(challenge, token)
    expect(consumed.status).toBe(200)
    expect(await consumed.json()).toEqual({ status: 'proven' })
    const proofTime = (await attemptRow(challenge)).mailbox_proven_at
    expect(proofTime).toBeInstanceOf(Date)
    const wrongRetry = await linkRequest(f.providerId, wrongSessionCookie, retry)
    expect((await freshProofChallenge(wrongRetry, wrongSessionCookie)).id).not.toBe(challenge.id)
    expect((await attemptRow(challenge)).consumed_at).toBeNull()

    const attempt = await startLink(f.providerId, challenge)
    expect((await attemptRow(challenge)).consumed_at).toBeInstanceOf(Date)
    expect(await attemptRow(attempt)).toMatchObject({
      kind: 'link',
      organization_id: fixture.team,
      provider_id: f.providerId,
      user_id: fixture.member,
      session_id: actor.id,
    })
    const code = idp.issue(attempt, linkedClaims)
    await refusal(await callback(attempt, code, { cookie: wrongSessionCookie }))
    expect(idp.exchange).not.toHaveBeenCalled()
    const pending = await pendingLink(attempt, code)
    expect((await effects()).links).toBe(before.links)
    await expectCompletionRefused(
      await complete(pending, {}, app, {
        cookie: `${wrongSessionCookie}; ${pending.completionCookie}`,
      }),
    )
    const otherBrowser = `${bindingCookie}=${randomBytes(32).toString('base64url')}`
    await expectCompletionRefused(
      await complete(pending, {}, app, {
        cookie: `${actor.cookie}; ${otherBrowser}; ${pending.completionCookie}`,
      }),
    )
    expect((await effects()).links).toBe(before.links)

    const responses = await Promise.all([complete(pending), complete(pending, {}, instance())])
    expect(responses.map(({ status }) => status).sort()).toEqual([302, 400])
    const accepted = responses.find(({ status }) => status === 302) as Response
    const denied = responses.find(({ status }) => status === 400) as Response
    await expectCompletionRefused(denied)
    expect(accepted.headers.get('location')).toBe('/app/settings')
    await expectSsoRequired(actor.cookie)
    expect(
      accepted.headers.getSetCookie().some((cookie) => cookie.includes('session_token=')),
    ).toBe(false)
    expect(idp.exchange).toHaveBeenCalledTimes(1)
    const link = await db
      .selectFrom('sso_identity_links')
      .selectAll()
      .where('provider_id', '=', f.providerId)
      .executeTakeFirstOrThrow()
    expect(link).toMatchObject({
      organization_id: fixture.team,
      user_id: fixture.member,
      issuer,
      subject: f.claims.sub,
      proven_email: f.email,
      email_proven_at: proofTime,
    })
    const { users, accounts, memberships, sessions, proofs, links } = await effects()
    expect({ users, accounts, memberships, sessions, proofs, links }).toMatchObject({
      users: before.users,
      accounts: before.accounts,
      memberships: before.memberships,
      sessions: before.sessions,
      proofs: before.proofs,
      links: String(Number(before.links) + 1),
    })
    const linkEvents = (await audit()).filter(({ action }) => action === 'sso_link.linked')
    expect(linkEvents).toMatchObject([{ actor_id: fixture.member, credential_id: actor.id }])
    const journal = JSON.stringify(linkEvents)
    expect(
      [f.email, f.claims.sub, ...idp.issuedSecrets].every((value) => !journal.includes(value)),
    ).toBe(true)
  })

  it('rejects cross-origin, bearer and unadmitted callers and accepts only strict self-link input', async () => {
    const f = await enrollment()
    const actor = await browserSession(fixture.member)
    const outsiderEmail = `invited@${f.claim.name}`
    await db
      .updateTable('auth.user')
      .set({ email: outsiderEmail })
      .where('id', '=', fixture.otherOwner)
      .execute()
    const outsider = await browserSession(fixture.otherOwner)
    await db
      .insertInto('auth.invitation')
      .values({
        inviterId: fixture.owner,
        organizationId: fixture.team,
        role: 'member',
        status: 'pending',
        email: outsiderEmail,
        expiresAt: at(300),
      })
      .execute()
    const me = await app.request(new URL('/api/v1/me', publicUrl), {
      headers: { cookie: outsider.cookie },
    })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ organization: { personal: true } })
    const before = await effects()
    for (const response of [
      await linkRequest(
        f.providerId,
        actor.cookie,
        {},
        { origin: 'https://different.example.test' },
      ),
      await linkRequest(f.providerId, actor.cookie, {}, { authorization: 'Bearer synthetic' }),
      await linkRequest(f.providerId, outsider.cookie),
    ]) {
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'team_management_access_denied' })
    }
    const missingContext = await post({}, app, { cookie: actor.cookie }, linkPath(f.providerId))
    expect(missingContext.status).toBe(409)
    expect(await missingContext.json()).toMatchObject({ error: 'organization_context_changed' })
    const badInput = await linkRequest(f.providerId, actor.cookie, { userId: fixture.otherOwner })
    expect(badInput.status).toBe(400)
    expect(await badInput.json()).toMatchObject({ error: 'invalid_request' })
    expect(await effects()).toEqual(before)
    expect(idp.send).not.toHaveBeenCalled()
    expect(
      await db
        .selectFrom('sso_attempts')
        .select('id')
        .where('organization_id', '=', fixture.team)
        .execute(),
    ).toEqual([])
  })

  it('refuses link when the IdP asserts a different mailbox despite email_verified', async () => {
    const f = await enrollment()
    const actor = await browserSession(fixture.member)
    const challenge = await requestLinkProof(f.providerId, actor.cookie)
    await proveMailbox(challenge)
    const attempt = await startLink(f.providerId, challenge)
    const before = await effects()
    const code = idp.issue(attempt, {
      ...f.claims,
      email: `different@${f.claim.name}`,
      email_verified: true,
    })
    await refusal(await callback(attempt, code))
    expect(await effects()).toEqual(before)
  })

  it.each(['its frozen mailbox changes', 'its team membership is suspended by SCIM'] as const)(
    'refuses link completion after %s',
    async (change) => {
      const f = await enrollment()
      const pending = await prepareLink(f)
      const before = await effects()
      if (change === 'its frozen mailbox changes') {
        await db
          .updateTable('auth.user')
          .set({ email: `different@${f.claim.name}` })
          .where('id', '=', fixture.member)
          .execute()
      } else await suspendScimMember(db, fixture.team, fixture.member)
      await expectCompletionRefused(await complete(pending))
      expect(await effects()).toEqual(before)
    },
  )

  it('refuses a subject bound to another user before completion and preserves their link', async () => {
    const f = await enrollment()
    const pending = await prepareLink(f)
    const other = await db
      .insertInto('sso_identity_links')
      .values({
        organization_id: fixture.team,
        provider_id: f.providerId,
        user_id: fixture.coOwner,
        issuer,
        subject: f.claims.sub,
        proven_email: `other@${f.claim.name}`,
        email_proven_at: at(-60),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    const before = await effects()
    await expectCompletionRefused(await complete(pending))
    expect(await effects()).toEqual(before)
    expect(
      await db
        .selectFrom('sso_identity_links')
        .selectAll()
        .where('id', '=', other.id)
        .executeTakeFirst(),
    ).toEqual(other)
  })

  it('requires independent mailbox proof from the exact browser and session to unlink only the caller', async () => {
    const f = await linked()
    const other = await recoveryTarget(f, fixture.admin)
    const actor = await browserSession(fixture.member)
    const otherSession = await browserSession(fixture.member)
    const path = linkPath(f.providerId)
    const input = { linkId: f.link.id }
    await db
      .insertInto('sso_policies')
      .values({ organization_id: fixture.team, require_sso: true })
      .execute()
    await expectSsoRequired(actor.cookie)

    const wrongLink = await recoveryRequest(path, actor.cookie, { linkId: other.link.id })
    expect(wrongLink.status).toBe(404)
    expect(await wrongLink.json()).toEqual({ error: 'sso_not_found' })
    for (const response of [
      await recoveryRequest(path, actor.cookie, input, {
        headers: { origin: 'https://different.example.test' },
      }),
      await recoveryRequest(path, actor.cookie, input, {
        headers: { authorization: 'Bearer synthetic' },
      }),
    ]) {
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'team_management_access_denied' })
    }

    const challenge = await freshProofChallenge(
      await recoveryRequest(path, actor.cookie, input),
      actor.cookie,
    )
    const retry = { ...input, proofAttemptId: challenge.id }
    expect(
      await freshProofChallenge(
        await recoveryRequest(path, challenge.cookie, retry),
        challenge.cookie,
      ),
    ).toEqual(challenge)
    const { message, token } = await mailboxMessage(challenge)
    expect(message.to).toBe(f.email)
    const binding = challenge.cookie
      .split('; ')
      .find((part) => part.startsWith(`${bindingCookie}=`))
    expect(binding).toBeDefined()
    const wrongSessionCookie = `${otherSession.cookie}; ${binding}`
    const wrongConsume = await consumeMailbox({ ...challenge, cookie: wrongSessionCookie }, token)
    expect(wrongConsume.status).toBe(400)
    expect(await wrongConsume.json()).toEqual({ error: 'sso_mailbox_proof_invalid' })
    expect((await consumeMailbox(challenge, token)).status).toBe(200)
    const wrongBrowserCookie = `${actor.cookie}; ${bindingCookie}=${randomBytes(32).toString('base64url')}`
    for (const cookie of [wrongSessionCookie, wrongBrowserCookie])
      expect(
        (await freshProofChallenge(await recoveryRequest(path, cookie, retry), cookie)).id,
      ).not.toBe(challenge.id)
    expect(await storedLink(f.link.id)).toEqual(f.link)
    expect(recoveryJobs).toEqual([])
    expect((await attemptRow(challenge)).consumed_at).toBeNull()

    const removed = await recoveryRequest(path, challenge.cookie, retry)
    expect(removed.status).toBe(204)
    expect(await removed.text()).toBe('')
    await expectSsoRequired(actor.cookie)
    expect(await storedLink(f.link.id)).toEqual({
      ...f.link,
      generation: f.link.generation + 1,
      retired_at: expect.any(Date),
    })
    expect(await storedLink(other.link.id)).toEqual(other.link)
    expect((await attemptRow(challenge)).consumed_at).toBeInstanceOf(Date)
    expect(recoveryJobs).toEqual([
      {
        name: 'sso-link-removal-email',
        payload: {
          userId: fixture.member,
          language: expect.any(String),
        },
      },
    ])
    expect(await audit()).toEqual([
      expect.objectContaining({
        action: 'sso_link.unlinked',
        actor_id: fixture.member,
        credential_id: actor.id,
        target_id: f.link.id,
      }),
    ])
    expect(idp.send).not.toHaveBeenCalled()
  })

  it('keeps administrator identity removal inside the active team and provider', async () => {
    const local = await linked()
    const secondProvider = await provider()
    const other = await db
      .insertInto('sso_providers')
      .values({ ...oidcProviderValues(fixture.otherTeam), enabled: true })
      .returning(['id', 'issuer'])
      .executeTakeFirstOrThrow()
    const foreign = await db
      .insertInto('sso_identity_links')
      .values({
        organization_id: fixture.otherTeam,
        provider_id: other.id,
        user_id: fixture.otherOwner,
        issuer: other.issuer,
        subject: 'Foreign subject',
        proven_email: 'foreign@example.test',
        email_proven_at: at(-60),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    // Membership in both teams still does not let an administrator cross the active-team boundary.
    await db
      .insertInto('auth.member')
      .values({
        organizationId: fixture.team,
        userId: fixture.otherOwner,
        role: 'member',
        createdAt: at(0),
      })
      .execute()
    const actor = await browserSession(fixture.owner)
    const foreignActor = await browserSession(fixture.otherOwner, fixture.otherTeam)
    for (const response of [
      await recoveryRequest(removeLinkPath(other.id, foreign.id), actor.cookie, {}),
      await recoveryRequest(removeLinkPath(local.providerId, foreign.id), actor.cookie, {}),
      await recoveryRequest(
        removeLinkPath(secondProvider.providerId, local.link.id),
        actor.cookie,
        {},
      ),
      await recoveryRequest(removeLinkPath(local.providerId, randomUUID()), actor.cookie, {}),
      await recoveryRequest(
        removeLinkPath(local.providerId, local.link.id),
        foreignActor.cookie,
        {},
        {
          headers: { 'X-Expected-Organization-Id': fixture.otherTeam },
        },
      ),
    ]) {
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'sso_not_found' })
    }
    expect(await storedLink(foreign.id)).toEqual(foreign)
    expect(await storedLink(local.link.id)).toEqual(local.link)
    expect(await audit()).toEqual([])
    expect(recoveryJobs).toEqual([])
  })

  it('allows admins to retire admins and members while an owner link needs a different owner', async () => {
    const f = await linked()
    const owner = await recoveryTarget(f, fixture.coOwner)
    const adminTarget = await recoveryTarget(f, fixture.admin)
    const peerAdmin = await db
      .updateTable('auth.member')
      .set({ role: 'admin' })
      .where('id', '=', fixture.memberMember)
      .returning('userId')
      .executeTakeFirstOrThrow()
    const admin = await browserSession(peerAdmin.userId)
    const adminAsTarget = await browserSession(fixture.admin)
    const ownerAsTarget = await browserSession(fixture.coOwner)
    const differentOwner = await browserSession(fixture.owner)
    const ownerPath = removeLinkPath(f.providerId, owner.link.id)
    const adminPath = removeLinkPath(f.providerId, adminTarget.link.id)
    for (const response of [
      await recoveryRequest(ownerPath, admin.cookie, {}),
      await recoveryRequest(ownerPath, ownerAsTarget.cookie, {}),
      await recoveryRequest(adminPath, adminAsTarget.cookie, {}),
    ]) {
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'team_management_access_denied' })
    }
    expect(await storedLink(owner.link.id)).toEqual(owner.link)
    expect(await storedLink(adminTarget.link.id)).toEqual(adminTarget.link)

    for (const { path, session, target } of [
      { path: adminPath, session: admin, target: adminTarget },
      { path: ownerPath, session: differentOwner, target: owner },
    ]) {
      const challenge = await recoveryProof(path, session.cookie)
      expect(
        (await recoveryRequest(path, challenge.cookie, { proofAttemptId: challenge.id })).status,
      ).toBe(204)
      expect(await storedLink(target.link.id)).toMatchObject({ retired_at: expect.any(Date) })
    }
    const retired = await recoveryRequest(ownerPath, admin.cookie, {})
    const unknown = await recoveryRequest(
      removeLinkPath(f.providerId, randomUUID()),
      admin.cookie,
      {},
    )
    expect(retired.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(await retired.text()).toBe(await unknown.text())
    expect(await storedLink(f.link.id)).toEqual(f.link)
    expect(idp.send).not.toHaveBeenCalled()
  })

  it('resolves concurrent removals of the same generation once and revokes only the affected proofs', async () => {
    const f = await provider()
    const target = await recoveryTarget(f, fixture.member)
    const other = await recoveryTarget(f, fixture.coOwner)
    const targetProofs = await createRecoveryProofs(f, target, fixture.memberMember)
    const secondSession = await start(f.providerId)
    const secondSignIn = await callback(secondSession, idp.issue(secondSession, target.claims))
    expect(secondSignIn.headers.get('location')).toBe('/app/bookings?tab=next#recent')
    const otherProofs = await createRecoveryProofs(f, other, fixture.coOwnerMember)
    const admin = await browserSession(fixture.admin)
    const owner = await browserSession(fixture.owner)
    const ordinary = await browserSession(fixture.member)
    const path = removeLinkPath(f.providerId, target.link.id)
    const denied = await recoveryRequest(path, ordinary.cookie, {})
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: 'team_management_access_denied' })
    const wrongGeneration = await recoveryRequest(path, admin.cookie, { expectedLinkGeneration: 2 })
    expect(wrongGeneration.status).toBe(409)
    expect(await wrongGeneration.json()).toEqual({ error: 'sso_configuration_changed' })
    const before = await effects()
    const adminChallenge = await freshProofChallenge(
      await recoveryRequest(path, admin.cookie, {}),
      admin.cookie,
    )
    const { message, token } = await mailboxMessage(adminChallenge)
    const adminEmail = await db
      .selectFrom('auth.user')
      .select('email')
      .where('id', '=', fixture.admin)
      .executeTakeFirstOrThrow()
    expect(message.to).toBe(adminEmail.email)
    expect((await consumeMailbox(adminChallenge, token)).status).toBe(200)
    const ownerChallenge = await recoveryProof(path, owner.cookie)
    const beforeFailedWrite = await audit()
    const failed = await recoveryRequest(
      path,
      adminChallenge.cookie,
      { proofAttemptId: adminChallenge.id },
      { request: instance({ failRecoveryNotification: true }) },
    )
    expect(failed.status).toBe(500)
    expect(await storedLink(target.link.id)).toEqual(target.link)
    expect((await attemptRow(adminChallenge)).consumed_at).toBeNull()
    expect((await effects()).proofs).toBe(before.proofs)
    expect(await audit()).toEqual(beforeFailedWrite)
    expect(recoveryJobs).toEqual([])
    const retries = [adminChallenge, ownerChallenge]
    idp.send.mockClear()
    const blocker = await owned.pool.connect()
    let requests: Promise<Response>[]
    try {
      await blocker.query('BEGIN')
      const { rows } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await blocker.query('SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE', [
        fixture.team,
      ])
      requests = retries.map((challenge) =>
        Promise.resolve(
          recoveryRequest(
            path,
            challenge.cookie,
            { proofAttemptId: challenge.id },
            { request: instance() },
          ),
        ),
      )
      await waitForBlocked(rows[0]?.pid)
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
    }
    const responses = await Promise.all(requests)
    expect(responses.map(({ status }) => status).sort()).toEqual([204, 404])
    const winner = responses.findIndex(({ status }) => status === 204)
    const stale = responses.find(({ status }) => status === 404) as Response
    expect(await stale.json()).toEqual({ error: 'sso_not_found' })
    const attempts = await Promise.all(retries.map(attemptRow))
    expect(attempts.map(({ consumed_at }) => consumed_at instanceof Date)).toEqual([
      winner === 0,
      winner === 1,
    ])
    expect(await storedLink(target.link.id)).toMatchObject({
      generation: target.link.generation + 1,
      retired_at: expect.any(Date),
    })
    expect(await storedLink(other.link.id)).toEqual(other.link)
    expect(
      await db
        .selectFrom('sso_browser_proofs')
        .selectAll()
        .where('provider_id', '=', f.providerId)
        .execute(),
    ).toEqual([otherProofs.issued])
    expect(
      await db
        .selectFrom('sso_delegation_bindings')
        .selectAll()
        .where('provider_id', '=', f.providerId)
        .execute(),
    ).toEqual([otherProofs.delegated])
    expect(await effects()).toMatchObject({
      sessions: before.sessions,
      memberships: before.memberships,
      proofs: String(Number(before.proofs) - 2),
    })
    expect(
      await db
        .selectFrom('auth.session')
        .select('id')
        .where('id', '=', targetProofs.issued.session_id)
        .executeTakeFirst(),
    ).toEqual({ id: targetProofs.issued.session_id })
    expect(recoveryJobs).toEqual([
      {
        name: 'sso-link-removal-email',
        payload: {
          userId: fixture.member,
          language: expect.any(String),
        },
      },
    ])
    const journal = (await audit()).filter(({ action }) => action === 'sso_link.unlinked')
    expect(journal).toEqual([
      expect.objectContaining({
        actor_id: winner === 0 ? fixture.admin : fixture.owner,
        credential_id: winner === 0 ? admin.id : owner.id,
        target_id: target.link.id,
        details: expect.objectContaining({ method: 'oidc', providerId: f.providerId }),
      }),
    ])
    expect(JSON.stringify(journal)).not.toContain(target.claims.email)
    expect(JSON.stringify(journal)).not.toContain(target.claims.sub)
    const deliver = vi.fn<Mailer['send']>(async () => {})
    const worker = ssoLinkRemovalEmailJob({
      db,
      capabilities: { ssoOidcEnabled: true, ssoSamlEnabled: false },
      mailer: { send: deliver },
    })
    await worker.handler(worker.payload.parse(recoveryJobs[0]?.payload), {
      id: 'synthetic-removal-job',
      attempt: 1,
      signal: new AbortController().signal,
    })
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ to: target.claims.email, sensitive: true }),
      { signal: expect.any(AbortSignal) },
    )
    expect(idp.send).not.toHaveBeenCalled()
  })

  it('refuses administrator removal after the affected person loses their independent sign-in method', async () => {
    const f = await linked()
    const actor = await browserSession(fixture.admin)
    const path = removeLinkPath(f.providerId, f.link.id)
    const challenge = await recoveryProof(path, actor.cookie)
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', fixture.member)
      .execute()

    const refused = await recoveryRequest(path, challenge.cookie, { proofAttemptId: challenge.id })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'sso_recovery_required' })
    expect(await storedLink(f.link.id)).toEqual(f.link)
    expect((await attemptRow(challenge)).consumed_at).toBeNull()
    expect(await audit()).toEqual([])
    expect(recoveryJobs).toEqual([])
    expect(idp.send).not.toHaveBeenCalled()
  })

  it('retires a conflicting identity before another member can explicitly re-link it under enforcement', async () => {
    const f = await enrollment()
    const old = await recoveryTarget(f, fixture.admin, f.claims.sub)
    const ownerIdentity = await recoveryTarget(f, fixture.owner)
    const member = await browserSession(fixture.member)
    await enforceSso()
    await expectSsoRequired(member.cookie)
    await expectCompletionRefused(await complete(await prepareLink(f, member.cookie)))
    expect(await storedLink(old.link.id)).toEqual(old.link)

    const path = removeLinkPath(f.providerId, old.link.id)
    const localOwner = await browserSession(fixture.owner)
    const refused = await recoveryRequest(path, localOwner.cookie, {})
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'sso_required' })
    expect(await storedLink(old.link.id)).toEqual(old.link)

    const ownerSignIn = await start(f.providerId)
    const ownerSignedIn = await callback(ownerSignIn, idp.issue(ownerSignIn, ownerIdentity.claims))
    expect(ownerSignedIn.status).toBe(302)
    const ownerCookie = sessionCookie(ownerSignedIn)
    const challenge = await freshProofChallenge(
      await recoveryRequest(path, ownerCookie, {}),
      ownerCookie,
      ['sso'],
    )
    const stepUp = await startStepUp(f.providerId, challenge)
    expectStepUpRedirect(
      await callback(
        stepUp,
        idp.issue(stepUp, { ...ownerIdentity.claims, auth_time: await authTime() }),
      ),
    )
    expect(
      (await recoveryRequest(path, challenge.cookie, { proofAttemptId: challenge.id })).status,
    ).toBe(204)
    const retired = await storedLink(old.link.id)
    expect(retired).toMatchObject({ generation: 2, retired_at: expect.any(Date) })
    const liveLinks = () =>
      db
        .selectFrom('sso_identity_links')
        .select(['id', 'user_id', 'subject', 'generation'])
        .where('provider_id', '=', f.providerId)
        .where('retired_at', 'is', null)
        .where('id', '!=', ownerIdentity.link.id)
        .execute()
    expect(await liveLinks()).toEqual([])
    const signIn = await start(f.providerId)
    await refusal(await callback(signIn, idp.issue(signIn, f.claims)))
    expect(await liveLinks()).toEqual([])
    const before = await effects()
    const result = await complete(await prepareLink(f, member.cookie))
    expect(result.status).toBe(302)
    expect(result.headers.get('location')).toBe('/app/settings')
    expect(await liveLinks()).toEqual([
      { id: expect.any(String), user_id: fixture.member, subject: f.claims.sub, generation: 1 },
    ])
    expect(await storedLink(old.link.id)).toEqual(retired)
    expect(await effects()).toMatchObject({
      accounts: before.accounts,
      memberships: before.memberships,
    })
    await expectSsoRequired(member.cookie)
    const memberSignIn = await start(f.providerId)
    const memberSignedIn = await callback(memberSignIn, idp.issue(memberSignIn, f.claims))
    expect(memberSignedIn.status).toBe(302)
    expect((await readEvents(sessionCookie(memberSignedIn))).status).toBe(200)
  })

  it('freezes new links when the current positive domain proof has a failed recheck', async () => {
    const f = await enrollment()
    const pending = await prepareLink(f)
    const actor = await browserSession(fixture.member)
    const before = await effects()
    await db
      .updateTable('sso_domains')
      .set({ last_check_outcome: 'failed', last_checked_at: sql`clock_timestamp()` })
      .where('id', '=', f.claim.id)
      .execute()
    for (const response of [
      await linkRequest(f.providerId, actor.cookie),
      await complete(pending),
    ]) {
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'sso_domain_unverified' })
    }
    expect(await effects()).toEqual(before)
  })

  it('refuses a link result after its IdP deadline', async () => {
    const f = await enrollment()
    const actor = await browserSession(fixture.member)
    const challenge = await requestLinkProof(f.providerId, actor.cookie)
    await proveMailbox(challenge)
    const attempt = await startLink(f.providerId, challenge)
    const deadline = Math.floor(new Date(at(3)).getTime() / 1000)
    const pending = await pendingLink(
      attempt,
      idp.issue(attempt, { ...f.claims, session_expires_at: deadline }),
    )
    const before = await effects()
    await vi.waitFor(
      async () => {
        const row = await db
          .selectFrom('sso_attempts')
          .select(sql<boolean>`expires_at <= clock_timestamp()`.as('expired'))
          .where('id', '=', pending.id)
          .executeTakeFirstOrThrow()
        expect(row.expired).toBe(true)
      },
      { timeout: 3500, interval: 50 },
    )
    await expectCompletionRefused(await complete(pending))
    expect(await effects()).toEqual(before)
  })

  it('refuses link completion when concurrent membership removal commits first', async () => {
    const f = await enrollment()
    const pending = await prepareLink(f)
    const before = await effects()
    const blocker = await owned.pool.connect()
    let completion: Promise<Response> | undefined
    try {
      await blocker.query('BEGIN')
      const { rows } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await blocker.query('SELECT id FROM auth.organization WHERE id = $1 FOR UPDATE', [
        fixture.team,
      ])
      await blocker.query('DELETE FROM auth.member WHERE id = $1', [fixture.memberMember])
      completion = Promise.resolve(complete(pending))
      await waitForBlocked(rows[0]?.pid)
      await blocker.query('COMMIT')
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
    }
    await expectCompletionRefused(await completion)
    expect(await effects()).toEqual({
      ...before,
      memberships: String(Number(before.memberships) - 1),
    })
  })

  it('discovers before taking team locks and rechecks the provider revision before spending proof', async () => {
    const f = await enrollment({ discovery: true })
    const actor = await browserSession(fixture.member)
    const challenge = await requestLinkProof(f.providerId, actor.cookie)
    await proveMailbox(challenge)
    idp.discovery.mockImplementationOnce(async () => {
      await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL lock_timeout = '500ms'`.execute(trx)
        await trx
          .selectFrom('auth.organization')
          .select('id')
          .where('id', '=', fixture.team)
          .forUpdate()
          .executeTakeFirstOrThrow()
        await trx
          .updateTable('sso_providers')
          .set({ revision: 2, configuration: configuration(f.providerId, 2, true) })
          .where('id', '=', f.providerId)
          .execute()
      })
      return json(metadata)
    })
    const response = await linkRequest(f.providerId, challenge.cookie, {
      proofAttemptId: challenge.id,
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'sso_configuration_changed' })
    expect(idp.discovery).toHaveBeenCalledTimes(1)
    expect((await attemptRow(challenge)).consumed_at).toBeNull()
    expect(
      await db
        .selectFrom('sso_attempts')
        .select('id')
        .where('organization_id', '=', fixture.team)
        .where('kind', '=', 'link')
        .execute(),
    ).toEqual([])
  })
})
