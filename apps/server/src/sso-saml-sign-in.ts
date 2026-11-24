import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import { type SsoAuditReason, writeSsoSecurityFailure } from '@hourmere/db/audit'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { sql } from 'kysely'
import { z } from 'zod'
import { apiBodyLimit, routeBodyLimit } from './body-limit.ts'
import { createRateLimiter, rateLimitKey } from './rate-limit.ts'
import { requireSsoEnabled, type SsoCapabilities } from './sso.ts'
import { openSsoProviderConfiguration, type SsoProviderRevision } from './sso-configuration.ts'
import { bindingCookieName, browserBindingDigest, sha256 } from './sso-mailbox-proof.ts'
import {
  lockOidcProvider,
  lockOidcTestActor,
  OidcAttemptRefused,
  type OidcTestActor,
  oidcReturnDestination,
} from './sso-oidc-attempt.ts'
import { expiresDuringOidcWrite } from './sso-oidc-completion.ts'
import {
  findOidcLink,
  lockOidcSignInContext,
  normalizeOidcMailbox,
  type OidcSessionOptions,
  type OidcSessionRequest,
  oidcSignInTiming,
  writeOidcSession,
} from './sso-oidc-session.ts'
import { writeSsoProviderTestReceipt } from './sso-oidc-test-receipts.ts'
import { samlServiceProviderMetadata } from './sso-saml-configuration.ts'
import {
  consumeSamlReplay,
  SamlTimingError,
  samlAcceptanceExpired,
  samlDatabaseInstantText,
  samlDatabaseNow,
  samlRequestExpired,
  samlSessionDeadline,
} from './sso-saml-replay.ts'
import {
  openSamlState,
  SAML_ACS_PATH,
  SAML_COMPLETE_PATH,
  SAML_METADATA_PATH,
  samlCompleteOperation,
  samlCompleteTestOperation,
  samlId,
  samlProviderConfig,
  samlRelayAttemptId,
  samlServiceProviderUrls,
  samlStartOperation,
  samlStateCookie,
  samlTestBinding,
  samlTestOperation,
  sealSamlState,
} from './sso-saml-state.ts'
import {
  SamlVerificationError,
  samlInitialAlgorithms,
  samlMaximumResponseBytes,
  type VerifiedSamlResponse,
  verifySamlResponse,
} from './sso-saml-verifier.ts'

const persistentNameId = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'
const errorPath = '/sign-in?error=unable_to_create_session'
const completionInvalid = { error: 'sso_saml_completion_invalid' } as const
const completionLifetime = { seconds: 300 }
// Decoded XML is bounded by the verifier. Allow its complete base64 form with URL escapes.
const acsBodyLimit = 4 * Math.ceil(samlMaximumResponseBytes / 3) * 3 + 512
const projectionSchema = z.strictObject({
  requestId: samlId,
  linkId: z.uuid(),
  userId: z.uuid(),
  linkGeneration: z.int().positive(),
  mailboxDigest: z.hex().length(64),
  acceptanceDeadline: z.iso.datetime(),
  sessionDeadline: z.iso.datetime().optional(),
})
const testFailureSchema = z.enum([
  'algorithm_refused',
  'audience_mismatch',
  'configuration_changed',
  'destination_mismatch',
  'issuer_mismatch',
  'response_malformed',
  'signature_invalid',
  'timing_invalid',
])
type SamlTestFailure = z.infer<typeof testFailureSchema>
const testResultSchema = z.union([
  z.strictObject({ requestId: samlId, acceptanceDeadline: z.iso.datetime() }),
  z.strictObject({ requestId: samlId, reason: testFailureSchema }),
])

interface SamlSignInDeps {
  db: Db
  capabilities: SsoCapabilities
  configurationKey?: Buffer | undefined
  session: OidcSessionOptions
  readSession?: (headers: Headers) => Promise<OidcTestActor | null | undefined>
}

export interface SamlSignInModule {
  mount(shared: {
    app: OpenAPIHono
    publicUrl: string
    requestLogger: MiddlewareHandler
    clientIp: MiddlewareHandler
  }): void
}

async function form(c: Context) {
  if (
    c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
    'application/x-www-form-urlencoded'
  )
    return undefined
  const text = await c.req.text().catch(() => undefined)
  if (text !== undefined) return new URLSearchParams(text)
}

