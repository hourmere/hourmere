import { createRoute, z } from '@hono/zod-openapi'
import { cancelTeamInvitation, TeamManagementError } from '@hourmere/auth'
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
    const headers = z.object({ 'x-expected-organization-id': z.uuid() })
    const params = z.object({ invitationId: z.uuid() })
    const summary = async (
      db: Parameters<typeof listTeamInvitationSummaries>[0],
      actor: Parameters<typeof listTeamInvitationSummaries>[1],
      invitationId: string,
    ) => {
      const page = await listTeamInvitationSummaries(
        db,
        actor,
        { invitationId },
        invitationMailLimits,
      )
      const row = page.data[0]
      if (!row) throw new DomainError('forbidden', 'team_management_access_denied')
      return row
    }
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/team/invitations/{invitationId}',
        summary: 'Read the current state of one team invitation',
        description:
          'Verified current team owner/admin session only. Reads the final invitation lifecycle and current mail generation independently of list filters. Missing and other-team IDs receive the same access denial. X-Expected-Organization-Id binds the page to its team.',
        tags: ['Team invitations'],
        security: [{ session: [] }],
        middleware: access.middleware,
        request: { headers, params },
        responses: {
          200: { description: 'Current invitation summary', content: json(TeamInvitationSummary) },
          400: { description: 'invalid_request: invalid identifier', content: json(ErrorBody) },
          403: { description: 'team_management_access_denied', content: json(ErrorBody) },
          409: {
            description: 'organization_context_changed: reload before trying again',
            content: json(ErrorBody),
          },
        },
      }),
      async (c) =>
        c.json(
          await access.read(
            c.var.principal,
            c.req.valid('header')['x-expected-organization-id'],
            (db, actor) => summary(db, actor, c.req.valid('param').invitationId),
          ),
          200,
        ),
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/team/invitations/{invitationId}/cancel',
        summary: 'Cancel a pending team invitation',
        description:
          'Verified current team owner/admin session and same-origin request only. Serializes with acceptance and resend. Cancels only a still-pending invitation, including an expired one; a joined member is never removed and an already accepted invitation remains accepted. Returns the actual lifecycle after locking. A mail submission already in flight may still complete; cancellation invalidates joining through the link. Repeating cancellation is safe. X-Expected-Organization-Id is required.',
        tags: ['Team invitations'],
        security: [{ session: [] }],
        middleware: access.middleware,
        request: { headers, params, body: { content: json(z.strictObject({})), required: true } },
        responses: {
          200: {
            description: 'Final invitation summary; accepted if joining won the race',
            content: json(TeamInvitationSummary),
          },
          400: { description: 'invalid_request: malformed request', content: json(ErrorBody) },
          403: { description: 'team_management_access_denied', content: json(ErrorBody) },
          409: {
            description: 'organization_context_changed: reload before trying again',
            content: json(ErrorBody),
          },
        },
      }),
      async (c) => {
        const expectedOrganizationId = c.req.valid('header')['x-expected-organization-id']
        const invitationId = c.req.valid('param').invitationId
        try {
          const row = await access.write(
            c.var.principal,
            expectedOrganizationId,
            async (trx, actor) => {
              await cancelTeamInvitation(trx, actor, invitationId)
              return summary(trx, actor, invitationId)
            },
            { expectedOrganizationId },
          )
          return c.json(row, 200)
        } catch (error) {
          if (error instanceof TeamManagementError)
            throw new DomainError('forbidden', 'team_management_access_denied')
          throw error
        }
      },
    )
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/team/invitations',
        summary: "Invitation delivery summaries of the session's current team",
        description:
          'Hourmere-owned protocol, independent of Better Auth response schemas. Requires a current verified team owner/admin browser session. Any Authorization header is denied before credentials are resolved, even with a valid session cookie. Optional X-Expected-Organization-Id binds the read to the team where the page opened; switching to any other organization, including personal space or a member-role team, returns 409 organization_context_changed with reload guidance when the reader still owns or administers the expected team. Invalid or inaccessible expected teams retain 403 team_management_access_denied. Omitting the header retains current-team reads for existing clients. Access denials have no WWW-Authenticate. Invitation status and expiry use the database clock; accepted/canceled/rejected statuses take precedence over expiry. Optional status filters the derived lifecycle before pagination. Delivery state is independent: queued is waiting, sending is submission to the mail server, smtp_accepted means mail server acceptance only, and unknown means no retained delivery row. Resend eligibility reuses the write path cooldown, generation, live lease, recipient membership and admission budgets. Expired pending invitations instead permit atomic cancellation and creation of a new invitation ID under the acting administrator, subject to fresh admission budgets, active duplicate and pending limits. The old ID is never renewed. This read reserves no capacity and the write rechecks eligibility. lastAttemptAt records the database time of the latest attempt; null means no attempt, an unknown legacy time or no delivery row. Ordered by invitation ID ascending. Pass nextCursor as cursor with the same current team and status filter for the next page. The invited email address is returned only to verified owners/admins of the current team; members, other teams and API-key/OAuth callers cannot read it. No links, tokens, mail bodies, credentials, job or lease identities or raw provider errors are returned.',
        tags: ['Team invitations'],
        security: [{ session: [] }],
        middleware: access.middleware,
        request: {
          headers: z.object({
            'x-expected-organization-id': z.string().optional().openapi({
              description:
                'Optional team where the page opened; a switch to any other organization returns 409 reload guidance while the reader still owns or administers the expected team, otherwise uniform 403 access denial',
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
              'organization_context_changed: the reader still owns or administers the expected team but the session switched to another organization; reload the page before trying again',
            content: json(ErrorBody),
          },
        },
      }),
      async (c) => {
        const expectedOrganizationId = c.req.valid('header')['x-expected-organization-id']
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
