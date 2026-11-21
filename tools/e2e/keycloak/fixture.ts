import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import type { BrowserContext } from '@playwright/test'
import { sql } from 'kysely'
import { createApp } from '../../../apps/server/src/app.ts'
import { productRoutes } from '../../../apps/server/src/server.ts'
import { sealSsoProviderConfiguration } from '../../../apps/server/src/sso-configuration.ts'
import { OIDC_CALLBACK_PATH, oidcSignInRoutes } from '../../../apps/server/src/sso-oidc-sign-in.ts'
import {
  createAuth,
  createAuthPool,
  createCallerResolver,
} from '../../../packages/auth/src/index.ts'
import { createDb, type Db } from '../../../packages/db/src/index.ts'
import { claimedDomainValues } from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createTestDatabase } from '../../../packages/db/src/testing.ts'
import { type SsoResponse, sendSsoRequest } from '../../../packages/outbound/src/sso.ts'
import { createFixtures } from '../../../packages/scheduling/src/testing.ts'
import { test as base, expect } from '../fixtures.ts'
import { listenOwned, type OwnedListener } from '../listeners.ts'
import { startKeycloak } from './keycloak.ts'

type Keycloak = Awaited<ReturnType<typeof startKeycloak>>
type TokenExchange = 'issued' | 'invalid_code' | 'failed'

export interface KeycloakFixture {
  url: string
  providerId: string
  idp: Keycloak
  linkedUserId: string
  personal: { email: string; userId: string }
  magicLink: (email: string) => Promise<URL>
  tokenExchanges: () => readonly TokenExchange[]
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

async function seedSignIn(db: Db, providerId: string, idp: Keycloak, configurationKey: Buffer) {
  const fixtures = createFixtures(db)
  const organizationId = await fixtures.organization('keycloak-team')
  const linked = await fixtures.host({ name: 'Keycloak Member', handle: 'keycloak-member' })
  const personal = await fixtures.host({ name: 'Personal Member', handle: 'personal-member' })
  const personalEmail = 'personal@example.test'
  await db
    .updateTable('auth.user')
    .set({ email: idp.linked.email })
    .where('id', '=', linked.userId)
    .execute()
  await db
    .updateTable('auth.user')
    .set({ email: personalEmail })
    .where('id', '=', personal.userId)
    .execute()
  await fixtures.member(linked.userId, organizationId, 'owner')

  const { issuer, clientId, clientSecret } = idp
  const revision = 1
  await db
    .insertInto('sso_providers')
    .values({
      id: providerId,
      organization_id: organizationId,
      protocol: 'oidc',
      display_name: 'Fixture Keycloak',
      issuer,
      client_id: clientId,
      configuration: sealSsoProviderConfiguration(
        configurationKey,
        { providerId, organizationId, revision },
        JSON.stringify({ issuer, clientId, clientSecret }),
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
  return {
    linkedUserId: linked.userId,
    personal: { email: personalEmail, userId: personal.userId },
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
  idp: Keycloak | undefined,
  drop: () => Promise<void>,
) {
  const closed = await Promise.allSettled([authPool?.end(), idp?.close()])
  await drop()
  const failures = closed.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  if (failures.length) throw new AggregateError(failures, 'Keycloak fixture cleanup failed')
}

export const test = base.extend<{ keycloak: KeycloakFixture; oidcEnabled: boolean }>({
  oidcEnabled: [true, { option: true }],
  // Chrome uses an isolated context and the route above restricts its destinations.
  ignoreHTTPSErrors: true,
  keycloak: [
    async ({ context, oidcEnabled }, use) => {
      const bootstrap = process.env.HOURMERE_E2E_BOOTSTRAP_URL
      if (!bootstrap) throw new Error('Keycloak tests require HOURMERE_E2E_BOOTSTRAP_URL')
      const owned = await createTestDatabase(bootstrap, undefined, { tag: 'keycloak' })
      let listener: OwnedListener | undefined
      let idp: Keycloak | undefined
      let authPool: ReturnType<typeof createAuthPool> | undefined
      const previousCAs = getCACertificates('default')
      try {
        listener = await listenOwned(createServer())
        const { server, url } = listener
        const db = createDb(owned.pool)
        const { providerId } = await db
          .selectNoFrom(sql<string>`uuidv7()`.as('providerId'))
          .executeTakeFirstOrThrow()
        idp = await startKeycloak(
          new URL(OIDC_CALLBACK_PATH.replace(':providerId', providerId), url).href,
        )
        setDefaultCACertificates([...previousCAs, idp.certificate])
        const configurationKey = randomBytes(32)
        const { linkedUserId, personal } = await seedSignIn(db, providerId, idp, configurationKey)
        const signup = { mode: 'closed', allowedDomains: [] } as const
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
        const capabilities = { ssoOidcEnabled: oidcEnabled, ssoSamlEnabled: false }
        authPool = createAuthPool(owned.url, signup)
        const auth = createAuth({
          pool: authPool,
          db,
          baseURL: url,
          secret,
          signup,
          socialProviders,
          socialProviderOptions: { google: vouching, microsoft: vouching },
          ...(oidcEnabled && { ssoCapabilities: capabilities }),
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
        const tokenEndpoint = `${idp.issuer}/protocol/openid-connect/token`
        const exchanges: TokenExchange[] = []
        const app = createApp({
          publicUrl: url,
          checkDb: async () => {},
          authHandler: auth.handler,
          resolveCaller: createCallerResolver({ auth, db, ssoCapabilities: capabilities }),
          webDist:
            process.env.HOURMERE_E2E_WEB_DIST ??
            fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)),
          ssoTeamReads: { db, capabilities },
          ssoOidcSignIn: oidcSignInRoutes({
            db,
            capabilities,
            configurationKey,
            privateTargets,
            signup,
            session: { secret },
            readSession: async (headers) =>
              (
                await auth.api.getSession({
                  headers,
                  query: { disableRefresh: true, disableCookieCache: true },
                })
              )?.session,
            send: async (request) => {
              if (new URL(request.url).origin !== issuer.origin)
                throw new Error('Keycloak fixture transport refused an unowned origin')
              const response = await sendSsoRequest(request)
              if (request.url === tokenEndpoint) exchanges.push(tokenExchange(response))
              return response
            },
          }),
          routes: productRoutes({
            db,
            invitationMailLimits: { secret },
            publicUrl: url,
            socialProviders,
            ...(oidcEnabled && { ssoOidcEnabled: true }),
          }),
        })
        server.on('request', getRequestListener(app.fetch, { hostname: '127.0.0.1' }))
        const checkBrowser = await guardBrowser(context, {
          url,
          idpOrigin: issuer.origin,
          personalCode,
        })
        await use({
          url,
          providerId,
          idp,
          linkedUserId,
          personal,
          magicLink: async (email) => {
            const link = mail.get(email)
            if (!link) throw new Error('No sign-in link in the fixture mail sink')
            mail.delete(email)
            return new URL(link)
          },
          tokenExchanges: () => [...exchanges],
        })
        checkBrowser()
      } finally {
        try {
          await listener?.close()
        } finally {
          setDefaultCACertificates(previousCAs)
          await releaseFixture(authPool, idp, owned.drop)
        }
      }
    },
    { timeout: 210_000 },
  ],
})

export { expect }