function samlRefusalReason(error: SamlVerificationError): SamlTestFailure {
  switch (error.reason) {
    case 'signature_invalid':
    case 'assertion_signature_required':
      return 'signature_invalid'
    case 'algorithm_not_allowed':
      return 'algorithm_refused'
    case 'issuer_mismatch':
    case 'audience_mismatch':
    case 'destination_mismatch':
      return error.reason
    case 'recipient_mismatch':
      return 'destination_mismatch'
    default:
      return 'response_malformed'
  }
}

function correlatedSamlRequest(
  db: Db,
  { organizationId, providerId, revision }: SsoProviderRevision,
  requestId: string,
  relayState: string,
  test = false,
) {
  return db
    .selectFrom('sso_attempts')
    .where('id', '=', requestId)
    .where('kind', '=', test ? 'test' : 'sign_in')
    .where('operation', '=', test ? samlTestOperation : samlStartOperation)
    .where('organization_id', '=', organizationId)
    .where('provider_id', '=', providerId)
    .where('provider_revision', '=', revision)
    .where('input_digest', '=', sha256(relayState))
}

/** Stage a verified result or a safe failure without enrolling the IdP identity. */
async function stageSamlTest(
  db: Db,
  configurationKey: Buffer,
  provider: SsoProviderRevision & { enabled: boolean },
  requestId: string,
  relayState: string,
  actor: OidcTestActor,
  verdict: VerifiedSamlResponse | SamlTestFailure,
) {
  const { organizationId, providerId, revision } = provider
  return db.transaction().execute(async (trx) => {
    // A concurrent logout or account deletion may cascade to the request. Take the
    // parent locks before locking it and creating the next session-bound attempt.
    const user = await trx
      .selectFrom('auth.user')
      .select('id')
      .where('id', '=', actor.userId)
      .forShare()
      .executeTakeFirst()
    if (!user) throw new OidcAttemptRefused()
    await lockOidcProvider(trx, provider, provider.enabled, 'saml')
    const session = await trx
      .selectFrom('auth.session')
      .select('id')
      .where('id', '=', actor.id)
      .where('userId', '=', actor.userId)
      .where('expiresAt', '>', sql<Date>`clock_timestamp()`)
      .forShare()
      .executeTakeFirst()
    if (!session) throw new OidcAttemptRefused()
    const request = await correlatedSamlRequest(trx, provider, requestId, relayState, true)
      .where('user_id', '=', actor.userId)
      .where('session_id', '=', actor.id)
      .select([
        'browser_binding_digest',
        'consumed_at',
        samlDatabaseInstantText(sql.ref('expires_at')).as('expiresAt'),
      ])
      .forUpdate()
      .executeTakeFirst()
    if (!request) throw new SamlTimingError('request_mismatch')
    if (request.consumed_at) throw new SamlTimingError('replay')
    const expiresAt = Temporal.Instant.from(request.expiresAt)
    const acceptanceDeadline =
      typeof verdict === 'string'
        ? undefined
        : await consumeSamlReplay(
            trx,
            verdict,
            { id: `_${requestId}`, organizationId, providerId, expiresAt },
            providerId,
          )
    const now = await samlDatabaseNow(trx)
    if (samlRequestExpired(expiresAt, now)) throw new SamlTimingError('request_expired')
    await trx
      .updateTable('sso_attempts')
      .set({ consumed_at: now.toString() })
      .where('id', '=', requestId)
      .execute()
    const deadline = now.add(completionLifetime)
    const pendingExpiry = Temporal.Instant.compare(deadline, expiresAt) < 0 ? deadline : expiresAt
    const { id } = await trx.selectNoFrom(sql<string>`uuidv7()`.as('id')).executeTakeFirstOrThrow()
    const result = sealSamlState(
      configurationKey,
      'result',
      id,
      JSON.stringify({
        requestId,
        ...(acceptanceDeadline && { acceptanceDeadline: acceptanceDeadline.toString() }),
        ...(typeof verdict === 'string' && { reason: verdict }),
      }),
    )
    await trx
      .insertInto('sso_attempts')
      .values({
        id,
        kind: 'test',
        operation: samlCompleteTestOperation,
        organization_id: organizationId,
        provider_id: providerId,
        provider_revision: revision,
        user_id: actor.userId,
        session_id: actor.id,
        browser_binding_digest: request.browser_binding_digest,
        input_digest: sha256(result),
        created_at: now.toString(),
        expires_at: pendingExpiry.toString(),
      })
      .execute()
    const stagedAt = await samlDatabaseNow(trx)
    if (samlRequestExpired(pendingExpiry, stagedAt)) throw new SamlTimingError('request_expired')
    if (acceptanceDeadline && samlAcceptanceExpired(acceptanceDeadline, stagedAt))
      throw new SamlTimingError('timing_invalid')
    return { id, result }
  })
}

