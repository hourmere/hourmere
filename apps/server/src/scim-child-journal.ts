import type { Database } from '@hourmere/db'
import { writeAuditEvent } from '@hourmere/db/audit'
import type { Transaction } from 'kysely'

type ChildMembershipChange =
  | 'added'
  | 'removed'
  | 'suspended'
  | 'reactivated'
  | 'credentials_revoked'

/** A child journal identifies only the local membership and the system that changed it. */
export function recordScimChildMembership(
  trx: Transaction<Database>,
  { childId, memberId }: { childId: string; memberId: string },
  change: ChildMembershipChange,
) {
  return writeAuditEvent(trx, {
    organizationId: childId,
    actor: { type: 'system', id: 'scim' },
    credential: { type: 'none' },
    action: `scim_membership.${change}`,
    targetType: 'member',
    targetId: memberId,
  })
}
