import { createRoute, z } from '@hono/zod-openapi'
import {
  listTeamAdminBookings,
  TeamAdminBookingPageSchema,
  TeamAdminBookingSchema,
} from '@hourmere/scheduling'
import { ErrorBody, json, type RouteModule, type ServiceDeps, serviceContext } from '../openapi.ts'
import { teamManagementAccess } from '../team-management.ts'
import { ListBookingsQuery } from './bookings.ts'

// Published responses remain extensible within v1; the mapper's shared schemas retain
// their strict privacy whitelist, including nested objects.
const TeamAdminBooking = z
  .object({
    ...TeamAdminBookingSchema.shape,
    eventType: z.object(TeamAdminBookingSchema.shape.eventType.unwrap().shape).nullable(),
    hosts: z.array(z.object(TeamAdminBookingSchema.shape.hosts.element.shape)),
    attendees: z.array(z.object(TeamAdminBookingSchema.shape.attendees.element.shape)),
  })
  .openapi('TeamAdminBooking')
const TeamAdminBookingPage = z
  .object({
    ...TeamAdminBookingPageSchema.shape,
    data: z.array(TeamAdminBooking),
  })
  .openapi('TeamAdminBookingPage')

/** Team administration uses browser sessions and the shared current-team access check. */
export function teamBookingRoutes(deps: ServiceDeps): RouteModule {
  return ({ app, caller }) => {
    const access = teamManagementAccess(deps.db, caller)
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/team/bookings',
        summary: "Bookings of the session's current team",
        description:
          'Requires a current verified team owner/admin browser session. Any Authorization header selects API-key/OAuth authentication and is denied, even with a valid session cookie. Missing sessions and ineligible callers receive the same 403 team_management_access_denied without revealing team existence. Includes bookings hosted by other team members, with only the team-administration field whitelist. Ordered by start time and id, ascending by default. Pass nextCursor as cursor with the same filters and order for the next page. Collective bookings appear once. Personal organizations are excluded.',
        tags: ['Team bookings'],
        security: [{ session: [] }],
        middleware: access.middleware,
        request: { query: ListBookingsQuery },
        responses: {
          200: { description: 'A page of team bookings', content: json(TeamAdminBookingPage) },
          400: {
            description: 'Invalid parameters (invalid_request, invalid_range or invalid_cursor)',
            content: json(ErrorBody),
          },
          403: {
            description:
              'team_management_access_denied: requires a current team owner/admin session without Authorization',
            content: json(ErrorBody),
          },
        },
      }),
      async (c) => {
        const q = c.req.valid('query')
        const page = await listTeamAdminBookings(serviceContext(deps, c.var.principal), {
          order: q.order,
          from: q.from === undefined ? undefined : Temporal.Instant.from(q.from),
          to: q.to === undefined ? undefined : Temporal.Instant.from(q.to),
          endAfter: q.endAfter === undefined ? undefined : Temporal.Instant.from(q.endAfter),
          endTo: q.endTo === undefined ? undefined : Temporal.Instant.from(q.endTo),
          status: q.status,
          limit: q.limit,
          cursor: q.cursor,
        })
        return c.json(page, 200)
      },
    )
  }
}