async function completeSamlTest(
  db: Db,
  id: string,
  binding: string,
  envelope: string,
  result: z.infer<typeof testResultSchema>,
  actor: OidcTestActor,
  test: z.infer<typeof samlTestBinding>,
  scimResourcesEnabled: boolean,
) {
  const pending = (executor: Db) =>
    executor
      .selectFrom('sso_attempts')
      .where('id', '=', id)
      .where('kind', '=', 'test')
      .where('operation', '=', samlCompleteTestOperation)
      .where('user_id', '=', actor.userId)
      .where('session_id', '=', actor.id)
      .where('browser_binding_digest', '=', binding)
      .where('input_digest', '=', sha256(envelope))
      .where('consumed_at', 'is', null)
  const snapshot = await pending(db)
    .select(['organization_id', 'provider_id', 'provider_revision'])
    .executeTakeFirst()
  if (!snapshot?.provider_id || snapshot.provider_revision === null) return false
  const provider = {
    organizationId: snapshot.organization_id,
    providerId: snapshot.provider_id,
    revision: snapshot.provider_revision,
  }
  return db.transaction().execute(async (trx) => {
    const role = await lockOidcTestActor(
      trx,
      provider,
      actor,
      test.recovery,
      scimResourcesEnabled,
      'saml',
    )
    const attempt = await pending(trx)
      .select(samlDatabaseInstantText(sql.ref('expires_at')).as('expiresAt'))
      .forUpdate()
      .executeTakeFirst()
    if (!attempt) return false
    const expiresAt = Temporal.Instant.from(attempt.expiresAt)
    const acceptanceDeadline =
      'acceptanceDeadline' in result ? Temporal.Instant.from(result.acceptanceDeadline) : undefined
    const requireLive = (now: Temporal.Instant) => {
      if (samlRequestExpired(expiresAt, now)) throw new SamlTimingError('request_expired')
      if (acceptanceDeadline && samlAcceptanceExpired(acceptanceDeadline, now))
        throw new SamlTimingError('timing_invalid')
    }
    const now = await samlDatabaseNow(trx)
    requireLive(now)
    await trx
      .updateTable('sso_attempts')
      .set({ consumed_at: now.toString() })
      .where('id', '=', id)
      .execute()
    await writeSsoProviderTestReceipt(
      trx,
      provider,
      actor,
      role,
      'saml',
      result.requestId,
      'reason' in result ? result.reason : undefined,
    )
    requireLive(await samlDatabaseNow(trx))
    return true
  })
}

