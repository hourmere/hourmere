import type { Database, Db } from '@hourmere/db'
import type { Transaction } from 'kysely'
import type { Principal } from './caller.ts'
import { isUuid } from './organizations.ts'
import {
  checkTeamManagementAccess,
  type TeamManager,
  teamManagementDenied,
  teamRoles,
} from './team-management.ts'

export interface TeamMemberRemovalInput {
  teamId: string
  memberUserId: string
  expectedOrganizationId: string
}

export interface TeamMemberRemoval {
  operationId: string
  memberUserId: string
  deactivatedEventTypeIds: string[]
}

/** The native preview and locked write enforce the same target role policy. */
export async function teamMemberRemovalTarget(
  db: Db,
  actor: TeamManager,
  memberUserId: string,
  lock: boolean,
) {
  if (!isUuid(memberUserId)) throw teamManagementDenied()
  let query = db
    .selectFrom('auth.member')
    .selectAll()
    .where('organizationId', '=', actor.organizationId)
    .where('userId', '=', memberUserId)
  if (lock) query = query.forUpdate()
  const member = await query.executeTakeFirst()
  const roles = teamRoles(member?.role)
  if (
    !member ||
    roles.includes('owner') ||
    (!roles.includes('admin') && !roles.includes('member')) ||
    (actor.role !== 'owner' && roles.includes('admin'))
  ) {
    throw teamManagementDenied()
  }
  return member
}

/**
 * The caller owns the shared user → organization → member → session locks. The parent
 * organization write lock orders removal with host assignments and public bookings.
 * Existing bookings and both configured and saved host relations remain unchanged.
 */
async function removeTeamMemberInTransaction(
  trx: Transaction<Database>,
  actor: TeamManager,
  input: { memberUserId: string },
): Promise<TeamMemberRemoval> {
  const member = await teamMemberRemovalTarget(trx, actor, input.memberUserId, true)

  const configured = await trx
    .selectFrom('event_types as event')
    .innerJoin('event_type_hosts as host', 'host.event_type_id', 'event.id')
    .select(['event.id', 'event.scheduling_type'])
    .where('event.organization_id', '=', actor.organizationId)
    .where('event.owner_user_id', 'is', null)
    .where('event.deleted_at', 'is', null)
    .where('event.is_active', '=', true)
    .where('host.user_id', '=', member.userId)
    .orderBy('event.id')
    .forUpdate('event')
    .execute()
  const deactivatedEventTypeIds: string[] = []
  for (const event of configured) {
    if (event.scheduling_type === 'round_robin') {
      // Match scheduling's current host eligibility: a configured, verified member.
      // Stale configured hosts do not keep an otherwise empty pool active.
      const remaining = await trx
        .selectFrom('event_type_hosts as host')
        .innerJoin('auth.member as member', 'member.userId', 'host.user_id')
        .innerJoin('auth.user as user', 'user.id', 'host.user_id')
        .select('host.user_id')
        .where('host.event_type_id', '=', event.id)
        .where('host.user_id', '!=', member.userId)
        .where('member.organizationId', '=', actor.organizationId)
        .where('user.emailVerified', '=', true)
        .executeTakeFirst()
      if (remaining) continue
    }
    await trx
      .updateTable('event_types')
      .set({ is_active: false, updated_at: new Date() })
      .where('id', '=', event.id)
      .where('organization_id', '=', actor.organizationId)
      .execute()
    deactivatedEventTypeIds.push(event.id)
  }

  await trx
    .deleteFrom('auth.member')
    .where('id', '=', member.id)
    .where('organizationId', '=', actor.organizationId)
    .where('userId', '=', member.userId)
    .execute()
  const operation = await trx
    .insertInto('organization_operations')
    .values({
      organization_id: actor.organizationId,
      operation: 'member_removed',
      actor_user_id: actor.userId,
      target_user_id: member.userId,
      previous_role: member.role,
      new_role: null,
      source: 'web',
      occurred_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { operationId: operation.id, memberUserId: member.userId, deactivatedEventTypeIds }
}

/** Recheck current session authority in the same transaction as every removal write. */
export function removeTeamMember(
  db: Db,
  principal: Principal,
  input: TeamMemberRemovalInput,
): Promise<TeamMemberRemoval> {
  const write = async (trx: Transaction<Database>) => {
    const actor = await checkTeamManagementAccess(trx, principal, input.teamId, true, {
      expectedOrganizationId: input.expectedOrganizationId,
      allowPersonal: false,
    })
    if (actor.role === 'member') throw teamManagementDenied()
    return removeTeamMemberInTransaction(trx, { ...actor, role: actor.role }, input)
  }
  return db.isTransaction
    ? write(db as Transaction<Database>)
    : db.transaction().setIsolationLevel('read committed').execute(write)
}
