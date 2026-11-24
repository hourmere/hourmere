import { randomBytes } from 'node:crypto'
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Principal, ScimClaimCompletion, SignupPolicy } from '@hourmere/auth'
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
import { delegationProofCookie, sealDelegationProof } from './sso-delegation-proof.ts'
import { type FreshProofDeps, runWithFreshProof } from './sso-fresh-proof.ts'
import {
  bindingCookieName,
  browserBindingDigest,
  MAILBOX_PROOF_CONFIRM_PATH,
  sha256,
} from './sso-mailbox-proof.ts'
import { completeOidcAdmission, stageOidcAdmission } from './sso-oidc-admission.ts'
import {
  consumeOidcAttempt,
  isOidcTestCallback,
  LINK_SSO_ACCOUNT,
  OidcAttemptRefused,
  OidcStateReplay,
  type OidcTestActor,
  oidcReturnDestination,
  recordOidcStepUp,
  startOidcAttempt,
  TEST_SSO_PROVIDER,
} from './sso-oidc-attempt.ts'
import {
  completeOidcSignIn,
  expiresDuringOidcWrite,
  stageOidcCompletion,
} from './sso-oidc-completion.ts'
import { fetchOidcDiscovery, OidcJwksCache } from './sso-oidc-jwks.ts'
import { authenticationAttemptLifetime } from './sso-oidc-limits.ts'
import {
  completeOidcLink,
  lockOidcLinkActor,
  lockOidcLinkDomain,
  OidcLinkDomainUnverified,
  oidcLinkReturnPath,
  stageOidcLink,
} from './sso-oidc-link.ts'
import {
  findOidcLink,
  issueOidcSession,
  normalizeOidcMailbox,
  type OidcSessionOptions,
} from './sso-oidc-session.ts'
import { recordOidcProviderTest } from './sso-oidc-test-receipts.ts'
import { verifyOidcIdToken } from './sso-oidc-verifier.ts'
import { authorizeSsoRead } from './sso-reads.ts'
import { providerRecoveryAuthority, ssoWriteContextAccess } from './sso-recovery-use.ts'
import { SamlStartRefused, startSamlSignIn } from './sso-saml-start.ts'
import { samlStateCookie, sealSamlState } from './sso-saml-state.ts'
import { EXPECTED_ORGANIZATION_HEADER } from './team-management.ts'

export const OIDC_SIGN_IN_PATH = '/api/auth/sign-in/sso'
export const OIDC_CALLBACK_PATH = '/api/auth/sso/callback/:providerId'
export const OIDC_COMPLETE_PATH = '/api/auth/sso/oidc/complete'
const ACCEPT_INVITATION_PATH = '/api/auth/organization/accept-invitation'
const OIDC_ADMISSION_HEADER = 'X-Hourmere-Sso-Attempt'
declare module 'hono' {
  interface ContextVariableMap {
    oidcInvitationAcceptance?: boolean
  }
}
const errorPath = '/sign-in?error=unable_to_create_session'
const testReturnPath = '/app/settings'
const providerIdSchema = z.uuidv7()
export const OidcSignInInput = z.discriminatedUnion('intent', [
  z.strictObject({
    providerId: providerIdSchema,
    intent: z.literal('sign_in'),
    returnTo: z.string().optional(),
  }),
  z.strictObject({
    providerId: providerIdSchema,
    intent: z.literal('step_up'),
    attemptId: z.uuid(),
    returnTo: z.string().optional(),
  }),
])
export const OidcCompleteInput = z.strictObject({ attemptId: z.uuidv7() })
const invitationInput = z.strictObject({ invitationId: z.uuid() })
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
  signup: SignupPolicy
  /**
   * The SCIM claim completion native invitation acceptance receives (the resource test flag of
   * docs/scim.md). Only test harnesses pass it, with the same value they pass createAuth.
   */
  scimClaims?: ScimClaimCompletion | undefined
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
  const scoped = organizationId ? query.where('organization_id', '=', organizationId) : query
  return (db.isTransaction ? scoped.forShare() : scoped).executeTakeFirst()
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
  stepUp = false,
) {
  const authorization = new URL(endpoints.authorizationEndpoint)
  authorization.search = new URLSearchParams({
    ...parameters,
    response_type: 'code',
    client_id: endpoints.clientId,
    redirect_uri: callbackUrl(publicUrl, providerId),
    scope: 'openid email profile',
    ...(stepUp && { prompt: 'login', max_age: '0' }),
  }).toString()
  return authorization.href
}

