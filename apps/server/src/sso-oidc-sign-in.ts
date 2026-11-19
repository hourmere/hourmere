import { randomBytes } from 'node:crypto'
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { type SsoAuditReason, writeSsoSecurityFailure } from '@hourmere/db/audit'
import { type SsoRequest, sendSsoRequest, ssoUrl } from '@hourmere/outbound/sso'
import { DomainError } from '@hourmere/scheduling'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { serialize } from 'hono/utils/cookie'
import { z } from 'zod'
import { apiBodyLimit } from './body-limit.ts'
import { createRateLimiter, rateLimitKey } from './rate-limit.ts'
import { requireSsoEnabled, type SsoCapabilities } from './sso.ts'
import { openSsoProviderConfiguration } from './sso-configuration.ts'
import { type FreshProofDeps, runWithFreshProof } from './sso-fresh-proof.ts'
import {
  bindingCookieName,
  browserBindingDigest,
  MAILBOX_PROOF_CONFIRM_PATH,
  sha256,
} from './sso-mailbox-proof.ts'
import {
  consumeOidcAttempt,
  OidcAttemptRefused,
  OidcStateReplay,
  type OidcTestActor,
  oidcReturnDestination,
  startOidcAttempt,
  TEST_SSO_PROVIDER,
} from './sso-oidc-attempt.ts'
import { completeOidcSignIn, stageOidcCompletion } from './sso-oidc-completion.ts'
import { fetchOidcDiscovery, OidcJwksCache } from './sso-oidc-jwks.ts'
import {
  findOidcLink,
  issueOidcSession,
  normalizeOidcMailbox,
  type OidcSessionOptions,
} from './sso-oidc-session.ts'
import { recordOidcProviderTest } from './sso-oidc-test-receipts.ts'
import { verifyOidcIdToken } from './sso-oidc-verifier.ts'
import { authorizeSsoRead } from './sso-reads.ts'
import { EXPECTED_ORGANIZATION_HEADER, organizationContextAccess } from './team-management.ts'

export const OIDC_SIGN_IN_PATH = '/api/auth/sign-in/sso'
export const OIDC_CALLBACK_PATH = '/api/auth/sso/callback/:providerId'
export const OIDC_COMPLETE_PATH = '/api/auth/sso/oidc/complete'
const errorPath = '/sign-in?error=unable_to_create_session'
const testReturnPath = '/app/settings'
const providerIdSchema = z.uuidv7()
const startInput = z.strictObject({
  providerId: providerIdSchema,
  intent: z.literal('sign_in'),
  returnTo: z.string().optional(),
})
const completeInput = z.strictObject({ attemptId: z.uuidv7() })
const completionInvalid = { error: 'sso_oidc_completion_invalid' } as const
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
  readSession: (headers: Headers) => Promise<OidcTestActor | null | undefined>
}

