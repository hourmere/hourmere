import type { Db } from '@hourmere/db'
import type { BetterAuthPlugin } from 'better-auth'
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import type { AuthMiddlewareContext } from './api-keys.ts'
import { isUuid } from './organizations.ts'
import { teamRoles } from './team-management.ts'
import { teamRoleDenied } from './team-role-policy.ts'

interface MemberSummary {
  id: string
  organizationId: string
  userId: string
  role: string
  createdAt: Date
  user: { id: string; name: string }
}

/** Native organization reads otherwise expose emails and invitations to every member. */
export function memberReadPrivacy(db: Db): BetterAuthPlugin {
  async function manager(ctx: AuthMiddlewareContext, organizationId: string) {
    const session = await getSessionFromCtx(ctx)
    if (!session) return false
    const actor = await db
      .selectFrom('auth.member as m')
      .innerJoin('auth.user as u', 'u.id', 'm.userId')
      .select(['m.role', 'u.emailVerified'])
      .where('m.organizationId', '=', organizationId)
      .where('m.userId', '=', session.user.id)
      .executeTakeFirst()
    if (!actor?.emailVerified) return false
    const roles = teamRoles(actor.role)
    return (
      roles.every((role) => ['owner', 'admin', 'member'].includes(role)) &&
      roles.some((role) => role === 'owner' || role === 'admin')
    )
  }

  return {
    id: 'member-read-privacy',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/organization/list-invitations',
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx)
            if (!session) return
            const organizationId = ctx.query?.organizationId || session.session.activeOrganizationId
            // Malformed selectors remain the native endpoint's responsibility.
            if (typeof organizationId !== 'string' || !isUuid(organizationId)) return
            if (!(await manager(ctx, organizationId))) throw teamRoleDenied()
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) =>
            ctx.path === '/organization/list-members' ||
            ctx.path === '/organization/get-full-organization',
          handler: createAuthMiddleware(async (ctx) => {
            const response = ctx.context.returned as
              | { id?: string; members?: MemberSummary[]; invitations?: unknown }
              | undefined
            if (!response || !Array.isArray(response.members)) return
            const organizationId = response.id ?? response.members[0]?.organizationId
            if (
              typeof organizationId === 'string' &&
              isUuid(organizationId) &&
              (await manager(ctx, organizationId))
            )
              return
            const members = response.members.map((member) => ({
              id: member.id,
              organizationId: member.organizationId,
              userId: member.userId,
              role: member.role,
              createdAt: member.createdAt,
              user: { id: member.user.id, name: member.user.name },
            }))
            const { invitations: _invitations, ...summary } = response
            return ctx.json({ ...summary, members })
          }),
        },
      ],
    },
  }
}
