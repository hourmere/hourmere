import type { Db } from '@hourmere/db'
import { MemberDepartureOwnerRequiredError } from './member-departure.ts'
import { teamRoles } from './team-management.ts'

/** The caller holds the organization's UPDATE lock through this check and the write. */
export async function assertTeamOwnerRemains(
  db: Db,
  organizationId: string,
  departingUserId: string,
): Promise<void> {
  const others = await db
    .selectFrom('auth.member')
    .select('role')
    .where('organizationId', '=', organizationId)
    .where('userId', '!=', departingUserId)
    .execute()
  if (!others.some((member) => teamRoles(member.role).includes('owner'))) {
    throw new MemberDepartureOwnerRequiredError()
  }
}
