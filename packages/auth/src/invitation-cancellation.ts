import type { Db } from '@hourmere/db'
import { APIError, getSessionFromCtx } from 'better-auth/api'
import type { AuthMiddlewareContext } from './api-keys.ts'
import { isUuid } from './organizations.ts'
import {
  checkTeamManagementAccess,
  TeamManagementError,
  type TeamManager,
} from './team-management.ts'
import { teamRoleDenied } from './team-role-policy.ts'

/** The caller holds the shared actor/team locks in the same transaction. */
export async function cancelTeamInvitation(db: Db, actor: TeamManager, invitationId: string) {
  const invitation = await db
    .selectFrom('auth.invitation')
    .selectAll()
    .where('id', '=', invitationId)
    .where('organizationId', '=', actor.organizationId)
    .forUpdate()
    .executeTakeFirst()
  if (!invitation) throw new TeamManagementError('team_management_access_denied')
  // Acceptance owns the same team/invitation locks. A completed acceptance wins;
  // cancelling its old invitation never changes the joined membership.
  if (invitation.status !== 'pending') return invitation
  return db
    .updateTable('auth.invitation')
    .set({ status: 'canceled' })
    .where('id', '=', invitation.id)
    .where('status', '=', 'pending')
    .returningAll()
    .executeTakeFirstOrThrow()
}

/** Protect native HTTP and trusted auth.api cancellation with the same locked write. */
export async function invitationCancellationRules(ctx: AuthMiddlewareContext, db: Db) {
  if (ctx.path !== '/organization/cancel-invitation') return
  if (ctx.request && ctx.request.headers.get('origin') !== new URL(ctx.context.baseURL).origin)
    throw teamRoleDenied()
  const session = await getSessionFromCtx(ctx)
  const input = ctx.body as { invitationId?: unknown } | undefined
  if (!session || typeof input?.invitationId !== 'string' || !isUuid(input.invitationId))
    throw teamRoleDenied()
  const invitationId = input.invitationId
  const expected = ctx.request?.headers.get('x-expected-organization-id')
  try {
    const invitation = await db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        const target = await trx
          .selectFrom('auth.invitation')
          .select('organizationId')
          .where('id', '=', invitationId)
          .executeTakeFirst()
        if (!target) throw teamRoleDenied()
        const facts = await checkTeamManagementAccess(
          trx,
          {
            kind: 'session',
            user: session.user,
            sessionId: session.session.id,
            organization: {
              id: session.session.activeOrganizationId ?? '',
              name: '',
              slug: '',
              personal: false,
            },
          },
          target.organizationId,
          true,
          ctx.request
            ? { expectedOrganizationId: expected ?? '', allowPersonal: false }
            : undefined,
        )
        if (facts.role === 'member') throw teamRoleDenied()
        return cancelTeamInvitation(trx, { ...facts, role: facts.role }, invitationId)
      })
    return ctx.json(invitation)
  } catch (error) {
    if (error instanceof TeamManagementError) {
      if (error.code === 'organization_context_changed')
        throw new APIError('CONFLICT', {
          code: 'ORGANIZATION_CONTEXT_CHANGED',
          message: 'Your team context changed. Reload before trying again.',
        })
      throw teamRoleDenied()
    }
    if (error instanceof APIError) throw error
    throw new APIError('INTERNAL_SERVER_ERROR', {
      code: 'INVITATION_REQUEST_FAILED',
      message: 'The invitation request could not be completed. Try again later.',
    })
  }
}
