import {
  checkTeamManagementAccess,
  ensurePersonalOrganization,
  lockSharedTeamSsoProof,
  MemberDepartureBlockedError,
  MemberDepartureOwnerRequiredError,
  removeSsoRecoveryOwner,
  type SsoAdmissionRemoval,
  ssoHardOff,
  TeamManagementError,
  teamRoles,
} from '@hourmere/auth'
import type { Database } from '@hourmere/db'
import { auditActor, writeAuditEvent } from '@hourmere/db/audit'
import {
  checkTeamWriteBeforeAuthorityChange,
  checkTeamWriteDeadline,
  teamWriteCheckFor,
  teamWriteTransaction,
} from '@hourmere/db/team-write'
import type { Transaction } from 'kysely'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { getTeamMemberDepartureImpact } from './member-departure-impact.ts'

/** Self departure only. Administrative removal has its own policy and persistence path. */
export async function leaveTeamMember(
  ctx: ServiceContext,
  input: { teamId: string; expectedOrganizationId: string },
  recordAdmissionRemoval?: SsoAdmissionRemoval,
  ssoCapabilities = ssoHardOff,
): Promise<{ organizationId: string }> {
  if (ctx.principal.kind !== 'session') {
    throw new DomainError('forbidden', 'team_management_access_denied')
  }
  const principal = ctx.principal
  // Repair legacy accounts before taking team locks; this helper may create its own
  // transaction. Only this user's personal space is touched here.
  const personalId = await ensurePersonalOrganization(ctx.db, principal.user.id)
  // Better Auth's native leave calls this inside its own read-committed transaction on the
  // auth pool and passes that transaction as ctx.db. Run on it: waiting for an application
  // connection while holding an auth connection can deadlock against requests that hold an
  // application transaction while they wait for an auth connection (the MCP OAuth broker).
  const departure = ctx.db.isTransaction
    ? {
        execute: <T>(work: (trx: Transaction<Database>) => Promise<T>) =>
          work(ctx.db as Transaction<Database>),
      }
    : {
        execute: <T>(work: (trx: Transaction<Database>) => Promise<T>) =>
          teamWriteTransaction(ctx.db.transaction().setIsolationLevel('read committed'), work),
      }
  return departure
    .execute(async (trx) => {
      // Web callers join the native switch ordering before taking any row locks.
      // Native HTTP departure already owns that context lock on its dedicated pool.
      await ctx.authorizeOrganizationWrite?.(trx, input.teamId)
      const actor = await checkTeamManagementAccess(
        trx,
        principal,
        input.teamId,
        true,
        {
          expectedOrganizationId: input.expectedOrganizationId,
          allowPersonal: false,
          includeRecoveryOwner: true,
        },
        true,
      )
      const identity = { userId: principal.user.id, sessionId: principal.sessionId }
      const denied = () => {
        throw new DomainError('forbidden', 'sso_required')
      }
      if (actor.recoveryOwner) {
        await lockSharedTeamSsoProof(trx, ssoCapabilities, identity, actor.organizationId, denied)
        await removeSsoRecoveryOwner(
          trx,
          principal,
          {
            organizationId: actor.organizationId,
            userId: actor.userId,
            isOwner: actor.role === 'owner',
          },
          ctx.requestId,
        )
      }
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
      // The write itself removes the membership and proof that authorized it.
      const check = teamWriteCheckFor(actor.organizationId, identity)
      const deadline = check
        ? await checkTeamWriteBeforeAuthorityChange(trx)
        : await lockSharedTeamSsoProof(trx, ssoCapabilities, identity, actor.organizationId, denied)
      if (recordAdmissionRemoval) {
        await recordAdmissionRemoval(trx, {
          organizationId: actor.organizationId,
          userId: actor.userId,
        })
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
      await writeAuditEvent(trx, {
        organizationId: actor.organizationId,
        ...auditActor(principal),
        action: 'membership.left',
        targetType: 'user',
        targetId: actor.userId,
        requestId: ctx.requestId,
      })
      await checkTeamWriteDeadline(trx, deadline, denied)
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
