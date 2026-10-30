import { createRoute, z } from '@hono/zod-openapi'
import { teamRoles } from '@hourmere/auth'
import { DomainError } from '@hourmere/scheduling'
import { ErrorBody, json, type RouteModule, type ServiceDeps } from '../openapi.ts'
import {
  type InvitationSummaryMailLimits,
  listTeamInvitationSummaries,
  TeamInvitationSummarySchema,
} from '../team-invitations.ts'
import { teamManagementAccess } from '../team-management.ts'

// Published response objects stay extensible; the runtime mapper uses strict whitelists.
const TeamInvitationSummary = z
  .object({
    ...TeamInvitationSummarySchema.shape,
    status: TeamInvitationSummarySchema.shape.status.openapi({
      description:
        'Known stored invitation lifecycle, with expired derived only for pending invitations using the database clock. Unrecognized stored statuses map to unknown, remain in pagination and are never pending or resendable.',
    }),
    delivery: z.object(TeamInvitationSummarySchema.shape.delivery.shape).extend({
      lastAttemptAt: z.iso.datetime().nullable().openapi({
        description:
          'Database time when the current generation last recorded an attempt. Null before any attempt, for unknown legacy attempt times or without a delivery row. Independent of later delivery updates.',
      }),
    }),
  })
  .openapi('TeamInvitationSummary')
const TeamInvitationPage = z
  .object({
    data: z.array(TeamInvitationSummary),
    nextCursor: z.string().nullable(),
  })
  .openapi('TeamInvitationPage')

/** Hourmere's invitation summary protocol; native Better Auth schemas are not exposed. */
export function teamInvitationRoutes(
  deps: ServiceDeps & {
    invitationMailLimits: InvitationSummaryMailLimits
  },
): RouteModule {
  const invitationMailLimits = deps.invitationMailLimits
  if (!invitationMailLimits)
    throw new Error('Invitation summary requires mail admission configuration')
  return ({ app, caller }) => {
    const access = teamManagementAccess(deps.db, caller)
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/team/invitations',
        summary: "Invitation delivery summaries of the session's current team",
        description:
          'Hourmere-owned protocol, independent of Better Auth response schemas. Requires a current verified team owner/admin browser session. Any Authorization header is denied before credentials are resolved, even with a valid session cookie. Optional X-Expected-Organization-Id binds the read to the team where the page opened; switching between teams the reader still manages returns 409 organization_context_changed with reload guidance. Invalid or inaccessible expected teams retain 403 team_management_access_denied. Omitting the header retains current-team reads for existing clients. Access denials have no WWW-Authenticate. Invitation status and expiry use the database clock; accepted/canceled/rejected statuses take precedence over expiry. Optional status filters the derived lifecycle before pagination. Delivery state is independent: queued is waiting, sending is submission to the mail server, smtp_accepted means mail server acceptance only, and unknown means no retained delivery row. Resend eligibility reuses the write path cooldown, generation, live lease, recipient membership and admission budgets; this read reserves no capacity and a later resend rechecks eligibility. lastAttemptAt records the database time of the latest attempt; null means no attempt, an unknown legacy time or no delivery row. Ordered by invitation ID ascending. Pass nextCursor as cursor with the same current team and status filter for the next page. No email, links, tokens, credentials, job or lease identities or raw provider errors are returned.',
        tags: ['Team invitations'],
        security: [{ session: [] }],
        middleware: access.middleware,
        request: {
          headers: z.object({
            'x-expected-organization-id': z.string().optional().openapi({
              description:
                'Optional team where the page opened; a switch between teams still managed by the reader returns 409 reload guidance, while invalid or inaccessible targets receive 403 access denial',
            }),
          }),
          query: z.object({
            limit: z.coerce.number().int().min(1).max(100).optional(),
            cursor: z.string().max(2000).optional(),
            status: TeamInvitationSummarySchema.shape.status.optional().openapi({
              description:
                'Filter the database-clock-derived invitation lifecycle before pagination. Omit for all lifecycle states. Keep this filter unchanged while following nextCursor.',
            }),
          }),
        },
        responses: {
          200: {
            description: 'A page of safe invitation delivery summaries',
            content: json(TeamInvitationPage),
          },
          400: {
            description:
              'invalid_request: invalid query; invalid_cursor: malformed cursor or cursor from another team',
            content: json(ErrorBody),
          },
          403: {
            description:
              'team_management_access_denied: requires a current verified team owner/admin session without Authorization; invalid, personal or inaccessible expected organizations receive the same denial',
            content: json(ErrorBody),
          },
          409: {
            description:
              'organization_context_changed: the reader switched between teams they still manage; reload the page before trying again',
            content: json(ErrorBody),
          },
        },
      }),
      async (c) => {
        const expectedOrganizationId = c.req.valid('header')['x-expected-organization-id']
        if (
          expectedOrganizationId !== undefined &&
          z.uuid().safeParse(expectedOrganizationId).success &&
          expectedOrganizationId.toLowerCase() !== c.var.principal.organization.id.toLowerCase()
        )
          await access.read(c.var.principal, c.var.principal.organization.id, async (db, actor) => {
            const membership = await db
              .selectFrom('auth.member')
              .leftJoin(
                'personal_organizations',
                'personal_organizations.organization_id',
                'auth.member.organizationId',
              )
              .select('auth.member.role')
              .where('auth.member.organizationId', '=', expectedOrganizationId)
              .where('auth.member.userId', '=', actor.userId)
              .where('personal_organizations.organization_id', 'is', null)
              .executeTakeFirst()
            if (teamRoles(membership?.role).some((role) => role === 'owner' || role === 'admin'))
              throw new DomainError(
                'conflict',
                'organization_context_changed',
                'Your team context changed. Reload the page before trying again.',
              )
          })
        const page = await access.read(
          c.var.principal,
          expectedOrganizationId ?? c.var.principal.organization.id,
          (db, actor) =>
            listTeamInvitationSummaries(db, actor, c.req.valid('query'), invitationMailLimits),
        )
        return c.json(page, 200)
      },
    )
  }
}
