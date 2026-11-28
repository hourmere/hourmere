import {
  customOperationTransportAllows,
  lockCustomRoleMaster,
  MCP_OAUTH_CONSENT_LIFETIME_MS,
  type Principal,
  requireActiveApiKey,
  resolveTeamPermissions,
  type TeamPermissionCheck,
} from '@hourmere/auth'
import { customRoleCatalogueV1 } from '@hourmere/core'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { DomainError } from './errors.ts'

export type PhaseOneGrant = (typeof customRoleCatalogueV1.phaseOne)[number]

const phaseOne: ReadonlySet<string> = new Set(customRoleCatalogueV1.phaseOne)

export function managedTeamPermissionChecks(
  principal: Principal,
  operations: readonly string[],
  fixedManager: boolean,
): TeamPermissionCheck[] {
  return operations.map((operation) => ({
    operation,
    fixed: ({ role, personal }) =>
      fixedManager &&
      !personal &&
      role.split(',').some((token) => ['owner', 'admin'].includes(token.trim()))
        ? 'elevated'
        : 'denied',
    versionedFixed: true,
    custom:
      phaseOne.has(operation) &&
      customOperationTransportAllows(
        operation,
        principal.kind === 'api_key' ? principal.apiKeyScope : principal.kind,
      ),
  }))
}

/** Fixed role predicates keep their existing behavior for unaffected memberships. */
export async function allowsManagedTeamOperations(
  db: Db,
  principal: Principal,
  operations: readonly string[],
  fixedManager: boolean,
  generation: number | null,
): Promise<boolean> {
  if (fixedManager && (generation === null || generation === 1)) return true
  if (!principal.customRoleAuthorization?.credential) return false
  const result = await resolveTeamPermissions(
    db,
    principal,
    principal.organization.id,
    managedTeamPermissionChecks(principal, operations, fixedManager),
    principal.customRoleAuthorization,
  )
  return result?.decisions.every(({ allowed }) => allowed) === true
}

/** Hold the policy and credential after the caller's organization lock, through commit. */
export async function lockVersionedTeamWrite(db: Db, principal: Principal, now: () => number) {
  if (!principal.customRoleAuthorization?.credential) return
  await lockCustomRoleMaster(db)
  if (principal.kind === 'api_key') {
    await requireActiveApiKey(db, principal, now)
    return
  }
  const sessionId = principal.kind === 'session' ? principal.sessionId : principal.oauthSessionId
  const session =
    sessionId &&
    (await db
      .selectFrom('auth.session')
      .select('expiresAt')
      .where('id', '=', sessionId)
      .where('userId', '=', principal.user.id)
      .forShare()
      .executeTakeFirst())
  if (principal.kind === 'oauth') {
    const consent = await db
      .selectFrom('auth.oauthConsent as consent')
      .innerJoin('mcp_oauth_grants as oauth_grant', (join) =>
        join
          .on(sql<boolean>`consent."referenceId" = oauth_grant.id::text`)
          .onRef('consent.userId', '=', 'oauth_grant.user_id')
          .onRef('consent.clientId', '=', 'oauth_grant.client_id'),
      )
      .select('consent.createdAt')
      .where('consent.id', '=', principal.oauthConsentId)
      .where(
        'oauth_grant.id',
        '=',
        principal.oauthGrantId ?? '00000000-0000-4000-8000-000000000000',
      )
      .where('oauth_grant.organization_id', '=', principal.organization.id)
      .where('oauth_grant.user_id', '=', principal.user.id)
      .where('oauth_grant.client_id', '=', principal.clientId)
      .forShare(['consent', 'oauth_grant'])
      .executeTakeFirst()
    if (
      !consent ||
      new Date(consent.createdAt).getTime() + MCP_OAUTH_CONSENT_LIFETIME_MS <= Date.now()
    )
      throw new DomainError('forbidden', 'insufficient_role')
  }
  if (sessionId && (!session || session.expiresAt.getTime() <= Date.now()))
    throw new DomainError('forbidden', 'insufficient_role')
}