/** Enforce SP initiation and commit the replay keys and pending result together. */
async function stageSamlCompletion(
  db: Db,
  configurationKey: Buffer,
  provider: SsoProviderRevision & { spEntityId: string },
  requestId: string,
  relayState: string,
  response: VerifiedSamlResponse,
) {
  const { organizationId, providerId, revision } = provider
  const { assertion } = response
  const { nameId } = assertion
  const sessionDeadline = samlSessionDeadline(assertion)
  return db.transaction().execute(async (trx) => {
    await lockOidcProvider(trx, provider, true, 'saml')
    const request = await correlatedSamlRequest(trx, provider, requestId, relayState)
      .select([
        'browser_binding_digest',
        'consumed_at',
        samlDatabaseInstantText(sql.ref('expires_at')).as('expiresAt'),
      ])
      .forUpdate()
      .executeTakeFirst()
    if (!request) throw new SamlTimingError('request_mismatch')
    if (request.consumed_at) throw new SamlTimingError('replay')
    const expiresAt = Temporal.Instant.from(request.expiresAt)
    const acceptanceDeadline = await consumeSamlReplay(
      trx,
      response,
      { id: `_${requestId}`, organizationId, providerId, expiresAt },
      providerId,
    )

    const now = await samlDatabaseNow(trx)
    await trx
      .updateTable('sso_attempts')
      .set({ consumed_at: now.toString() })
      .where('id', '=', requestId)
      .execute()

    const [email, ...otherEmails] = assertion.attributes.email ?? []
    // An explicit qualifier must name the IdP or SP whose scope the stored subject represents.
    if (
      nameId.format !== persistentNameId ||
      (nameId.nameQualifier !== null && nameId.nameQualifier !== assertion.issuer) ||
      (nameId.spNameQualifier !== null && nameId.spNameQualifier !== provider.spEntityId) ||
      !email ||
      otherEmails.length
    )
      return undefined
    const link = await findOidcLink(trx, provider, {
      issuer: assertion.issuer,
      subject: nameId.value,
    })
    if (!link || link.retired_at || link.proven_email !== normalizeOidcMailbox(email))
      return undefined

    const deadline = now.add(completionLifetime)
    const pendingExpiry = Temporal.Instant.compare(deadline, expiresAt) < 0 ? deadline : expiresAt
    const { id } = await trx.selectNoFrom(sql<string>`uuidv7()`.as('id')).executeTakeFirstOrThrow()
    const result = sealSamlState(
      configurationKey,
      'result',
      id,
      JSON.stringify({
        requestId,
        linkId: link.id,
        userId: link.user_id,
        linkGeneration: link.generation,
        mailboxDigest: sha256(link.proven_email),
        acceptanceDeadline: acceptanceDeadline.toString(),
        sessionDeadline: sessionDeadline
          ?.round({ smallestUnit: 'microsecond', roundingMode: 'floor' })
          .toString(),
      } satisfies z.infer<typeof projectionSchema>),
    )
    await trx
      .insertInto('sso_attempts')
      .values({
        id,
        kind: 'sign_in',
        operation: samlCompleteOperation,
        organization_id: organizationId,
        provider_id: providerId,
        provider_revision: revision,
        browser_binding_digest: request.browser_binding_digest,
        input_digest: sha256(result),
        created_at: now.toString(),
        expires_at: pendingExpiry.toString(),
      })
      .execute()
    const stagedAt = await samlDatabaseNow(trx)
    if (samlRequestExpired(pendingExpiry, stagedAt)) throw new SamlTimingError('request_expired')
    if (samlAcceptanceExpired(acceptanceDeadline, stagedAt))
      throw new SamlTimingError('timing_invalid')
    return { id, result }
  })
}

