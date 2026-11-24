import { decryptCredential, encryptCredential } from '@hourmere/calendars'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { z } from 'zod'
import { type SsoProviderRevision, ssoProviderConfigurationAad } from './sso-configuration.ts'
import { browserBindingDigest, databaseClock, sha256 } from './sso-mailbox-proof.ts'
import { OidcAttemptRefused, oidcReturnDestination } from './sso-oidc-attempt.ts'
import {
  lockOidcSignInContext,
  normalizeOidcMailbox,
  type OidcLink,
  type OidcSessionRequest,
  oidcSignInTiming,
  writeOidcSession,
} from './sso-oidc-session.ts'
import { samlMailboxOperation } from './sso-saml-state.ts'

const operation = 'oidcCompleteSignIn'
const mailboxSchema = z.email().max(320)
const projectionSchema = z.strictObject({
  linkId: z.uuid(),
  linkGeneration: z.int().positive(),
  userId: z.uuid(),
  memberId: z.uuid(),
  mailboxSnapshot: z.hex().length(64),
  domainId: z.uuid(),
  domainGeneration: z.int().positive(),
  trustGeneration: z.int().positive(),
  sessionDeadline: z.iso.datetime().optional(),
  returnPath: z.string().optional(),
  requestId: z.uuidv7().optional(),
})

interface CompletionDependencies {
  db: Db
  configurationKey: Buffer
}

function projectionAad(provider: SsoProviderRevision, id: string, binding: string) {
  return JSON.stringify([
    'hourmere-oidc-completion-v1',
    ssoProviderConfigurationAad(provider),
    id,
    binding,
  ])
}

export function sealOidcCompletion(
  key: Buffer,
  provider: SsoProviderRevision,
  id: string,
  binding: string,
  result: object,
) {
  return encryptCredential(
    key,
    projectionAad(provider, id, binding),
    JSON.stringify(result),
  ).toString('base64url')
}

export function openOidcCompletion(
  key: Buffer,
  provider: SsoProviderRevision,
  id: string,
  binding: string,
  envelope: string,
): unknown {
  return JSON.parse(
    decryptCredential(
      key,
      projectionAad(provider, id, binding),
      Buffer.from(envelope, 'base64url'),
    ),
  )
}

export function isOidcCompletionEnvelope(envelope: string | undefined): envelope is string {
  return !!envelope && envelope.length <= 3800 && /^[A-Za-z0-9_-]+$/.test(envelope)
}

const mailboxSnapshot = (accountMailbox: string, linkMailbox: string, assertedMailbox: string) =>
  sha256(JSON.stringify([normalizeOidcMailbox(accountMailbox), linkMailbox, assertedMailbox]))

export function expiresDuringOidcWrite(error: unknown): boolean {
  return (
    error instanceof Error &&
    'constraint' in error &&
    (error.constraint === 'sso_attempts_starts_open' ||
      error.constraint === 'sso_attempts_unexpired' ||
      error.constraint === 'sso_attempts_proven' ||
      error.constraint === 'sso_reliance_live')
  )
}

/** Transfer a consumed callback to its own immutable, mailbox-bound completion attempt. */
export async function stageOidcCompletion(
  { db, configurationKey }: CompletionDependencies,
  provider: SsoProviderRevision,
  candidate: OidcLink,
  assertedMailbox: string,
  sessionDeadline: Date | undefined,
  attempt: { expiresAt: Date; returnPath: string },
  browserBinding: string | undefined,
) {
  const binding = browserBindingDigest(browserBinding)
  return stageSsoMailboxCompletion(
    { db, configurationKey },
    provider,
    candidate,
    assertedMailbox,
    sessionDeadline,
    attempt,
    binding,
  )
}

