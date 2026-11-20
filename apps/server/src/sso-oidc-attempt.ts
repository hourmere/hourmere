import { createHash, randomBytes } from 'node:crypto'
import { checkTeamManagementMembership, TeamManagementError } from '@hourmere/auth'
import { decryptCredential, encryptCredential } from '@hourmere/calendars'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { z } from 'zod'
import { type SsoProviderRevision, ssoProviderConfigurationAad } from './sso-configuration.ts'
import { BIND_SSO_DELEGATION } from './sso-delegation-proof.ts'
import { browserBindingDigest, MAILBOX_PROOF_LIMITS, sha256 } from './sso-mailbox-proof.ts'
import { authenticationAttemptLifetime, oidcClockSkew } from './sso-oidc-limits.ts'

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
const oidcStepUpBinding = z.strictObject({
  attemptId: uuid,
  linkId: uuid,
  linkGeneration: z.int().positive(),
  trustGeneration: z.int().positive(),
})
type StepUpBinding = z.infer<typeof oidcStepUpBinding>
const statePayload = z.tuple([
  secret,
  secret,
  z.string(),
  z.hex().length(64).optional(),
  z.union([oidcLinkBinding, oidcStepUpBinding]).optional(),
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
}

type OriginatingBrowser = SsoProviderRevision & { browserBinding: string | undefined }
export interface OidcTestActor {
  userId: string
  id: string
}
type Ceremony =
  | { kind: 'sign_in' }
  | { kind: 'test'; actor: OidcTestActor }
  | { kind: 'link'; actor: OidcTestActor; binding: z.infer<typeof oidcLinkBinding> }
  | { kind: 'step_up'; actor: OidcTestActor; attemptId: string }

type BoundStepUp = { kind: 'step_up'; actor: OidcTestActor; binding: StepUpBinding }

const operations = {
  sign_in: signInOperation,
  test: TEST_SSO_PROVIDER,
  link: LINK_SSO_ACCOUNT,
  step_up: 'oidcStepUp',
}

// The stored link kind provides the authenticated ceremony shape. The operation
// and authenticated state distinguish step-up from every self-linking path.
const storedKind = (kind: Ceremony['kind']) => (kind === 'step_up' ? 'link' : kind)

/** A canonical, same-origin destination under /app, or undefined for unsafe input. */
export function oidcReturnDestination(raw: string): string | undefined {
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.length > maxReturnPathLength)
    return undefined
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject characters the URL parser strips
  if (/[\u0000- \u007f-\u009f\\]/.test(raw) || !raw.isWellFormed()) return undefined
  const url = new URL(raw, appOrigin)
  const path = url.pathname + url.search + url.hash
  if (
    url.origin !== appOrigin ||
    !(url.pathname === '/app' || url.pathname.startsWith('/app/')) ||
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

export async function lockOidcProvider(trx: Db, browser: SsoProviderRevision, enabled = true) {
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
    .where('protocol', '=', 'oidc')
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
) {
  const user = await trx
    .selectFrom('auth.user')
    .select('id')
    .where('id', '=', actor.userId)
    .where('emailVerified', '=', true)
    .forShare()
    .executeTakeFirst()
  if (!user) throw refused()
  await lockOidcProvider(trx, provider, false)
  try {
    const member = await checkTeamManagementMembership(
      trx,
      actor.userId,
      provider.organizationId,
      true,
    )
    const session = await trx
      .selectFrom('auth.session')
      .select(['expiresAt', 'activeOrganizationId'])
      .where('id', '=', actor.id)
      .where('userId', '=', actor.userId)
      .forShare()
      .executeTakeFirst()
    if (session?.activeOrganizationId !== provider.organizationId) throw refused()
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

async function lockOidcStepUpTarget(
  trx: Db,
  provider: OriginatingBrowser,
  actor: OidcTestActor,
  attemptId: string,
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
  const { issuer } = await lockOidcProvider(trx, provider)
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
    .select(['id', 'created_at', 'expires_at', 'mailbox', 'operation'])
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
  const link = await trx
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

async function lockBoundStepUp(trx: Db, provider: OriginatingBrowser, stepUp: BoundStepUp) {
  const target = await lockOidcStepUpTarget(trx, provider, stepUp.actor, stepUp.binding.attemptId)
  if (
    target.binding.linkId !== stepUp.binding.linkId ||
    target.binding.linkGeneration !== stepUp.binding.linkGeneration ||
    target.binding.trustGeneration !== stepUp.binding.trustGeneration
  )
    throw refused()
  return target
}

/** Record identity and freshness on the original write challenge after verified token exchange. */
export async function recordOidcStepUp(
  db: Db,
  provider: OriginatingBrowser,
  stepUp: BoundStepUp,
  ceremonyCreatedAt: Date,
  identity: {
    issuer: string
    subject: string
    authTime: number | undefined
    sessionDeadline?: Date | undefined
  },
) {
  return db.transaction().execute(async (trx) => {
    const { attempt, binding, issuer, link, mailbox, now } = await lockBoundStepUp(
      trx,
      provider,
      stepUp,
    )
    if (identity.issuer !== issuer || identity.subject !== link.subject) throw refused()

    const lifetime = MAILBOX_PROOF_LIMITS.tokenLifetimeSeconds * 1000
    const skew = oidcClockSkew * 1000
    const authTime = identity.authTime === undefined ? undefined : identity.authTime * 1000
    const needsMailbox = authTime === undefined
    if (
      identity.sessionDeadline &&
      identity.sessionDeadline <= now &&
      attempt.operation === BIND_SSO_DELEGATION
    )
      return { failure: 'timing_invalid' } as const
    if (
      authTime !== undefined &&
      (authTime < Math.max(attempt.created_at.getTime(), ceremonyCreatedAt.getTime()) - skew ||
        authTime > now.getTime() + skew ||
        authTime + lifetime <= now.getTime())
    )
      return { failure: 'authentication_stale' } as const
    if (needsMailbox && attempt.mailbox !== mailbox) throw refused()

    // A missing claim proves identity only. Receipt time bounds that identity result
    // while the same attempt still requires a fresh proof of its frozen mailbox.
    const authenticatedAt = authTime ?? now.getTime()
    const expiresAt = Math.min(authenticatedAt + lifetime, attempt.expires_at.getTime())
    if (expiresAt <= authenticatedAt || expiresAt <= now.getTime()) throw refused()
    await trx
      .updateTable('sso_attempts')
      .set({
        ...(needsMailbox && { requires_mailbox: true }),
        step_up_provider_id: provider.providerId,
        step_up_link_id: link.id,
        step_up_authenticated_at: new Date(authenticatedAt),
        step_up_proof_expires_at: new Date(expiresAt),
        step_up_trust_generation: binding.trustGeneration,
      })
      .where('id', '=', attempt.id)
      .execute()
    return {
      delegation:
        attempt.operation === BIND_SSO_DELEGATION
          ? {
              attemptId: attempt.id,
              linkGeneration: binding.linkGeneration,
              expiresAt: new Date(expiresAt),
            }
          : undefined,
    }
  })
}

/** Builds authorization parameters for a fresh browser-bound OIDC attempt. */
export async function startOidcAttempt(
  { db, configurationKey }: AttemptDependencies,
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
        ? await lockOidcStepUpTarget(trx, browser, ceremony.actor, ceremony.attemptId)
        : undefined
    if (!stepUp) await lockOidcProvider(trx, browser, ceremony.kind !== 'test')
    const { id, now } = await trx
      .selectNoFrom([
        sql<string>`uuidv7()`.as('id'),
        sql<string>`clock_timestamp()::text`.as('now'),
      ])
      .executeTakeFirstOrThrow()
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
          ${stepUp?.attempt.expires_at ?? (ceremony.kind === 'link' ? ceremony.binding.proofExpiresAt : null)}::timestamptz
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

/**
 * Consumes matching state before returning the verifier to an eventual token exchange.
 * The transaction commits first, so even a failed exchange can never make this state usable again.
 */
export async function consumeOidcAttempt(
  { db, configurationKey }: AttemptDependencies,
  browser: OriginatingBrowser & { state: string | null },
  test: Extract<Ceremony, { kind: 'test' }> | undefined = undefined,
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
  let ceremony: Exclude<Ceremony, { kind: 'step_up' }> | BoundStepUp = test ?? { kind: 'sign_in' }
  if (material.ceremonyBinding) {
    const actor = !test && (await readActor?.())
    if (!actor) throw refused()
    const binding = material.ceremonyBinding
    ceremony =
      'attemptId' in binding
        ? { kind: 'step_up', actor, binding }
        : { kind: 'link', actor, binding }
  }

  const attempt = await db.transaction().execute(async (trx) => {
    if (ceremony.kind === 'test') await lockOidcTestActor(trx, browser, ceremony.actor)
    else if (ceremony.kind === 'step_up') await lockBoundStepUp(trx, browser, ceremony)
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
    link: ceremony.kind === 'link' ? ceremony : undefined,
    stepUp: ceremony.kind === 'step_up' ? ceremony : undefined,
  }
}