async function completeSamlSignIn(
  db: Db,
  id: string,
  binding: string,
  envelope: string,
  result: z.infer<typeof projectionSchema>,
  readReturn: (requestId: string) => string | undefined,
  options: OidcSessionRequest,
) {
  const readAttempt = (executor: Db) =>
    executor
      .selectFrom('sso_attempts')
      .where('id', '=', id)
      .where('kind', '=', 'sign_in')
      .where('operation', '=', samlCompleteOperation)
      .where('browser_binding_digest', '=', binding)
      .where('input_digest', '=', sha256(envelope))
      .where('consumed_at', 'is', null)
  const pending = await readAttempt(db)
    .select(['organization_id', 'provider_id', 'provider_revision'])
    .executeTakeFirst()
  if (!pending?.provider_id || pending.provider_revision === null) return undefined
  const storedReturn = readReturn(result.requestId)
  if (storedReturn === undefined) return undefined
  const returnPath = oidcReturnDestination(storedReturn)
  if (!returnPath?.startsWith('/app')) return undefined

  const provider = {
    organizationId: pending.organization_id,
    providerId: pending.provider_id,
    revision: pending.provider_revision,
  }
  const candidate = { id: result.linkId, user_id: result.userId, generation: result.linkGeneration }
  try {
    return await db.transaction().execute(async (trx) => {
      const link = await trx
        .selectFrom('sso_identity_links')
        .select('proven_email')
        .where('id', '=', candidate.id)
        .executeTakeFirst()
      if (!link || sha256(link.proven_email) !== result.mailboxDigest) return undefined
      // Follow the account/team lock order before taking the one-time attempt lock.
      const context = await lockOidcSignInContext(
        trx,
        provider,
        candidate,
        link.proven_email,
        false,
        options.scimResourcesEnabled === true,
        'saml',
      )
      if (context.reason !== undefined || context.link.proven_email !== link.proven_email)
        return undefined
      const attempt = await readAttempt(trx)
        .select(samlDatabaseInstantText(sql.ref('expires_at')).as('expiresAt'))
        .forUpdate()
        .executeTakeFirst()
      if (!attempt) return undefined

      const acceptanceDeadline = Temporal.Instant.from(result.acceptanceDeadline)
      const pendingExpiry = Temporal.Instant.from(attempt.expiresAt)
      const now = await samlDatabaseNow(trx)
      if (samlRequestExpired(pendingExpiry, now) || samlAcceptanceExpired(acceptanceDeadline, now))
        return undefined
      const timing = await oidcSignInTiming(
        trx,
        context,
        attempt.expiresAt,
        result.sessionDeadline,
        options,
      )
      if (timing.reason !== undefined) return undefined
      await trx
        .updateTable('sso_attempts')
        .set({ consumed_at: timing.now })
        .where('id', '=', id)
        .execute()
      const session = await writeOidcSession(trx, provider, context, id, timing, options, 'saml')
      // Session or audit writes may wait. Roll all of them back if a deadline passes meanwhile.
      const completedAt = await samlDatabaseNow(trx)
      if (samlRequestExpired(pendingExpiry, completedAt))
        throw new SamlTimingError('request_expired')
      if (samlAcceptanceExpired(acceptanceDeadline, completedAt))
        throw new SamlTimingError('timing_invalid')
      return { ...session, returnPath, requestId: result.requestId }
    })
  } catch (error) {
    if (
      error instanceof OidcAttemptRefused ||
      error instanceof SamlTimingError ||
      expiresDuringOidcWrite(error)
    )
      return undefined
    throw error
  }
}

