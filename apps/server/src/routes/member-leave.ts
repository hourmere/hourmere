import { createRoute, z } from '@hono/zod-openapi'
import { MemberDepartureBlockedError } from '@hourmere/auth'
import { leaveTeamMember, MemberDepartureImpactSchema } from '@hourmere/scheduling'
import {
  ErrorBody,
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'
import { EXPECTED_ORGANIZATION_HEADER, organizationContextWriteLock } from '../team-management.ts'
import { DepartureImpact } from './member-departure-impact.ts'

const Handling = z.object({
  eventTypes: z.literal('ask_admin_to_replace_or_remove_host'),
  futureBookings: z.literal('coordinate_cancellation'),
  inProgressBookings: z.literal('wait_until_end_or_coordinate_offline'),
})

export function memberLeaveRoutes(deps: ServiceDeps): RouteModule {
  return ({ app, caller }) => {
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/teams/{teamId}/leave',
        summary: 'Leave a team after resolving event types and unfinished bookings',
        description:
          'Requires a verified browser session and X-Expected-Organization-Id matching this team and the current session. Rechecks departure impact inside the locked membership transaction. A blocked departure returns the first impact pages, counts and handling steps; use the departure-impact read to page remaining items. With no impact, revokes membership and returns the personal organization.',
        tags: ['Team members'],
        security: [{ session: [] }],
        middleware: caller,
        request: {
          params: z.strictObject({ teamId: z.uuid() }),
          headers: z.object({ 'X-Expected-Organization-Id': z.string().optional() }),
          body: { required: true, content: json(z.strictObject({})) },
        },
        responses: {
          200: {
            description: 'Membership revoked; personal organization active',
            content: json(z.object({ organizationId: z.uuid() })),
          },
          ...errorResponses({ 400: 'Invalid parameters', 403: 'team_management_access_denied' }),
          409: {
            description:
              'member_departure_blocked with impact/handling, or organization_context_changed: reload before retrying',
            content: json(
              ErrorBody.extend({
                impact: DepartureImpact.optional(),
                handling: Handling.optional(),
              }),
            ),
          },
        },
      }),
      async (c) => {
        try {
          const result = await leaveTeamMember(
            {
              ...serviceContext(deps, c.var.principal),
              authorizeOrganizationWrite: organizationContextWriteLock(c.var.principal),
            },
            {
              teamId: c.req.valid('param').teamId,
              expectedOrganizationId: c.req.header(EXPECTED_ORGANIZATION_HEADER) ?? '',
            },
          )
          return c.json(result, 200)
        } catch (error) {
          if (!(error instanceof MemberDepartureBlockedError)) throw error
          return c.json(
            {
              error: error.code,
              message: error.message,
              impact: MemberDepartureImpactSchema.parse(error.impact),
              handling: error.handling,
            },
            409,
          )
        }
      },
    )
  }
}
