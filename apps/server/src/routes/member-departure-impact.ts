import { createRoute, z } from '@hono/zod-openapi'
import {
  getTeamMemberDepartureImpact,
  MemberDepartureBookingSchema,
  MemberDepartureEventTypeSchema,
  MemberDepartureImpactSchema,
  TeamAdminBookingSchema,
} from '@hourmere/scheduling'
import { ErrorBody, json, type RouteModule, type ServiceDeps, serviceContext } from '../openapi.ts'
import { teamManagementAccess } from '../team-management.ts'

// Internal schemas detect leaks. Published objects stay open for additive v1 fields,
// including every nested booking object inherited from the administration whitelist.
const DepartureEventType = z.object(MemberDepartureEventTypeSchema.shape)
const DepartureBooking = z.object({
  ...MemberDepartureBookingSchema.shape,
  eventType: z.object(TeamAdminBookingSchema.shape.eventType.unwrap().shape).nullable(),
  hosts: z.array(z.object(TeamAdminBookingSchema.shape.hosts.element.shape)),
  attendees: z.array(z.object(TeamAdminBookingSchema.shape.attendees.element.shape)),
})
export const DepartureImpact = z
  .object({
    ...MemberDepartureImpactSchema.shape,
    eventTypes: z.object({
      ...MemberDepartureImpactSchema.shape.eventTypes.shape,
      data: z.array(DepartureEventType),
    }),
    bookings: z.object({
      ...MemberDepartureImpactSchema.shape.bookings.shape,
      data: z.array(DepartureBooking),
    }),
  })
  .openapi('MemberDepartureImpact')

const DepartureQuery = z.strictObject({
  teamId: z.uuid(),
  eventTypesLimit: z.coerce.number().int().min(1).max(100).optional(),
  eventTypesCursor: z.string().max(1024).optional(),
  bookingsLimit: z.coerce.number().int().min(1).max(100).optional(),
  bookingsCursor: z.string().max(1024).optional(),
})

export function memberDepartureImpactRoutes(deps: ServiceDeps): RouteModule {
  return ({ app, caller }) => {
    const access = teamManagementAccess(deps.db, caller)
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/team/members/{memberUserId}/departure-impact',
        summary: "Event types and unfinished bookings affected by a member's departure",
        description:
          'Requires a current verified browser session in the requested team. Members can inspect themselves; owners and admins can inspect current members of their team. Any Authorization header, including empty, malformed, API-key or MCP OAuth values, is denied even with a valid session cookie. Missing or invalid sessions and inaccessible teams or members receive the same 403 team_management_access_denied without revealing their existence. Each collection has an independent cursor and totalCount, with a default limit of 50 and maximum 100. Event types are ordered by id and include remainingHostCount, the number of other current verified team hosts; zero identifies a round-robin pool left without a host. Bookings are ordered by precise stored start time and id. Confirmed bookings ending after evaluatedAt include those in progress. In-progress bookings require waiting until they end or coordinating offline; this read does not relax cancellation rules or authorize a departure. Results and counts are recalculated on every request; keep team, member and limits unchanged while following cursors.',
        tags: ['Team members'],
        security: [{ session: [] }],
        middleware: access.memberReadMiddleware,
        request: {
          params: z.strictObject({ memberUserId: z.uuid() }),
          query: DepartureQuery,
        },
        responses: {
          200: { description: 'Current departure impact', content: json(DepartureImpact) },
          400: {
            description: 'Invalid parameters (invalid_request, invalid_cursor or invalid_limit)',
            content: json(ErrorBody),
          },
          403: {
            description:
              'team_management_access_denied: requires a current team session without Authorization and an accessible member',
            content: json(ErrorBody),
          },
        },
      }),
      async (c) => {
        const impact = await getTeamMemberDepartureImpact(serviceContext(deps, c.var.principal), {
          ...c.req.valid('query'),
          memberUserId: c.req.valid('param').memberUserId,
        })
        return c.json(impact, 200)
      },
    )
  }
}
