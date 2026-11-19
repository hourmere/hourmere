import { createHash, randomBytes } from 'node:crypto'
import { checkTeamManagementMembership, TeamManagementError } from '@hourmere/auth'
import { decryptCredential, encryptCredential } from '@hourmere/calendars'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { z } from 'zod'
import { type SsoProviderRevision, ssoProviderConfigurationAad } from './sso-configuration.ts'
import { browserBindingDigest, sha256 } from './sso-mailbox-proof.ts'
import { authenticationAttemptLifetime } from './sso-oidc-limits.ts'

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
const statePayload = z.tuple([
  secret,
  secret,
  z.string(),
  z.hex().length(64).optional(),
  oidcLinkBinding.optional(),
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

const operations = {
  sign_in: signInOperation,
  test: TEST_SSO_PROVIDER,
  link: LINK_SSO_ACCOUNT,
}

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
    await lockOidcProvider(trx, browser, ceremony.kind !== 'test')
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
        kind: ceremony.kind,
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
          ${ceremony.kind === 'link' ? ceremony.binding.proofExpiresAt : null}::timestamptz
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
    const [codeVerifier, nonce, returnPath, endpointsDigest, linkBinding] = statePayload.parse(
      JSON.parse(plaintext),
    )
    const destination = oidcReturnDestination(returnPath)
    if (!destination) throw refused()
    return { codeVerifier, nonce, returnPath: destination, endpointsDigest, linkBinding }
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
  readLinkActor?: () => Promise<OidcTestActor | null | undefined>,
) {
  const binding = bindingDigest(browser)
  const state = browser.state
  if (typeof state !== 'string' || state.length > maxStateLength) throw refused()
  const match = statePattern.exec(state)
  const id = match?.[1]
  const envelope = match?.[2]
  if (!id || !envelope) throw refused()
  const material = openState(configurationKey, stateAad(browser, id, binding), envelope)
  let ceremony: Ceremony = test ?? { kind: 'sign_in' }
  if (material.linkBinding) {
    const actor = !test && (await readLinkActor?.())
    if (!actor) throw refused()
    ceremony = { kind: 'link', actor, binding: material.linkBinding }
  }

  const attempt = await db.transaction().execute(async (trx) => {
    if (ceremony.kind === 'test') await lockOidcTestActor(trx, browser, ceremony.actor)
    else await lockOidcProvider(trx, browser)
    const query = trx
      .selectFrom('sso_attempts')
      .select(['id', 'consumed_at'])
      .where('id', '=', id)
      .where('kind', '=', ceremony.kind)
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
  }
}
