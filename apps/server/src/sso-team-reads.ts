import {
  liveBrowserProofQuery,
  lockSsoDelegation,
  lockTeamSsoProof,
  memoizeTeamSsoAccess,
  type Principal,
  type TeamReadPolicy,
  type TeamSsoDeps,
  type TeamSsoSession,
} from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { scimSuspended } from '@hourmere/db/scim-suspension'
import { DomainError } from '@hourmere/scheduling'

export type { TeamReadPolicy } from '@hourmere/auth'
export interface TeamReadAccess {
  allowed: boolean
  suspended?: true
  /** A machine decision carries only the authorization result. Fetch policy fields on demand. */
  policy: TeamReadPolicy | null | undefined
}
export type SsoTeamReadDeps = TeamSsoDeps

type Scope = Pick<Principal['organization'], 'id' | 'personal'>

function sessionIdentity(principal: Principal): TeamSsoSession | null {
  return principal.kind === 'session'
    ? { sessionId: principal.sessionId, userId: principal.user.id }
    : null
}

/** Shared by enforcement and the caller's own proof summary. */
export function liveBrowserProofs(
  principal: Extract<Principal, { kind: 'session' }>,
  organizationId: Parameters<typeof liveBrowserProofQuery>[1],
  trustGeneration: Parameters<typeof liveBrowserProofQuery>[2],
  capabilities: Parameters<typeof liveBrowserProofQuery>[3],
) {
  return liveBrowserProofQuery(
    { sessionId: principal.sessionId, userId: principal.user.id },
    organizationId,
    trustGeneration,
    capabilities,
  )
}

function missingProof(): never {
  throw new DomainError('forbidden', 'sso_required')
}

/** One live decision per request, including when the handler also needs the policy. */
export function teamReadAccess(deps: SsoTeamReadDeps, principal: Principal) {
  const decision = memoizeTeamSsoAccess(deps, sessionIdentity(principal))
  let organizationId: string | undefined
  let machineDecision: Promise<TeamReadAccess> | undefined
  return (scope: Scope = principal.organization): Promise<TeamReadAccess> => {
    if (scope.personal) return Promise.resolve({ allowed: true, policy: null })
    if (organizationId !== undefined && organizationId !== scope.id)
      throw new Error('Team read enforcement received multiple target organizations')
    organizationId = scope.id
    if (
      principal.kind !== 'session' &&
      principal.ssoDelegationStatus !== undefined &&
      scope.id === principal.organization.id
    ) {
      const status = principal.ssoDelegationStatus
      if (status === 'required') return Promise.resolve({ allowed: false, policy: undefined })
      // The resolver captured delegation before this operation. SCIM can commit
      // between those two boundaries while leaving the credential itself in place.
      machineDecision ??= deps.db
        .selectNoFrom(scimSuspended(scope.id, principal.user.id).as('suspended'))
        .executeTakeFirstOrThrow()
        .then<TeamReadAccess>(({ suspended }) => ({
          allowed: !suspended,
          ...(suspended && { suspended: true }),
          policy: status === null ? null : undefined,
        }))
      return machineDecision
    }
    return decision(scope.id)
  }
}

export type TeamReadCheck = ReturnType<typeof teamReadAccess>

export function requireTeamRead(access: TeamReadAccess): void {
  if (access.suspended) throw new DomainError('forbidden', 'team_management_access_denied')
  if (!access.allowed) missingProof()
}

export function teamWriteCheck(deps: SsoTeamReadDeps, principal: Principal) {
  const { organization, user } = principal
  const actor = { organizationId: organization.id, userId: user.id }
  return {
    organizationId: organization.id,
    identity: sessionIdentity(principal),
    expired: missingProof,
    lockProof: (db: Db) => {
      if (principal.kind === 'api_key') {
        return lockSsoDelegation(
          db,
          deps.capabilities,
          { ...actor, kind: 'api_key', credentialId: principal.apiKeyId },
          missingProof,
        )
      }
      if (principal.kind === 'oauth' && principal.oauthGrantId) {
        return lockSsoDelegation(
          db,
          deps.capabilities,
          { ...actor, kind: 'oauth_grant', credentialId: principal.oauthGrantId },
          missingProof,
        )
      }
      return lockTeamSsoProof(deps, db, sessionIdentity(principal), organization.id, missingProof)
    },
  }
}
