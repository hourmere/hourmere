import { randomBytes } from 'node:crypto'
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import { writeSsoSecurityFailure } from '@hourmere/db/audit'
import { type SsoRequest, sendSsoRequest, ssoUrl } from '@hourmere/outbound/sso'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { apiBodyLimit } from './body-limit.ts'
import { createRateLimiter, rateLimitKey } from './rate-limit.ts'
import { requireSsoEnabled, type SsoCapabilities } from './sso.ts'
import { openSsoProviderConfiguration } from './sso-configuration.ts'
import { bindingCookieName, browserBindingDigest, sha256 } from './sso-mailbox-proof.ts'
import {
  consumeOidcAttempt,
  OidcAttemptRefused,
  OidcStateReplay,
  oidcReturnDestination,
  startOidcAttempt,
} from './sso-oidc-attempt.ts'
import { fetchOidcDiscovery, OidcJwksCache } from './sso-oidc-jwks.ts'
import { issueOidcSession, type OidcSessionOptions } from './sso-oidc-session.ts'
import { verifyOidcIdToken } from './sso-oidc-verifier.ts'

export const OIDC_SIGN_IN_PATH = '/api/auth/sign-in/sso'
export const OIDC_CALLBACK_PATH = '/api/auth/sso/callback/:providerId'
const errorPath = '/sign-in?error=unable_to_create_session'
const providerIdSchema = z.uuidv7()
const startInput = z.strictObject({
  providerId: providerIdSchema,
  intent: z.literal('sign_in'),
  returnTo: z.string().optional(),
})
const sealedConfig = z.strictObject({
  issuer: z.string().min(1),
  clientId: z.string().min(1).max(1024),
  clientSecret: z.string().min(1).max(16384),
  authorizationEndpoint: z.string().optional(),
  tokenEndpoint: z.string().optional(),
  jwksUrl: z.string().optional(),
  algorithms: z.tuple([z.literal('RS256')]).optional(),
})

interface OidcSignInDeps {
  db: Db
  capabilities: SsoCapabilities
  configurationKey?: Buffer | undefined
  privateTargets: SsoRequest['privateTargets']
  send?: typeof sendSsoRequest | undefined
  session: OidcSessionOptions
}

function findProvider(db: Db, providerId: string) {
  return db
    .selectFrom('sso_providers')
    .select([
      'id as providerId',
      'organization_id as organizationId',
      'revision',
      'configuration',
      'issuer',
      'client_id as clientId',
      'enabled',
      'retired_at as retiredAt',
    ])
    .where('id', '=', providerId)
    .where('protocol', '=', 'oidc')
    .executeTakeFirst()
}
type Provider = NonNullable<Awaited<ReturnType<typeof findProvider>>>

