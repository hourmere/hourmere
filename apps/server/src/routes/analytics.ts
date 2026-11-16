import { createRoute, z } from '@hono/zod-openapi'
import { getBookingActivity, MAX_ANALYTICS_DAYS } from '@hourmere/scheduling'
import {
  authenticated,
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'

const Counts = z.object({
  created: z.number().int().nonnegative(),
  rescheduled: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  noShows: z.number().int().nonnegative().openapi({
    description:
      'Attendees (invitees, guests and group seats, each counted once) currently marked as no-shows on bookings that are still confirmed, by the local date of the scheduled start. Cancelled and rescheduled-away bookings are excluded. Clients must tolerate its absence on older servers.',
  }),
})
export const BookingActivity = z
  .object({
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    timeZone: z.string(),
    totals: Counts,
    data: z.array(Counts.extend({ date: z.iso.date() })).max(MAX_ANALYTICS_DAYS),
  })
  .openapi('BookingActivity')

export function analyticsRoutes(deps: ServiceDeps): RouteModule {
  return ({ app, caller }) => {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/analytics/bookings',
        summary: 'Daily booking activity of the acting organization',
        description:
          'Counts initial creations, reschedule operations and actual cancellations by their stored operation dates in an IANA time zone. Both dates inclusive, at most 90 local dates. Reschedule withdrawals are excluded from cancellations. noShows counts currently marked attendees on still-confirmed bookings by the scheduled start date instead. Based on currently retained rows; deletion can alter history. No traffic or conversion metrics. Also available as MCP get_booking_activity and CLI booking-activity.',
        tags: ['Analytics'],
        security: authenticated,
        middleware: caller,
        request: {
          query: z.strictObject({
            startDate: z.iso.date(),
            endDate: z.iso.date(),
            timeZone: z.string().min(1).max(64),
          }),
        },
        responses: {
          200: {
            description: 'Totals and zero-filled daily counts, ordered by date',
            content: json(BookingActivity),
          },
          ...errorResponses({
            400: 'invalid_request, invalid_time_zone or invalid_analytics_range',
            403: 'insufficient_role: requires the personal owner or a team owner/admin',
          }),
        },
      }),
      async (c) =>
        c.json(
          await getBookingActivity(serviceContext(deps, c.var.principal), c.req.valid('query')),
          200,
        ),
    )
  }
}
