import type { AuthConfig } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { leaveTeamMember } from '@hourmere/scheduling'

/**
 * Better Auth's native leave, backed by the scheduling departure. Native departure runs
 * inside Better Auth's auth transaction and passes it: the departure must use that held
 * connection, never wait for an application connection while holding it.
 */
export function nativeTeamLeave(db: Db): NonNullable<AuthConfig['leaveTeamMember']> {
  return (principal, teamId, expectedOrganizationId, transaction) =>
    leaveTeamMember(
      { db: transaction ?? db, principal, now: () => Temporal.Now.instant() },
      { teamId, expectedOrganizationId },
    )
}