export async function stageSsoMailboxCompletion(
  { db, configurationKey }: CompletionDependencies,
  provider: SsoProviderRevision,
  candidate: OidcLink,
  assertedMailbox: string,
  sessionDeadline: Date | undefined,
  attempt: { expiresAt: Date; returnPath: string } | { expiresAt: Date; requestId: string },
  binding: string | null,
) {
  if (!binding || !mailboxSchema.safeParse(assertedMailbox).success)
    return { reason: 'mailbox_unproven' } as const
  const method = 'requestId' in attempt ? 'saml' : 'oidc'

  try {
    const stage = async (trx: Db) => {
      const context = await lockOidcSignInContext(
        trx,
        provider,
        candidate,
        assertedMailbox,
        false,
        method,
      )
      if (context.reason !== undefined) return { reason: context.reason }
      if (context.link.proven_email !== candidate.proven_email)
        return { reason: 'mailbox_unproven' } as const

      const now = await databaseClock(trx)
      const expiresAt =
        sessionDeadline && sessionDeadline < attempt.expiresAt ? sessionDeadline : attempt.expiresAt
      const timing = await trx
        .selectNoFrom([
          sql<boolean>`${expiresAt}::timestamptz > ${now}::timestamptz`.as('live'),
          sql<boolean>`${context.claim.deadline}::timestamptz > ${now}::timestamptz`.as(
            'domain_live',
          ),
        ])
        .executeTakeFirstOrThrow()
      if (!timing.live) return { reason: 'attempt_expired' } as const
      if (!timing.domain_live) return { reason: 'domain_unverified' } as const

      const { id } = await trx
        .selectNoFrom(sql<string>`uuidv7()`.as('id'))
        .executeTakeFirstOrThrow()
      const projection: z.infer<typeof projectionSchema> = {
        linkId: candidate.id,
        linkGeneration: candidate.generation,
        userId: candidate.user_id,
        memberId: context.member.id,
        mailboxSnapshot: mailboxSnapshot(
          context.user.email,
          candidate.proven_email,
          assertedMailbox,
        ),
        domainId: context.claim.id,
        domainGeneration: context.claim.generation,
        trustGeneration: context.trustGeneration,
        sessionDeadline: sessionDeadline?.toISOString(),
        ...('requestId' in attempt
          ? { requestId: attempt.requestId }
          : { returnPath: attempt.returnPath }),
      }
      // The pending row freezes a digest of this encrypted projection. The browser carries
      // the ciphertext so the existing attempt storage needs no claim or token columns.
      const envelope = sealOidcCompletion(configurationKey, provider, id, binding, projection)
      await trx
        .insertInto('sso_attempts')
        .values({
          id,
          kind: 'sign_in',
          organization_id: provider.organizationId,
          provider_id: provider.providerId,
          provider_revision: provider.revision,
          browser_binding_digest: binding,
          operation: method === 'saml' ? samlMailboxOperation : operation,
          input_digest: sha256(envelope),
          requires_mailbox: true,
          mailbox: assertedMailbox,
          created_at: now,
          expires_at: expiresAt,
        })
        .execute()
      return { id, envelope, expiresAt }
    }
    return await (db.isTransaction ? stage(db) : db.transaction().execute(stage))
  } catch (error) {
    if (db.isTransaction) throw error
    if (expiresDuringOidcWrite(error)) return { reason: 'attempt_expired' } as const
    throw error
  }
}

const invalid = { status: 'invalid' } as const
const collision = { status: 'collision' } as const

