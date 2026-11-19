import { createHash, randomBytes } from 'node:crypto'
import { decryptCredential, encryptCredential } from '@hourmere/calendars'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { z } from 'zod'
import { type SsoProviderRevision, ssoProviderConfigurationAad } from './sso-configuration.ts'
import { browserBindingDigest, sha256 } from './sso-mailbox-proof.ts'
import { authenticationAttemptLifetime } from './sso-oidc-limits.ts'

const operation = 'oidcSignIn'
const maxReturnPathLength = 2048
const maxStateLength = 4096
const appOrigin = 'https://app.invalid'
const uuid = z.uuid()
const statePattern =
  /^([a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.([\w-]+)$/
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const statePayload = z.tuple([secret, secret, z.string()])
const refused = () => new Error('OIDC attempt refused')

interface AttemptDependencies {
  db: Db
  configurationKey: Buffer
}

type OriginatingBrowser = SsoProviderRevision & { browserBinding: string | undefined }

function returnDestination(raw: string): string {
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.length > maxReturnPathLength)
    throw refused()
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject characters the URL parser strips
  if (/[\u0000- \u007f-\u009f\\]/.test(raw)) throw refused()
  const url = new URL(raw, appOrigin)
  const path = url.pathname + url.search + url.hash
  if (
    url.origin !== appOrigin ||
    !(url.pathname === '/app' || url.pathname.startsWith('/app/')) ||
    /%2f|%5c/i.test(url.pathname) ||
    path.length > maxReturnPathLength
  )
    throw refused()
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

async function lockProvider(trx: Db, browser: OriginatingBrowser): Promise<void> {
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
    .select('id')
    .where('id', '=', browser.providerId)
    .where('organization_id', '=', browser.organizationId)
    .where('revision', '=', browser.revision)
    .where('protocol', '=', 'oidc')
    .where('enabled', '=', true)
    .where('retired_at', 'is', null)
    .forShare()
    .executeTakeFirst()
  if (!provider) throw refused()
}

/** Builds authorization parameters for a fresh browser-bound OIDC sign-in attempt. */
export async function startOidcAttempt(
  { db, configurationKey }: AttemptDependencies,
  browser: OriginatingBrowser & { returnPath: string },
) {
  const binding = bindingDigest(browser)
  const returnPath = returnDestination(browser.returnPath)
  const codeVerifier = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const state = await db.transaction().execute(async (trx) => {
    await lockProvider(trx, browser)
    const { id, now } = await trx
      .selectNoFrom([
        sql<string>`uuidv7()`.as('id'),
        sql<string>`clock_timestamp()::text`.as('now'),
      ])
      .executeTakeFirstOrThrow()
    // The verifier, nonce and return path travel in authenticated ciphertext. Storage keeps
    // only digests of the browser binding and the full state for the eventual one-shot update.
    const envelope = encryptCredential(
      configurationKey,
      stateAad(browser, id, binding),
      JSON.stringify([codeVerifier, nonce, returnPath]),
    ).toString('base64url')
    const state = `${id}.${envelope}`
    await trx
      .insertInto('sso_attempts')
      .values({
        id,
        kind: 'sign_in',
        organization_id: browser.organizationId,
        provider_id: browser.providerId,
        provider_revision: browser.revision,
        browser_binding_digest: binding,
        operation,
        input_digest: sha256(state),
        created_at: now,
        expires_at: sql`${now}::timestamptz + make_interval(secs => ${authenticationAttemptLifetime})`,
      })
      .execute()
    return state
  })
  return {
    state,
    nonce,
    code_challenge: createHash('sha256').update(codeVerifier, 'ascii').digest('base64url'),
    code_challenge_method: 'S256' as const,
  }
}

function openState(
  configurationKey: Buffer,
  aad: string,
  envelope: string,
): [string, string, string] {
  try {
    const plaintext = decryptCredential(configurationKey, aad, Buffer.from(envelope, 'base64url'))
    const [codeVerifier, nonce, returnPath] = statePayload.parse(JSON.parse(plaintext))
    return [codeVerifier, nonce, returnDestination(returnPath)]
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
) {
  const binding = bindingDigest(browser)
  const state = browser.state
  if (typeof state !== 'string' || state.length > maxStateLength) throw refused()
  const match = statePattern.exec(state)
  const id = match?.[1]
  const envelope = match?.[2]
  if (!id || !envelope) throw refused()
  const [codeVerifier, nonce, returnPath] = openState(
    configurationKey,
    stateAad(browser, id, binding),
    envelope,
  )

  const attempt = await db.transaction().execute(async (trx) => {
    await lockProvider(trx, browser)
    const eligible = await trx
      .selectFrom('sso_attempts')
      .select('id')
      .where('id', '=', id)
      .where('kind', '=', 'sign_in')
      .where('operation', '=', operation)
      .where('organization_id', '=', browser.organizationId)
      .where('provider_id', '=', browser.providerId)
      .where('provider_revision', '=', browser.revision)
      .where('browser_binding_digest', '=', binding)
      .where('input_digest', '=', sha256(state))
      .where('consumed_at', 'is', null)
      .forUpdate()
      .executeTakeFirst()
    if (!eligible) throw refused()
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
    codeVerifier,
    nonce,
    returnPath,
    createdAt: attempt.created_at,
    expiresAt: attempt.expires_at,
  }
}