export function samlSignInRoutes({
  db,
  capabilities,
  configurationKey,
  session,
  readSession,
}: SamlSignInDeps): SamlSignInModule {
  const deliveries = createRateLimiter({ limit: 30, windowSeconds: 60 })
  const completions = createRateLimiter({ limit: 30, windowSeconds: 60 })
  const guard: MiddlewareHandler = async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    requireSsoEnabled(capabilities, 'saml')
    await next()
  }
  return {
    mount({ app, publicUrl, requestLogger, clientIp }) {
      const origin = new URL(publicUrl).origin
      const bindingName = bindingCookieName(publicUrl)

      app.all(SAML_METADATA_PATH, requestLogger, guard, async (c) => {
        if (c.req.method !== 'GET') return c.json({ error: 'method_not_allowed' }, 405)
        const id = samlId.safeParse(c.req.param('providerId'))
        if (!id.success) return c.json({ error: 'sso_not_found' }, 404)
        const provider = await db
          .selectFrom('sso_providers')
          .select('id')
          .where('id', '=', id.data)
          .where('protocol', '=', 'saml')
          .where('retired_at', 'is', null)
          .executeTakeFirst()
        if (!provider) return c.json({ error: 'sso_not_found' }, 404)
        return c.body(samlServiceProviderMetadata(publicUrl, provider.id), 200, {
          'Content-Type': 'application/samlmetadata+xml; charset=utf-8',
        })
      })

      app.all(
        SAML_ACS_PATH,
        requestLogger,
        guard,
        clientIp,
        routeBodyLimit(acsBodyLimit),
        apiBodyLimit(),
        async (c: Context) => {
          if (c.req.method !== 'POST') return c.json({ error: 'method_not_allowed' }, 405)
          const refuse = () => c.redirect(errorPath, 303)
          if (!configurationKey || c.req.header('authorization') !== undefined) return refuse()
          const wait = deliveries.hit(rateLimitKey(c.var.clientIp))
          if (wait !== undefined) {
            c.header('Retry-After', String(wait))
            return c.json({ error: 'rate_limited' }, 429)
          }

          const id = samlId.safeParse(c.req.param('providerId'))
          const fields = await form(c)
          if (!id.success || fields?.size !== 2) return refuse()
          const relayState = fields.get('RelayState')
          const samlResponse = fields.get('SAMLResponse')
          if (!relayState || !samlResponse) return refuse()
          const requestId = samlRelayAttemptId(relayState)
          if (!requestId) return refuse()
          const provider = await db
            .selectFrom('sso_providers')
            .select([
              'organization_id as organizationId',
              'id as providerId',
              'revision',
              'issuer',
              'configuration',
              'enabled',
            ])
            .where('id', '=', id.data)
            .where('protocol', '=', 'saml')
            .where('retired_at', 'is', null)
            .executeTakeFirst()
          if (!provider) return refuse()

          // Check the opaque correlation and deadline before doing XML signature work.
          const request = await db
            .selectFrom('sso_attempts')
            .select(['id', 'kind', 'operation', 'user_id', 'session_id'])
            .where('id', '=', requestId)
            .where('organization_id', '=', provider.organizationId)
            .where('provider_id', '=', provider.providerId)
            .where('provider_revision', '=', provider.revision)
            .where('input_digest', '=', sha256(relayState))
            .where('expires_at', '>', sql<Date>`clock_timestamp()`)
            .executeTakeFirst()
          if (!request) return refuse()
          const test = request.kind === 'test' && request.operation === samlTestOperation
          if (
            !test &&
            (!provider.enabled ||
              request.operation !== samlStartOperation ||
              request.kind !== 'sign_in')
          )
            return refuse()
          const fail = async (reason: SsoAuditReason | 'replay') => {
            await writeSsoSecurityFailure(db, {
              organizationId: provider.organizationId,
              providerId: provider.providerId,
              revision: provider.revision,
              correlationId: request.id,
              method: 'saml',
              actor: { type: 'anonymous' },
              credential: { type: 'none' },
              ...(reason === 'replay'
                ? { action: 'sso_authentication.replay_rejected' }
                : { action: 'sso_authentication.failed', reason }),
            })
            return refuse()
          }
          const finish = (pending: { id: string; result: string }) => {
            const cookie = samlStateCookie(publicUrl, 'result', pending.id)
            setCookie(c, cookie.name, pending.result, {
              ...cookie.options,
              maxAge: completionLifetime.seconds,
            })
            return c.redirect(`${SAML_COMPLETE_PATH}?attemptId=${pending.id}`, 303)
          }
          const stageTest = (verdict: VerifiedSamlResponse | SamlTestFailure) => {
            if (!request.user_id || !request.session_id) throw new OidcAttemptRefused()
            const actor = { userId: request.user_id, id: request.session_id }
            return stageSamlTest(
              db,
              configurationKey,
              provider,
              requestId,
              relayState,
              actor,
              verdict,
            )
          }
          const verify = () => {
            let config: z.infer<typeof samlProviderConfig>
            try {
              config = samlProviderConfig.parse(
                JSON.parse(
                  openSsoProviderConfiguration(configurationKey, provider, provider.configuration),
                ),
              )
            } catch {
              return 'configuration_changed' as const
            }
            if (!config.signingCertificates) return 'configuration_changed' as const
            try {
              return verifySamlResponse(
                {
                  ...samlServiceProviderUrls(publicUrl, provider.providerId),
                  idpEntityId: provider.issuer,
                  signingCertificates: config.signingCertificates,
                  algorithms: samlInitialAlgorithms,
                },
                samlResponse,
              )
            } catch (error) {
              if (error instanceof SamlVerificationError) return samlRefusalReason(error)
              throw error
            }
          }
          try {
            const verified = verify()
            if (test) {
              const pending = await stageTest(verified).catch((error: unknown) => {
                if (error instanceof SamlTimingError && error.reason === 'timing_invalid')
                  return stageTest('timing_invalid')
                throw error
              })
              return finish(pending)
            }
            if (typeof verified === 'string') return fail(verified)
            const pending = await stageSamlCompletion(
              db,
              configurationKey,
              {
                ...provider,
                spEntityId: samlServiceProviderUrls(publicUrl, provider.providerId).spEntityId,
              },
              requestId,
              relayState,
              verified,
            )
            if (!pending) return fail('mailbox_unproven')
            return finish(pending)
          } catch (error) {
            if (error instanceof SamlTimingError) {
              if (error.reason === 'request_mismatch') return fail('attempt_invalid')
              if (error.reason === 'request_expired') return fail('attempt_expired')
              return fail(error.reason)
            }
            if (error instanceof OidcAttemptRefused) return fail('configuration_changed')
            if (expiresDuringOidcWrite(error)) return fail('attempt_expired')
            throw error
          }
        },
      )

      app.all(SAML_COMPLETE_PATH, requestLogger, guard, clientIp, apiBodyLimit(), async (c) => {
        if (c.req.method === 'GET') {
          const query = new URL(c.req.url).searchParams
          const id = samlId.safeParse(query.get('attemptId'))
          if (!id.success || query.size !== 1) return c.json(completionInvalid, 400)
          const chinese = /^(zh)(?:[-;,]|$)/i.test(c.req.header('accept-language') ?? '')
          const label = chinese ? '继续' : 'Continue'
          // This origin-only policy lets a native form POST send Origin without the attempt URL.
          c.header('Referrer-Policy', 'strict-origin')
          c.header('Vary', 'Accept-Language')
          return c.html(
            `<!doctype html><html lang="${chinese ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${label}</title></head><body><main><form action="${SAML_COMPLETE_PATH}" method="post"><input type="hidden" name="attemptId" value="${id.data}"><button type="submit">${label}</button></form></main></body></html>`,
          )
        }
        if (c.req.method !== 'POST') return c.json({ error: 'method_not_allowed' }, 405)
        if (c.req.header('origin') !== origin || c.req.header('authorization') !== undefined)
          return c.json({ error: 'forbidden' }, 403)

        const fields = await form(c)
        const id = samlId.safeParse(fields?.get('attemptId'))
        if (!id.success || fields?.size !== 1) return c.json({ error: 'invalid_request' }, 400)
        const wait = completions.hit(rateLimitKey(c.var.clientIp))
        if (wait !== undefined) {
          c.header('Retry-After', String(wait))
          return c.json({ error: 'rate_limited' }, 429)
        }
        const binding = browserBindingDigest(getCookie(c, bindingName))
        const cookie = samlStateCookie(publicUrl, 'result', id.data)
        const envelope = getCookie(c, cookie.name)
        if (!configurationKey || !binding || !envelope) return c.json(completionInvalid, 400)

        const plaintext = openSamlState(configurationKey, 'result', id.data, envelope)
        if (plaintext === undefined) return c.json(completionInvalid, 400)
        const projection: unknown = JSON.parse(plaintext)
        const test = testResultSchema.safeParse(projection)
        if (test.success) {
          const testCookie = samlStateCookie(publicUrl, 'test', test.data.requestId)
          const state = getCookie(c, testCookie.name)
          const testState =
            state && openSamlState(configurationKey, 'test', test.data.requestId, state)
          const actor = testState && (await readSession?.(c.req.raw.headers))
          if (!actor || !testState) return c.json(completionInvalid, 400)
          const testBinding = samlTestBinding.parse(JSON.parse(testState))
          const completed = await completeSamlTest(
            db,
            id.data,
            binding,
            envelope,
            test.data,
            actor,
            testBinding,
            capabilities.scimResourcesEnabled === true,
          ).catch((error: unknown) => {
            if (
              error instanceof OidcAttemptRefused ||
              error instanceof SamlTimingError ||
              expiresDuringOidcWrite(error)
            )
              return false
            throw error
          })
          if (!completed) return c.json(completionInvalid, 400)
          deleteCookie(c, testCookie.name, testCookie.options)
          deleteCookie(c, cookie.name, cookie.options)
          return c.redirect('/app/settings', 303)
        }

        const signIn = projectionSchema.safeParse(projection)
        if (!signIn.success) return c.json(completionInvalid, 400)
        const completed = await completeSamlSignIn(
          db,
          id.data,
          binding,
          envelope,
          signIn.data,
          (requestId) => {
            const name = samlStateCookie(publicUrl, 'return', requestId).name
            const stored = getCookie(c, name)
            if (stored) return openSamlState(configurationKey, 'return', requestId, stored)
          },
          { ...session, publicUrl, headers: c.req.raw.headers, ip: c.var.clientIp },
        )
        if (!completed) return c.json(completionInvalid, 400)
        const returnCookie = samlStateCookie(publicUrl, 'return', completed.requestId)
        deleteCookie(c, returnCookie.name, returnCookie.options)
        deleteCookie(c, cookie.name, cookie.options)
        c.header('Set-Cookie', completed.cookie, { append: true })
        return c.redirect(completed.returnPath, 303)
      })
    },
  }
}
