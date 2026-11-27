import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import type { BrowserContext, Page } from '@playwright/test'
import { sql } from 'kysely'
import { createApp } from '../../../apps/server/src/app.ts'
import { loadConfig } from '../../../apps/server/src/config.ts'
import { mcpEndpoint } from '../../../apps/server/src/mcp/endpoint.ts'
import {
  productionSsoCapabilities,
  productRoutes,
  productTools,
} from '../../../apps/server/src/server.ts'
import { sealSsoProviderConfiguration } from '../../../apps/server/src/sso-configuration.ts'
import {
  deliverMailboxProof,
  MAILBOX_PROOF_CONFIRM_PATH,
  MailboxProofEmailPayload,
  mailboxProofRoutes,
} from '../../../apps/server/src/sso-mailbox-proof.ts'
import {
  OIDC_CALLBACK_PATH,
  OIDC_SIGN_IN_PATH,
  oidcSignInRoutes,
} from '../../../apps/server/src/sso-oidc-sign-in.ts'
import { samlSignInRoutes } from '../../../apps/server/src/sso-saml-sign-in.ts'
import { samlServiceProviderUrls } from '../../../apps/server/src/sso-saml-state.ts'
import {
  createAuth,
  createAuthPool,
  createCallerResolver,
  type SignupPolicy,
} from '../../../packages/auth/src/index.ts'
import { createDb, type Db } from '../../../packages/db/src/index.ts'
import { claimedDomainValues } from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createTestDatabase } from '../../../packages/db/src/testing.ts'
import { type SsoResponse, sendSsoRequest } from '../../../packages/outbound/src/sso.ts'
import { createFixtures } from '../../../packages/scheduling/src/testing.ts'
import { test as base, expect } from '../fixtures.ts'
import { listenOwned, type OwnedListener } from '../listeners.ts'
import { startKeycloak } from './keycloak.ts'
import { startSamlPeer } from './saml-peer.ts'

type KeycloakContainer = Awaited<ReturnType<typeof startKeycloak>>
type KeycloakRealm = Awaited<ReturnType<KeycloakContainer['createRealm']>>
type Keycloak = Omit<KeycloakRealm, 'close'> & { stop: () => Promise<void> }
type TokenExchange = 'issued' | 'invalid_code' | 'failed'
type Admission = 'invitation_only' | 'jit'
type AuthorizationField = 'state' | 'nonce'

interface AccountState {
  userId: string | null
  teamRole: string | null
  linkedSubjects: string[]
  sessionCount: number
  personalSpace: boolean
}

export interface KeycloakFixture {
  url: string
  db: Db
  databaseUrl: string
  providerId: string
  idp: Keycloak
  teamId: string
  teamName: string
  linkedUserId: string
  linkableUserId: string
  invitationId: string
  personal: { email: string; userId: string }
  account: (email: string) => Promise<AccountState>
  invitationStatus: () => Promise<string>
  magicLink: (email: string) => Promise<URL>
  mailboxLink: (email: string) => Promise<URL>
  tokenExchanges: () => readonly TokenExchange[]
  signingKeyIds: () => readonly string[]
  jwksRequests: () => number
  postSamlToPeer: (fields: URLSearchParams) => Promise<{ status: number; location: string | null }>
}

function tokenExchange(response: SsoResponse): TokenExchange {
  if (response.status === 200) return 'issued'
  if (response.status === 400) {
    try {
      const result = JSON.parse(response.body.toString('utf8'))
      // The pinned Keycloak image reports consumed codes before checking PKCE.
      if (result.error === 'invalid_grant' && result.error_description === 'Code not valid')
        return 'invalid_code'
    } catch {
      return 'failed'
    }
  }
  return 'failed'
}

function readSigningKeyId(response: SsoResponse): string {
  try {
    const { id_token: token } = JSON.parse(response.body.toString('utf8'))
    const { kid } = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'))
    if (typeof kid === 'string' && kid.length > 0) return kid
  } catch {
    // Keep raw token data out of failures.
  }
  throw new Error('The Keycloak ID token did not identify its signing key')
}