function authorizationBindingCookie(publicUrl: string, browserBinding: string) {
  // Top-level GET callbacks must receive the same binding as the fresh-proof request.
  return serialize(bindingCookieName(publicUrl), browserBinding, {
    httpOnly: true,
    secure: new URL(publicUrl).protocol === 'https:',
    path: '/',
    sameSite: 'Lax',
  })
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
  recoveryRequired = false,
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
    return provider
  }
  let authorized: Provider | undefined
  let endpoints: Awaited<ReturnType<typeof providerEndpoints>> | undefined
  const checkRevision = () => {
    if (authorized?.revision !== input.expectedRevision) throw changed()
  }
  const spendRecovery = providerRecoveryAuthority(principal, recoveryRequired)
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
      consumeRecovery: async (...args) => {
        const recovery = await spendRecovery(...args)
        if (recovery) checkRevision()
        return recovery
      },
      authorize: async (db) => {
        await authorizeSsoRead({ ...deps, db }, principal)
        await ssoWriteContextAccess(db, principal, headers, recoveryRequired)
        authorized = await draft(db)
      },
      authorizeOrdinary: () => {
        if (authorized?.enabled) throw missing()
        checkRevision()
      },
      prepare: async () => {
        if (!authorized || !configurationKey) throw missing()
        try {
          endpoints = await providerEndpoints(authorized, configurationKey, transport)
        } catch {
          throw missing()
        }
      },
      mutate: async (db, _input, browserBinding, _mailbox, _attemptId, recovery) => {
        const provider = authorized
        if (!provider || !configurationKey || !endpoints) throw missing()
        const parameters = await startOidcAttempt(
          { db, configurationKey },
          {
            ...provider,
            browserBinding,
            returnPath: testReturnPath,
            endpointsDigest: endpoints.digest,
          },
          {
            kind: 'test',
            actor,
            ...(recovery && {
              recovery: {
                deadline: recovery.deadline,
                acceptedAt: recovery.acceptedAt,
                testProviderEnabled: provider.enabled,
              },
            }),
          },
        )
        return {
          url: authorizationUrl(publicUrl, provider.providerId, endpoints, parameters),
          attemptId: parameters.id,
          setCookie: authorizationBindingCookie(publicUrl, browserBinding),
        }
      },
    },
  ).catch((error) => {
    if (error instanceof HTTPException && error.status === 403) throw denied()
    if (error instanceof OidcAttemptRefused || expiresDuringOidcWrite(error)) throw changed()
    throw error
  })
}

export const LinkSsoAccountInput = z.strictObject({ proofAttemptId: z.uuid().optional() })
const linkInput = z.strictObject({ providerId: providerIdSchema, revision: z.int().positive() })

