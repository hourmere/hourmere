import { AUTH_SESSION_LIFETIME_SECONDS, createBrowserSession } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { auditActor, writeSsoAuditEvent } from '@hourmere/db/audit'
import { scimSuspended } from '@hourmere/db/scim-suspension'
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

export type OidcSessionRequest = OidcSessionOptions & {
  publicUrl: string
  headers: Headers
  ip?: string | undefined
  scimResourcesEnabled?: boolean | undefined
}

export const normalizeOidcMailbox = (email: string) => email.trim().toLowerCase()

export function findOidcLink(
  db: Db,
  { organizationId, providerId }: SsoProviderRevision,
  { issuer, subject }: Pick<Awaited<ReturnType<typeof verifyOidcIdToken>>, 'issuer' | 'subject'>,
) {
  return db
    .selectFrom('sso_identity_links')
    .select(['id', 'user_id', 'generation', 'proven_email', 'retired_at'])
    .where('organization_id', '=', organizationId)
    .where('provider_id', '=', providerId)
    .where('issuer', '=', issuer)
    .where('subject', '=', subject)
    .orderBy(sql`retired_at IS NULL`, 'desc')
    .limit(1)
    .executeTakeFirst()
}

export type OidcLink = NonNullable<Awaited<ReturnType<typeof findOidcLink>>>

/** Revalidate the linked account, team and trust chain under locks through session creation. */
export async function lockOidcSignInContext(
  trx: Db,
  provider: SsoProviderRevision,
  candidate: Pick<OidcLink, 'id' | 'user_id' | 'generation'>,
  mailbox: string,
  writeLink = false,
  scimResourcesEnabled = false,
  method: 'oidc' | 'saml' = 'oidc',
) {
  const domain = normalizeSsoDomain(mailbox.slice(mailbox.lastIndexOf('@') + 1))
  if (!domain) return { reason: 'domain_unverified' } as const
  const { organizationId, providerId } = provider
  // Match the user → organization → member order used by membership and account writes.
  const user = await trx
    .selectFrom('auth.user')
    .select(['id', 'email', 'emailVerified'])
    .where('id', '=', candidate.user_id)
    .forShare()
    .executeTakeFirst()
  if (!user?.emailVerified) return { reason: 'mailbox_unproven' } as const
  await lockOidcProvider(trx, provider, true, method)
  const member = await trx
    .selectFrom('auth.member')
    .select(['id', scimSuspended(organizationId, user.id, scimResourcesEnabled).as('suspended')])
    .where('organizationId', '=', organizationId)
    .where('userId', '=', user.id)
    .forShare()
    .executeTakeFirst()
  if (!member) return { reason: 'mailbox_unproven' } as const
  if (member.suspended) return { reason: 'scim_suspended' } as const
  const links = trx
    .selectFrom('sso_identity_links')
    .select(['id', 'generation', 'proven_email'])
    .where('id', '=', candidate.id)
    .where('organization_id', '=', organizationId)
    .where('provider_id', '=', providerId)
    .where('user_id', '=', candidate.user_id)
    .where('generation', '=', candidate.generation)
    .where('retired_at', 'is', null)
  const link = await (writeLink ? links.forUpdate() : links.forShare()).executeTakeFirst()
  if (!link) return { reason: 'mailbox_unproven' } as const

  const policy = await trx
    .selectFrom('sso_policies')
    .select('trust_generation')
    .where('organization_id', '=', organizationId)
    .forShare()
    .executeTakeFirst()
  const claim = await trx
    .selectFrom('sso_domains as d')
    .innerJoin('sso_provider_domains as pd', (join) =>
      join.onRef('pd.domain_id', '=', 'd.id').onRef('pd.organization_id', '=', 'd.organization_id'),
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
  return {
    user,
    member: { id: member.id },
    link,
    claim,
    trustGeneration: policy?.trust_generation ?? 1,
  }
}

type OidcSignInContext = Exclude<
  Awaited<ReturnType<typeof lockOidcSignInContext>>,
  { reason: string }
>

export async function oidcSignInTiming(
  trx: Db,
  context: OidcSignInContext,
  attemptExpiresAt: Date | string,
  sessionDeadline: Date | string | undefined,
  options: OidcSessionOptions,
) {
  const now = await databaseClock(trx)
  const expiresIn = options.expiresIn ?? AUTH_SESSION_LIFETIME_SECONDS
  const timing = await trx
    .selectNoFrom([
      sql<boolean>`${attemptExpiresAt}::timestamptz > ${now}::timestamptz`.as('attempt_live'),
      sql<boolean>`${context.claim.deadline}::timestamptz > ${now}::timestamptz`.as('domain_live'),
      sql<boolean>`coalesce(${sessionDeadline ?? null}::timestamptz > ${now}::timestamptz, true)`.as(
        'idp_live',
      ),
      sql<string>`least(
        ${now}::timestamptz + make_interval(secs => ${ssoProofLifetime}),
        ${now}::timestamptz + make_interval(secs => ${expiresIn}),
        ${context.claim.deadline}::timestamptz,
        ${sessionDeadline ?? null}::timestamptz
      )::text`.as('deadline'),
    ])
    .executeTakeFirstOrThrow()
  if (!timing.attempt_live) return { reason: 'attempt_expired' } as const
  if (!timing.domain_live) return { reason: 'domain_unverified' } as const
  if (!timing.idp_live) return { reason: 'timing_invalid' } as const
  return { now, deadline: timing.deadline }
}

export async function writeOidcSession(
  trx: Db,
  { organizationId, providerId, revision }: SsoProviderRevision,
  { user, member, link, claim, trustGeneration }: OidcSignInContext,
  attemptId: string,
  { now, deadline }: { now: string; deadline: string },
  options: OidcSessionRequest,
  method: 'oidc' | 'saml' = 'oidc',
) {
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
      trust_generation: trustGeneration,
      created_at: now,
      expires_at: deadline,
    })
    .execute()
  await writeSsoAuditEvent(trx, {
    ...auditActor({ kind: 'session', sessionId: session.id, user }),
    organizationId,
    targetType: 'sso_provider',
    targetId: providerId,
    action: 'sso_authentication.succeeded',
    details: { method, providerId, revision, correlationId: attemptId },
  })
  return { cookie: session.cookie, sessionId: session.id }
}

export function issueOidcSession(
  db: Db,
  provider: SsoProviderRevision,
  candidate: OidcLink,
  sessionDeadline: Date | undefined,
  attempt: { id: string; expiresAt: Date },
  options: OidcSessionRequest,
) {
  return db.transaction().execute(async (trx) => {
    const context = await lockOidcSignInContext(
      trx,
      provider,
      candidate,
      candidate.proven_email,
      false,
      options.scimResourcesEnabled === true,
    )
    if (context.reason !== undefined) return { reason: context.reason }
    // The current account must be verified. Its independently proven link owns the IdP mailbox.
    if (context.link.proven_email !== candidate.proven_email)
      return { reason: 'mailbox_unproven' } as const
    const timing = await oidcSignInTiming(trx, context, attempt.expiresAt, sessionDeadline, options)
    if (timing.reason !== undefined) return { reason: timing.reason }
    return writeOidcSession(trx, provider, context, attempt.id, timing, options)
  })
}