async function tamperAuthorization(
  response: Response,
  endpoint: string,
  field: AuthorizationField,
) {
  const data = await response.json().catch(() => null)
  const url = typeof data?.url === 'string' ? URL.parse(data.url) : null
  if (!url || url.origin + url.pathname !== endpoint)
    throw new Error('Hourmere did not return the owned Keycloak authorization URL')
  const original = url.searchParams.get(field)
  if (!original) throw new Error(`Keycloak authorization request has no ${field}`)
  // Change ciphertext while keeping the state envelope header and attempt ID.
  // Keycloak signs the changed nonce into its genuine ID token.
  const index = field === 'state' ? original.length - 2 : 0
  const replacement = original[index] === 'A' ? 'B' : 'A'
  url.searchParams.set(
    field,
    `${original.slice(0, index)}${replacement}${original.slice(index + 1)}`,
  )
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return Response.json({ ...data, url: url.href }, { status: response.status, headers })
}

async function seedSignIn(
  db: Db,
  providerId: string,
  idp: Keycloak,
  configurationKey: Buffer,
  {
    admission,
    enforced,
    brokenProvider,
  }: { admission: Admission; enforced: boolean; brokenProvider: boolean },
) {
  const fixtures = createFixtures(db)
  const teamName = 'keycloak-team'
  const organizationId = await fixtures.organization(teamName)
  // Seed the inviter first so its invitation qualifies under closed signup.
  const linked = await fixtures.host({ name: 'Keycloak Member', handle: 'keycloak-member' })
  const linkable = await fixtures.host({ name: 'Linkable Member', handle: 'linkable-member' })
  const personal = await fixtures.host({ name: 'Personal Member', handle: 'personal-member' })
  const personalEmail = 'personal@example.test'
  await db
    .updateTable('auth.user')
    .set({ email: idp.linked.email })
    .where('id', '=', linked.userId)
    .execute()
  await db
    .updateTable('auth.user')
    .set({ email: idp.linkable.email })
    .where('id', '=', linkable.userId)
    .execute()
  await db
    .updateTable('auth.user')
    .set({ email: personalEmail })
    .where('id', '=', personal.userId)
    .execute()
  await fixtures.member(linked.userId, organizationId, 'owner')
  await fixtures.member(linkable.userId, organizationId)
  const invitation = await db
    .insertInto('auth.invitation')
    .values({
      organizationId,
      inviterId: linked.userId,
      role: 'member',
      status: 'pending',
      expiresAt: sql<Date>`clock_timestamp() + interval '1 hour'`,
      email: idp.invited.email,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  if (admission === 'jit' || enforced)
    await db
      .insertInto('sso_policies')
      .values({ organization_id: organizationId, admission, require_sso: enforced })
      .execute()

  const { saml, clientId, clientSecret } = idp
  const issuer = saml?.entityId ?? idp.issuer
  const configuration = saml
    ? {
        ssoEndpoint: saml.ssoEndpoint,
        // The fixture's HTTPS certificate is a valid RSA certificate with an unrelated key.
        signingCertificates: brokenProvider ? [idp.certificate] : saml.signingCertificates,
        subjectAttribute: saml.subjectAttribute,
      }
    : {
        issuer,
        clientId,
        clientSecret: brokenProvider ? randomBytes(32).toString('base64url') : clientSecret,
      }
  const revision = 1
  await db
    .insertInto('sso_providers')
    .values({
      id: providerId,
      organization_id: organizationId,
      protocol: saml ? 'saml' : 'oidc',
      display_name: 'Fixture Keycloak',
      issuer,
      client_id: saml ? null : clientId,
      configuration: sealSsoProviderConfiguration(
        configurationKey,
        { providerId, organizationId, revision },
        JSON.stringify(configuration),
      ),
      enabled: true,
    })
    .execute()
  const domain = await db
    .insertInto('sso_domains')
    .values(
      claimedDomainValues(
        organizationId,
        idp.linked.email.slice(idp.linked.email.indexOf('@') + 1),
      ),
    )
    .returning('id')
    .executeTakeFirstOrThrow()
  await db
    .insertInto('sso_provider_domains')
    .values({ organization_id: organizationId, provider_id: providerId, domain_id: domain.id })
    .execute()
  await db
    .insertInto('sso_identity_links')
    .values({
      organization_id: organizationId,
      provider_id: providerId,
      user_id: linked.userId,
      issuer,
      subject: idp.linked.subject,
      proven_email: idp.linked.email,
      email_proven_at: new Date(),
    })
    .execute()
  if (brokenProvider)
    await db
      .updateTable('sso_providers')
      .set({ enabled: false })
      .where('id', '=', providerId)
      .execute()
  return {
    teamId: organizationId,
    teamName,
    linkedUserId: linked.userId,
    linkableUserId: linkable.userId,
    invitationId: invitation.id,
    personal: { email: personalEmail, userId: personal.userId },
  }
}

async function readAccount(
  db: Db,
  teamId: string,
  providerId: string,
  email: string,
): Promise<AccountState> {
  const user = await db
    .selectFrom('auth.user')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst()
  if (!user)
    return {
      userId: null,
      teamRole: null,
      linkedSubjects: [],
      sessionCount: 0,
      personalSpace: false,
    }

  const [membership, links, sessions, personal] = await Promise.all([
    db
      .selectFrom('auth.member')
      .select('role')
      .where('userId', '=', user.id)
      .where('organizationId', '=', teamId)
      .executeTakeFirst(),
    db
      .selectFrom('sso_identity_links')
      .select('subject')
      .where('user_id', '=', user.id)
      .where('provider_id', '=', providerId)
      .where('retired_at', 'is', null)
      .orderBy('subject')
      .execute(),
    db
      .selectFrom('auth.session')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('userId', '=', user.id)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('personal_organizations')
      .select('user_id')
      .where('user_id', '=', user.id)
      .executeTakeFirst(),
  ])
  return {
    userId: user.id,
    teamRole: membership?.role ?? null,
    linkedSubjects: links.map(({ subject }) => subject),
    sessionCount: Number(sessions.count),
    personalSpace: personal !== undefined,
  }
}

/** Keep the queue and mail transport in memory while using the real proof delivery worker. */
function mailboxProofSink(deps: Omit<Parameters<typeof deliverMailboxProof>[0], 'mailer'>) {
  const queued: MailboxProofEmailPayload[] = []
  const links = new Map<string, URL>()
  const prefix = new URL(MAILBOX_PROOF_CONFIRM_PATH, deps.publicUrl).href
  const routes = mailboxProofRoutes({
    db: deps.db,
    capabilities: deps.capabilities,
    queue: {
      async enqueue(_name, payload) {
        queued.push(MailboxProofEmailPayload.parse(payload))
        return 'fixture-mailbox-proof'
      },
    },
  })
  return {
    routes,
    async link(email: string) {
      for (const payload of queued.splice(0))
        await deliverMailboxProof(
          {
            ...deps,
            mailer: {
              async send({ to, text }) {
                const link = text?.split('\n').find((line) => line.startsWith(`${prefix}#`))
                if (!link || typeof to !== 'string')
                  throw new Error('The mailbox proof message lacked its recipient or link')
                links.set(to, new URL(link))
              },
            },
          },
          payload,
        )
      const link = links.get(email)
      if (!link) throw new Error('No proof link in the fixture mail sink')
      links.delete(email)
      return link
    },
  }
}

/** Fake the personal IdPs at the browser boundary, keeping Better Auth's real callbacks. */
async function guardBrowser(
  context: BrowserContext,
  { url, idpOrigin, personalCode }: { url: string; idpOrigin: string; personalCode: string },
) {
  let externalRequests = 0
  await context.route('**/*', async (route) => {
    const request = route.request()
    const target = new URL(request.url())
    if (target.origin === url || target.origin === idpOrigin) return route.continue()
    const provider =
      target.origin === 'https://accounts.google.com'
        ? 'google'
        : target.origin === 'https://login.microsoftonline.com'
          ? 'microsoft'
          : undefined
    if (provider && request.isNavigationRequest()) {
      const callback = new URL(`/api/auth/callback/${provider}`, url)
      expect(target.searchParams.get('redirect_uri') === callback.href).toBe(true)
      expect(target.searchParams.has('state')).toBe(true)
      expect(target.searchParams.has('code_challenge')).toBe(true)
      callback.search = new URLSearchParams({
        state: target.searchParams.get('state') ?? '',
        code: personalCode,
      }).toString()
      return route.fulfill({
        contentType: 'text/html',
        headers: { 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' },
        body: `<!doctype html><script>location.replace(${JSON.stringify(callback.href).replaceAll('<', '\\u003c')})</script>`,
      })
    }
    externalRequests++
    return route.abort('blockedbyclient')
  })
  return () => {
    expect(externalRequests, 'Browser traffic must stay on fixture origins').toBe(0)
  }
}

async function releaseFixture(
  authPool: ReturnType<typeof createAuthPool> | undefined,
  closeIdp: (() => Promise<void>) | undefined,
  drop: () => Promise<void>,
) {
  const closed = await Promise.allSettled([authPool?.end(), closeIdp?.()])
  await drop()
  const failures = closed.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  const idpResult = closed[1]
  if (failures.length)
    throw new AggregateError(failures, 'Keycloak fixture cleanup failed', {
      cause: idpResult.status === 'rejected' ? idpResult.reason : undefined,
    })
}

/** Say where a sign-in stopped without printing query strings, cookies or form values. */
export async function describeStrandedPage(page: Page, app: { url: string }) {
  const url = new URL(page.url())
  const site = url.origin === app.url ? 'Hourmere' : 'the identity provider'
  const feedback = await page
    .locator('#input-error, #kc-error-message, .pf-m-error, [role="alert"]')
    .first()
    .textContent({ timeout: 500 })
    .catch(() => null)
  const form = await page
    .locator('input[name="password"]')
    .isVisible()
    .catch(() => false)
  const heading = await page
    .locator('h1, #kc-page-title')
    .first()
    .textContent({ timeout: 500 })
    .catch(() => null)
  const clip = (text: string | null) =>
    text ? text.replace(/\s+/g, ' ').trim().slice(0, 120) : 'none'
  return `${site} ${url.pathname}; heading: ${clip(heading)}; feedback: ${clip(feedback)}; password field: ${form}`
}

export const test = base.extend<
  {
    keycloak: KeycloakFixture
    protocol: 'oidc' | 'saml'
    oidcEnabled: boolean
    samlEnabled: boolean
    admission: Admission
    signupMode: SignupPolicy['mode']
    enforced: boolean
    brokenProvider: boolean
    keyRotation: boolean
    dedicatedKeycloak: boolean
    tamperedAuthorizationField: AuthorizationField | undefined
  },
  { getWorkerKeycloak: () => Promise<KeycloakContainer> }
>({
  protocol: ['oidc', { option: true }],
  oidcEnabled: [true, { option: true }],
  samlEnabled: [false, { option: true }],
  admission: ['invitation_only', { option: true }],
  signupMode: ['closed', { option: true }],
  enforced: [false, { option: true }],
  brokenProvider: [false, { option: true }],
  keyRotation: [false, { option: true }],
  dedicatedKeycloak: [false, { option: true }],
  tamperedAuthorizationField: [undefined, { option: true }],
  getWorkerKeycloak: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructuring fixture dependencies.
    async ({}, use) => {
      // Leave workers that only run disruptive cases free of a second container.
      let container: Promise<KeycloakContainer> | undefined
      try {
        await use(() => (container ??= startKeycloak()))
      } finally {
        // Startup already cleans up on failure and reports it to the requesting test.
        const started = await container?.catch(() => undefined)
        await started?.close()
      }
    },
    { scope: 'worker' },
  ],
  // Chrome uses an isolated context and the route above restricts its destinations.
  ignoreHTTPSErrors: true,
  keycloak: [
    async (
      {
        context,
        page,
        protocol,
        oidcEnabled,
        samlEnabled,
        admission,
        signupMode,
        enforced,
        brokenProvider,
        keyRotation,
        dedicatedKeycloak,
        tamperedAuthorizationField,
        getWorkerKeycloak,
      },
      use,
      testInfo,
    ) => {
      const bootstrap = process.env.HOURMERE_E2E_BOOTSTRAP_URL
      if (!bootstrap) throw new Error('Keycloak tests require HOURMERE_E2E_BOOTSTRAP_URL')
      const owned = await createTestDatabase(bootstrap, undefined, { tag: 'keycloak' })
      let listener: OwnedListener | undefined
      let dedicated: KeycloakContainer | undefined
      let closeRealm: (() => Promise<void>) | undefined
      let authPool: ReturnType<typeof createAuthPool> | undefined
      let samlPeer: ReturnType<typeof startSamlPeer> | undefined
      const previousCAs = getCACertificates('default')
      try {
        listener = await listenOwned(createServer())
        const { server, url } = listener
        const db = createDb(owned.pool)
        const { providerId } = await db
          .selectNoFrom(sql<string>`uuidv7()`.as('providerId'))
          .executeTakeFirstOrThrow()
        if (dedicatedKeycloak || keyRotation) dedicated = await startKeycloak()
        const container = dedicated ?? (await getWorkerKeycloak())
        const samlSp = protocol === 'saml' ? samlServiceProviderUrls(url, providerId) : undefined
        const { close, rotateSigningKey, ...realm } = await container.createRealm(
          new URL(OIDC_CALLBACK_PATH.replace(':providerId', providerId), url).href,
          samlSp,
        )
        closeRealm = close
        const idp: Keycloak = {
          ...realm,
          async stop() {
            if (!dedicated) throw new Error('Stopping Keycloak requires a dedicated container')
            await dedicated.stop()
          },
          async rotateSigningKey() {
            if (!keyRotation) throw new Error('This fixture did not enable Keycloak key rotation')
            await rotateSigningKey()
          },
        }
        setDefaultCACertificates([...previousCAs, idp.certificate])
        const configurationKey = randomBytes(32)
        const seeded = await seedSignIn(db, providerId, idp, configurationKey, {
          admission,
          enforced,
          brokenProvider,
        })
        const { personal, teamId, invitationId } = seeded
        const signup: SignupPolicy = { mode: signupMode, allowedDomains: [] }
        const secret = randomBytes(32).toString('base64')
        const personalCode = randomBytes(24).toString('base64url')
        const client = {
          clientId: 'fixture-personal',
          clientSecret: randomBytes(32).toString('base64url'),
        }
        const socialProviders = { google: client, microsoft: client }
        const vouching = {
          getUserInfo: async () => ({
            user: {
              email: personal.email,
              emailVerified: true,
              name: 'Personal Member',
            },
            data: { oid: 'fixture-personal-subject', sub: 'fixture-personal-subject' } as never,
          }),
        }
        const mail = new Map<string, string>()
        // Parse both operator settings through the production configuration.
        const config = loadConfig({
          DATABASE_URL: owned.url,
          BETTER_AUTH_SECRET: secret,
          SSO_OIDC_ENABLED: oidcEnabled ? 'true' : '',
          SSO_SAML_ENABLED: samlEnabled ? 'true' : '',
          SSO_ENCRYPTION_KEY: configurationKey.toString('base64'),
        })
        const capabilities = productionSsoCapabilities(config)
        const ssoConfigurationKey = Buffer.from(config.SSO_ENCRYPTION_KEY ?? '', 'base64')
        const mailbox = mailboxProofSink({ db, capabilities, publicUrl: url, secret })
        authPool = createAuthPool(owned.url, signup)
        const auth = createAuth({
          pool: authPool,
          db,
          baseURL: url,
          secret,
          signup,
          socialProviders,
          socialProviderOptions: { google: vouching, microsoft: vouching },
          ssoCapabilities: capabilities,
          mailer: {
            async send() {
              throw new Error('Keycloak fixture sign-in mail must use the in-memory queue')
            },
          },
          async queueSignInEmail({ email, url: link }) {
            mail.set(email, link)
          },
        })
        for (const provider of (await auth.$context).socialProviders)
          provider.validateAuthorizationCode = async ({ code, codeVerifier, redirectURI }) => {
            if (
              code !== personalCode ||
              !codeVerifier ||
              redirectURI !== `${url}/api/auth/callback/${provider.id}`
            )
              throw new Error('Unexpected personal fixture OAuth exchange')
            return { accessToken: personalCode, scopes: ['openid', 'profile', 'email'] }
          }
        const issuer = new URL(idp.issuer)
        const privateTargets = [{ host: issuer.hostname, port: Number(issuer.port) }]
        const oidcEndpoint = `${idp.issuer}/protocol/openid-connect`
        const exchanges: TokenExchange[] = []
        const signingKeyIds: string[] = []
        let jwksRequests = 0
        const readSession = async (headers: Headers) =>
          (
            await auth.api.getSession({
              headers,
              query: { disableRefresh: true, disableCookieCache: true },
            })
          )?.session
        const app = createApp({
          publicUrl: url,
          checkDb: async () => {},
          authHandler: auth.handler,
          resolveCaller: createCallerResolver({ auth, db, ssoCapabilities: capabilities }),
          webDist:
            process.env.HOURMERE_E2E_WEB_DIST ??
            fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)),
          ssoTeamReads: { db, capabilities },
          ssoMailboxProof: mailbox.routes,
          mcp: mcpEndpoint({
            tools: productTools({ db, publicUrl: url, ssoCapabilities: capabilities }),
          }),
          ssoOidcSignIn: oidcSignInRoutes({
            db,
            capabilities,
            configurationKey: ssoConfigurationKey,
            privateTargets,
            signup,
            session: { secret },
            readSession,
            send: async (request) => {
              if (new URL(request.url).origin !== issuer.origin)
                throw new Error('Keycloak fixture transport refused an unowned origin')
              const response = await sendSsoRequest(request)
              if (request.url === `${oidcEndpoint}/certs`) jwksRequests++
              if (request.url === `${oidcEndpoint}/token`) {
                const exchange = tokenExchange(response)
                exchanges.push(exchange)
                if (keyRotation && exchange === 'issued')
                  signingKeyIds.push(readSigningKeyId(response))
              }
              return response
            },
          }),
          ssoSamlSignIn: samlSignInRoutes({
            db,
            capabilities,
            configurationKey: ssoConfigurationKey,
            signup,
            session: { secret },
            readSession,
          }),
          routes: productRoutes({
            db,
            invitationMailLimits: { secret },
            publicUrl: url,
            socialProviders,
            ...capabilities,
            ssoConfigurationKey,
            ssoPrivateTargets: privateTargets,
            ssoRecoveryEnrollmentQueue: {
              async enqueue() {
                return 'fixture-sso-recovery-notice'
              },
            },
          }),
        })
        const handleRequest = tamperedAuthorizationField
          ? async (request: Request, env: Parameters<typeof app.fetch>[1]) => {
              const response = await app.fetch(request, env)
              // Give the SPA the altered URL for every navigation. A one-shot
              // Playwright override applies only to the first browser request.
              if (
                request.method === 'POST' &&
                new URL(request.url).pathname === OIDC_SIGN_IN_PATH &&
                response.ok
              )
                return tamperAuthorization(
                  response,
                  `${oidcEndpoint}/auth`,
                  tamperedAuthorizationField,
                )
              return response
            }
          : app.fetch
        server.on('request', getRequestListener(handleRequest, { hostname: '127.0.0.1' }))
        const checkBrowser = await guardBrowser(context, {
          url,
          idpOrigin: issuer.origin,
          personalCode,
        })
        await use({
          url,
          db,
          databaseUrl: owned.url,
          providerId,
          idp,
          ...seeded,
          account: (email) => readAccount(db, teamId, providerId, email),
          invitationStatus: async () => {
            const { status } = await db
              .selectFrom('auth.invitation')
              .select('status')
              .where('id', '=', invitationId)
              .executeTakeFirstOrThrow()
            return status
          },
          magicLink: async (email) => {
            const link = mail.get(email)
            if (!link) throw new Error('No sign-in link in the fixture mail sink')
            mail.delete(email)
            return new URL(link)
          },
          mailboxLink: mailbox.link,
          tokenExchanges: () => [...exchanges],
          signingKeyIds: () => [...signingKeyIds],
          jwksRequests: () => jwksRequests,
          postSamlToPeer: async (fields) => {
            if (!samlSp || !samlEnabled) throw new Error('The Keycloak SAML fixture is disabled')
            samlPeer ??= startSamlPeer({
              databaseUrl: owned.url,
              publicUrl: url,
              capabilities,
              configurationKey: ssoConfigurationKey,
              signup,
              secret,
            })
            const peer = await samlPeer
            return peer.post(new URL(samlSp.acsUrl).pathname, fields)
          },
        })
        // A failed sign-in round trip otherwise reports only a timeout. Name where it stopped.
        if (testInfo.status !== testInfo.expectedStatus)
          console.log(`Keycloak test stopped at: ${await describeStrandedPage(page, { url })}`)
        checkBrowser()
      } finally {
        try {
          try {
            await listener?.close()
          } finally {
            const peer = await samlPeer?.catch(() => undefined)
            await peer?.close()
          }
        } finally {
          setDefaultCACertificates(previousCAs)
          // An outage test may have stopped its IdP. Removing its dedicated container also
          // discards its realm. A worker's container lives on after its test's realm is deleted.
          await releaseFixture(authPool, dedicated?.close ?? closeRealm, owned.drop)
        }
      }
    },
    { timeout: 210_000 },
  ],
})

export { expect }