export async function linkSsoAccount(
  deps: OidcProviderTestDeps,
  principal: Principal,
  headers: Headers,
  providerId: string,
  input: z.infer<typeof LinkSsoAccountInput>,
) {
  requireSsoEnabled(deps.capabilities, 'oidc')
  const denied = () => new DomainError('forbidden', 'team_management_access_denied')
  const missing = () => new DomainError('not_found', 'sso_not_found')
  const changed = () => new DomainError('conflict', 'sso_configuration_changed')
  if (
    principal.kind !== 'session' ||
    principal.organization.personal ||
    headers.has('authorization') ||
    headers.get('origin') !== new URL(deps.publicUrl).origin
  )
    throw denied()
  const organizationId = principal.organization.id
  if (headers.get(EXPECTED_ORGANIZATION_HEADER)?.toLowerCase() !== organizationId)
    throw new DomainError('conflict', 'organization_context_changed')
  const actor = { userId: principal.user.id, id: principal.sessionId }
  const { db, configurationKey, publicUrl } = deps
  const snapshot = await findProvider(db, providerId, organizationId)
  let authorized:
    | {
        context: Awaited<ReturnType<typeof lockOidcLinkActor>>
        claim: Awaited<ReturnType<typeof lockOidcLinkDomain>>
      }
    | undefined
  let endpoints: Awaited<ReturnType<typeof providerEndpoints>> | undefined
  try {
    return await runWithFreshProof(
      deps,
      {
        headers,
        userId: actor.userId,
        sessionId: actor.id,
        organizationId,
        operation: LINK_SSO_ACCOUNT,
        proofMode: 'mailbox',
        input: { ...input, providerId, revision: snapshot?.revision ?? 1 },
        schema: linkInput,
      },
      {
        authorize: async (trx) => {
          const context = await lockOidcLinkActor(trx, organizationId, actor).catch((error) => {
            if (error instanceof OidcAttemptRefused) throw denied()
            throw error
          })
          const current = await findProvider(trx, providerId, organizationId)
          if (!current || current.retiredAt) throw missing()
          if (current.protocol !== 'oidc') throw new DomainError('not_found', 'sso_disabled')
          if (!current.enabled) throw missing()
          if (current.revision !== snapshot?.revision) throw changed()
          const claim = await lockOidcLinkDomain(trx, current, context.mailbox)
          authorized = { context, claim }
        },
        prepare: async () => {
          if (!snapshot || !configurationKey) throw missing()
          try {
            endpoints = await providerEndpoints(snapshot, configurationKey, {
              privateTargets: deps.privateTargets ?? [],
              send: deps.send ?? sendSsoRequest,
            })
          } catch {
            throw missing()
          }
        },
        mutate: async (trx, _input, browserBinding, mailboxProof) => {
          if (!snapshot || !configurationKey || !endpoints || !authorized || !mailboxProof)
            throw new OidcAttemptRefused()
          const { context, claim } = authorized
          if (context.mailbox !== mailboxProof.mailbox) throw new OidcAttemptRefused()
          const parameters = await startOidcAttempt(
            { db: trx, configurationKey },
            {
              ...snapshot,
              browserBinding,
              returnPath: oidcLinkReturnPath,
              endpointsDigest: endpoints.digest,
            },
            {
              kind: 'link',
              actor,
              binding: {
                memberId: context.member.id,
                domainId: claim.id,
                domainGeneration: claim.generation,
                mailboxDigest: sha256(mailboxProof.mailbox),
                provenAt: mailboxProof.provenAt,
                proofExpiresAt: mailboxProof.expiresAt,
              },
            },
          )
          return {
            url: authorizationUrl(publicUrl, snapshot.providerId, endpoints, parameters),
            attemptId: parameters.id,
            setCookie: authorizationBindingCookie(publicUrl, browserBinding),
          }
        },
      },
    )
  } catch (error) {
    if (error instanceof OidcLinkDomainUnverified)
      throw new DomainError('conflict', 'sso_domain_unverified')
    if (error instanceof HTTPException && error.status === 403) throw denied()
    if (error instanceof OidcAttemptRefused || expiresDuringOidcWrite(error)) throw changed()
    throw error
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
  mountInvitationAcceptance(app: OpenAPIHono, publicUrl: string): void
}

function admissionCookieName(publicUrl: string, id: string) {
  const secure = new URL(publicUrl).protocol === 'https:'
  return `${secure ? '__Secure-' : ''}hourmere.oidc_admission.${id}`
}

function admissionCookieOptions(publicUrl: string) {
  return {
    httpOnly: true,
    secure: new URL(publicUrl).protocol === 'https:',
    sameSite: 'Strict',
    path: '/api/auth',
  } as const
}

function admissionRefused(
  c: Context,
  status: Exclude<
    Awaited<ReturnType<typeof completeOidcAdmission>>['status'],
    'completed' | 'link_required'
  >,
) {
  switch (status) {
    case 'domain_unverified':
      return c.json({ error: 'sso_domain_unverified' }, 409)
    case 'invitation_required':
      return c.json({ error: 'sso_invitation_required' }, 409)
    case 'signup_disabled':
      return c.json({ error: 'signup_disabled' }, 403)
    case 'membership_limit':
      return c.json({ error: 'organization_membership_limit_reached' }, 403)
    case 'blocked':
      return c.json({ error: 'team_management_access_denied' }, 403)
    case 'invitation_invalid':
      return c.json({ error: 'team_management_access_denied' }, 403)
    case 'subject_conflict':
    case 'invalid':
      return c.json(completionInvalid, 400)
  }
}

export function oidcSignInRoutes(deps: OidcSignInDeps): OidcSignInModule {
  const { db, capabilities, configurationKey, privateTargets, signup, scimClaims } = deps
  const transport = { send: deps.send ?? sendSsoRequest, privateTargets }
  const keys = new OidcJwksCache(transport)
  const starts = createRateLimiter({ limit: 30, windowSeconds: 60 })
  const completions = createRateLimiter({ limit: 30, windowSeconds: 60 })
  const sessionOptions = (c: Context, publicUrl: string) => ({
    ...deps.session,
    publicUrl,
    headers: c.req.raw.headers,
    ip: c.var.clientIp,
  })
  return {
    mount({ app, publicUrl, requestLogger, clientIp }) {
      const origin = new URL(publicUrl).origin
      const cookie = bindingCookieName(publicUrl)
      const secure = new URL(publicUrl).protocol === 'https:'
      const startBindingOptions = { httpOnly: true, secure, path: '/', sameSite: 'Lax' } as const
      const resultCookieName = (id: string) =>
        `${secure ? '__Secure-' : ''}hourmere.oidc_result.${id}`
      const resultCookieOptions = {
        httpOnly: true,
        secure,
        sameSite: 'Strict',
        path: OIDC_COMPLETE_PATH,
      } as const
      const guard =
        (protocol?: 'oidc'): MiddlewareHandler =>
        async (c, next) => {
          c.header('Cache-Control', 'no-store')
          c.header('Referrer-Policy', 'no-referrer')
          requireSsoEnabled(capabilities, protocol)
          await next()
        }
      const oidcGuard = guard('oidc')

      app.all(OIDC_SIGN_IN_PATH, requestLogger, guard(), clientIp, apiBodyLimit(), async (c) => {
        if (c.req.method !== 'POST') return c.json({ error: 'method_not_allowed' }, 405)
        if (c.req.header('origin') !== origin || c.req.header('authorization') !== undefined)
          return c.json({ error: 'forbidden' }, 403)
        const parsed = OidcSignInInput.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
        const returnPath = oidcReturnDestination(parsed.data.returnTo ?? '/app')
        if (!returnPath) return c.json({ error: 'invalid_request' }, 400)
        const wait = starts.hit(rateLimitKey(c.var.clientIp))
        if (wait !== undefined) {
          c.header('Retry-After', String(wait))
          return c.json({ error: 'rate_limited' }, 429)
        }
        const currentBinding = getCookie(c, cookie)
        const reuse = currentBinding !== undefined && browserBindingDigest(currentBinding) !== null
        const browserBinding = reuse ? currentBinding : randomBytes(32).toString('base64url')
        const provider = await findProvider(db, parsed.data.providerId)
        if (!provider?.enabled || provider.retiredAt) return c.json({ error: 'sso_not_found' }, 404)
        if (provider.protocol === 'oidc' || provider.protocol === 'saml') {
          requireSsoEnabled(capabilities, provider.protocol)
        }
        if (!configurationKey) return c.json({ error: 'sso_not_found' }, 404)
        if (provider.protocol === 'saml') {
          if (parsed.data.intent !== 'sign_in') return c.json({ error: 'invalid_request' }, 400)
          if (!returnPath.startsWith('/app')) return c.json({ error: 'invalid_request' }, 400)
          try {
            const { id, url } = await startSamlSignIn(
              { db, configurationKey, privateTargets, publicUrl },
              provider,
              browserBinding,
            )
            const result = samlStateCookie(publicUrl, 'return', id)
            setCookie(c, cookie, browserBinding, startBindingOptions)
            setCookie(c, result.name, sealSamlState(configurationKey, 'return', id, returnPath), {
              ...result.options,
              maxAge: authenticationAttemptLifetime,
            })
            return c.json({ url, redirect: true })
          } catch (error) {
            if (error instanceof SamlStartRefused) return c.json({ error: 'sso_not_found' }, 404)
            throw error
          }
        }
        if (provider.protocol !== 'oidc') return c.json({ error: 'sso_not_found' }, 404)
        let ceremony: { kind: 'step_up'; actor: OidcTestActor; attemptId: string } | undefined
        if (parsed.data.intent === 'step_up') {
          const actor = reuse && (await deps.readSession(c.req.raw.headers))
          if (!actor) return c.json({ error: 'sso_not_found' }, 404)
          ceremony = { kind: 'step_up', actor, attemptId: parsed.data.attemptId }
        }
        let endpoints: Awaited<ReturnType<typeof providerEndpoints>>
        try {
          endpoints = await providerEndpoints(provider, configurationKey, transport)
        } catch {
          return c.json({ error: 'sso_not_found' }, 404)
        }

        try {
          const parameters = await startOidcAttempt(
            { db, configurationKey },
            { ...provider, browserBinding, returnPath, endpointsDigest: endpoints.digest },
            ceremony,
          )
          // A binding issued by fresh administration can still have SameSite=Strict.
          // Keep its value and allow the top-level GET back from the provider.
          setCookie(c, cookie, browserBinding, startBindingOptions)
          return c.json({
            url: authorizationUrl(
              publicUrl,
              provider.providerId,
              endpoints,
              parameters,
              !!ceremony,
            ),
            redirect: true,
          })
        } catch (error) {
          if (error instanceof OidcAttemptRefused || (ceremony && expiresDuringOidcWrite(error)))
            return c.json({ error: 'sso_not_found' }, 404)
          throw error
        }
      })

      app.all(OIDC_CALLBACK_PATH, requestLogger, oidcGuard, clientIp, async (c: Context) => {
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
        const query = new URL(c.req.url).searchParams
        const states = query.getAll('state')
        const browser = { ...provider, browserBinding: getCookie(c, cookie) }
        const readActor = () => deps.readSession(c.req.raw.headers)
        const testActor = !provider.enabled && !provider.retiredAt ? await readActor() : undefined
        const quietTestRefusal = async () =>
          testActor || (await isOidcTestCallback(db, browser, states[0], readActor))
        const refuseAttempt = async (reason: SsoAuditReason) =>
          (await quietTestRefusal()) ? c.redirect(errorPath) : fail(reason)
        if (provider.retiredAt) return refuseAttempt('provider_disabled')
        if (!provider.enabled && !testActor) return c.redirect(errorPath)
        if (states.length !== 1) return refuseAttempt('attempt_invalid')
        let attempt: Awaited<ReturnType<typeof consumeOidcAttempt>>
        try {
          attempt = await consumeOidcAttempt(
            { db, configurationKey },
            { ...browser, state: states[0] ?? null },
            testActor ? { kind: 'test', actor: testActor } : undefined,
            readActor,
          )
        } catch (error) {
          if (error instanceof OidcStateReplay) {
            if (await quietTestRefusal()) return c.redirect(errorPath)
            await writeSsoSecurityFailure(db, {
              ...audit,
              action: 'sso_authentication.replay_rejected',
              correlationId: error.attemptId,
            })
            return c.redirect(errorPath)
          }
          if (error instanceof OidcAttemptRefused) return refuseAttempt('attempt_invalid')
          throw error
        }
        correlationId = attempt.id
        const finishTest = async (reason?: SsoAuditReason) => {
          try {
            await recordOidcProviderTest(db, provider, attempt, reason)
            return c.redirect(attempt.returnPath)
          } catch (error) {
            if (error instanceof OidcAttemptRefused) return c.redirect(errorPath)
            throw error
          }
        }
        const failResponse = (reason: SsoAuditReason) =>
          attempt.test ? finishTest(reason) : fail(reason)
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
        if (attempt.test) return finishTest()
        try {
          if (attempt.stepUp) {
            const browserBinding = getCookie(c, cookie)
            const result = await recordOidcStepUp(
              db,
              { ...provider, browserBinding },
              attempt.stepUp,
              attempt.createdAt,
              identity,
            )
            if (result.failure) return fail(result.failure)
            if (result.delegation) {
              const digest = browserBindingDigest(browserBinding)
              if (!digest) throw new OidcAttemptRefused()
              const { attemptId, linkGeneration, expiresAt } = result.delegation
              const { name, options } = delegationProofCookie(publicUrl, attemptId)
              const envelope = sealDelegationProof(configurationKey, provider, attemptId, digest, {
                linkGeneration,
                sessionDeadline: identity.sessionDeadline?.toISOString(),
              })
              setCookie(c, name, envelope, { ...options, expires: expiresAt })
            }
            return c.redirect(attempt.returnPath)
          }
          if (attempt.link) {
            const pending = await stageOidcLink(
              { db, configurationKey },
              provider,
              attempt.link,
              identity,
              attempt.expiresAt,
              getCookie(c, cookie),
            )
            setCookie(c, resultCookieName(pending.id), pending.envelope, {
              ...resultCookieOptions,
              expires: pending.expiresAt,
            })
            return c.redirect(`${oidcLinkReturnPath}#sso-link=${pending.id}`)
          }
          const link = await findOidcLink(db, provider, identity)
          if (identity.email === undefined || link?.retired_at) return fail('mailbox_unproven')
          if (!link) {
            const pending = await stageOidcAdmission(
              { db, configurationKey },
              provider,
              { ...identity, email: identity.email },
              attempt,
              getCookie(c, cookie),
            )
            if (pending.reason !== undefined) return fail(pending.reason)
            setCookie(c, admissionCookieName(publicUrl, pending.id), pending.envelope, {
              ...admissionCookieOptions(publicUrl),
              expires: pending.expiresAt,
            })
            return c.redirect(`${MAILBOX_PROOF_CONFIRM_PATH}#attempt=${pending.id}`)
          }
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
            sessionOptions(c, publicUrl),
          )
          if ('reason' in session) return fail(session.reason)
          c.header('Set-Cookie', session.cookie, { append: true })
          return c.redirect(attempt.returnPath)
        } catch (error) {
          if (error instanceof OidcLinkDomainUnverified) return fail('domain_unverified')
          if ((attempt.link || attempt.stepUp) && expiresDuringOidcWrite(error))
            return fail('attempt_expired')
          if (error instanceof OidcAttemptRefused) return fail('configuration_changed')
          throw error
        }
      })

      app.all(OIDC_COMPLETE_PATH, requestLogger, oidcGuard, clientIp, apiBodyLimit(), async (c) => {
        if (c.req.method !== 'POST') return c.json({ error: 'method_not_allowed' }, 405)
        if (c.req.header('origin') !== origin || c.req.header('authorization') !== undefined)
          return c.json({ error: 'forbidden' }, 403)
        const parsed = OidcCompleteInput.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
        const wait = completions.hit(rateLimitKey(c.var.clientIp))
        if (wait !== undefined) {
          c.header('Retry-After', String(wait))
          return c.json({ error: 'rate_limited' }, 429)
        }
        if (!configurationKey) return c.json(completionInvalid, 400)
        const id = parsed.data.attemptId
        const admissionName = admissionCookieName(publicUrl, id)
        const admissionEnvelope = getCookie(c, admissionName)
        if (admissionEnvelope !== undefined) {
          const admission = await completeOidcAdmission(
            { db, configurationKey, signup },
            { id, browserBinding: getCookie(c, cookie), envelope: admissionEnvelope },
            sessionOptions(c, publicUrl),
            { kind: 'jit' },
          )
          if (admission.status !== 'completed' && admission.status !== 'link_required')
            return admissionRefused(c, admission.status)
          deleteCookie(c, admissionName, admissionCookieOptions(publicUrl))
          if (admission.status === 'link_required') return c.json({ status: 'link_required' })
          c.header('Set-Cookie', admission.cookie, { append: true })
          return c.redirect(admission.returnPath)
        }
        const name = resultCookieName(id)
        const pending = { id, browserBinding: getCookie(c, cookie), envelope: getCookie(c, name) }
        const link = await completeOidcLink({ db, configurationKey }, pending, () =>
          deps.readSession(c.req.raw.headers),
        )
        if (link?.status === 'invalid') return c.json(completionInvalid, 400)
        if (link?.status === 'domain_unverified')
          return c.json({ error: 'sso_domain_unverified' }, 409)
        if (link?.status === 'linked') {
          deleteCookie(c, name, resultCookieOptions)
          return c.redirect(oidcLinkReturnPath)
        }
        const result = await completeOidcSignIn(
          { db, configurationKey },
          pending,
          sessionOptions(c, publicUrl),
        )
        if (result.status === 'invalid') return c.json(completionInvalid, 400)
        deleteCookie(c, name, resultCookieOptions)
        if (result.status === 'collision') return c.json({ error: 'sso_email_collision' }, 409)
        c.header('Set-Cookie', result.cookie, { append: true })
        return c.redirect(result.returnPath)
      })
    },
    mountInvitationAcceptance(app, publicUrl) {
      const origin = new URL(publicUrl).origin
      const cookie = bindingCookieName(publicUrl)
      const cookieOptions = admissionCookieOptions(publicUrl)
      app.post(ACCEPT_INVITATION_PATH, async (c, next) => {
        const id = providerIdSchema.safeParse(c.req.header(OIDC_ADMISSION_HEADER))
        if (!id.success) return next()
        const name = admissionCookieName(publicUrl, id.data)
        const envelope = getCookie(c, name)
        if (envelope === undefined) return next()

        c.set('oidcInvitationAcceptance', true)
        c.header('Cache-Control', 'no-store')
        c.header('Referrer-Policy', 'no-referrer')
        requireSsoEnabled(capabilities, 'oidc')
        if (c.req.header('origin') !== origin || c.req.header('authorization') !== undefined)
          return c.json({ error: 'forbidden' }, 403)
        const invitation = invitationInput.safeParse(await c.req.json().catch(() => null))
        if (!invitation.success) return c.json({ error: 'invalid_request' }, 400)
        const wait = completions.hit(rateLimitKey(c.var.clientIp))
        if (wait !== undefined) {
          c.header('Retry-After', String(wait))
          return c.json({ error: 'rate_limited' }, 429)
        }
        if (!configurationKey) return c.json(completionInvalid, 400)
        const result = await completeOidcAdmission(
          { db, configurationKey, signup, scimClaims },
          { id: id.data, browserBinding: getCookie(c, cookie), envelope },
          sessionOptions(c, publicUrl),
          { kind: 'invitation', invitationId: invitation.data.invitationId },
        )
        if (result.status !== 'completed' && result.status !== 'link_required')
          return admissionRefused(c, result.status)
        deleteCookie(c, name, cookieOptions)
        if (result.status === 'link_required') return c.json({ status: 'link_required' })
        c.header('Set-Cookie', result.cookie, { append: true })
        return c.json({ invitation: result.invitation, member: result.member })
      })
    },
  }
}