/** Complete from locked local state. This code has no provider transport. */
export async function completeOidcSignIn(
  { db, configurationKey }: CompletionDependencies,
  {
    id,
    browserBinding,
    envelope,
  }: {
    id: string
    browserBinding: string | undefined
    envelope: string | undefined
  },
  options: OidcSessionRequest,
  readSamlReturn?: (requestId: string) => string | undefined,
) {
  const method = readSamlReturn ? 'saml' : 'oidc'
  const binding = browserBindingDigest(browserBinding)
  if (!binding || !isOidcCompletionEnvelope(envelope)) return invalid

  const attempts = (executor: Db) =>
    executor
      .selectFrom('sso_attempts')
      .where('id', '=', id)
      .where('kind', '=', 'sign_in')
      .where('operation', '=', readSamlReturn ? samlMailboxOperation : operation)
      .where('browser_binding_digest', '=', binding)
      .where('input_digest', '=', sha256(envelope))
      .where('consumed_at', 'is', null)
      .where('requires_mailbox', '=', true)
  const pending = await attempts(db)
    .select(['organization_id', 'provider_id', 'provider_revision', 'mailbox'])
    .executeTakeFirst()
  if (!pending?.provider_id || pending.provider_revision === null || !pending.mailbox)
    return invalid
  const mailbox = pending.mailbox
  const provider = {
    organizationId: pending.organization_id,
    providerId: pending.provider_id,
    revision: pending.provider_revision,
  }

  let result: z.infer<typeof projectionSchema>
  try {
    result = projectionSchema.parse(
      openOidcCompletion(configurationKey, provider, id, binding, envelope),
    )
  } catch {
    return invalid
  }
  const storedReturn = readSamlReturn
    ? result.requestId && readSamlReturn(result.requestId)
    : result.returnPath
  const returnPath = storedReturn && oidcReturnDestination(storedReturn)
  if (!returnPath || (readSamlReturn && !returnPath.startsWith('/app'))) return invalid

  try {
    return await db.transaction().execute(async (trx) => {
      // Follow the session lock order, then lock the pending attempt. Mailbox proof
      // takes only the attempt/token locks and does not wait on the linked account.
      const context = await lockOidcSignInContext(
        trx,
        provider,
        { id: result.linkId, user_id: result.userId, generation: result.linkGeneration },
        mailbox,
        true,
        method,
      )
      if (
        context.reason !== undefined ||
        context.member.id !== result.memberId ||
        context.claim.id !== result.domainId ||
        context.claim.generation !== result.domainGeneration ||
        context.trustGeneration !== result.trustGeneration ||
        mailboxSnapshot(context.user.email, context.link.proven_email, mailbox) !==
          result.mailboxSnapshot
      )
        return invalid

      const attempt = await attempts(trx)
        .select(['expires_at'])
        .where('mailbox_proof_expires_at', '>', sql<Date>`clock_timestamp()`)
        .forUpdate()
        .executeTakeFirst()
      if (!attempt) return invalid

      const timing = await oidcSignInTiming(
        trx,
        context,
        attempt.expires_at,
        result.sessionDeadline ? new Date(result.sessionDeadline) : undefined,
        options,
      )
      if (timing.reason !== undefined) return invalid

      // Spend this attempt before resolving the new address. A collision is disclosed
      // only to the bound browser with current proof, and its pending mailbox is erased.
      const proof = await trx
        .updateTable('sso_attempts')
        .set({ consumed_at: timing.now })
        .where('id', '=', id)
        .returning(sql<string>`mailbox_proven_at::text`.as('proven_at'))
        .executeTakeFirstOrThrow()
      const otherAccount = await trx
        .selectFrom('auth.user')
        .select('id')
        .where('id', '!=', context.user.id)
        .where(sql<string>`lower(btrim(email))`, '=', mailbox)
        .executeTakeFirst()
      if (otherAccount) {
        await trx.deleteFrom('sso_attempts').where('id', '=', id).execute()
        return collision
      }

      const link = await trx
        .updateTable('sso_identity_links')
        .set({
          proven_email: mailbox,
          email_proven_at: proof.proven_at,
          generation: context.link.generation + 1,
        })
        .where('id', '=', context.link.id)
        .returning(['id', 'generation', 'proven_email'])
        .executeTakeFirstOrThrow()
      const session = await writeOidcSession(
        trx,
        provider,
        { ...context, link },
        id,
        timing,
        options,
        method,
      )
      if (readSamlReturn) {
        const { live } = await trx
          .selectNoFrom(
            sql<boolean>`${attempt.expires_at}::timestamptz > clock_timestamp()`.as('live'),
          )
          .executeTakeFirstOrThrow()
        if (!live) throw new OidcAttemptRefused()
      }
      return {
        status: 'completed',
        returnPath,
        cookie: session.cookie,
        requestId: result.requestId,
      } as const
    })
  } catch (error) {
    if (error instanceof OidcAttemptRefused || expiresDuringOidcWrite(error)) return invalid
    throw error
  }
}
