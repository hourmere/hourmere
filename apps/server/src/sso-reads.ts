import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling'
import { z } from 'zod'
import { requireSsoEnabled, type SsoCapabilities } from './sso.ts'

export interface SsoReadDeps {
  db: Db
  capabilities: SsoCapabilities
}
const denied = () => new DomainError('forbidden', 'team_management_access_denied')

/** Every adapter uses the same current membership and credential boundary. */
export async function authorizeSsoRead(deps: SsoReadDeps, principal: Principal) {
  requireSsoEnabled(deps.capabilities)
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

export async function getSsoPolicy(deps: SsoReadDeps, principal: Principal) {
  await authorizeSsoRead(deps, principal)
  const policy = await deps.db
    .selectFrom('sso_policies')
    .select(['require_sso', 'admission', 'policy_revision', 'trust_generation'])
    .where('organization_id', '=', principal.organization.id)
    .executeTakeFirst()
  return {
    requireSso: policy?.require_sso ?? false,
    admission: policy?.admission ?? 'invitation_only',
    policyRevision: policy?.policy_revision ?? 1,
    trustGeneration: policy?.trust_generation ?? 1,
  }
}

const Cursor = z.strictObject({ organizationId: z.uuid(), id: z.uuid() })
export async function listSsoProviders(
  deps: SsoReadDeps,
  principal: Principal,
  query: { cursor?: string | undefined; limit?: number | undefined } = {},
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
  // Deliberate column allow-list: sealed configuration and identity tables are never read.
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
    ])
    .where('organization_id', '=', principal.organization.id)
    .where('retired_at', 'is', null)
    .$if(after !== undefined, (qb) => qb.where('id', '>', after as string))
    .orderBy('id', 'asc')
    .limit(limit + 1)
    .execute()
  const page = rows.slice(0, limit)
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
      testStatus: 'unknown',
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
    })),
    nextCursor:
      rows.length > limit
        ? Buffer.from(
            JSON.stringify({ organizationId: principal.organization.id, id: page.at(-1)?.id }),
          ).toString('base64url')
        : null,
  }
}