function findProvider(db: Db, providerId: string, organizationId?: string) {
  const query = db
    .selectFrom('sso_providers')
    .select([
      'id as providerId',
      'organization_id as organizationId',
      'revision',
      'protocol',
      'configuration',
      'issuer',
      'client_id as clientId',
      'enabled',
      'retired_at as retiredAt',
    ])
    .where('id', '=', providerId)
  return (
    organizationId ? query.where('organization_id', '=', organizationId).forShare() : query
  ).executeTakeFirst()
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

function callbackUrl(publicUrl: string, providerId: string) {
  return new URL(OIDC_CALLBACK_PATH.replace(':providerId', providerId), publicUrl).href
}

function authorizationUrl(
  publicUrl: string,
  providerId: string,
  endpoints: Awaited<ReturnType<typeof providerEndpoints>>,
  { id: _id, ...parameters }: Awaited<ReturnType<typeof startOidcAttempt>>,
) {
  const authorization = new URL(endpoints.authorizationEndpoint)
  authorization.search = new URLSearchParams({
    ...parameters,
    response_type: 'code',
    client_id: endpoints.clientId,
    redirect_uri: callbackUrl(publicUrl, providerId),
    scope: 'openid email profile',
  }).toString()
  return authorization.href
}

const testInput = z.strictObject({ expectedRevision: z.number().int().min(1).max(2147483647) })
export const TestSsoProviderInput = testInput.extend({ proofAttemptId: z.uuid().optional() })
export interface OidcProviderTestDeps extends FreshProofDeps {
  configurationKey?: Buffer | undefined
  privateTargets?: SsoRequest['privateTargets'] | undefined
  send?: typeof sendSsoRequest | undefined
}

export async function testSsoProvider(
  deps: OidcProviderTestDeps,
  principal: Principal,
  headers: Headers,
  providerId: string,
  input: z.infer<typeof TestSsoProviderInput>,
) {
  requireSsoEnabled(deps.capabilities, 'oidc')
  const denied = () => new DomainError('forbidden', 'team_management_access_denied')
  const missing = () => new DomainError('not_found', 'sso_not_found')
  const changed = () => new DomainError('conflict', 'sso_configuration_changed')
  if (principal.kind !== 'session' || principal.organization.personal) throw denied()
  const organizationId = principal.organization.id
  const actor = { userId: principal.user.id, id: principal.sessionId }
  const { configurationKey, publicUrl } = deps
  const transport = { privateTargets: deps.privateTargets ?? [], send: deps.send ?? sendSsoRequest }
  const draft = async (db: Db) => {
    const provider = await findProvider(db, providerId, organizationId)
    if (!provider || provider.retiredAt) throw missing()
    if (provider.protocol !== 'oidc') throw new DomainError('not_found', 'sso_disabled')
    if (provider.enabled) throw missing()
    if (provider.revision !== input.expectedRevision) throw changed()
    return provider
  }
  return runWithFreshProof(
    deps,
    {
      headers,
      userId: actor.userId,
      sessionId: actor.id,
      organizationId,
      operation: TEST_SSO_PROVIDER,
      input: { ...input, providerId },
      schema: testInput.extend({ providerId: providerIdSchema }),
    },
    {
      authorize: async (db) => {
        await authorizeSsoRead({ ...deps, db }, principal)
        await organizationContextAccess(
          principal,
          headers.get(EXPECTED_ORGANIZATION_HEADER) ?? undefined,
          true,
          true,
        )(db, organizationId)
        await draft(db)
      },
      mutate: async (db, _input, browserBinding) => {
        const provider = await draft(db)
        if (!configurationKey) throw missing()
        let endpoints: Awaited<ReturnType<typeof providerEndpoints>>
        try {
          endpoints = await providerEndpoints(provider, configurationKey, transport)
        } catch {
          throw missing()
        }
        const parameters = await startOidcAttempt(
          { db, configurationKey },
          {
            ...provider,
            browserBinding,
            returnPath: testReturnPath,
            endpointsDigest: endpoints.digest,
          },
          { kind: 'test', actor },
        )
        return {
          url: authorizationUrl(publicUrl, provider.providerId, endpoints, parameters),
          attemptId: parameters.id,
          // Retain the fresh-proof binding for the cross-site top-level callback.
          setCookie: serialize(bindingCookieName(publicUrl), browserBinding, {
            httpOnly: true,
            secure: new URL(publicUrl).protocol === 'https:',
            path: '/',
            sameSite: 'Lax',
          }),
        }
      },
    },
  ).catch((error) => {
    if (error instanceof HTTPException && error.status === 403) throw denied()
    if (error instanceof OidcAttemptRefused) throw changed()
    throw error
  })
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
  const completions = createRateLimiter({ limit: 30, windowSeconds: 60 })
  return {
    mount({ app, publicUrl, requestLogger, clientIp }) {
      const origin = new URL(publicUrl).origin
      const cookie = bindingCookieName(publicUrl)
      const secure = new URL(publicUrl).protocol === 'https:'
      const resultCookieName = (id: string) =>
        `${secure ? '__Secure-' : ''}hourmere.oidc_result.${id}`
      const resultCookieOptions = {
        httpOnly: true,
        secure,
        sameSite: 'Strict',
        path: OIDC_COMPLETE_PATH,
      } as const
      const sessionOptions = (c: Context) => ({
        ...deps.session,
        publicUrl,
        headers: c.req.raw.headers,
        ip: c.var.clientIp,
      })
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
        if (
          provider?.protocol !== 'oidc' ||
          !provider.enabled ||
          provider.retiredAt ||
          !configurationKey
        )
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
          const parameters = await startOidcAttempt(
            { db, configurationKey },
            { ...provider, browserBinding, returnPath, endpointsDigest: endpoints.digest },
          )
          // A binding issued by fresh administration can still have SameSite=Strict.
          // Keep its value and allow the top-level GET back from the provider.
          setCookie(c, cookie, browserBinding, {
            httpOnly: true,
            secure,
            path: '/',
            sameSite: 'Lax',
          })
          return c.json({
            url: authorizationUrl(publicUrl, provider.providerId, endpoints, parameters),
            redirect: true,
          })
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
        if (provider?.protocol !== 'oidc') return c.redirect(errorPath)
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
        if (provider.retiredAt) return fail('provider_disabled')
        const testActor = provider.enabled ? undefined : await deps.readSession(c.req.raw.headers)
        if (!provider.enabled && !testActor) return c.redirect(errorPath)
        const refuseAttempt = () => (testActor ? c.redirect(errorPath) : fail('attempt_invalid'))

        const query = new URL(c.req.url).searchParams
        const states = query.getAll('state')
        if (states.length !== 1) return refuseAttempt()
        let attempt: Awaited<ReturnType<typeof consumeOidcAttempt>>
        try {
          attempt = await consumeOidcAttempt(
            { db, configurationKey },
            { ...provider, state: states[0] ?? null, browserBinding: getCookie(c, cookie) },
            testActor ? { kind: 'test', actor: testActor } : undefined,
          )
        } catch (error) {
          if (error instanceof OidcStateReplay) {
            if (testActor) return c.redirect(errorPath)
            await writeSsoSecurityFailure(db, {
              ...audit,
              action: 'sso_authentication.replay_rejected',
              correlationId: error.attemptId,
            })
            return c.redirect(errorPath)
          }
          if (error instanceof OidcAttemptRefused) return refuseAttempt()
          throw error
        }
        correlationId = attempt.id
        const finishTest = async (actor: OidcTestActor, reason?: SsoAuditReason) => {
          try {
            await recordOidcProviderTest(db, provider, actor, attempt, reason)
            return c.redirect(attempt.returnPath)
          } catch (error) {
            if (error instanceof OidcAttemptRefused) return c.redirect(errorPath)
            throw error
          }
        }
        const failResponse = (reason: SsoAuditReason) =>
          testActor ? finishTest(testActor, reason) : fail(reason)
        if (query.has('error')) return failResponse('provider_error')
        const issuers = query.getAll('iss')
        if (issuers.length && (issuers.length !== 1 || issuers[0] !== provider.issuer))
          return failResponse('issuer_mismatch')
        const codes = query.getAll('code')
        const code = codes[0]
        if (codes.length !== 1 || !code || !/^[\x20-\x7e]{1,4096}$/.test(code))
          return failResponse('response_malformed')

        let endpoints: Awaited<ReturnType<typeof providerEndpoints>>
        let token: unknown
        try {
          endpoints = await providerEndpoints(provider, configurationKey, transport)
          if (endpoints.digest !== attempt.endpointsDigest)
            return failResponse('configuration_changed')
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
              redirect_uri: callbackUrl(publicUrl, provider.providerId),
            }).toString(),
            privateTargets,
            signal: c.req.raw.signal,
          })
          if (response.status !== 200) return failResponse('token_exchange_failed')
          token = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(response.body),
          )?.id_token
        } catch {
          return failResponse('token_exchange_failed')
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
          return failResponse('response_malformed')
        }
        if (testActor) return finishTest(testActor)
        try {
          const link = await findOidcLink(db, provider, identity)
          if (!link || identity.email === undefined) return fail('mailbox_unproven')
          const mailbox = normalizeOidcMailbox(identity.email)
          if (mailbox !== link.proven_email) {
            const pending = await stageOidcCompletion(
              { db, configurationKey },
              provider,
              link,
              mailbox,
              identity.sessionDeadline,
              attempt,
              getCookie(c, cookie),
            )
            if (pending.reason !== undefined) return fail(pending.reason)
            setCookie(c, resultCookieName(pending.id), pending.envelope, {
              ...resultCookieOptions,
              expires: pending.expiresAt,
            })
            return c.redirect(`${MAILBOX_PROOF_CONFIRM_PATH}#attempt=${pending.id}`)
          }
          const session = await issueOidcSession(
            db,
            provider,
            link,
            identity.sessionDeadline,
            attempt,
            sessionOptions(c),
          )
          if ('reason' in session) return fail(session.reason)
          c.header('Set-Cookie', session.cookie, { append: true })
          return c.redirect(attempt.returnPath)
        } catch (error) {
          if (error instanceof OidcAttemptRefused) return fail('configuration_changed')
          throw error
        }
      })

      app.all(OIDC_COMPLETE_PATH, requestLogger, guard, clientIp, apiBodyLimit(), async (c) => {
        if (c.req.method !== 'POST') return c.json({ error: 'method_not_allowed' }, 405)
        if (c.req.header('origin') !== origin || c.req.header('authorization') !== undefined)
          return c.json({ error: 'forbidden' }, 403)
        const parsed = completeInput.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
        const wait = completions.hit(rateLimitKey(c.var.clientIp))
        if (wait !== undefined) {
          c.header('Retry-After', String(wait))
          return c.json({ error: 'rate_limited' }, 429)
        }
        if (!configurationKey) return c.json(completionInvalid, 400)
        const id = parsed.data.attemptId
        const name = resultCookieName(id)
        const result = await completeOidcSignIn(
          { db, configurationKey },
          { id, browserBinding: getCookie(c, cookie), envelope: getCookie(c, name) },
          sessionOptions(c),
        )
        if (result.status === 'invalid') return c.json(completionInvalid, 400)
        deleteCookie(c, name, resultCookieOptions)
        if (result.status === 'collision') return c.json({ error: 'sso_email_collision' }, 409)
        c.header('Set-Cookie', result.cookie, { append: true })
        return c.redirect(result.returnPath)
      })
    },
  }
}
