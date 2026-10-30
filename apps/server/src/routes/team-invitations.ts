import { createRoute, z } from '@hono/zod-openapi'
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
          'Hourmere-owned protocol, independent of Better Auth response schemas. Requires a current verified team owner/admin browser session. Any Authorization header is denied before credentials are resolved, even with a valid session cookie. All access denials are 403 team_management_access_denied without WWW-Authenticate. Invitation status and expiry use the database clock; accepted/canceled/rejected statuses take precedence over expiry. Delivery state is independent: queued is waiting, smtp_accepted means SMTP acceptance only, and unknown means no retained delivery row. Resend eligibility reuses the write path cooldown, generation, live lease, recipient membership and admission budgets; this read reserves no capacity and a later resend rechecks eligibility. lastAttemptAt records the database time of the latest attempt; null means no attempt, an unknown legacy time or no delivery row. Ordered by invitation ID ascending. Pass nextCursor as cursor with the same current team for the next page. No email, links, tokens, credentials, job or lease identities or raw provider errors are returned.',
        tags: ['Team invitations'],
        security: [{ session: [] }],
        middleware: access.middleware,
        request: {
          query: z.object({
            limit: z.coerce.number().int().min(1).max(100).optional(),
            cursor: z.string().max(2000).optional(),
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
              'team_management_access_denied: requires a current verified team owner/admin session without Authorization',
            content: json(ErrorBody),
          },
        },
      }),
      async (c) => {
        const page = await access.read(
          c.var.principal,
          c.var.principal.organization.id,
          (db, actor) =>
            listTeamInvitationSummaries(db, actor, c.req.valid('query'), invitationMailLimits),
        )
        return c.json(page, 200)
      },
    )
  }
}
