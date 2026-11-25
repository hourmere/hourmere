import { teamRoles } from '@hourmere/auth'
import type { Database, Db } from '@hourmere/db'
import {
  lockScimCredentialRevocation,
  revokeScimTeamCredentials,
} from '@hourmere/db/scim-suspension'
import { DomainError, hasTeamMemberDepartureImpact } from '@hourmere/scheduling'
import { sql, type Transaction } from 'kysely'
import { recordScimChildMembership } from './scim-child-journal.ts'

export function lockMappingTeams(trx: Db, teams: string[]) {
  return trx
    .selectFrom('auth.organization')
    .select('id')
    .where('id', 'in', teams)
    .orderBy('id')
    .forUpdate()
    .execute()
}

/** Both teams and the live mapping are locked. Remove only the child memberships it sourced. */
export async function retireScimTeamMapping(
  trx: Transaction<Database>,
  mappingId: string,
  childOrganizationId: string,
) {
  const roster = await trx
    .selectFrom('scim_team_managed_memberships as source')
    .innerJoin('auth.member as member', (join) =>
      join
        .onRef('member.id', '=', 'source.member_id')
        .onRef('member.userId', '=', 'source.user_id')
        .onRef('member.organizationId', '=', 'source.child_organization_id'),
    )
    .select(['member.id', 'member.role', 'member.userId'])
    .where('source.mapping_id', '=', mappingId)
    .where('source.child_organization_id', '=', childOrganizationId)
    .orderBy('member.userId')
    .forUpdate('member')
    .execute()
  if (
    roster.some(({ role }) => teamRoles(role).some((item) => item === 'owner' || item === 'admin'))
  )
    throw new DomainError('forbidden', 'scim_mapping_privileged_member')
  for (const { userId } of roster) {
    if (
      await hasTeamMemberDepartureImpact(trx, { teamId: childOrganizationId, memberUserId: userId })
    )
      throw new DomainError('conflict', 'scim_mapping_roster_requires_departure')
  }

  for (const { userId } of roster) await lockScimCredentialRevocation(trx, userId)
  for (const { id, userId } of roster) {
    const membership = { childId: childOrganizationId, memberId: id }
    await revokeScimTeamCredentials(trx, childOrganizationId, userId)
    await recordScimChildMembership(trx, membership, 'credentials_revoked')
    // Removes the provenance row via its scoped FK and retains ordinary admission blockers.
    await trx.deleteFrom('auth.member').where('id', '=', id).execute()
    await recordScimChildMembership(trx, membership, 'removed')
  }
  await trx
    .updateTable('scim_team_mappings')
    .set({ retired_at: sql<Date>`clock_timestamp()` })
    .where('id', '=', mappingId)
    .execute()
}
