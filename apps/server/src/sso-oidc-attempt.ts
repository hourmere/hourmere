import { createHash, randomBytes } from 'node:crypto'
import { checkTeamManagementMembership, TeamManagementError } from '@hourmere/auth'
import { decryptCredential, encryptCredential } from '@hourmere/calendars'
import type { Db } from '@hourmere/db'
import { scimSuspended } from '@hourmere/db/scim-suspension'
import { sql } from 'kysely'
import { z } from 'zod'
import { type SsoProviderRevision, ssoProviderConfigurationAad } from './sso-configuration.ts'
import { databaseInstantText } from './sso-database-clock.ts'
import { BIND_SSO_DELEGATION } from './sso-delegation-proof.ts'
import { browserBindingDigest, MAILBOX_PROOF_LIMITS, sha256 } from './sso-mailbox-proof.ts'
import { authenticationAttemptLifetime, oidcClockSkew } from './sso-oidc-limits.ts'
import { samlClockSkew } from './sso-saml-limits.ts'

export const TEST_SSO_PROVIDER = 'testSsoProvider'
export const LINK_SSO_ACCOUNT = 'linkSsoAccount'
const signInOperation = 'oidcSignIn'
const maxReturnPathLength = 2048
const maxStateLength = 4096
const appOrigin = 'https://app.invalid'
const uuid = z.uuid()
const statePattern =
  /^([a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.([\w-]+)$/
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const oidcLinkBinding = z.strictObject({
  memberId: uuid,
  domainId: uuid,
  domainGeneration: z.int().positive(),
  mailboxDigest: z.hex().length(64),
  provenAt: z.string(),
  proofExpiresAt: z.string(),
})
export const ssoStepUpBinding = z.strictObject({
  attemptId: uuid,
  linkId: uuid,
  linkGeneration: z.int().positive(),
  trustGeneration: z.int().positive(),
})
type StepUpBinding = z.infer<typeof ssoStepUpBinding>
const oidcRecoveryTestBinding = z.strictObject({
  testProviderEnabled: z.boolean(),
  acceptedAt: z.string(),
})
type RecoveryTestBinding = z.infer<typeof oidcRecoveryTestBinding>
const statePayload = z.tuple([
  secret,
  secret,
  z.string(),
  z.hex().length(64).optional(),
  z.union([oidcLinkBinding, ssoStepUpBinding, oidcRecoveryTestBinding]).optional(),
])
export class OidcAttemptRefused extends Error {
  constructor() {
    super('OIDC attempt refused')
  }
}
const refused = () => new OidcAttemptRefused()

export class OidcStateReplay extends OidcAttemptRefused {
  readonly attemptId: string
  constructor(attemptId: string) {
    super()
    this.attemptId = attemptId
  }
}

interface AttemptDependencies {
  db: Db
  configurationKey: Buffer
  scimResourcesEnabled?: boolean | undefined
}

type OriginatingBrowser = SsoProviderRevision & { browserBinding: string | undefined }
export interface OidcTestActor {
  userId: string
  id: string
}
type Ceremony =
  | { kind: 'sign_in' }
  | { kind: 'test'; actor: OidcTestActor; recovery?: RecoveryTestBinding & { deadline: string } }
  | { kind: 'link'; actor: OidcTestActor; binding: z.infer<typeof oidcLinkBinding> }
  | { kind: 'step_up'; actor: OidcTestActor; attemptId: string }

type BoundStepUp = { actor: OidcTestActor; binding: StepUpBinding }
type BoundTest = { kind: 'test'; actor: OidcTestActor; recovery?: RecoveryTestBinding }

const operations = {
  sign_in: signInOperation,
  test: TEST_SSO_PROVIDER,
  link: LINK_SSO_ACCOUNT,
  step_up: 'oidcStepUp',
}

// The stored link kind provides the authenticated ceremony shape. The operation
// and authenticated state distinguish step-up from every self-linking path.
const storedKind = (kind: Ceremony['kind']) => (kind === 'step_up' ? 'link' : kind)

/** Canonical same-origin application and OAuth authorization destinations. */
export function oidcReturnDestination(raw: string): string | undefined {
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.length > maxReturnPathLength)
    return undefined
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject characters the URL parser strips
  if (/[\u0000- \u007f-\u009f\\]/.test(raw) || !raw.isWellFormed()) return undefined
  const url = new URL(raw, appOrigin)
  const path = url.pathname + url.search + url.hash
  // Only the organization selection page can resume after signing in to a new session.
  // The OAuth broker validates the signed query before it allows the request to continue.
  const oauth =
    url.pathname === '/oauth/authorize' &&
    url.searchParams.has('sig') &&
    url.searchParams.has('exp') &&
    !url.hash
  if (
    url.origin !== appOrigin ||
    !(url.pathname === '/app' || url.pathname.startsWith('/app/') || oauth) ||
    /%2f|%5c/i.test(url.pathname) ||
    path.length > maxReturnPathLength
  )
    return undefined
  return path
}

function bindingDigest(browser: OriginatingBrowser): string {
  const digest = browserBindingDigest(browser.browserBinding)
  if (
    digest === null ||
    !uuid.safeParse(browser.organizationId).success ||
    !uuid.safeParse(browser.providerId).success ||
    !Number.isInteger(browser.revision) ||
    browser.revision < 1 ||
    browser.revision > 2147483647
  )
    throw refused()
  return digest
}

function stateAad(browser: OriginatingBrowser, id: string, binding: string): string {
  return JSON.stringify([
    'hourmere-oidc-state-v1',
    ssoProviderConfigurationAad(browser),
    id,
    binding,
  ])
}

export async function lockOidcProvider(
  trx: Db,
  browser: SsoProviderRevision,
  enabled = true,
  protocol: 'oidc' | 'saml' = 'oidc',
) {
  // Match the team-write order. Hold the provider revision stable until the attempt commits.
  const organization = await trx
    .selectFrom('auth.organization')
    .select('id')
    .where('id', '=', browser.organizationId)
    .forShare()
    .executeTakeFirst()
  if (!organization) throw refused()
  const provider = await trx
    .selectFrom('sso_providers')
    .select('issuer')
    .where('id', '=', browser.providerId)
    .where('organization_id', '=', browser.organizationId)
    .where('revision', '=', browser.revision)
    .where('protocol', '=', protocol)
    .where('enabled', '=', enabled)
    .where('retired_at', 'is', null)
    .forShare()
    .executeTakeFirst()
  if (!provider) throw refused()
  return provider
}

/** Recheck the original test session and current authority around the outbound exchange. */
export async function lockOidcTestActor(
  trx: Db,
  provider: SsoProviderRevision,
  actor: OidcTestActor,
  recovery?: RecoveryTestBinding,
  scimResourcesEnabled = false,
  protocol: 'oidc' | 'saml' = 'oidc',
) {
  const user = await trx
    .selectFrom('auth.user')
    .select('id')
    .where('id', '=', actor.userId)
    .where('emailVerified', '=', true)
    .forShare()
    .executeTakeFirst()
  if (!user) throw refused()
  await lockOidcProvider(trx, provider, recovery?.testProviderEnabled ?? false, protocol)
  try {
    const member = await checkTeamManagementMembership(
      trx,
      actor.userId,
      provider.organizationId,
      true,
      false,
      false,
      false,
      false,
      scimResourcesEnabled,
    )
    if (recovery) {
      if (member.role !== 'owner') throw refused()
      const enrollment = await trx
        .selectFrom('sso_recovery_owners')
        .select('member_id')
        .where('organization_id', '=', provider.organizationId)
        .where('user_id', '=', actor.userId)
        .where('accepted_at', '=', sql<Date>`${recovery.acceptedAt}::timestamptz`)
        .executeTakeFirst()
      if (!enrollment) throw refused()
    }
    const session = await trx
      .selectFrom('auth.session')
      .select(['expiresAt', 'activeOrganizationId'])
      .where('id', '=', actor.id)
      .where('userId', '=', actor.userId)
      .forShare()
      .executeTakeFirst()
    if (!session || (!recovery && session.activeOrganizationId !== provider.organizationId))
      throw refused()
    const { live } = await trx
      .selectNoFrom(sql<boolean>`${session.expiresAt}::timestamptz > clock_timestamp()`.as('live'))
      .executeTakeFirstOrThrow()
    if (!live) throw refused()
    return member.role
  } catch (error) {
    if (error instanceof TeamManagementError) throw refused()
    throw error
  }
}

export async function lockSsoStepUpTarget(
  trx: Db,
  provider: OriginatingBrowser,
  actor: OidcTestActor,
  attemptId: string,
  scimResourcesEnabled: boolean,
  protocol: 'oidc' | 'saml' = 'oidc',
) {
  // Use the same person -> team -> session -> attempt order as the protected write.
  const user = await trx
    .selectFrom('auth.user')
    .select('email')
    .where('id', '=', actor.userId)
    .where('emailVerified', '=', true)
    .forShare()
    .executeTakeFirst()
  if (!user) throw refused()
  const { issuer } = await lockOidcProvider(trx, provider, true, protocol)
  const session = await trx
    .selectFrom('auth.session')
    .select('expiresAt')
    .where('id', '=', actor.id)
    .where('userId', '=', actor.userId)
    .where(sql<string>`lower("activeOrganizationId")`, '=', provider.organizationId)
    .forShare()
    .executeTakeFirst()
  if (!session) throw refused()
  const attempt = await trx
    .selectFrom('sso_attempts')
    .select([
      'id',
      'created_at',
      'expires_at',
      'mailbox',
      'operation',
      databaseInstantText(sql.ref('created_at')).as('createdAt'),
    ])
    .where('id', '=', attemptId)
    .where('kind', '=', 'fresh_proof')
    .where('organization_id', '=', provider.organizationId)
    .where('user_id', '=', actor.userId)
    .where('session_id', '=', actor.id)
    .where('browser_binding_digest', '=', bindingDigest(provider))
    .where('requires_sso', '=', true)
    .where('consumed_at', 'is', null)
    .where('step_up_link_id', 'is', null)
    .forUpdate()
    .executeTakeFirst()
  if (!attempt) throw refused()
  const policy = await trx
    .selectFrom('sso_policies')
    .select(['trust_generation', 'require_sso'])
    .where('organization_id', '=', provider.organizationId)
    .forShare()
    .executeTakeFirst()
  const linkedMember = trx
    .selectFrom('sso_identity_links as l')
    .innerJoin('auth.member as m', (join) =>
      join.onRef('m.userId', '=', 'l.user_id').onRef('m.organizationId', '=', 'l.organization_id'),
    )
    .select(['l.id', 'l.subject', 'l.generation'])
    .where('l.organization_id', '=', provider.organizationId)
    .where('l.provider_id', '=', provider.providerId)
    .where('l.issuer', '=', issuer)
    .where('l.user_id', '=', actor.userId)
    .where('l.retired_at', 'is', null)
  // SAML checks SCIM suspension before starting the ceremony and recording proof.
  // The shared helper preserves the existing OIDC membership check.
  const link = await (protocol === 'saml'
    ? linkedMember.where((eb) =>
        eb.not(scimSuspended(provider.organizationId, actor.userId, scimResourcesEnabled)),
      )
    : linkedMember
  )
    .forShare()
    .executeTakeFirst()
  const { now } = await trx
    .selectNoFrom(sql<Date>`clock_timestamp()`.as('now'))
    .executeTakeFirstOrThrow()
  if (
    (!policy?.require_sso && attempt.operation !== BIND_SSO_DELEGATION) ||
    !link ||
    session.expiresAt <= now ||
    attempt.expires_at <= now
  )
    throw refused()
  return {
    attempt,
    link,
    issuer,
    now,
    mailbox: user.email.trim().toLowerCase(),
    binding: {
      attemptId: attempt.id,
      linkId: link.id,
      linkGeneration: link.generation,
      trustGeneration: policy?.trust_generation ?? 1,
    },
  }
}

async function lockBoundStepUp(
  trx: Db,
  provider: OriginatingBrowser,
  stepUp: BoundStepUp,
  scimResourcesEnabled: boolean,
  protocol: 'oidc' | 'saml' = 'oidc',
) {
  const target = await lockSsoStepUpTarget(
    trx,
    provider,
    stepUp.actor,
    stepUp.binding.attemptId,
    scimResourcesEnabled,
    protocol,
  )
  if (
    target.binding.linkId !== stepUp.binding.linkId ||
    target.binding.linkGeneration !== stepUp.binding.linkGeneration ||
    target.binding.trustGeneration !== stepUp.binding.trustGeneration
  )
    throw refused()
  return target
}

export function ssoStepUpSubjectDigest(issuer: string, subject: string) {
  return sha256(JSON.stringify([issuer, subject]))
}

function ceilMillisecond(instant: string) {
  return Temporal.Instant.from(instant).round({ smallestUnit: 'millisecond', roundingMode: 'ceil' })
    .epochMilliseconds
}

/** Record a verified authentication event on the original write challenge. */
export async function recordSsoStepUp(
  db: Db,
  provider: OriginatingBrowser,
  stepUp: BoundStepUp,
  ceremonyCreatedAt: Date | string,
  identity: {
    subjectDigest: string
    authTimeMs: number | undefined
    sessionDeadline?: Date | undefined
    receivedAt?: Date | undefined
  },
  scimResourcesEnabled: boolean,
  protocol: 'oidc' | 'saml' = 'oidc',
) {
  const record = async (trx: Db) => {
    const { attempt, binding, issuer, link, mailbox, now } = await lockBoundStepUp(
      trx,
      provider,
      stepUp,
      scimResourcesEnabled,
      protocol,
    )
    if (identity.subjectDigest !== ssoStepUpSubjectDigest(issuer, link.subject)) throw refused()

    const lifetime = MAILBOX_PROOF_LIMITS.tokenLifetimeSeconds * 1000
    const skew = (protocol === 'saml' ? samlClockSkew : oidcClockSkew) * 1000
    const authTime = identity.authTimeMs
    const receivedAt = identity.receivedAt ?? now
    // SAML projects the authentication event at millisecond precision. Round the lower
    // bound up so the stored timestamp also obeys PostgreSQL's microsecond constraint.
    const createdAt =
      typeof ceremonyCreatedAt === 'string'
        ? Math.max(ceilMillisecond(attempt.createdAt), ceilMillisecond(ceremonyCreatedAt))
        : Math.max(attempt.created_at.getTime(), ceremonyCreatedAt.getTime())
    if (
      identity.sessionDeadline &&
      identity.sessionDeadline <= now &&
      attempt.operation === BIND_SSO_DELEGATION
    )
      return { failure: 'timing_invalid' } as const
    const stale =
      authTime !== undefined &&
      (authTime < createdAt - skew || authTime + lifetime <= receivedAt.getTime())
    if (
      (authTime !== undefined && authTime > receivedAt.getTime() + skew) ||
      (protocol === 'oidc' && stale)
    )
      return { failure: 'authentication_stale' } as const
    const needsMailbox = authTime === undefined || stale
    if (needsMailbox && attempt.mailbox !== mailbox) throw refused()

    // If the assertion only proves identity, receipt time bounds that result
    // while the same attempt still requires a fresh proof of its frozen mailbox.
    const authenticatedAt = needsMailbox ? receivedAt.getTime() : authTime
    const expiresAt = Math.min(authenticatedAt + lifetime, attempt.expires_at.getTime())
    if (expiresAt <= authenticatedAt || expiresAt <= now.getTime()) throw refused()
    const proofExpiresAt = new Date(expiresAt)
    await trx
      .updateTable('sso_attempts')
      .set({
        ...(needsMailbox && { requires_mailbox: true }),
        step_up_provider_id: provider.providerId,
        step_up_link_id: link.id,
        step_up_authenticated_at: new Date(authenticatedAt),
        step_up_proof_expires_at: proofExpiresAt,
        step_up_trust_generation: binding.trustGeneration,
      })
      .where('id', '=', attempt.id)
      .execute()
    return {
      proofExpiresAt,
      delegation:
        attempt.operation === BIND_SSO_DELEGATION
          ? {
              attemptId: attempt.id,
              linkGeneration: binding.linkGeneration,
              expiresAt: proofExpiresAt,
            }
          : undefined,
    }
  }
  return db.isTransaction ? record(db) : db.transaction().execute(record)
}

/** Builds authorization parameters for a fresh browser-bound OIDC attempt. */
export async function startOidcAttempt(
  { db, configurationKey, scimResourcesEnabled }: AttemptDependencies,
  browser: OriginatingBrowser & { returnPath: string; endpointsDigest?: string },
  ceremony: Ceremony = { kind: 'sign_in' },
) {
  const binding = bindingDigest(browser)
  const returnPath = oidcReturnDestination(browser.returnPath)
  if (!returnPath) throw refused()
  const codeVerifier = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const write = async (trx: Db) => {
    const stepUp =
      ceremony.kind === 'step_up'
        ? await lockSsoStepUpTarget(
            trx,
            browser,
            ceremony.actor,
            ceremony.attemptId,
            scimResourcesEnabled === true,
          )
        : undefined
    if (!stepUp)
      await lockOidcProvider(
        trx,
        browser,
        ceremony.kind === 'test' ? (ceremony.recovery?.testProviderEnabled ?? false) : true,
      )
    const deadline =
      stepUp?.attempt.expires_at ??
      (ceremony.kind === 'link' ? ceremony.binding.proofExpiresAt : null) ??
      (ceremony.kind === 'test' ? (ceremony.recovery?.deadline ?? null) : null)
    const { id, now, live } = await trx
      .selectNoFrom([
        sql<string>`uuidv7()`.as('id'),
        sql<string>`statement_timestamp()::text`.as('now'),
        sql<boolean>`coalesce(${deadline}::timestamptz > statement_timestamp(), true)`.as('live'),
      ])
      .executeTakeFirstOrThrow()
    if (!live) throw refused()
    // Ceremony material travels in authenticated ciphertext. The attempt stores only
    // digests of the browser binding and full state for the eventual one-shot update.
    const payload: z.infer<typeof statePayload> = [codeVerifier, nonce, returnPath]
    if (browser.endpointsDigest) payload.push(browser.endpointsDigest)
    if (ceremony.kind === 'link') {
      if (!browser.endpointsDigest) throw refused()
      payload.push(ceremony.binding)
    }
    if (stepUp) {
      if (!browser.endpointsDigest) throw refused()
      payload.push(stepUp.binding)
    }
    if (ceremony.kind === 'test' && ceremony.recovery) {
      if (!browser.endpointsDigest) throw refused()
      const { testProviderEnabled, acceptedAt } = ceremony.recovery
      payload.push({ testProviderEnabled, acceptedAt })
    }
    const envelope = encryptCredential(
      configurationKey,
      stateAad(browser, id, binding),
      JSON.stringify(payload),
    ).toString('base64url')
    const state = `${id}.${envelope}`
    await trx
      .insertInto('sso_attempts')
      .values({
        id,
        kind: storedKind(ceremony.kind),
        organization_id: browser.organizationId,
        provider_id: browser.providerId,
        provider_revision: browser.revision,
        ...(ceremony.kind !== 'sign_in' && {
          user_id: ceremony.actor.userId,
          session_id: ceremony.actor.id,
        }),
        browser_binding_digest: binding,
        operation: operations[ceremony.kind],
        input_digest: sha256(state),
        created_at: now,
        expires_at: sql`least(
          ${now}::timestamptz + make_interval(secs => ${authenticationAttemptLifetime}),
          ${deadline}::timestamptz
        )`,
      })
      .execute()
    return { id, state }
  }
  const { id, state } = await (db.isTransaction ? write(db) : db.transaction().execute(write))
  return {
    id,
    state,
    nonce,
    code_challenge: createHash('sha256').update(codeVerifier, 'ascii').digest('base64url'),
    code_challenge_method: 'S256' as const,
  }
}

function openState(configurationKey: Buffer, aad: string, envelope: string) {
  try {
    const plaintext = decryptCredential(configurationKey, aad, Buffer.from(envelope, 'base64url'))
    const [codeVerifier, nonce, returnPath, endpointsDigest, ceremonyBinding] = statePayload.parse(
      JSON.parse(plaintext),
    )
    const destination = oidcReturnDestination(returnPath)
    if (!destination) throw refused()
    return { codeVerifier, nonce, returnPath: destination, endpointsDigest, ceremonyBinding }
  } catch {
    throw refused()
  }
}

/** Classify a refused callback for auditing without authorizing or consuming the test. */
export async function isOidcTestCallback(
  db: Db,
  browser: OriginatingBrowser,
  state: string | undefined,
  readActor: () => Promise<OidcTestActor | null | undefined>,
) {
  const id = state && state.length <= maxStateLength ? statePattern.exec(state)?.[1] : undefined
  // An exact stored state identifies the intent even with a different provider, browser or
  // session. Preserve sign-in auditing if a browser is also running a test.
  if (state && id) {
    const attempt = await db
      .selectFrom('sso_attempts')
      .select(['kind', 'operation'])
      .where('id', '=', id)
      .where('input_digest', '=', sha256(state))
      .executeTakeFirst()
    if (attempt) return attempt.kind === 'test' && attempt.operation === TEST_SSO_PROVIDER
  }

  // A corrupted state may be unrecognizable. Require the initiating session and browser
  // for that fallback, and scope it to a pending test for the callback's provider.
  const binding = browserBindingDigest(browser.browserBinding)
  if (!binding) return false
  const actor = await readActor()
  if (!actor) return false
  const bound = await db
    .selectFrom('sso_attempts')
    .select('id')
    .where('kind', '=', 'test')
    .where('operation', '=', TEST_SSO_PROVIDER)
    .where('organization_id', '=', browser.organizationId)
    .where('provider_id', '=', browser.providerId)
    .where('user_id', '=', actor.userId)
    .where('session_id', '=', actor.id)
    .where('browser_binding_digest', '=', binding)
    .where('consumed_at', 'is', null)
    .limit(1)
    .executeTakeFirst()
  return bound !== undefined
}

/**
 * Consumes matching state before returning the verifier to an eventual token exchange.
 * The transaction commits first, so even a failed exchange can never make this state usable again.
 */
export async function consumeOidcAttempt(
  { db, configurationKey, scimResourcesEnabled }: AttemptDependencies,
  browser: OriginatingBrowser & { state: string | null },
  test: BoundTest | undefined = undefined,
  readActor?: () => Promise<OidcTestActor | null | undefined>,
) {
  const binding = bindingDigest(browser)
  const state = browser.state
  if (typeof state !== 'string' || state.length > maxStateLength) throw refused()
  const match = statePattern.exec(state)
  const id = match?.[1]
  const envelope = match?.[2]
  if (!id || !envelope) throw refused()
  const material = openState(configurationKey, stateAad(browser, id, binding), envelope)
  let ceremony:
    | Exclude<Ceremony, { kind: 'step_up' | 'test' }>
    | (BoundStepUp & { kind: 'step_up' })
    | BoundTest = test ?? {
    kind: 'sign_in',
  }
  const storedBinding = material.ceremonyBinding
  if (storedBinding && 'testProviderEnabled' in storedBinding) {
    const actor = test?.actor ?? (await readActor?.())
    if (!actor) throw refused()
    ceremony = { kind: 'test', actor, recovery: storedBinding }
  } else if (storedBinding) {
    const actor = !test && (await readActor?.())
    if (!actor) throw refused()
    ceremony =
      'attemptId' in storedBinding
        ? { kind: 'step_up', actor, binding: storedBinding }
        : { kind: 'link', actor, binding: storedBinding }
  }

  const attempt = await db.transaction().execute(async (trx) => {
    if (ceremony.kind === 'test')
      await lockOidcTestActor(
        trx,
        browser,
        ceremony.actor,
        ceremony.recovery,
        scimResourcesEnabled === true,
      )
    else if (ceremony.kind === 'step_up')
      await lockBoundStepUp(trx, browser, ceremony, scimResourcesEnabled === true)
    else await lockOidcProvider(trx, browser)
    const query = trx
      .selectFrom('sso_attempts')
      .select(['id', 'consumed_at'])
      .where('id', '=', id)
      .where('kind', '=', storedKind(ceremony.kind))
      .where('operation', '=', operations[ceremony.kind])
      .where('organization_id', '=', browser.organizationId)
      .where('provider_id', '=', browser.providerId)
      .where('provider_revision', '=', browser.revision)
      .where('browser_binding_digest', '=', binding)
      .where('input_digest', '=', sha256(state))
    const eligible = await (ceremony.kind !== 'sign_in'
      ? query
          .where('user_id', '=', ceremony.actor.userId)
          .where('session_id', '=', ceremony.actor.id)
      : query
    )
      .forUpdate()
      .executeTakeFirst()
    if (!eligible) throw refused()
    if (eligible.consumed_at) throw new OidcStateReplay(eligible.id)
    // Sample the database wall clock after acquiring the row lock.
    try {
      const consumed = await trx
        .updateTable('sso_attempts')
        .set({ consumed_at: sql`clock_timestamp()` })
        .where('id', '=', eligible.id)
        .where('expires_at', '>', sql<Date>`clock_timestamp()`)
        .returning(['created_at', 'expires_at'])
        .executeTakeFirst()
      if (!consumed) throw refused()
      return consumed
    } catch (error) {
      // The row can expire between the UPDATE filter and the database trigger.
      if (
        error instanceof Error &&
        'constraint' in error &&
        error.constraint === 'sso_attempts_unexpired'
      )
        throw refused()
      throw error
    }
  })
  return {
    id,
    ...material,
    createdAt: attempt.created_at,
    expiresAt: attempt.expires_at,
    test: ceremony.kind === 'test' ? ceremony : undefined,
    link: ceremony.kind === 'link' ? ceremony : undefined,
    stepUp: ceremony.kind === 'step_up' ? ceremony : undefined,
  }
}
