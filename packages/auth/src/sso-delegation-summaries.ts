import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { MCP_OAUTH_CONSENT_LIFETIME_MS, MCP_OAUTH_SCOPE } from './mcp-oauth.ts'
import type { TeamSsoCapabilities } from './team-sso.ts'

export interface SsoDelegationSummary {
  id: string
  expiresAt: string
}

/** Account inventories show live leases, including those prepared before enforcement. */
export async function liveSsoDelegationSummaries(
  db: Db,
  { ssoOidcEnabled, ssoSamlEnabled }: TeamSsoCapabilities,
  userId: string,
  kind: 'api_key' | 'oauth_grant',
  credentialIds: string[],
): Promise<ReadonlyMap<string, SsoDelegationSummary>> {
  if (!(ssoOidcEnabled || ssoSamlEnabled) || credentialIds.length === 0) return new Map()

  const isKey = kind === 'api_key'
  const credential = isKey ? sql`b.api_key_id` : sql`b.oauth_grant_id`
  const credentialJoin = isKey
    ? sql`
      JOIN auth.apikey k ON k.id = b.api_key_id AND k."referenceId" = b.user_id::text
        AND k.enabled IS DISTINCT FROM false
        AND CASE WHEN k.metadata IS JSON OBJECT THEN
          lower(k.metadata::jsonb ->> 'organizationId') = b.organization_id::text
          AND k.metadata::jsonb ->> 'scope' IN ('bookings', 'read', 'full')
        END
    `
    : sql`
      JOIN mcp_oauth_grants g ON g.id = b.oauth_grant_id
        AND g.user_id = b.user_id AND g.organization_id = b.organization_id
      JOIN auth."oauthConsent" c ON c."referenceId" = g.id::text
        AND c."userId" = g.user_id AND c."clientId" = g.client_id
        AND c.scopes @> jsonb_build_array(${MCP_OAUTH_SCOPE}::text)
      JOIN auth."oauthClient" a ON a."clientId" = g.client_id AND a.disabled IS DISTINCT FROM true
    `
  const credentialDeadline = isKey
    ? sql`k."expiresAt"`
    : sql`c."createdAt" + ${MCP_OAUTH_CONSENT_LIFETIME_MS}::double precision * interval '1 millisecond'`
  const deadline = sql`least(b.expires_at, ${credentialDeadline})`
  const result = await sql<{ credential_id: string; id: string; expires_at: Date }>`
    SELECT ${credential} AS credential_id, b.id, ${deadline} AS expires_at
    FROM sso_delegation_bindings b
    ${credentialJoin}
    JOIN auth.member m ON m.id = b.member_id AND m."userId" = b.user_id
      AND m."organizationId" = b.organization_id
    JOIN sso_identity_links l ON l.id = b.link_id AND l.generation = b.link_generation
    JOIN sso_providers p ON p.id = b.provider_id AND p.organization_id = b.organization_id
    JOIN sso_domains d ON d.id = b.domain_id AND d.organization_id = b.organization_id
      AND d.generation = b.domain_generation
    JOIN sso_provider_domains pd ON pd.organization_id = b.organization_id
      AND pd.domain_id = b.domain_id AND pd.provider_id = b.provider_id
    LEFT JOIN sso_policies policy ON policy.organization_id = b.organization_id
    WHERE b.user_id = ${userId}::uuid AND ${credential} = ANY(${credentialIds}::uuid[])
      AND b.trust_generation = coalesce(policy.trust_generation, 1)
      AND ${deadline} > statement_timestamp()
      AND l.retired_at IS NULL AND p.enabled AND p.retired_at IS NULL
      AND ((${ssoOidcEnabled} AND p.protocol = 'oidc') OR (${ssoSamlEnabled} AND p.protocol = 'saml'))
      AND d.retired_at IS NULL AND d.verified_at IS NOT NULL
      AND d.verification_expires_at > statement_timestamp()
  `.execute(db)
  return new Map(
    result.rows.map((row) => [
      row.credential_id,
      { id: row.id, expiresAt: row.expires_at.toISOString() },
    ]),
  )
}
