import { createRoute, z } from '@hono/zod-openapi'
import { MemberDepartureBlockedError, MemberDepartureOwnerRequiredError } from '@hourmere/auth'
import { leaveTeamMember, MemberDepartureImpactSchema } from '@hourmere/scheduling'
import { ErrorBody, json, type RouteModule, type ServiceDeps, serviceContext } from '../openapi.ts'
import {
  EXPECTED_ORGANIZATION_HEADER,
  organizationContextWriteLock,
  teamManagementSessionCaller,
} from '../team-management.ts'
import { DepartureImpact } from './member-departure-impact.ts'

const Handling = z.object({
  eventTypes: z.literal('ask_admin_to_replace_or_remove_host').optional(),
  futureBookings: z.literal('coordinate_cancellation').optional(),
  inProgressBookings: z.literal('wait_until_end_or_coordinate_offline').optional(),
  owner: z.literal('another_owner_is_needed_before_you_can_leave').optional(),
})

export function memberLeaveRoutes(deps: ServiceDeps): RouteModule {
  return ({ app, caller }) => {
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/teams/{teamId}/leave',
        summary: 'Leave a team after resolving event types and unfinished bookings',
        description:
          'Requires a verified browser session and X-Expected-Organization-Id matching this team and the current session. Any Authorization header, including empty, malformed, API-key or MCP OAuth values, is denied before credentials are resolved, even with a valid session cookie. Missing or invalid sessions receive the same 403 team_management_access_denied without a WWW-Authenticate challenge. Rechecks owner continuity and departure impact inside the locked membership transaction. A sole owner must arrange another owner before leaving. A blocked departure returns the first impact pages, counts and handling steps; use the departure-impact read to page remaining items. With no impact, revokes membership and returns the personal organization.',
        tags: ['Team members'],
        security: [{ session: [] }],
        middleware: teamManagementSessionCaller(caller),
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
          400: { description: 'Invalid parameters', content: json(ErrorBody) },
          403: {
            description:
              'team_management_access_denied: requires a current team session without Authorization',
            content: json(ErrorBody),
          },
          409: {
            description:
              'member_departure_blocked with impact/handling, member_departure_owner_required with handling.owner (another owner is needed before you can leave), or organization_context_changed: reload before retrying',
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
          if (error instanceof MemberDepartureOwnerRequiredError) {
            return c.json(
              { error: error.code, message: error.message, handling: error.handling },
              409,
            )
          }
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
