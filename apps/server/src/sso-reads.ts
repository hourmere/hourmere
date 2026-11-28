import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling'
import { sql } from 'kysely'
import { z } from 'zod'
import { requireSsoRetained, type SsoCapabilities, samlLinkRecoveryAvailable } from './sso.ts'
import { currentSsoProviderTestStatus } from './sso-oidc-test-receipts.ts'
import type { TeamReadPolicy } from './sso-team-reads.ts'

export interface SsoReadDeps {
  db: Db
  capabilities: SsoCapabilities
}
const denied = () => new DomainError('forbidden', 'team_management_access_denied')

/** Every adapter uses the same current membership and credential boundary. */
export async function authorizeSsoRead(deps: SsoReadDeps, principal: Principal) {
  requireSsoRetained(deps.capabilities)
  if (
    principal.organization.personal ||
    (principal.kind === 'api_key' && !['read', 'full'].includes(principal.apiKeyScope)) ||
    (principal.kind === 'oauth' && !principal.scopes.includes('mcp:tools'))
  )
    throw denied()
  const member = await deps.db
    .selectFrom('auth.member as m')
    .innerJoin('auth.user as u', 'u.id', 'm.userId')
    .leftJoin('personal_organizations as p', 'p.organization_id', 'm.organizationId')
    .select(['m.role', 'p.user_id'])
    .where('m.organizationId', '=', principal.organization.id)
    .where('m.userId', '=', principal.user.id)
    .where('u.emailVerified', '=', true)
    .executeTakeFirst()
  if (
    !member ||
    member.user_id ||
    !member.role.split(',').some((role) => ['owner', 'admin'].includes(role.trim()))
  )
    throw denied()
}

export async function getSsoPolicy(
  deps: SsoReadDeps,
  principal: Principal,
  checkedPolicy?: TeamReadPolicy | null,
) {
  await authorizeSsoRead(deps, principal)
  const policy =
    checkedPolicy === undefined
      ? await deps.db
          .selectFrom('sso_policies')
          .select(['require_sso', 'admission', 'policy_revision', 'trust_generation'])
          .where('organization_id', '=', principal.organization.id)
          .executeTakeFirst()
      : checkedPolicy
  return ssoPolicySummary(policy)
}

export function ssoPolicySummary(policy: TeamReadPolicy | null | undefined) {
  return {
    requireSso: policy?.require_sso ?? false,
    admission: policy?.admission ?? 'invitation_only',
    policyRevision: policy?.policy_revision ?? 1,
    trustGeneration: policy?.trust_generation ?? 1,
  }
}

const Cursor = z.strictObject({ organizationId: z.uuid(), id: z.uuid() })

async function listRecoveryLinks(
  db: Db,
  principal: Extract<Principal, { kind: 'session' }>,
  providerIds: string[],
) {
  // Scope the link projection and recheck the viewer's browser session and role in its snapshot.
  return db
    .selectFrom('sso_identity_links as l')
    .innerJoin('sso_providers as p', (join) =>
      join.onRef('p.id', '=', 'l.provider_id').onRef('p.organization_id', '=', 'l.organization_id'),
    )
    .select(['l.id', 'l.provider_id', 'l.generation'])
    .where('l.organization_id', '=', principal.organization.id)
    .where('l.provider_id', 'in', providerIds)
    .where('l.retired_at', 'is', null)
    .where('p.retired_at', 'is', null)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('auth.member as target')
          .select('target.id')
          .whereRef('target.organizationId', '=', 'l.organization_id')
          .whereRef('target.userId', '=', 'l.user_id'),
      ),
    )
    .where(sql<boolean>`EXISTS (
      SELECT 1 FROM auth.session s
      JOIN auth."user" u ON u.id = s."userId"
      JOIN auth.member m ON m."userId" = s."userId" AND m."organizationId" = l.organization_id
      WHERE s.id = ${principal.sessionId}::uuid AND u.id = ${principal.user.id}::uuid
        AND lower(s."activeOrganizationId") = l.organization_id::text
        AND s."expiresAt" > statement_timestamp() AND u."emailVerified"
        AND EXISTS (SELECT 1 FROM unnest(string_to_array(m.role, ',')) AS token
          WHERE btrim(token) IN ('owner', 'admin'))
    )`)
    .orderBy('l.id')
    .execute()
}

