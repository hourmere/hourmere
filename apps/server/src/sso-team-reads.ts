import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling'
import { sql } from 'kysely'
import type { SsoCapabilities } from './sso.ts'

export interface SsoTeamReadDeps {
  capabilities: SsoCapabilities
  db: Db
}

export interface TeamReadPolicy {
  require_sso: boolean
  admission: string
  policy_revision: number
  trust_generation: number
}

export interface TeamReadAccess {
  allowed: boolean
  policy: TeamReadPolicy | null
}

type Scope = Pick<Principal['organization'], 'id' | 'personal'>

/** Shared by enforcement and the caller's own proof summary. */
export function liveBrowserProofs(
  principal: Extract<Principal, { kind: 'session' }>,
  organizationId: string,
  trustGeneration: number | ReturnType<typeof sql<number>>,
  { ssoOidcEnabled, ssoSamlEnabled }: SsoCapabilities,
) {
  return sql`
    SELECT b.id, b.provider_id,
      least(b.expires_at, s."expiresAt", d.verification_expires_at) AS expires_at
    FROM sso_browser_proofs b
    JOIN auth.session s ON s.id = b.session_id AND s."userId" = b.user_id
    JOIN auth.member m ON m.id = b.member_id AND m."userId" = b.user_id
      AND m."organizationId" = b.organization_id
    JOIN sso_identity_links l ON l.id = b.link_id AND l.generation = b.link_generation
    JOIN sso_providers p ON p.id = b.provider_id AND p.organization_id = b.organization_id
    JOIN sso_domains d ON d.id = b.domain_id AND d.organization_id = b.organization_id
      AND d.generation = b.domain_generation
    JOIN sso_provider_domains pd ON pd.organization_id = b.organization_id
      AND pd.domain_id = b.domain_id AND pd.provider_id = b.provider_id
    WHERE b.session_id = ${principal.sessionId}::uuid AND b.user_id = ${principal.user.id}::uuid
      AND b.organization_id = ${organizationId}::uuid AND b.trust_generation = ${trustGeneration}
      AND b.expires_at > statement_timestamp() AND s."expiresAt" > statement_timestamp()
      AND l.retired_at IS NULL AND p.enabled AND p.retired_at IS NULL
      AND ((${ssoOidcEnabled} AND p.protocol = 'oidc') OR (${ssoSamlEnabled} AND p.protocol = 'saml'))
      AND d.retired_at IS NULL AND d.verified_at IS NOT NULL
      AND d.verification_expires_at > statement_timestamp()
  `
}

async function readAccess(
  { db, capabilities }: SsoTeamReadDeps,
  principal: Principal,
  scope: Scope,
): Promise<TeamReadAccess> {
  const hasProof =
    principal.kind === 'session' && (capabilities.ssoOidcEnabled || capabilities.ssoSamlEnabled)
      ? sql<boolean>`EXISTS (${liveBrowserProofs(principal, scope.id, sql<number>`sso_policies.trust_generation`, capabilities)})`
      : sql<boolean>`false`
  const policy = await db
    .selectFrom('sso_policies')
    .select(['require_sso', 'admission', 'policy_revision', 'trust_generation'])
    .select(sql<boolean>`CASE WHEN require_sso THEN ${hasProof} ELSE true END`.as('allowed'))
    .where('organization_id', '=', scope.id)
    .executeTakeFirst()
  return { allowed: policy?.allowed ?? true, policy: policy ?? null }
}

/** One decision per request, including when the handler also needs the policy. */
export function teamReadAccess(deps: SsoTeamReadDeps, principal: Principal) {
  let decision: Promise<TeamReadAccess> | undefined
  let organizationId: string | undefined
  return (scope: Scope = principal.organization) => {
    if (scope.personal) return Promise.resolve({ allowed: true, policy: null })
    if (organizationId !== undefined && organizationId !== scope.id)
      throw new Error('Team read enforcement received multiple target organizations')
    organizationId = scope.id
    decision ??= readAccess(deps, principal, scope)
    return decision
  }
}

export type TeamReadCheck = ReturnType<typeof teamReadAccess>

export function requireTeamRead(access: TeamReadAccess): void {
  if (!access.allowed) throw new DomainError('forbidden', 'sso_required')
}
