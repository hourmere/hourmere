import type { Db } from '@hourmere/db'
import { scimSuspended } from '@hourmere/db/scim-suspension'
import { type Expression, sql } from 'kysely'
import { MCP_OAUTH_CONSENT_LIFETIME_MS, MCP_OAUTH_SCOPE } from './mcp-oauth.ts'
import type { TeamSsoCapabilities } from './team-sso.ts'

type CredentialKind = 'api_key' | 'oauth_grant'
export type SsoDelegationStatus = 'unenforced' | 'required' | 'valid' | null

/** One reliance predicate for inventory, machine authorization and write-time checks. */
export function liveSsoDelegations(
  kind: CredentialKind,
  { ssoOidcEnabled, ssoSamlEnabled }: TeamSsoCapabilities,
) {
  const isKey = kind === 'api_key'
  const credential = isKey ? sql`lease_binding.api_key_id` : sql`lease_binding.oauth_grant_id`
  const credentialJoin = isKey
    ? sql`
      JOIN auth.apikey lease_key ON lease_key.id = lease_binding.api_key_id AND lease_key."referenceId" = lease_binding.user_id::text
        AND lease_key.enabled IS DISTINCT FROM false
        AND CASE WHEN lease_key.metadata IS JSON OBJECT THEN
          lower(lease_key.metadata::jsonb ->> 'organizationId') = lease_binding.organization_id::text
          AND lease_key.metadata::jsonb ->> 'scope' IN ('bookings', 'read', 'full')
        END
    `
    : sql`
      JOIN mcp_oauth_grants lease_grant ON lease_grant.id = lease_binding.oauth_grant_id
        AND lease_grant.user_id = lease_binding.user_id AND lease_grant.organization_id = lease_binding.organization_id
      JOIN auth."oauthConsent" lease_consent ON lease_consent."referenceId" = lease_grant.id::text
        AND lease_consent."userId" = lease_grant.user_id AND lease_consent."clientId" = lease_grant.client_id
        AND lease_consent.scopes @> jsonb_build_array(${MCP_OAUTH_SCOPE}::text)
      JOIN auth."oauthClient" lease_client ON lease_client."clientId" = lease_grant.client_id AND lease_client.disabled IS DISTINCT FROM true
    `
  const credentialDeadline = isKey
    ? sql`lease_key."expiresAt"`
    : sql`lease_consent."createdAt" + ${MCP_OAUTH_CONSENT_LIFETIME_MS}::double precision * interval '1 millisecond'`
  const expiry = sql`least(lease_binding.expires_at, ${credentialDeadline})`
  return {
    credential,
    expiry,
    deadline: sql`least(${expiry}, lease_domain.verification_expires_at)`,
    locks: isKey
      ? sql`lease_key, lease_member, lease_provider, lease_link, lease_domain, lease_provider_domain, lease_binding`
      : sql`lease_consent, lease_grant, lease_client, lease_member, lease_provider, lease_link, lease_domain, lease_provider_domain, lease_binding`,
    from: sql`
      FROM sso_delegation_bindings lease_binding
      ${credentialJoin}
      JOIN auth.member lease_member ON lease_member.id = lease_binding.member_id AND lease_member."userId" = lease_binding.user_id
        AND lease_member."organizationId" = lease_binding.organization_id
      JOIN sso_identity_links lease_link ON lease_link.id = lease_binding.link_id AND lease_link.generation = lease_binding.link_generation
      JOIN sso_providers lease_provider ON lease_provider.id = lease_binding.provider_id AND lease_provider.organization_id = lease_binding.organization_id
      JOIN sso_domains lease_domain ON lease_domain.id = lease_binding.domain_id AND lease_domain.organization_id = lease_binding.organization_id
        AND lease_domain.generation = lease_binding.domain_generation
      JOIN sso_provider_domains lease_provider_domain ON lease_provider_domain.organization_id = lease_binding.organization_id
        AND lease_provider_domain.domain_id = lease_binding.domain_id AND lease_provider_domain.provider_id = lease_binding.provider_id
    `,
    live: sql`
      ${expiry} > statement_timestamp()
      AND NOT (${scimSuspended(sql.ref('lease_binding.organization_id'), sql.ref('lease_binding.user_id'))})
      AND lease_link.retired_at IS NULL AND lease_provider.enabled AND lease_provider.retired_at IS NULL
      AND ((${ssoOidcEnabled} AND lease_provider.protocol = 'oidc') OR (${ssoSamlEnabled} AND lease_provider.protocol = 'saml'))
      AND lease_domain.retired_at IS NULL AND lease_domain.verified_at IS NOT NULL
      AND lease_domain.verification_expires_at > statement_timestamp()
    `,
  }
}

function forCredential(
  kind: CredentialKind,
  capabilities: TeamSsoCapabilities,
  organizationId: string | Expression<string>,
  userId: string | Expression<string>,
  credentialId: string | Expression<string>,
  trustGeneration: number | Expression<number>,
) {
  const lease = liveSsoDelegations(kind, capabilities)
  return {
    ...lease,
    matching: sql`
      ${lease.from}
      WHERE lease_binding.organization_id = ${organizationId}::uuid
        AND lease_binding.user_id = ${userId}::uuid AND ${lease.credential} = ${credentialId}::uuid
        AND lease_binding.trust_generation = ${trustGeneration} AND ${lease.live}
    `,
  }
}

/** Project in an existing credential query. NULL means the team has no stored policy. */
export function ssoDelegationStatus(
  organizationId: Expression<string>,
  userId: Expression<string>,
  kind: CredentialKind,
  credentialId: Expression<string>,
  capabilities: TeamSsoCapabilities,
) {
  const hasDelegation =
    capabilities.ssoOidcEnabled || capabilities.ssoSamlEnabled
      ? sql`EXISTS (SELECT 1 ${
          forCredential(
            kind,
            capabilities,
            organizationId,
            userId,
            credentialId,
            sql<number>`policy.trust_generation`,
          ).matching
        })`
      : sql`false`
  return sql<SsoDelegationStatus>`(
    SELECT CASE WHEN NOT policy.require_sso THEN 'unenforced'
      WHEN ${hasDelegation} THEN 'valid' ELSE 'required' END
    FROM sso_policies policy
    WHERE policy.organization_id = ${organizationId}::uuid
  )`
}

/** Lock reliance on the committing connection, then check the clock after any lock wait. */
export async function lockSsoDelegation(
  db: Db,
  capabilities: TeamSsoCapabilities,
  {
    organizationId,
    userId,
    kind,
    credentialId,
  }: { organizationId: string; userId: string; kind: CredentialKind; credentialId: string },
  denied: () => never,
): Promise<string | undefined> {
  const policy = await db
    .selectFrom('sso_policies')
    .select(['require_sso', 'trust_generation'])
    .where('organization_id', '=', organizationId)
    .forShare()
    .executeTakeFirst()
  if (!policy?.require_sso) return
  if (!(capabilities.ssoOidcEnabled || capabilities.ssoSamlEnabled)) denied()
  const lease = forCredential(
    kind,
    capabilities,
    organizationId,
    userId,
    credentialId,
    policy.trust_generation,
  )
  const { rows } = await sql<{ deadline: string }>`
    WITH locked AS MATERIALIZED (
      SELECT ${lease.deadline} AS deadline ${lease.matching} FOR SHARE OF ${lease.locks}
    )
    SELECT deadline::text FROM locked WHERE deadline > clock_timestamp()
  `.execute(db)
  const deadline = rows[0]?.deadline
  if (!deadline) denied()
  return deadline
}
