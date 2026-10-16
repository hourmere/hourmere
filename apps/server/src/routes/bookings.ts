import { createRoute, z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import {
  cancelHostBooking,
  cancelManagedBooking,
  getHostBooking,
  getManagedBooking,
  LOCATION_KINDS,
  listHostBookings,
  MAX_PAGE_SIZE,
  type PublicContext,
  ResponsesSchema,
  rescheduleManagedBooking,
  type ServiceContext,
} from '@hourmere/scheduling'
import type { Context } from 'hono'
import { authenticated, ErrorBody, json, type RouteModule } from '../openapi.ts'
import { createRateLimiter, PUBLIC_RATE_LIMITS, type RateLimit, rateLimit } from '../rate-limit.ts'

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

export const Responses = ResponsesSchema.openapi('Responses', {
  description:
    "Answers to the event type's questions, keyed by question id: text for short_text, long_text and phone; one option for select; a list of options for multi_select; true or false for checkbox",
})

export const Booking = z
  .object({
    id: z.uuid(),
    eventTypeId: z.uuid().nullable(),
    status: z.enum(['confirmed', 'cancelled']),
    start: Instant,
    end: Instant,
    title: z.string(),
    location: BookingLocation.nullable(),
    responses: Responses,
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

export const BookingWithToken = z
  .object({
    booking: Booking,
    manageToken: z.string().nullable().openapi({
      description:
        "The secret of the invitee's manage link (https://<app>/booking#token=<token>), sent as X-Manage-Token to /api/v1/bookings/manage. Returned only once and never stored, so a replayed request (same Idempotency-Key) gets null.",
    }),
  })
  .openapi('BookingWithToken')

const CancelBody = z
  .strictObject({ reason: z.string().max(1000).optional() })
  .openapi('CancelBooking')

const BookingPage = z
  .object({
    data: z.array(Booking),
    nextCursor: z.string().nullable().openapi({
      description: 'Pass as `cursor` to get the next page; null on the last page',
    }),
  })
  .openapi('BookingPage')

const error = (description: string) => ({ description, content: json(ErrorBody) })

/** Invitee data behind a secret: keep it out of shared caches and history. */
export const noStore = (c: Context) => c.header('Cache-Control', 'no-store')

const ManageToken = z.object({
  'x-manage-token': z.string().optional().openapi({
    description:
      "The secret from the invitee's link (the `token` in https://<app>/booking#token=…). A missing or unknown token gets 404 `booking_not_found`.",
  }),
})
const manageNotFound = error('Missing or unknown manage token (`booking_not_found`)')
const rateLimited = error('Too many requests from this address (`rate_limited`); see Retry-After')
const hostNotFound = error(
  'No such booking among those the caller hosts in this organization (`booking_not_found`)',
)
const unauthorized = error('No valid session or API key')

export interface BookingRoutesDeps {
  db: Db
  now?: () => Temporal.Instant
  /** Replaces PUBLIC_RATE_LIMITS.manage, e.g. in tests. */
  rateLimits?: Partial<Record<keyof typeof PUBLIC_RATE_LIMITS, RateLimit>>
}

/**
 * /api/v1/bookings: the invitee's manage endpoints (unauthenticated, token in the
 * X-Manage-Token header, rate limited per client IP) and the host's bookings
 * (authenticated, scoped to the caller's organization).
 */
export function bookingRoutes({
  db,
  now = () => Temporal.Now.instant(),
  rateLimits = {},
}: BookingRoutesDeps): RouteModule {
  const publicContext: PublicContext = { db, now }
  const manageLimit = rateLimit(createRateLimiter(rateLimits.manage ?? PUBLIC_RATE_LIMITS.manage))

  return ({ app, caller }) => {
    const context = (principal: ServiceContext['principal']): ServiceContext => ({
      db,
      principal,
      now,
    })

    // Registered before /api/v1/bookings/{id}…: Hono runs matching routes in registration
    // order, and "manage" would otherwise be taken for an id (and need a caller).
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/bookings/manage',
        summary: "The booking behind an invitee's manage token",
        middleware: manageLimit,
        request: { headers: ManageToken },
        responses: {
          200: { description: 'The booking', content: json(Booking) },
          404: manageNotFound,
          429: rateLimited,
        },
      }),
      async (c) => {
        const booking = await getManagedBooking(
          publicContext,
          c.req.valid('header')['x-manage-token'],
        )
        noStore(c)
        return c.json(booking, 200)
      },
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/bookings/manage/cancel',
        summary: 'Cancel with the manage token',
        middleware: manageLimit,
        request: {
          headers: ManageToken,
          body: { content: json(CancelBody), required: false },
        },
        responses: {
          200: { description: 'The cancelled booking', content: json(Booking) },
          400: error('Invalid request'),
          404: manageNotFound,
          409: error(
            'Already cancelled (`booking_cancelled`) or already started (`booking_in_past`)',
          ),
          429: rateLimited,
        },
      }),
      async (c) => {
        const { reason } = (c.req.valid('json') as z.infer<typeof CancelBody> | undefined) ?? {}
        const booking = await cancelManagedBooking(
          publicContext,
          c.req.valid('header')['x-manage-token'],
          { reason },
        )
        noStore(c)
        return c.json(booking, 200)
      },
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/bookings/manage/reschedule',
        summary: 'Reschedule with the manage token',
        description:
          'Cancels the booking and books the new time in one step. The new time may overlap the old one. Returns the new booking and its manage token; the old token then shows the cancelled booking.',
        middleware: manageLimit,
        request: {
          headers: ManageToken,
          body: {
            content: json(z.strictObject({ start: Instant }).openapi('Reschedule')),
            required: true,
          },
        },
        responses: {
          200: { description: 'The new booking', content: json(BookingWithToken) },
          400: error('Invalid request'),
          404: manageNotFound,
          409: error(
            'Already cancelled (`booking_cancelled`), already started (`booking_in_past`), the event type no longer takes bookings (`event_type_unavailable`), or the time is not offered (`slot_unavailable`, `slot_taken`)',
          ),
          429: rateLimited,
        },
      }),
      async (c) => {
        const result = await rescheduleManagedBooking(
          publicContext,
          c.req.valid('header')['x-manage-token'],
          { start: Temporal.Instant.from(c.req.valid('json').start) },
        )
        noStore(c)
        return c.json(result, 200)
      },
    )

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
          400: error('Invalid parameters (`invalid_request`, `invalid_range`, `invalid_cursor`)'),
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
          404: hostNotFound,
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
          400: error('Invalid request'),
          401: unauthorized,
          404: hostNotFound,
          409: error(
            'Already cancelled (`booking_cancelled`) or already started (`booking_in_past`)',
          ),
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
