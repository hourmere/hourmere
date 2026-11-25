import type { OpenAPIHono } from '@hono/zod-openapi'
import type { SignupPolicy } from '@hourmere/auth'
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
import { delegationProofCookie, sealDelegationProof } from './sso-delegation-proof.ts'
import {
  bindingCookieName,
  browserBindingDigest,
  MAILBOX_PROOF_CONFIRM_PATH,
  sha256,
} from './sso-mailbox-proof.ts'
import {
  completeSsoAdmission,
  ssoAdmissionCookie,
  ssoAdmissionRefused,
  stageSsoAdmission,
} from './sso-oidc-admission.ts'
import {
  lockOidcProvider,
  lockOidcTestActor,
  OidcAttemptRefused,
  type OidcTestActor,
  oidcReturnDestination,
  recordSsoStepUp,
  ssoStepUpBinding,
  ssoStepUpSubjectDigest,
} from './sso-oidc-attempt.ts'
import {
  completeOidcSignIn,
  expiresDuringOidcWrite,
  SsoMailboxCompletionExpired,
  stageSsoMailboxCompletion,
} from './sso-oidc-completion.ts'
import {
  completeOidcLink,
  lockOidcLinkActor,
  oidcLinkReturnPath,
  stageSsoLinkResult,
} from './sso-oidc-link.ts'
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
import { samlClockSkew } from './sso-saml-limits.ts'
import {
  consumeSamlReplay,
  SamlTimingError,
  samlAcceptanceExpired,
  samlDatabaseInstantText,
  samlDatabaseNow,
  samlRequestExpired,
  samlSessionDeadline,
  samlStepUpAuthTime,
} from './sso-saml-replay.ts'
import {
  openSamlState,
  SAML_ACS_PATH,
  SAML_COMPLETE_PATH,
  SAML_METADATA_PATH,
  samlCompleteOperation,
  samlCompleteStepUpOperation,
  samlCompleteTestOperation,
  samlId,
  samlLinkOperation,
  samlProviderConfig,
  samlRelayAttemptId,
  samlServiceProviderUrls,
  samlStartOperation,
  samlStateCookie,
  samlStepUpOperation,
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
const emailAddress = z.email().max(320)
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
const stepUpResultSchema = z.strictObject({
  requestId: samlId,
  subjectDigest: z.hex().length(64),
  authTimeMs: z.int().optional(),
  ceremonyCreatedAt: z.iso.datetime(),
  acceptanceDeadline: z.iso.datetime(),
  sessionDeadline: z.iso.datetime().optional(),
})
const samlStepUpState = z.strictObject({
  binding: ssoStepUpBinding,
  returnPath: z.string(),
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
  signup: SignupPolicy
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
  kind: 'test' | 'link' | 'sign_in' | 'step_up',
) {
  const operations = {
    test: samlTestOperation,
    link: samlLinkOperation,
    sign_in: samlStartOperation,
    step_up: samlStepUpOperation,
  }
  return db
    .selectFrom('sso_attempts')
    .where('id', '=', requestId)
    .where('kind', '=', kind === 'step_up' ? 'link' : kind)
    .where('operation', '=', operations[kind])
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
    const request = await correlatedSamlRequest(trx, provider, requestId, relayState, 'test')
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

function stableSamlSubject(
  { assertion: { nameId, attributes, issuer } }: VerifiedSamlResponse,
  spEntityId: string,
  subjectAttribute: string | undefined,
) {
  let subject: string | undefined
  if (subjectAttribute !== undefined) {
    const values = Object.hasOwn(attributes, subjectAttribute)
      ? attributes[subjectAttribute]
      : undefined
    if (values?.length === 1) subject = values[0]
  } else if (
    nameId.format === persistentNameId &&
    (nameId.nameQualifier === null || nameId.nameQualifier === issuer) &&
    (nameId.spNameQualifier === null || nameId.spNameQualifier === spEntityId)
  ) {
    subject = nameId.value
  }
  if (
    !subject?.trim() ||
    Buffer.byteLength(subject) > 1024 ||
    z.email().safeParse(subject.trim()).success
  )
    return
  return subject
}

/** Enforce SP initiation and commit the replay keys and pending result together. */
async function stageSamlCompletion(
  db: Db,
  configurationKey: Buffer,
  provider: SsoProviderRevision & { spEntityId: string; subjectAttribute?: string | undefined },
  requestId: string,
  relayState: string,
  response: VerifiedSamlResponse,
  scimResourcesEnabled: boolean,
  ceremony?: { kind: 'link' | 'step_up'; actor: OidcTestActor },
) {
  const { organizationId, providerId, revision } = provider
  const { actor } = ceremony ?? {}
  const { issuer, attributes } = response.assertion
  const subject = stableSamlSubject(response, provider.spEntityId, provider.subjectAttribute)
  const [email, ...otherEmails] = Object.hasOwn(attributes, 'email') ? (attributes.email ?? []) : []
  const mailbox = email && normalizeOidcMailbox(email)
  const identity =
    subject && mailbox && !otherEmails.length && emailAddress.safeParse(mailbox).success
      ? { issuer, subject, mailbox }
      : undefined
  const candidate = !actor && identity ? await findOidcLink(db, provider, identity) : undefined
  const sessionDeadline = samlSessionDeadline(response.assertion)
  return db.transaction().execute(async (trx) => {
    // Match sign-in and membership writes: a linked account lock precedes the team lock.
    if (candidate && candidate.proven_email !== identity?.mailbox) {
      await trx
        .selectFrom('auth.user')
        .select('id')
        .where('id', '=', candidate.user_id)
        .forShare()
        .executeTakeFirst()
    }
    const local =
      actor && (await lockOidcLinkActor(trx, organizationId, actor, scimResourcesEnabled))
    await lockOidcProvider(trx, provider, true, 'saml')
    const correlated = correlatedSamlRequest(
      trx,
      provider,
      requestId,
      relayState,
      ceremony?.kind ?? 'sign_in',
    )
    const request = await (actor
      ? correlated.where('user_id', '=', actor.userId).where('session_id', '=', actor.id)
      : correlated
    )
      .select([
        'browser_binding_digest',
        'consumed_at',
        samlDatabaseInstantText(sql.ref('created_at')).as('createdAt'),
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

    const deadline = now.add(completionLifetime)
    const pendingExpiry = Temporal.Instant.compare(deadline, expiresAt) < 0 ? deadline : expiresAt
    const stageResult = async (
      projection: z.infer<typeof projectionSchema> | z.infer<typeof stepUpResultSchema>,
      stepUpActor?: OidcTestActor,
    ) => {
      const { id } = await trx
        .selectNoFrom(sql<string>`uuidv7()`.as('id'))
        .executeTakeFirstOrThrow()
      const result = sealSamlState(configurationKey, 'result', id, JSON.stringify(projection))
      await trx
        .insertInto('sso_attempts')
        .values({
          id,
          kind: stepUpActor ? 'link' : 'sign_in',
          operation: stepUpActor ? samlCompleteStepUpOperation : samlCompleteOperation,
          organization_id: organizationId,
          provider_id: providerId,
          provider_revision: revision,
          ...(stepUpActor && { user_id: stepUpActor.userId, session_id: stepUpActor.id }),
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
      return { id, result, kind: 'result' as const }
    }
    const serializedSessionDeadline = sessionDeadline
      ?.round({ smallestUnit: 'microsecond', roundingMode: 'floor' })
      .toString()
    if (ceremony?.kind === 'step_up') {
      if (!subject) return undefined
      return stageResult(
        {
          requestId,
          subjectDigest: ssoStepUpSubjectDigest(issuer, subject),
          authTimeMs: samlStepUpAuthTime(response.assertion, now),
          ceremonyCreatedAt: request.createdAt,
          acceptanceDeadline: acceptanceDeadline.toString(),
          sessionDeadline: serializedSessionDeadline,
        },
        ceremony.actor,
      )
    }
    if (!identity) return undefined
    const signInDeadline = [
      pendingExpiry,
      acceptanceDeadline.add({ seconds: samlClockSkew }),
      sessionDeadline,
    ].reduce<Temporal.Instant>(
      (earliest, value) =>
        value && Temporal.Instant.compare(value, earliest) < 0 ? value : earliest,
      pendingExpiry,
    )
    if (actor) {
      if (local?.mailbox !== identity.mailbox) return undefined
      const { expiresAt } = await trx
        .selectNoFrom(
          samlDatabaseInstantText(sql`least(
            ${signInDeadline.round({ smallestUnit: 'microsecond', roundingMode: 'floor' }).toString()}::timestamptz,
            ${local.session.deadline}::timestamptz
          )`).as('expiresAt'),
        )
        .executeTakeFirstOrThrow()
      if (samlRequestExpired(Temporal.Instant.from(expiresAt), now)) return undefined
      const pending = await stageSsoLinkResult(
        trx,
        configurationKey,
        provider,
        actor,
        request.browser_binding_digest,
        { requestId, subject: identity.subject, mailboxDigest: sha256(identity.mailbox) },
        now.toString(),
        expiresAt,
      )
      return { id: pending.id, result: pending.envelope, kind: 'link-result' as const }
    }
    const link = candidate
    if (link?.retired_at) return undefined
    if (!link) {
      const expiresAt = signInDeadline.round({ smallestUnit: 'microsecond', roundingMode: 'floor' })
      const pending = await stageSsoAdmission(
        { db: trx, configurationKey },
        provider,
        {
          ...identity,
          email: identity.mailbox,
          sessionDeadline: serializedSessionDeadline,
        },
        { expiresAt: expiresAt.toString(), requestId },
        request.browser_binding_digest,
      )
      if (pending.reason === 'attempt_expired') throw new SamlTimingError('request_expired')
      if (pending.reason !== undefined) return undefined
      if (samlRequestExpired(expiresAt, await samlDatabaseNow(trx)))
        throw new SamlTimingError('request_expired')
      return { id: pending.id, result: pending.envelope, kind: 'admission' as const }
    }
    if (link.proven_email !== identity.mailbox) {
      const pending = await stageSsoMailboxCompletion(
        { db: trx, configurationKey, scimResourcesEnabled },
        provider,
        link,
        identity.mailbox,
        sessionDeadline && new Date(sessionDeadline.epochMilliseconds),
        { expiresAt: new Date(signInDeadline.epochMilliseconds), requestId },
        request.browser_binding_digest,
      )
      if (pending.reason === 'attempt_expired') throw new SamlTimingError('request_expired')
      if (pending.reason !== undefined) return undefined
      return { id: pending.id, result: pending.envelope, kind: 'mailbox' as const }
    }
    return stageResult({
      requestId,
      linkId: link.id,
      userId: link.user_id,
      linkGeneration: link.generation,
      mailboxDigest: sha256(link.proven_email),
      acceptanceDeadline: acceptanceDeadline.toString(),
      sessionDeadline: serializedSessionDeadline,
    })
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

async function completeSamlStepUp(
  db: Db,
  { id, browserBinding, envelope }: { id: string; browserBinding: string; envelope: string },
  result: z.infer<typeof stepUpResultSchema>,
  actor: OidcTestActor,
  state: z.infer<typeof samlStepUpState>,
  scimResourcesEnabled: boolean,
) {
  const binding = browserBindingDigest(browserBinding)
  const returnPath = oidcReturnDestination(state.returnPath)
  if (!binding || !returnPath?.startsWith('/app')) return
  const readAttempt = (executor: Db) =>
    executor
      .selectFrom('sso_attempts')
      .where('id', '=', id)
      .where('kind', '=', 'link')
      .where('operation', '=', samlCompleteStepUpOperation)
      .where('user_id', '=', actor.userId)
      .where('session_id', '=', actor.id)
      .where('browser_binding_digest', '=', binding)
      .where('input_digest', '=', sha256(envelope))
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', sql<Date>`clock_timestamp()`)
  const pending = await readAttempt(db)
    .select(['organization_id', 'provider_id', 'provider_revision', 'created_at'])
    .executeTakeFirst()
  if (!pending?.provider_id || pending.provider_revision === null) return
  const provider = {
    organizationId: pending.organization_id,
    providerId: pending.provider_id,
    revision: pending.provider_revision,
  }
  const acceptanceDeadline = Temporal.Instant.from(result.acceptanceDeadline)
  const sessionDeadline = result.sessionDeadline ? new Date(result.sessionDeadline) : undefined
  return db.transaction().execute(async (trx) => {
    // Take the shared lock on the account, team and write challenge before consuming the result.
    const recorded = await recordSsoStepUp(
      trx,
      { ...provider, browserBinding },
      { actor, binding: state.binding },
      result.ceremonyCreatedAt,
      {
        subjectDigest: result.subjectDigest,
        authTimeMs: result.authTimeMs,
        sessionDeadline,
        receivedAt: pending.created_at,
      },
      scimResourcesEnabled,
      'saml',
    )
    if (recorded.failure) return
    const attempt = await readAttempt(trx)
      .select(samlDatabaseInstantText(sql.ref('expires_at')).as('expiresAt'))
      .forUpdate()
      .executeTakeFirst()
    if (!attempt) throw new OidcAttemptRefused()
    const expiry = Temporal.Instant.from(attempt.expiresAt)
    const requireLive = (now: Temporal.Instant) => {
      if (
        samlRequestExpired(expiry, now) ||
        recorded.proofExpiresAt.getTime() <= now.epochMilliseconds
      )
        throw new SamlTimingError('request_expired')
      if (samlAcceptanceExpired(acceptanceDeadline, now))
        throw new SamlTimingError('timing_invalid')
    }
    const now = await samlDatabaseNow(trx)
    requireLive(now)
    await trx
      .updateTable('sso_attempts')
      .set({ consumed_at: now.toString() })
      .where('id', '=', id)
      .execute()
    requireLive(await samlDatabaseNow(trx))
    return { returnPath, provider, delegation: recorded.delegation }
  })
}

export function samlSignInRoutes({
  db,
  capabilities,
  configurationKey,
  signup,
  session,
  readSession,
}: SamlSignInDeps): SamlSignInModule {
  const scimResourcesEnabled = capabilities.scimResourcesEnabled === true
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
          const link = request.kind === 'link' && request.operation === samlLinkOperation
          const stepUp = request.kind === 'link' && request.operation === samlStepUpOperation
          const signIn = request.kind === 'sign_in' && request.operation === samlStartOperation
          if (
            (!test && (!provider.enabled || (!link && !signIn && !stepUp))) ||
            ((link || stepUp) && (!request.user_id || !request.session_id))
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
          const finish = (pending: {
            id: string
            result: string
            kind?: 'result' | 'link-result' | 'mailbox' | 'admission'
          }) => {
            const cookie =
              pending.kind === 'admission'
                ? ssoAdmissionCookie(publicUrl, 'saml', pending.id)
                : samlStateCookie(publicUrl, pending.kind ?? 'result', pending.id)
            setCookie(c, cookie.name, pending.result, {
              ...cookie.options,
              maxAge: completionLifetime.seconds,
            })
            if (pending.kind === 'mailbox' || pending.kind === 'admission')
              return c.redirect(`${MAILBOX_PROOF_CONFIRM_PATH}#attempt=${pending.id}&saml=1`, 303)
            const intent = pending.kind === 'link-result' ? '&intent=link' : ''
            return c.redirect(`${SAML_COMPLETE_PATH}?attemptId=${pending.id}${intent}`, 303)
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
              const response = verifySamlResponse(
                {
                  ...samlServiceProviderUrls(publicUrl, provider.providerId),
                  idpEntityId: provider.issuer,
                  signingCertificates: config.signingCertificates,
                  algorithms: samlInitialAlgorithms,
                },
                samlResponse,
                { allowMissingAuthnInstant: stepUp },
              )
              return { response, subjectAttribute: config.subjectAttribute }
            } catch (error) {
              if (error instanceof SamlVerificationError) return samlRefusalReason(error)
              throw error
            }
          }
          try {
            const verified = verify()
            if (test) {
              const pending = await stageTest(
                typeof verified === 'string' ? verified : verified.response,
              ).catch((error: unknown) => {
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
                subjectAttribute: verified.subjectAttribute,
              },
              requestId,
              relayState,
              verified.response,
              scimResourcesEnabled,
              (link || stepUp) && request.user_id && request.session_id
                ? {
                    kind: stepUp ? 'step_up' : 'link',
                    actor: { userId: request.user_id, id: request.session_id },
                  }
                : undefined,
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
            if (error instanceof SsoMailboxCompletionExpired || expiresDuringOidcWrite(error))
              return fail('attempt_expired')
            throw error
          }
        },
      )

      app.all(SAML_COMPLETE_PATH, requestLogger, guard, clientIp, apiBodyLimit(), async (c) => {
        if (c.req.method === 'GET') {
          const query = new URL(c.req.url).searchParams
          const id = samlId.safeParse(query.get('attemptId'))
          const link = query.get('intent') === 'link'
          if (!id.success || query.size !== (link ? 2 : 1)) return c.json(completionInvalid, 400)
          const chinese = /^(zh)(?:[-;,]|$)/i.test(c.req.header('accept-language') ?? '')
          const label = link
            ? chinese
              ? '关联账号'
              : 'Link account'
            : chinese
              ? '继续'
              : 'Continue'
          const consent = link ? '<input type="hidden" name="intent" value="link">' : ''
          // This origin-only policy lets a native form POST send Origin without the attempt URL.
          c.header('Referrer-Policy', 'strict-origin')
          c.header('Vary', 'Accept-Language')
          return c.html(
            `<!doctype html><html lang="${chinese ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${label}</title></head><body><main><form action="${SAML_COMPLETE_PATH}" method="post"><input type="hidden" name="attemptId" value="${id.data}">${consent}<button type="submit">${label}</button></form></main></body></html>`,
          )
        }
        if (c.req.method !== 'POST') return c.json({ error: 'method_not_allowed' }, 405)
        if (c.req.header('origin') !== origin || c.req.header('authorization') !== undefined)
          return c.json({ error: 'forbidden' }, 403)

        const fields = await form(c)
        const id = samlId.safeParse(fields?.get('attemptId'))
        const linkIntent = fields?.get('intent') === 'link'
        if (!id.success || fields?.size !== (linkIntent ? 2 : 1))
          return c.json({ error: 'invalid_request' }, 400)
        const wait = completions.hit(rateLimitKey(c.var.clientIp))
        if (wait !== undefined) {
          c.header('Retry-After', String(wait))
          return c.json({ error: 'rate_limited' }, 429)
        }
        const browserBinding = getCookie(c, bindingName)
        const binding = browserBindingDigest(browserBinding)
        if (!configurationKey || !browserBinding || !binding) return c.json(completionInvalid, 400)
        const sessionOptions = {
          ...session,
          scimResourcesEnabled,
          publicUrl,
          headers: c.req.raw.headers,
          ip: c.var.clientIp,
        }
        const returnState = (requestId: string) => {
          const name = samlStateCookie(publicUrl, 'return', requestId).name
          const stored = getCookie(c, name)
          if (stored) return openSamlState(configurationKey, 'return', requestId, stored)
        }
        const linkCookie = samlStateCookie(publicUrl, 'link-result', id.data)
        const linkEnvelope = getCookie(c, linkCookie.name)
        if (linkIntent) {
          const completed = await completeOidcLink(
            { db, configurationKey, scimResourcesEnabled },
            { id: id.data, browserBinding, envelope: linkEnvelope },
            async () => readSession?.(c.req.raw.headers),
            (requestId) => {
              const name = samlStateCookie(publicUrl, 'link', requestId).name
              const state = getCookie(c, name)
              const plaintext = state && openSamlState(configurationKey, 'link', requestId, state)
              if (plaintext) return JSON.parse(plaintext)
            },
          )
          if (completed?.status === 'domain_unverified')
            return c.json({ error: 'sso_domain_unverified' }, 409)
          if (completed?.status !== 'linked' || !completed.requestId)
            return c.json(completionInvalid, 400)
          const startCookie = samlStateCookie(publicUrl, 'link', completed.requestId)
          deleteCookie(c, linkCookie.name, linkCookie.options)
          deleteCookie(c, startCookie.name, startCookie.options)
          return c.redirect(oidcLinkReturnPath, 303)
        }
        if (linkEnvelope !== undefined) return c.json(completionInvalid, 400)
        const admissionCookie = ssoAdmissionCookie(publicUrl, 'saml', id.data)
        const admissionEnvelope = getCookie(c, admissionCookie.name)
        if (admissionEnvelope !== undefined) {
          const completed = await completeSsoAdmission(
            { db, configurationKey, signup },
            { id: id.data, browserBinding, envelope: admissionEnvelope },
            sessionOptions,
            { kind: 'jit' },
            'saml',
            returnState,
          )
          if (completed.status !== 'completed' && completed.status !== 'link_required')
            return ssoAdmissionRefused(c, completed.status, 'saml')
          deleteCookie(c, admissionCookie.name, admissionCookie.options)
          if (completed.requestId !== undefined) {
            const returnCookie = samlStateCookie(publicUrl, 'return', completed.requestId)
            deleteCookie(c, returnCookie.name, returnCookie.options)
          }
          if (completed.status === 'link_required') return c.json({ status: 'link_required' })
          c.header('Set-Cookie', completed.cookie, { append: true })
          return c.redirect(completed.returnPath, 303)
        }
        const mailboxCookie = samlStateCookie(publicUrl, 'mailbox', id.data)
        const mailboxEnvelope = getCookie(c, mailboxCookie.name)
        if (mailboxEnvelope !== undefined) {
          const completed = await completeOidcSignIn(
            { db, configurationKey, scimResourcesEnabled },
            { id: id.data, browserBinding, envelope: mailboxEnvelope },
            sessionOptions,
            returnState,
          )
          if (completed.status === 'invalid') return c.json(completionInvalid, 400)
          deleteCookie(c, mailboxCookie.name, mailboxCookie.options)
          if (completed.status === 'collision') return c.json({ error: 'sso_email_collision' }, 409)
          if (completed.requestId) {
            const returnCookie = samlStateCookie(publicUrl, 'return', completed.requestId)
            deleteCookie(c, returnCookie.name, returnCookie.options)
          }
          c.header('Set-Cookie', completed.cookie, { append: true })
          return c.redirect(completed.returnPath, 303)
        }
        const cookie = samlStateCookie(publicUrl, 'result', id.data)
        const envelope = getCookie(c, cookie.name)
        if (!envelope) return c.json(completionInvalid, 400)

        const plaintext = openSamlState(configurationKey, 'result', id.data, envelope)
        if (plaintext === undefined) return c.json(completionInvalid, 400)
        const projection: unknown = JSON.parse(plaintext)
        const stepUp = stepUpResultSchema.safeParse(projection)
        if (stepUp.success) {
          const startCookie = samlStateCookie(publicUrl, 'step-up', stepUp.data.requestId)
          const startEnvelope = getCookie(c, startCookie.name)
          const startState =
            startEnvelope &&
            openSamlState(configurationKey, 'step-up', stepUp.data.requestId, startEnvelope)
          if (!startState) return c.json(completionInvalid, 400)
          const actor = await readSession?.(c.req.raw.headers)
          if (!actor) return c.json(completionInvalid, 400)
          const state = samlStepUpState.parse(JSON.parse(startState))
          const completed = await completeSamlStepUp(
            db,
            { id: id.data, browserBinding, envelope },
            stepUp.data,
            actor,
            state,
            scimResourcesEnabled,
          ).catch((error: unknown) => {
            if (
              error instanceof OidcAttemptRefused ||
              error instanceof SamlTimingError ||
              expiresDuringOidcWrite(error)
            )
              return undefined
            throw error
          })
          if (!completed) return c.json(completionInvalid, 400)
          if (completed.delegation) {
            const { attemptId, linkGeneration, expiresAt } = completed.delegation
            const proofCookie = delegationProofCookie(publicUrl, attemptId)
            const proof = sealDelegationProof(
              configurationKey,
              completed.provider,
              attemptId,
              binding,
              {
                linkGeneration,
                sessionDeadline: stepUp.data.sessionDeadline,
              },
            )
            setCookie(c, proofCookie.name, proof, { ...proofCookie.options, expires: expiresAt })
          }
          deleteCookie(c, startCookie.name, startCookie.options)
          deleteCookie(c, cookie.name, cookie.options)
          return c.redirect(completed.returnPath, 303)
        }
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
            scimResourcesEnabled,
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
          returnState,
          sessionOptions,
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
