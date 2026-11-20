import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { liveSsoDelegations } from './sso-delegation-access.ts'
import type { TeamSsoCapabilities } from './team-sso.ts'

export interface SsoDelegationSummary {
  id: string
  expiresAt: string
}

/** Account inventories show live leases, including those prepared before enforcement. */
export async function liveSsoDelegationSummaries(
  db: Db,
  capabilities: TeamSsoCapabilities,
  userId: string,
  kind: 'api_key' | 'oauth_grant',
  credentialIds: string[],
): Promise<ReadonlyMap<string, SsoDelegationSummary>> {
  if (!(capabilities.ssoOidcEnabled || capabilities.ssoSamlEnabled) || credentialIds.length === 0)
    return new Map()

  const lease = liveSsoDelegations(kind, capabilities)
  const result = await sql<{ credential_id: string; id: string; expires_at: Date }>`
    SELECT ${lease.credential} AS credential_id, lease_binding.id, ${lease.expiry} AS expires_at
    ${lease.from}
    LEFT JOIN sso_policies policy ON policy.organization_id = lease_binding.organization_id
    WHERE lease_binding.user_id = ${userId}::uuid AND ${lease.credential} = ANY(${credentialIds}::uuid[])
      AND lease_binding.trust_generation = coalesce(policy.trust_generation, 1) AND ${lease.live}
  `.execute(db)
  return new Map(
    result.rows.map((row) => [
      row.credential_id,
      { id: row.id, expiresAt: row.expires_at.toISOString() },
    ]),
  )
}
