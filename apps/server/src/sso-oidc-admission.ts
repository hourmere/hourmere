import type { SignupPolicy } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { z } from 'zod'
import type { SsoProviderRevision } from './sso-configuration.ts'
import { browserBindingDigest, databaseClock, sha256 } from './sso-mailbox-proof.ts'
import { admitOidcAccount, type OidcAdmissionDecision } from './sso-oidc-admission-write.ts'
import { lockOidcProvider, OidcAttemptRefused, oidcReturnDestination } from './sso-oidc-attempt.ts'
import {
  expiresDuringOidcWrite,
  isOidcCompletionEnvelope,
  openOidcCompletion,
  sealOidcCompletion,
} from './sso-oidc-completion.ts'
import { normalizeOidcMailbox, type OidcSessionRequest } from './sso-oidc-session.ts'

const operation = 'oidcCompleteAdmission'
const mailboxSchema = z.email().max(320)
const projectionSchema = z.strictObject({
  subject: z.string().regex(/^[\x20-\x7e]{1,255}$/),
  sessionDeadline: z.iso.datetime().optional(),
  returnPath: z.string(),
})
const invalid = { status: 'invalid' } as const

interface AdmissionDependencies {
  db: Db
  configurationKey: Buffer
}

interface AdmissionResultCookie {
  id: string
  browserBinding: string | undefined
  envelope: string | undefined
}

/** Freeze only validated identity fields. This path does not query accounts or admission policy. */
export async function stageOidcAdmission(
  { db, configurationKey }: AdmissionDependencies,
  provider: SsoProviderRevision,
  identity: { issuer: string; subject: string; email: string; sessionDeadline?: Date | undefined },
  attempt: { expiresAt: Date; returnPath: string },
  browserBinding: string | undefined,
) {
  const binding = browserBindingDigest(browserBinding)
  const mailbox = normalizeOidcMailbox(identity.email)
  if (!binding || !mailboxSchema.safeParse(mailbox).success)
    return { reason: 'mailbox_unproven' } as const

  try {
    return await db.transaction().execute(async (trx) => {
      const current = await lockOidcProvider(trx, provider)
      if (current.issuer !== identity.issuer) throw new OidcAttemptRefused()
      const expiresAt =
        identity.sessionDeadline && identity.sessionDeadline < attempt.expiresAt
          ? identity.sessionDeadline
          : attempt.expiresAt
      const now = await databaseClock(trx)
      const { id, live } = await trx
        .selectNoFrom([
          sql<string>`uuidv7()`.as('id'),
          sql<boolean>`${expiresAt}::timestamptz > ${now}::timestamptz`.as('live'),
        ])
        .executeTakeFirstOrThrow()
      if (!live) return { reason: 'attempt_expired' } as const
      const projection: z.infer<typeof projectionSchema> = {
        subject: identity.subject,
        sessionDeadline: identity.sessionDeadline?.toISOString(),
        returnPath: attempt.returnPath,
      }
      const envelope = sealOidcCompletion(configurationKey, provider, id, binding, projection)
      if (!isOidcCompletionEnvelope(envelope)) return { reason: 'response_malformed' } as const
      await trx
        .insertInto('sso_attempts')
        .values({
          id,
          kind: 'sign_in',
          organization_id: provider.organizationId,
          provider_id: provider.providerId,
          provider_revision: provider.revision,
          browser_binding_digest: binding,
          operation,
          input_digest: sha256(envelope),
          requires_mailbox: true,
          mailbox,
          created_at: now,
          expires_at: expiresAt,
        })
        .execute()
      return { id, envelope, expiresAt }
    })
  } catch (error) {
    if (expiresDuringOidcWrite(error)) return { reason: 'attempt_expired' } as const
    throw error
  }
}

/** Both ways to admit a new user spend the same browser-bound proof under the team lock. */
export async function completeOidcAdmission(
  { db, configurationKey, signup }: AdmissionDependencies & { signup: SignupPolicy },
  { id, browserBinding, envelope }: AdmissionResultCookie,
  options: OidcSessionRequest,
  decision: OidcAdmissionDecision,
) {
  const binding = browserBindingDigest(browserBinding)
  if (!binding || !isOidcCompletionEnvelope(envelope)) return invalid
  const digest = sha256(envelope)
  const attempts = (executor: Db) =>
    executor
      .selectFrom('sso_attempts as a')
      .where('a.id', '=', id)
      .where('a.kind', '=', 'sign_in')
      .where('a.operation', '=', operation)
      .where('a.browser_binding_digest', '=', binding)
      .where('a.input_digest', '=', digest)
      .where('a.consumed_at', 'is', null)
      .where('a.expires_at', '>', sql<Date>`clock_timestamp()`)
      .where('a.requires_mailbox', '=', true)
      .where('a.mailbox_proof_expires_at', '>', sql<Date>`clock_timestamp()`)
  const pending = await attempts(db)
    .innerJoin('sso_providers as p', (join) =>
      join
        .onRef('p.id', '=', 'a.provider_id')
        .onRef('p.organization_id', '=', 'a.organization_id')
        .onRef('p.revision', '=', 'a.provider_revision'),
    )
    .select(['a.organization_id', 'a.mailbox', 'a.expires_at', 'p.id', 'p.issuer', 'p.revision'])
    .where('p.protocol', '=', 'oidc')
    .where('p.enabled', '=', true)
    .where('p.retired_at', 'is', null)
    .executeTakeFirst()
  if (!pending?.mailbox) return invalid
  const provider = {
    organizationId: pending.organization_id,
    providerId: pending.id,
    revision: pending.revision,
  }

  let projection: z.infer<typeof projectionSchema>
  try {
    projection = projectionSchema.parse(
      openOidcCompletion(configurationKey, provider, id, binding, envelope),
    )
  } catch {
    return invalid
  }
  const returnPath = oidcReturnDestination(projection.returnPath)
  if (!returnPath) return invalid

  const result = await admitOidcAccount(
    db,
    {
      id,
      provider,
      issuer: pending.issuer,
      subject: projection.subject,
      mailbox: pending.mailbox,
      deadline: projection.sessionDeadline ? new Date(projection.sessionDeadline) : undefined,
      expiresAt: pending.expires_at,
    },
    signup,
    options,
    decision,
    async (trx) => {
      const attempt = await attempts(trx).select('a.id').forUpdate().executeTakeFirst()
      if (!attempt) return undefined
      return trx
        .updateTable('sso_attempts')
        .set({ consumed_at: sql`clock_timestamp()` })
        .where('id', '=', id)
        .where('expires_at', '>', sql<Date>`clock_timestamp()`)
        .where('mailbox_proof_expires_at', '>', sql<Date>`clock_timestamp()`)
        .returning(sql<string>`mailbox_proven_at::text`.as('provenAt'))
        .executeTakeFirst()
    },
  )
  return result.status === 'completed' ? { ...result, returnPath } : result
}
