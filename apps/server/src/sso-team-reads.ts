import {
  liveBrowserProofQuery,
  lockTeamSsoProof,
  memoizeTeamSsoAccess,
  type Principal,
  type TeamReadAccess,
  type TeamSsoDeps,
  type TeamSsoSession,
} from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling'

export type { TeamReadAccess, TeamReadPolicy } from '@hourmere/auth'
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

/** One decision per request, including when the handler also needs the policy. */
export function teamReadAccess(deps: SsoTeamReadDeps, principal: Principal) {
  const decision = memoizeTeamSsoAccess(deps, sessionIdentity(principal))
  let organizationId: string | undefined
  return (scope: Scope = principal.organization) => {
    if (scope.personal) return Promise.resolve({ allowed: true, policy: null })
    if (organizationId !== undefined && organizationId !== scope.id)
      throw new Error('Team read enforcement received multiple target organizations')
    organizationId = scope.id
    return decision(scope.id)
  }
}

export type TeamReadCheck = ReturnType<typeof teamReadAccess>

export function requireTeamRead(access: TeamReadAccess): void {
  if (!access.allowed) missingProof()
}

export function teamWriteCheck(deps: SsoTeamReadDeps, principal: Principal) {
  return {
    organizationId: principal.organization.id,
    identity: sessionIdentity(principal),
    expired: missingProof,
    lockProof: (db: Db) =>
      lockTeamSsoProof(
        deps,
        db,
        sessionIdentity(principal),
        principal.organization.id,
        missingProof,
      ),
  }
}
