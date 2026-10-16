import { createRoute, z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import {
  cancelHostBooking,
  getHostBooking,
  LOCATION_KINDS,
  listHostBookings,
  MAX_PAGE_SIZE,
  type ServiceContext,
} from '@hourmere/scheduling'
import { authenticated, ErrorBody, json, type RouteModule } from '../openapi.ts'

// Schemas shared with the public routes (public.ts).

export const Instant = z.iso.datetime({ offset: true }).openapi({
  description: 'An instant (RFC 3339). Responses always use UTC with a Z suffix.',
  example: '2026-11-02T09:00:00.000Z',
})

export const LocationKind = z.enum(LOCATION_KINDS)

export const BookingLocation = z.looseObject({ kind: LocationKind }).openapi('BookingLocation', {
  description:
    'Where the meeting happens. Details depend on the kind: `number` (phone), `address` (in_person), `url` (link)',
})

const Attendee = z
  .object({
    name: z.string(),
    email: z.string(),
    timeZone: z.string().openapi({ description: 'IANA time zone' }),
    locale: z.string().nullable(),
    isBooker: z.boolean().openapi({
      description: 'The invitee who made the booking; the others are guests they added',
    }),
  })
  .openapi('Attendee')

export const ResponseValue = z.union([z.string(), z.array(z.string()), z.boolean()])

export const Booking = z
  .object({
    id: z.uuid(),
    eventTypeId: z.uuid().nullable(),
    status: z.enum(['confirmed', 'cancelled']),
    start: Instant,
    end: Instant,
    title: z.string(),
    location: BookingLocation.nullable(),
    responses: z.record(z.string(), ResponseValue).openapi({
      description: "Answers to the event type's questions, keyed by question id",
    }),
    attendees: z.array(Attendee).openapi({ description: 'The invitee first, then guests' }),
    rescheduledFromId: z.uuid().nullable().openapi({
      description: 'The booking this one replaced when it was rescheduled',
    }),
    cancelledAt: Instant.nullable(),
    cancelReason: z.string().nullable(),
    source: z.enum(['web', 'embed', 'api', 'mcp']).openapi({
      description: 'How the booking was made; api and mcp are agents',
    }),
    createdAt: Instant,
  })
  .openapi('Booking')

export const CancelBody = z
  .object({ reason: z.string().max(1000).optional() })
  .openapi('CancelBooking')

const BookingPage = z
  .object({
    bookings: z.array(Booking),
    nextCursor: z.string().nullable().openapi({
      description: 'Pass as `cursor` to get the next page; null on the last page',
    }),
  })
  .openapi('BookingPage')

const notFound = {
  description:
    'No such booking among those the caller hosts in this organization (`booking_not_found`)',
  content: json(ErrorBody),
}
const unauthorized = { description: 'No valid session or API key', content: json(ErrorBody) }

/** The host's bookings: authenticated, scoped to the caller's organization. */
export function bookingRoutes({
  db,
  now = () => Temporal.Now.instant(),
}: {
  db: Db
  now?: () => Temporal.Instant
}): RouteModule {
  return ({ app, caller }) => {
    const context = (principal: ServiceContext['principal']): ServiceContext => ({
      db,
      principal,
      now,
    })

    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/bookings',
        summary: 'Bookings the caller hosts',
        description:
          'Bookings in the organization the caller acts in where the caller is a host, ordered by start time. Paginated with a cursor: pass `nextCursor` from one page as `cursor` for the next (keep the other parameters the same).',
        security: authenticated,
        middleware: caller,
        request: {
          query: z.object({
            from: Instant.optional().openapi({ description: 'Only bookings starting at or after' }),
            to: Instant.optional().openapi({ description: 'Only bookings starting before' }),
            status: z.enum(['confirmed', 'cancelled']).optional(),
            limit: z.coerce
              .number()
              .int()
              .min(1)
              .max(MAX_PAGE_SIZE)
              .optional()
              .openapi({ description: `Page size, 1–${MAX_PAGE_SIZE} (default 50)` }),
            cursor: z.string().optional(),
          }),
        },
        responses: {
          200: { description: 'A page of bookings', content: json(BookingPage) },
          400: {
            description:
              'Invalid parameters (`invalid_request`, `invalid_range`, `invalid_cursor`)',
            content: json(ErrorBody),
          },
          401: unauthorized,
        },
      }),
      async (c) => {
        const q = c.req.valid('query')
        const page = await listHostBookings(context(c.var.principal), {
          from: q.from === undefined ? undefined : Temporal.Instant.from(q.from),
          to: q.to === undefined ? undefined : Temporal.Instant.from(q.to),
          status: q.status,
          limit: q.limit,
          cursor: q.cursor,
        })
        return c.json(page, 200)
      },
    )

    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/bookings/{id}',
        summary: 'A booking the caller hosts',
        security: authenticated,
        middleware: caller,
        request: { params: z.object({ id: z.uuid() }) },
        responses: {
          200: { description: 'The booking', content: json(Booking) },
          401: unauthorized,
          404: notFound,
        },
      }),
      async (c) =>
        c.json(await getHostBooking(context(c.var.principal), c.req.valid('param').id), 200),
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/bookings/{id}/cancel',
        summary: 'Cancel a booking the caller hosts',
        security: authenticated,
        middleware: caller,
        request: {
          params: z.object({ id: z.uuid() }),
          body: { content: json(CancelBody), required: false },
        },
        responses: {
          200: { description: 'The cancelled booking', content: json(Booking) },
          400: { description: 'Invalid request', content: json(ErrorBody) },
          401: unauthorized,
          404: notFound,
          409: {
            description:
              'Already cancelled (`booking_cancelled`) or already started (`booking_in_past`)',
            content: json(ErrorBody),
          },
        },
      }),
      async (c) => {
        const { reason } = (c.req.valid('json') as z.infer<typeof CancelBody> | undefined) ?? {}
        const booking = await cancelHostBooking(context(c.var.principal), c.req.valid('param').id, {
          reason,
        })
        return c.json(booking, 200)
      },
    )
  }
}