export async function listSsoProviders(
  deps: SsoReadDeps,
  principal: Principal,
  query: {
    cursor?: string | undefined
    limit?: number | undefined
    includeRecoveryLinks?: boolean
  } = {},
) {
  await authorizeSsoRead(deps, principal)
  const limit = query.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new DomainError('invalid', 'invalid_limit')
  let after: string | undefined
  if (query.cursor !== undefined) {
    try {
      if (query.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error()
      const cursor = Cursor.parse(
        JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')),
      )
      if (cursor.organizationId !== principal.organization.id) throw new Error()
      after = cursor.id
    } catch {
      throw new DomainError('invalid', 'invalid_cursor')
    }
  }
  // Deliberate column allow-list: sealed configuration is never read.
  const rows = await deps.db
    .selectFrom('sso_providers')
    .select([
      'id',
      'protocol',
      'revision',
      'enabled',
      'display_name',
      'issuer',
      'client_id',
      'created_at',
      currentSsoProviderTestStatus.as('test_status'),
    ])
    .where('organization_id', '=', principal.organization.id)
    .where('retired_at', 'is', null)
    .$if(after !== undefined, (qb) => qb.where('id', '>', after as string))
    .orderBy('id', 'asc')
    .limit(limit + 1)
    .execute()
  const page = rows.slice(0, limit)
  const recoveryProviderIds =
    query.includeRecoveryLinks && principal.kind === 'session'
      ? new Set(
          page
            .filter(
              ({ protocol }) =>
                protocol === 'oidc' ||
                (protocol === 'saml' && samlLinkRecoveryAvailable(deps.capabilities)),
            )
            .map(({ id }) => id),
        )
      : new Set<string>()
  const links =
    recoveryProviderIds.size > 0 && principal.kind === 'session'
      ? await listRecoveryLinks(deps.db, principal, [...recoveryProviderIds])
      : []
  const domains =
    page.length === 0
      ? []
      : await deps.db
          .selectFrom('sso_provider_domains as pd')
          .innerJoin('sso_domains as d', (join) =>
            join
              .onRef('d.id', '=', 'pd.domain_id')
              .onRef('d.organization_id', '=', 'pd.organization_id'),
          )
          .select([
            'pd.provider_id',
            'd.id',
            'd.name',
            'd.generation',
            'd.verified_at',
            'd.verification_expires_at',
            'd.last_check_outcome',
          ])
          .where('pd.organization_id', '=', principal.organization.id)
          .where(
            'pd.provider_id',
            'in',
            page.map((p) => p.id),
          )
          .where('d.retired_at', 'is', null)
          .orderBy('d.id')
          .execute()
  const now = Date.now()
  return {
    data: page.map((row) => ({
      id: row.id,
      protocol: row.protocol,
      revision: row.revision,
      enabled: row.enabled,
      displayName: row.display_name,
      issuer: row.issuer,
      clientId: row.client_id,
      createdAt: new Date(row.created_at).toISOString(),
      validationStatus: 'unknown',
      testStatus: row.test_status,
      domains: domains
        .filter((d) => d.provider_id === row.id)
        .map((d) => ({
          id: d.id,
          name: d.name,
          generation: d.generation,
          status: !d.verified_at
            ? d.last_check_outcome === 'unknown'
              ? 'unknown'
              : d.last_check_outcome === 'failed'
                ? 'failed'
                : 'pending'
            : !d.verification_expires_at || new Date(d.verification_expires_at).getTime() <= now
              ? 'expired'
              : d.last_check_outcome === 'positive'
                ? 'verified'
                : d.last_check_outcome === 'failed'
                  ? 'failed'
                  : 'unknown',
        })),
      ...(recoveryProviderIds.has(row.id) && {
        links: links
          .filter((link) => link.provider_id === row.id)
          .map(({ id, generation }) => ({ id, generation })),
      }),
    })),
    nextCursor:
      rows.length > limit
        ? Buffer.from(
            JSON.stringify({ organizationId: principal.organization.id, id: page.at(-1)?.id }),
          ).toString('base64url')
        : null,
  }
}
