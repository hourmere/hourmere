import { createRoute, z } from '@hono/zod-openapi'
import {
  type BookingNotifier,
  cancelTeamAdminBooking,
  listTeamAdminBookings,
  TeamAdminBookingPageSchema,
  TeamAdminBookingSchema,
} from '@hourmere/scheduling'
import {
  ErrorBody,
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'
import {
  EXPECTED_ORGANIZATION_HEADER,
  ORGANIZATION_CONTEXT_CHANGED,
  teamManagementAccess,
} from '../team-management.ts'
import { CancelBody, ListBookingsQuery } from './bookings.ts'

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
const TeamBookingCancellation = z
  .object({ cancelled: z.boolean() })
  .openapi('TeamBookingCancellation')

/** Team administration uses browser sessions and the shared current-team access check. */
export function teamBookingRoutes(
  deps: ServiceDeps & { notify?: BookingNotifier | undefined },
): RouteModule {
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
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/team/bookings/{id}/cancel',
        summary: "Cancel a booking of the session's current team",
        description:
          'Requires a current verified team owner/admin browser session and a same-origin Origin or Referer. X-Expected-Organization-Id must match the team where the action started and the current session team. Cancels only a booking in that team before its start, queues the normal cancellation notifications, and preserves its saved hosts and conference organizer. Success returns {cancelled:true}; a retry after a committed cancellation returns 409 booking_already_cancelled without sending notifications again. Missing, inaccessible and already-started targets share team_management_access_denied. API keys and MCP OAuth tokens have no team-management access, including alongside a session cookie. This grants no host reschedule or private conference retry authority.',
        tags: ['Team bookings'],
        security: [{ session: [] }],
        middleware: access.middleware,
        request: {
          params: z.object({ id: z.uuid() }),
          // Optional in validation so missing context receives the recoverable 409 below.
          headers: z.object({
            'x-expected-organization-id': z
              .string()
              .optional()
              .openapi({
                description: 'Required: the organization where this cancellation action started',
                param: { required: true },
              }),
          }),
          body: { content: json(CancelBody), required: false },
        },
        responses: {
          200: {
            description: 'The team booking was cancelled',
            content: json(TeamBookingCancellation),
          },
          ...errorResponses({
            400: 'Invalid parameters (invalid_request or invalid_reason)',
            403: 'team_management_access_denied: requires a current team owner/admin and an accessible cancellable booking; forbidden: cookie writes require same-origin Origin or Referer',
            409: `${ORGANIZATION_CONTEXT_CHANGED}; booking_already_cancelled: this team's booking is already cancelled`,
          }),
        },
      }),
      async (c) => {
        const { reason } = (c.req.valid('json') as z.infer<typeof CancelBody> | undefined) ?? {}
        const expectedOrganizationId = c.req.header(EXPECTED_ORGANIZATION_HEADER) ?? ''
        const { notify } = deps
        if (!notify) throw new Error('Team booking cancellation requires a notifier')
        await access.write(
          c.var.principal,
          c.var.principal.organization.id,
          (trx, actor) =>
            cancelTeamAdminBooking(
              trx,
              actor,
              c.req.valid('param').id,
              deps.now ?? Temporal.Now.instant,
              {
                expectedOrganizationId,
                reason,
                notify,
              },
            ),
          { expectedOrganizationId },
        )
        return c.json({ cancelled: true }, 200)
      },
    )
  }
}
