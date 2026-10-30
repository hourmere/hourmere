import {
  checkTeamManagementAccess,
  ensurePersonalOrganization,
  MemberDepartureBlockedError,
  MemberDepartureOwnerRequiredError,
  TeamManagementError,
  teamRoles,
} from '@hourmere/auth'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { getTeamMemberDepartureImpact } from './member-departure-impact.ts'

/** Self departure only. Administrative removal has its own policy and persistence path. */
export async function leaveTeamMember(
  ctx: ServiceContext,
  input: { teamId: string; expectedOrganizationId: string },
): Promise<{ organizationId: string }> {
  if (ctx.principal.kind !== 'session') {
    throw new DomainError('forbidden', 'team_management_access_denied')
  }
  const principal = ctx.principal
  if (input.expectedOrganizationId.toLowerCase() !== principal.organization.id.toLowerCase()) {
    throw new DomainError('conflict', 'organization_context_changed')
  }
  // Repair legacy accounts before taking team locks; this helper may create its own
  // transaction. Only this user's personal space is touched here.
  const personalId = await ensurePersonalOrganization(ctx.db, principal.user.id)
  return ctx.db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx) => {
      // Web callers join the native switch ordering before taking any row locks.
      // Native HTTP departure already owns that context lock on its dedicated pool.
      await ctx.authorizeOrganizationWrite?.(trx, input.teamId)
      const actor = await checkTeamManagementAccess(
        trx,
        principal,
        input.teamId,
        true,
        { expectedOrganizationId: input.expectedOrganizationId, allowPersonal: false },
        true,
      )
      if (actor.role === 'owner') {
        // Every leave and role change holds this organization UPDATE lock. Count only
        // other current members with an exact owner token, after waiting for that lock.
        const otherMembers = await trx
          .selectFrom('auth.member')
          .select('role')
          .where('organizationId', '=', actor.organizationId)
          .where('userId', '!=', actor.userId)
          .execute()
        if (!otherMembers.some((member) => teamRoles(member.role).includes('owner'))) {
          throw new MemberDepartureOwnerRequiredError()
        }
      }
      // The organization UPDATE lock excludes the SHARE locks used by event/booking
      // writers. Read after waiting for it, on this same connection, through deletion.
      const impact = await getTeamMemberDepartureImpact(
        { ...ctx, db: trx },
        { teamId: actor.organizationId, memberUserId: actor.userId },
      )
      if (impact.eventTypes.totalCount > 0 || impact.bookings.totalCount > 0) {
        throw new MemberDepartureBlockedError(impact)
      }
      const removed = await trx
        .deleteFrom('auth.member')
        .where('organizationId', '=', actor.organizationId)
        .where('userId', '=', actor.userId)
        .returning('role')
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('organization_operations')
        .values({
          organization_id: actor.organizationId,
          operation: 'member_removed',
          actor_user_id: actor.userId,
          target_user_id: actor.userId,
          previous_role: removed.role,
          new_role: null,
          source: 'web',
          occurred_at: new Date(),
        })
        .execute()
      await trx
        .updateTable('auth.session')
        .set({ activeOrganizationId: personalId, updatedAt: new Date() })
        .where('id', '=', principal.sessionId)
        .where('userId', '=', actor.userId)
        .execute()
      return { organizationId: personalId }
    })
    .catch((error: unknown) => {
      if (error instanceof TeamManagementError) {
        throw new DomainError(
          error.code === 'organization_context_changed' ? 'conflict' : 'forbidden',
          error.code,
        )
      }
      throw error
    })
}