async function providerEndpoints(
  provider: Provider,
  configurationKey: Buffer,
  transport: { privateTargets: SsoRequest['privateTargets']; send: typeof sendSsoRequest },
) {
  const config = sealedConfig.parse(
    JSON.parse(openSsoProviderConfiguration(configurationKey, provider, provider.configuration)),
  )
  const { privateTargets } = transport
  const issuer = ssoUrl(config.issuer, privateTargets)
  if (
    !issuer ||
    issuer.includes('?') ||
    config.issuer !== provider.issuer ||
    config.clientId !== provider.clientId
  )
    throw new Error('Invalid OIDC configuration')
  const explicit = {
    authorizationEndpoint: ssoUrl(config.authorizationEndpoint, privateTargets),
    tokenEndpoint: ssoUrl(config.tokenEndpoint, privateTargets),
    jwksUrl: ssoUrl(config.jwksUrl, privateTargets),
  }
  if (
    (config.authorizationEndpoint !== undefined && !explicit.authorizationEndpoint) ||
    (config.tokenEndpoint !== undefined && !explicit.tokenEndpoint) ||
    (config.jwksUrl !== undefined && !explicit.jwksUrl)
  )
    throw new Error('Invalid OIDC endpoint')
  const discovery =
    explicit.authorizationEndpoint && explicit.tokenEndpoint && explicit.jwksUrl
      ? undefined
      : await fetchOidcDiscovery(
          {
            issuer: config.issuer,
            discoveryUrl: `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
            jwksUrl: explicit.jwksUrl,
          },
          transport,
        )
  const authorizationEndpoint = explicit.authorizationEndpoint ?? discovery?.authorizationEndpoint
  const tokenEndpoint = explicit.tokenEndpoint ?? discovery?.tokenEndpoint
  const jwksUrl = explicit.jwksUrl ?? discovery?.jwksUrl
  if (!authorizationEndpoint || !tokenEndpoint || !jwksUrl || authorizationEndpoint.includes('?'))
    throw new Error('Incomplete OIDC configuration')
  return {
    authorizationEndpoint,
    tokenEndpoint,
    jwksUrl,
    digest: sha256(JSON.stringify([authorizationEndpoint, tokenEndpoint, jwksUrl])),
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  }
}

/** Mount the auth-protocol exceptions ahead of Better Auth's wildcard. */
export interface OidcSignInModule {
  mount(shared: {
    app: OpenAPIHono
    publicUrl: string
    requestLogger: MiddlewareHandler
    clientIp: MiddlewareHandler
  }): void
}

export function oidcSignInRoutes(deps: OidcSignInDeps): OidcSignInModule {
  const { db, capabilities, configurationKey, privateTargets } = deps
  const transport = { send: deps.send ?? sendSsoRequest, privateTargets }
  const keys = new OidcJwksCache(transport)
  const starts = createRateLimiter({ limit: 30, windowSeconds: 60 })
  return {
    mount({ app, publicUrl, requestLogger, clientIp }) {
      const origin = new URL(publicUrl).origin
      const cookie = bindingCookieName(publicUrl)
      const secure = new URL(publicUrl).protocol === 'https:'
      const callbackUrl = (providerId: string) =>
        new URL(OIDC_CALLBACK_PATH.replace(':providerId', providerId), publicUrl).href
      const guard: MiddlewareHandler = async (c, next) => {
        c.header('Cache-Control', 'no-store')
        c.header('Referrer-Policy', 'no-referrer')
        requireSsoEnabled(capabilities, 'oidc')
        await next()
      }

      app.all(OIDC_SIGN_IN_PATH, requestLogger, guard, clientIp, apiBodyLimit(), async (c) => {
        if (c.req.method !== 'POST') return c.json({ error: 'method_not_allowed' }, 405)
        if (c.req.header('origin') !== origin || c.req.header('authorization') !== undefined)
          return c.json({ error: 'forbidden' }, 403)
        const parsed = startInput.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
        const returnPath = oidcReturnDestination(parsed.data.returnTo ?? '/app')
        if (!returnPath) return c.json({ error: 'invalid_request' }, 400)
        const wait = starts.hit(rateLimitKey(c.var.clientIp))
        if (wait !== undefined) {
          c.header('Retry-After', String(wait))
          return c.json({ error: 'rate_limited' }, 429)
        }
        const provider = await findProvider(db, parsed.data.providerId)
        if (!provider?.enabled || provider.retiredAt || !configurationKey)
          return c.json({ error: 'sso_not_found' }, 404)
        let endpoints: Awaited<ReturnType<typeof providerEndpoints>>
        try {
          endpoints = await providerEndpoints(provider, configurationKey, transport)
        } catch {
          return c.json({ error: 'sso_not_found' }, 404)
        }

        const currentBinding = getCookie(c, cookie)
        const reuse = currentBinding !== undefined && browserBindingDigest(currentBinding) !== null
        const browserBinding = reuse ? currentBinding : randomBytes(32).toString('base64url')
        try {
          const authorization = new URL(endpoints.authorizationEndpoint)
          const parameters = await startOidcAttempt(
            { db, configurationKey },
            { ...provider, browserBinding, returnPath, endpointsDigest: endpoints.digest },
          )
          authorization.search = new URLSearchParams({
            ...parameters,
            response_type: 'code',
            client_id: endpoints.clientId,
            redirect_uri: callbackUrl(provider.providerId),
            scope: 'openid email profile',
          }).toString()
          if (!reuse)
            setCookie(c, cookie, browserBinding, {
              httpOnly: true,
              secure,
              path: '/',
              sameSite: 'Lax',
            })
          return c.json({ url: authorization.href, redirect: true })
        } catch (error) {
          if (error instanceof OidcAttemptRefused) return c.json({ error: 'sso_not_found' }, 404)
          throw error
        }
      })

      app.all(OIDC_CALLBACK_PATH, requestLogger, guard, clientIp, async (c: Context) => {
        if (c.req.method !== 'GET') return c.json({ error: 'method_not_allowed' }, 405)
        if (c.req.header('authorization') !== undefined) return c.redirect(errorPath)
        const parsed = providerIdSchema.safeParse(c.req.param('providerId'))
        if (!parsed.success || !configurationKey) return c.redirect(errorPath)
        const provider = await findProvider(db, parsed.data)
        if (!provider) return c.redirect(errorPath)
        let correlationId: string | undefined
        const audit = {
          organizationId: provider.organizationId,
          providerId: provider.providerId,
          revision: provider.revision,
          method: 'oidc',
          actor: { type: 'anonymous' },
          credential: { type: 'none' },
        } as const
        const fail = async (reason: string) => {
          await writeSsoSecurityFailure(db, {
            ...audit,
            action: 'sso_authentication.failed',
            reason,
            ...(correlationId !== undefined && { correlationId }),
          })
          return c.redirect(errorPath)
        }
        if (!provider.enabled || provider.retiredAt) return fail('provider_disabled')

        const query = new URL(c.req.url).searchParams
        const states = query.getAll('state')
        if (states.length !== 1) return fail('attempt_invalid')
        let attempt: Awaited<ReturnType<typeof consumeOidcAttempt>>
        try {
          attempt = await consumeOidcAttempt(
            { db, configurationKey },
            { ...provider, state: states[0] ?? null, browserBinding: getCookie(c, cookie) },
          )
        } catch (error) {
          if (error instanceof OidcStateReplay) {
            await writeSsoSecurityFailure(db, {
              ...audit,
              action: 'sso_authentication.replay_rejected',
              correlationId: error.attemptId,
            })
            return c.redirect(errorPath)
          }
          if (error instanceof OidcAttemptRefused) return fail('attempt_invalid')
          throw error
        }
        correlationId = attempt.id
        if (query.has('error')) return fail('provider_error')
        const issuers = query.getAll('iss')
        if (issuers.length && (issuers.length !== 1 || issuers[0] !== provider.issuer))
          return fail('issuer_mismatch')
        const codes = query.getAll('code')
        const code = codes[0]
        if (codes.length !== 1 || !code || !/^[\x20-\x7e]{1,4096}$/.test(code))
          return fail('response_malformed')

        let endpoints: Awaited<ReturnType<typeof providerEndpoints>>
        let token: unknown
        try {
          endpoints = await providerEndpoints(provider, configurationKey, transport)
          if (endpoints.digest !== attempt.endpointsDigest) return fail('configuration_changed')
          // Authorization codes are single-use at the provider and PKCE-bound to this
          // attempt. The local state was committed as consumed before any exchange.
          const formComponent = (value: string) =>
            new URLSearchParams({ v: value }).toString().slice(2)
          const clientAuth = Buffer.from(
            `${formComponent(endpoints.clientId)}:${formComponent(endpoints.clientSecret)}`,
          ).toString('base64')
          const response = await transport.send({
            url: endpoints.tokenEndpoint,
            method: 'POST',
            headers: {
              accept: 'application/json',
              authorization: `Basic ${clientAuth}`,
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              code_verifier: attempt.codeVerifier,
              redirect_uri: callbackUrl(provider.providerId),
            }).toString(),
            privateTargets,
            signal: c.req.raw.signal,
          })
          if (response.status !== 200) return fail('token_exchange_failed')
          token = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(response.body),
          )?.id_token
        } catch {
          return fail('token_exchange_failed')
        }

        let identity: Awaited<ReturnType<typeof verifyOidcIdToken>>
        try {
          identity = await verifyOidcIdToken(
            keys,
            {
              providerId: provider.providerId,
              clientId: endpoints.clientId,
              issuer: provider.issuer,
              jwksUrl: endpoints.jwksUrl,
            },
            token,
            attempt.nonce,
          )
        } catch {
          return fail('response_malformed')
        }
        try {
          const session = await issueOidcSession(db, provider, identity, attempt, {
            ...deps.session,
            publicUrl,
            headers: c.req.raw.headers,
            ip: c.var.clientIp,
          })
          if (session.reason !== undefined) return fail(session.reason)
          c.header('Set-Cookie', session.cookie, { append: true })
          return c.redirect(attempt.returnPath)
        } catch (error) {
          if (error instanceof OidcAttemptRefused) return fail('configuration_changed')
          throw error
        }
      })
    },
  }
}
