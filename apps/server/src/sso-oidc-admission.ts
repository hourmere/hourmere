import type { ScimClaimCompletion, SignupPolicy } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import type { Context } from 'hono'
import { sql } from 'kysely'
import { z } from 'zod'
import type { SsoProviderRevision } from './sso-configuration.ts'
import { browserBindingDigest, databaseClock, sha256 } from './sso-mailbox-proof.ts'
import { admitSsoAccount, type SsoAdmissionDecision } from './sso-oidc-admission-write.ts'
import { lockOidcProvider, OidcAttemptRefused, oidcReturnDestination } from './sso-oidc-attempt.ts'
import {
  expiresDuringOidcWrite,
  isOidcCompletionEnvelope,
  openOidcCompletion,
  sealOidcCompletion,
} from './sso-oidc-completion.ts'
import { normalizeOidcMailbox, type OidcSessionRequest } from './sso-oidc-session.ts'
import { samlAdmissionOperation, samlId } from './sso-saml-state.ts'

const admissionOperation = (method: 'oidc' | 'saml') =>
  method === 'saml' ? samlAdmissionOperation : 'oidcCompleteAdmission'
const mailboxSchema = z.email().max(320)
const oidcProjection = z.strictObject({
  subject: z.string().regex(/^[\x20-\x7e]{1,255}$/),
  sessionDeadline: z.iso.datetime().optional(),
  returnPath: z.string(),
})
const samlProjection = z.strictObject({
  subject: z.string().refine((value) => !!value.trim() && Buffer.byteLength(value) <= 1024),
  sessionDeadline: z.iso.datetime().optional(),
  requestId: samlId,
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

export function ssoAdmissionCookie(publicUrl: string, method: 'oidc' | 'saml', id: string) {
  const secure = new URL(publicUrl).protocol === 'https:'
  return {
    name: `${secure ? '__Secure-' : ''}hourmere.${method}_admission.${id}`,
    options: { httpOnly: true, secure, sameSite: 'Strict', path: '/api/auth' } as const,
  }
}

/** Freeze only validated identity fields. This path does not query accounts or admission policy. */
export async function stageSsoAdmission(
  { db, configurationKey }: AdmissionDependencies,
  provider: SsoProviderRevision,
  identity: {
    issuer: string
    subject: string
    email: string
    sessionDeadline?: string | undefined
  },
  attempt: { expiresAt: Date | string } & ({ returnPath: string } | { requestId: string }),
  binding: string | null,
) {
  const mailbox = normalizeOidcMailbox(identity.email)
  if (!binding || !mailboxSchema.safeParse(mailbox).success)
    return { reason: 'mailbox_unproven' } as const
  const method = 'requestId' in attempt ? 'saml' : 'oidc'

  try {
    const stage = async (trx: Db) => {
      const current = await lockOidcProvider(trx, provider, true, method)
      if (current.issuer !== identity.issuer) throw new OidcAttemptRefused()
      const now = await databaseClock(trx)
      const deadline = sql`least(${attempt.expiresAt}::timestamptz, ${identity.sessionDeadline ?? null}::timestamptz)`
      const { id, live, expiresAt } = await trx
        .selectNoFrom([
          sql<string>`uuidv7()`.as('id'),
          sql<boolean>`${deadline} > ${now}::timestamptz`.as('live'),
          sql<string>`${deadline}::text`.as('expiresAt'),
        ])
        .executeTakeFirstOrThrow()
      if (!live) return { reason: 'attempt_expired' } as const
      const projection = {
        subject: identity.subject,
        sessionDeadline: identity.sessionDeadline,
        ...('requestId' in attempt
          ? { requestId: attempt.requestId }
          : { returnPath: attempt.returnPath }),
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
          operation: admissionOperation(method),
          input_digest: sha256(envelope),
          requires_mailbox: true,
          mailbox,
          created_at: now,
          expires_at: expiresAt,
        })
        .execute()
      return { id, envelope, expiresAt }
    }
    return await (db.isTransaction ? stage(db) : db.transaction().execute(stage))
  } catch (error) {
    if (!db.isTransaction && expiresDuringOidcWrite(error))
      return { reason: 'attempt_expired' } as const
    throw error
  }
}

/** Both ways to admit a new user spend the same browser-bound proof under the team lock. */
export async function completeSsoAdmission(
  {
    db,
    configurationKey,
    signup,
    scimClaims,
  }: AdmissionDependencies & { signup: SignupPolicy; scimClaims?: ScimClaimCompletion | undefined },
  { id, browserBinding, envelope }: AdmissionResultCookie,
  options: OidcSessionRequest,
  decision: SsoAdmissionDecision,
  method: 'oidc' | 'saml' = 'oidc',
  readSamlReturn?: (requestId: string) => string | undefined,
) {
  const binding = browserBindingDigest(browserBinding)
  if (!binding || !isOidcCompletionEnvelope(envelope)) return invalid
  const digest = sha256(envelope)
  const attempts = (executor: Db) =>
    executor
      .selectFrom('sso_attempts as a')
      .where('a.id', '=', id)
      .where('a.kind', '=', 'sign_in')
      .where('a.operation', '=', admissionOperation(method))
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
    .select([
      'a.organization_id',
      'a.mailbox',
      sql<string>`a.expires_at::text`.as('expiresAt'),
      'p.id',
      'p.issuer',
      'p.revision',
    ])
    .where('p.protocol', '=', method)
    .where('p.enabled', '=', true)
    .where('p.retired_at', 'is', null)
    .executeTakeFirst()
  if (!pending?.mailbox) return invalid
  const provider = {
    organizationId: pending.organization_id,
    providerId: pending.id,
    revision: pending.revision,
  }

  let projection: z.infer<typeof oidcProjection> | z.infer<typeof samlProjection>
  try {
    projection = (method === 'saml' ? samlProjection : oidcProjection).parse(
      openOidcCompletion(configurationKey, provider, id, binding, envelope),
    )
  } catch {
    return invalid
  }
  const requestId = 'requestId' in projection ? projection.requestId : undefined
  const storedReturn =
    'returnPath' in projection
      ? projection.returnPath
      : decision.kind === 'invitation'
        ? '/app'
        : readSamlReturn?.(projection.requestId)
  const returnPath = storedReturn && oidcReturnDestination(storedReturn)
  if (!returnPath || (method === 'saml' && !returnPath.startsWith('/app'))) return invalid

  const result = await admitSsoAccount(
    db,
    {
      id,
      provider,
      issuer: pending.issuer,
      subject: projection.subject,
      mailbox: pending.mailbox,
      deadline: projection.sessionDeadline,
      expiresAt: pending.expiresAt,
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
    scimClaims,
    method,
  )
  if (result.status === 'completed') return { ...result, returnPath, requestId }
  if (result.status === 'link_required') return { ...result, requestId }
  return result
}

export function ssoAdmissionRefused(
  c: Context,
  status: Exclude<
    Awaited<ReturnType<typeof completeSsoAdmission>>['status'],
    'completed' | 'link_required'
  >,
  method: 'oidc' | 'saml',
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
    case 'invitation_invalid':
      return c.json({ error: 'team_management_access_denied' }, 403)
    case 'subject_conflict':
    case 'invalid':
      return c.json({ error: `sso_${method}_completion_invalid` }, 400)
  }
}
