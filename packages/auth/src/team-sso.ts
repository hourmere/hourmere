import type { Db } from '@hourmere/db'
import { scimSuspended } from '@hourmere/db/scim-suspension'
import { hasTeamWriteOrganizationLock, teamWriteCheckFor } from '@hourmere/db/team-write'
import { type Expression, sql } from 'kysely'
import { jsonObjectFrom } from 'kysely/helpers/postgres'

export interface TeamSsoCapabilities {
  readonly ssoOidcEnabled: boolean
  readonly ssoSamlEnabled: boolean
  /**
   * The in-process SCIM resource capability, carried with the protocol capabilities so
   * every proof and delegation check reads a managed child suspension. Defaults off.
   */
  readonly scimResourcesEnabled?: boolean | undefined
}

export const ssoHardOff: TeamSsoCapabilities = { ssoOidcEnabled: false, ssoSamlEnabled: false }

/** Off returns the same object, so nothing downstream changes without the test flag. */
export function withScimResources(
  capabilities: TeamSsoCapabilities,
  scimResourcesEnabled: boolean | undefined,
): TeamSsoCapabilities {
  return scimResourcesEnabled ? { ...capabilities, scimResourcesEnabled: true } : capabilities
}

export interface TeamSsoDeps {
  capabilities: TeamSsoCapabilities
  db: Db
}

export interface TeamSsoSession {
  sessionId: string
  userId: string
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
  suspended?: true
}

/** Shared by enforcement and the caller's own proof summary. */
export function liveBrowserProofQuery(
  identity: TeamSsoSession,
  organizationId: string,
  trustGeneration: number | ReturnType<typeof sql<number>>,
  { ssoOidcEnabled, ssoSamlEnabled, scimResourcesEnabled }: TeamSsoCapabilities,
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
    WHERE b.session_id = ${identity.sessionId}::uuid AND b.user_id = ${identity.userId}::uuid
      AND b.organization_id = ${organizationId}::uuid AND b.trust_generation = ${trustGeneration}
      AND NOT (${scimSuspended(organizationId, identity.userId, scimResourcesEnabled === true)})
      AND b.expires_at > statement_timestamp() AND s."expiresAt" > statement_timestamp()
      AND l.retired_at IS NULL AND p.enabled AND p.retired_at IS NULL
      AND ((${ssoOidcEnabled} AND p.protocol = 'oidc') OR (${ssoSamlEnabled} AND p.protocol = 'saml'))
      AND d.retired_at IS NULL AND d.verified_at IS NOT NULL
      AND d.verification_expires_at > statement_timestamp()
  `
}

export async function teamSsoAccess(
  { db, capabilities }: TeamSsoDeps,
  identity: TeamSsoSession | null,
  organizationId: string,
): Promise<TeamReadAccess> {
  const hasProof =
    identity && (capabilities.ssoOidcEnabled || capabilities.ssoSamlEnabled)
      ? sql<boolean>`EXISTS (${liveBrowserProofQuery(identity, organizationId, sql<number>`policy.trust_generation`, capabilities)})`
      : sql<boolean>`false`
  const policy = db
    .selectFrom('sso_policies as policy')
    .select(['require_sso', 'admission', 'policy_revision', 'trust_generation'])
    .select(sql<boolean>`CASE WHEN require_sso THEN ${hasProof} ELSE true END`.as('allowed'))
    .where('policy.organization_id', '=', organizationId)
  const access = await db
    .selectNoFrom([
      jsonObjectFrom(policy).as('policy'),
      (identity
        ? scimSuspended(organizationId, identity.userId, capabilities.scimResourcesEnabled === true)
        : sql<boolean>`false`
      ).as('suspended'),
    ])
    .executeTakeFirstOrThrow()
  if (access.suspended) return { allowed: false, policy: access.policy, suspended: true }
  return { allowed: access.policy?.allowed ?? true, policy: access.policy }
}

export function memoizeTeamSsoAccess(deps: TeamSsoDeps, identity: TeamSsoSession | null) {
  const decisions = new Map<string, Promise<TeamReadAccess>>()
  return (organizationId: string, db = deps.db) => {
    const id = organizationId.toLowerCase()
    let decision = decisions.get(id)
    if (!decision) {
      decision = teamSsoAccess({ ...deps, db }, identity, id)
      decisions.set(id, decision)
    }
    return decision
  }
}

/** Read suspension in a fresh READ COMMITTED snapshot after waiting for the team. */
export async function lockTeamSsoPolicy(
  db: Db,
  organizationId: string,
  userId: string | undefined,
  organizationLocked = false,
  admissionBlock?: Expression<boolean>,
  scimResourcesEnabled = false,
) {
  if (!organizationLocked && !hasTeamWriteOrganizationLock(db, organizationId)) {
    await db
      .selectFrom('auth.organization')
      .select('id')
      .where('id', '=', organizationId)
      .forKeyShare()
      .executeTakeFirst()
  }
  const lockedPolicy = db
    .selectFrom('sso_policies')
    .select(['require_sso', 'trust_generation'])
    .where('organization_id', '=', organizationId)
    .forShare()
  return db
    .selectNoFrom([
      jsonObjectFrom(lockedPolicy).as('policy'),
      (userId
        ? scimSuspended(organizationId, userId, scimResourcesEnabled)
        : sql<boolean>`false`
      ).as('suspended'),
    ])
    .$if(admissionBlock !== undefined, (query) =>
      query.select(sql<boolean>`${admissionBlock}`.as('admissionBlocked')),
    )
    .executeTakeFirstOrThrow()
}

/** Reuse the read predicate on the committing connection, with locks held through commit. */
export async function lockTeamSsoProof(
  { capabilities }: Pick<TeamSsoDeps, 'capabilities'>,
  db: Db,
  identity: TeamSsoSession | null,
  organizationId: string,
  denied: () => never,
  options?: {
    organizationLocked: true
    admission?: { blocked: Expression<boolean>; denied: () => never }
  },
): Promise<string | undefined> {
  const { policy, suspended, admissionBlocked } = await lockTeamSsoPolicy(
    db,
    organizationId,
    identity?.userId,
    options?.organizationLocked,
    options?.admission?.blocked,
    capabilities.scimResourcesEnabled === true,
  )
  if (suspended) denied()
  if (admissionBlocked) options?.admission?.denied()
  if (!policy?.require_sso) return
  if (!identity || !(capabilities.ssoOidcEnabled || capabilities.ssoSamlEnabled)) denied()
  // Management can remove a membership before updating the session. Follow its
  // member-before-session lock order, and lock proof after the rows it depends on.
  const { rows } = await sql<{ deadline: string | null }>`
    WITH locked AS MATERIALIZED (
      ${liveBrowserProofQuery(identity, organizationId, policy.trust_generation, capabilities)}
      FOR SHARE OF m, s, p, l, d, pd, b
    )
    SELECT max(expires_at)::text AS deadline FROM locked
    HAVING max(expires_at) > clock_timestamp()
  `.execute(db)
  const deadline = rows[0]?.deadline
  if (!deadline) denied()
  return deadline
}

/** Services already holding the team lock can join the REST caller's check for this actor. */
export function lockSharedTeamSsoProof(
  db: Db,
  capabilities: TeamSsoCapabilities,
  identity: TeamSsoSession | null,
  organizationId: string,
  denied: () => never,
) {
  const check = teamWriteCheckFor(organizationId, identity)
  return check && db.isTransaction
    ? check.lockProof(db as Parameters<typeof check.lockProof>[0])
    : lockTeamSsoProof({ capabilities }, db, identity, organizationId, denied, {
        organizationLocked: true,
      })
}
