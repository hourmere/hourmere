import { AUTH_SESSION_LIFETIME_SECONDS, createBrowserSession } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { auditActor, writeSsoAuditEvent } from '@hourmere/db/audit'
import { sql } from 'kysely'
import type { SsoProviderRevision } from './sso-configuration.ts'
import { normalizeSsoDomain } from './sso-domains.ts'
import { databaseClock } from './sso-mailbox-proof.ts'
import { lockOidcProvider } from './sso-oidc-attempt.ts'
import { ssoProofLifetime } from './sso-oidc-limits.ts'
import type { verifyOidcIdToken } from './sso-oidc-verifier.ts'

export interface OidcSessionOptions {
  secret: string
  expiresIn?: number | undefined
}

const normalizeEmail = (email: string) => email.trim().toLowerCase()

/** Only a link's existing, independently verified member can receive a session and proof. */
export async function issueOidcSession(
  db: Db,
  provider: SsoProviderRevision,
  identity: Awaited<ReturnType<typeof verifyOidcIdToken>>,
  attempt: { id: string; expiresAt: Date },
  options: OidcSessionOptions & {
    publicUrl: string
    headers: Headers
    ip?: string | undefined
  },
) {
  const { organizationId, providerId, revision } = provider
  const matchingLink = (executor: Db) =>
    executor
      .selectFrom('sso_identity_links')
      .select(['id', 'user_id', 'generation', 'proven_email'])
      .where('organization_id', '=', organizationId)
      .where('provider_id', '=', providerId)
      .where('issuer', '=', identity.issuer)
      .where('subject', '=', identity.subject)
      .where('retired_at', 'is', null)
  const candidate = await matchingLink(db).executeTakeFirst()
  // Unlinked subjects stop here. Never resolve a local user by the asserted address.
  if (!candidate) return { reason: 'mailbox_unproven' } as const
  const { email, sessionDeadline } = identity
  if (email === undefined || normalizeEmail(email) !== candidate.proven_email)
    return { reason: 'mailbox_unproven' } as const
  const domain = normalizeSsoDomain(
    candidate.proven_email.slice(candidate.proven_email.lastIndexOf('@') + 1),
  )
  if (!domain) return { reason: 'domain_unverified' } as const

  return db.transaction().execute(async (trx) => {
    // Match the user → organization → member order used by membership and account writes.
    const user = await trx
      .selectFrom('auth.user')
      .select(['id', 'email', 'emailVerified'])
      .where('id', '=', candidate.user_id)
      .forShare()
      .executeTakeFirst()
    if (!user?.emailVerified || normalizeEmail(user.email) !== candidate.proven_email)
      return { reason: 'mailbox_unproven' } as const
    await lockOidcProvider(trx, provider)
    const member = await trx
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', organizationId)
      .where('userId', '=', user.id)
      .forShare()
      .executeTakeFirst()
    const link = await matchingLink(trx)
      .where('id', '=', candidate.id)
      .where('generation', '=', candidate.generation)
      .where('proven_email', '=', candidate.proven_email)
      .forShare()
      .executeTakeFirst()
    if (!member || !link) return { reason: 'mailbox_unproven' } as const

    const policy = await trx
      .selectFrom('sso_policies')
      .select('trust_generation')
      .where('organization_id', '=', organizationId)
      .forShare()
      .executeTakeFirst()
    const claim = await trx
      .selectFrom('sso_domains as d')
      .innerJoin('sso_provider_domains as pd', (join) =>
        join
          .onRef('pd.domain_id', '=', 'd.id')
          .onRef('pd.organization_id', '=', 'd.organization_id'),
      )
      .select(['d.id', 'd.generation', sql<string>`d.verification_expires_at::text`.as('deadline')])
      .where('pd.provider_id', '=', providerId)
      .where('d.organization_id', '=', organizationId)
      .where('d.name', '=', domain)
      .where('d.retired_at', 'is', null)
      .where('d.verified_at', 'is not', null)
      .forShare(['d', 'pd'])
      .executeTakeFirst()
    if (!claim) return { reason: 'domain_unverified' } as const
    const now = await databaseClock(trx)
    const expiresIn = options.expiresIn ?? AUTH_SESSION_LIFETIME_SECONDS
    const timing = await trx
      .selectNoFrom([
        sql<boolean>`${attempt.expiresAt}::timestamptz > ${now}::timestamptz`.as('attempt_live'),
        sql<boolean>`${claim.deadline}::timestamptz > ${now}::timestamptz`.as('domain_live'),
        sql<boolean>`coalesce(${sessionDeadline ?? null}::timestamptz > ${now}::timestamptz, true)`.as(
          'idp_live',
        ),
        sql<string>`least(
          ${now}::timestamptz + make_interval(secs => ${ssoProofLifetime}),
          ${now}::timestamptz + make_interval(secs => ${expiresIn}),
          ${claim.deadline}::timestamptz,
          ${sessionDeadline ?? null}::timestamptz
        )::text`.as('deadline'),
      ])
      .executeTakeFirstOrThrow()
    if (!timing.attempt_live) return { reason: 'attempt_expired' } as const
    if (!timing.domain_live) return { reason: 'domain_unverified' } as const
    if (!timing.idp_live) return { reason: 'timing_invalid' } as const

    const session = await createBrowserSession(trx, options, {
      ...options,
      userId: user.id,
      organizationId,
      now,
    })
    await trx
      .insertInto('sso_browser_proofs')
      .values({
        organization_id: organizationId,
        user_id: user.id,
        member_id: member.id,
        session_id: session.id,
        provider_id: providerId,
        link_id: link.id,
        link_generation: link.generation,
        domain_id: claim.id,
        domain_generation: claim.generation,
        trust_generation: policy?.trust_generation ?? 1,
        created_at: now,
        expires_at: timing.deadline,
      })
      .execute()
    await writeSsoAuditEvent(trx, {
      ...auditActor({ kind: 'session', sessionId: session.id, user }),
      organizationId,
      targetType: 'sso_provider',
      targetId: providerId,
      action: 'sso_authentication.succeeded',
      details: { method: 'oidc', providerId, revision, correlationId: attempt.id },
    })
    return { cookie: session.cookie }
  })
}
