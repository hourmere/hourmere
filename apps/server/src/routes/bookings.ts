import { createRoute, z } from '@hono/zod-openapi'
import { retryBookingConference } from '@hourmere/calendars'
import type { Db } from '@hourmere/db'
import {
  type BookingNotifier,
  cancelHostBooking,
  cancelManagedBooking,
  getHostBooking,
  getManagedBookingDetails,
  LOCATION_KINDS,
  listHostBookings,
  listManagedSlots,
  MAX_PAGE_SIZE,
  MAX_SLOT_RANGE_DAYS,
  type PublicContext,
  ResponsesSchema,
  rescheduleManagedBooking,
  type ServiceContext,
} from '@hourmere/scheduling'
import { authenticated, ErrorBody, json, type RouteModule } from '../openapi.ts'
import { createRateLimiter, PUBLIC_RATE_LIMITS, type RateLimit, rateLimit } from '../rate-limit.ts'

// Schemas shared with the public routes (public.ts).

/** Whether Temporal (and so every service) can read it: e.g. at most nine fractional digits. */
const isTemporalInstant = (value: string) => {
  try {
    Temporal.Instant.from(value)
    return true
  } catch {
    return false
  }
}

export const Instant = z.iso
  .datetime({ offset: true })
  .refine(isTemporalInstant, 'must be an instant with at most nine fractional digits')
  .openapi({
    description:
      'An instant (RFC 3339, up to nine fractional digits; stored with microsecond precision). Responses always use UTC with a Z suffix.',
    example: '2026-11-02T09:00:00.000Z',
  })

export const LocationKind = z.enum(LOCATION_KINDS)

/** A bookable time: public slots and the times a booking can move to. */
export const Slot = z.object({ start: Instant, end: Instant }).openapi('Slot')

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
    conference: z
      .object({
        provider: z.literal('google_meet'),
        status: z.enum(['pending', 'ready', 'failed']),
        errorCode: z.string().max(64).nullable(),
      })
      .optional(),
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
    assignedHost: z
      .object({ name: z.string(), timeZone: z.string() })
      .nullable()
      .optional()
      .openapi({
        description:
          'The actual round-robin winner; no private host identity or availability mapping',
      }),
  })
  .openapi('Booking')

export const ManagedBooking = Booking.extend({
  eventType: z.object({ title: z.string(), durationMinutes: z.number().int() }).nullable().openapi({
    description: 'The event type as it is now; null once it is deleted',
  }),
  hosts: z.array(z.object({ name: z.string() })).openapi({
    description: "Who the invitee meets: each host's name",
  }),
}).openapi('ManagedBooking')

export const BookingWithToken = z
  .object({
    booking: Booking,
    manageToken: z.string().nullable().openapi({
      description:
        "The booking's own manage token (it stays with this booking; emails carry their own), sent as X-Manage-Token to /api/v1/bookings/manage. Returned only once and never stored, so a replayed request (same Idempotency-Key) gets null.",
    }),
  })
  .openapi('BookingWithToken')

export const CancelBody = z
  .strictObject({ reason: z.string().max(1000).optional() })
  .openapi('CancelBooking')

export const BookingPage = z
  .object({
    data: z.array(Booking),
    nextCursor: z.string().nullable().openapi({
      description: 'Pass as `cursor` to get the next page; null on the last page',
    }),
  })
  .openapi('BookingPage')

/** Filters and paging for the host's bookings (GET /api/v1/bookings, MCP list_bookings). */
export const ListBookingsQuery = z.object({
  order: z.enum(['asc', 'desc']).optional().openapi({
    description: 'Order by start time and id: asc (default) or desc. Keep unchanged between pages.',
  }),
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
})

const error = (description: string) => ({ description, content: json(ErrorBody) })

const ManageToken = z.object({
  'x-manage-token': z.string().optional().openapi({
    description:
      "The invitee's secret: the `manageToken` the booking API returned, or the `token` in a link from a booking email (https://<app>/booking#token=…). A missing or unknown token gets 404 `booking_not_found`. After a reschedule, the token returned for the old booking shows that cancelled booking, while tokens from emails open the booking that replaced it.",
  }),
})
const manageNotFound = error('Missing or unknown manage token (`booking_not_found`)')
const rateLimited = error('Too many requests from this address (`rate_limited`); see Retry-After')
const hostNotFound = error(
  'No such booking among those the caller hosts in this organization (`booking_not_found`)',
)
const unauthorized = error('No valid session or API key')
const keyRateLimited = error(
  "The API key's rate limit is used up (`rate_limited`); see Retry-After",
)
const crossOrigin = error(
  'A cookie-authenticated write that does not come from the app itself (`forbidden`)',
)
const invalidId = error('The id is not a UUID (`invalid_request`)')
const invalidCancel = error(
  'Invalid request (`invalid_request`), or a reason over 1000 characters or with control characters (`invalid_reason`)',
)

export interface BookingRoutesDeps {
  db: Db
  automaticMeet?: boolean | undefined
  now?: () => Temporal.Instant
  /** Queues the booking emails in the transaction of each change; none are sent without it. */
  notify?: BookingNotifier | undefined
  /** Replaces PUBLIC_RATE_LIMITS.manage (and .slots for the reschedule slots), e.g. in tests. */
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
  notify,
  automaticMeet,
  rateLimits = {},
}: BookingRoutesDeps): RouteModule {
  const publicContext: PublicContext = { db, now, notify, automaticMeet }
  const manageLimit = rateLimit(createRateLimiter(rateLimits.manage ?? PUBLIC_RATE_LIMITS.manage))
  // Picking a new time pages through months of slots, so it counts like public slots.
  const manageSlotsLimit = rateLimit(
    createRateLimiter(rateLimits.slots ?? PUBLIC_RATE_LIMITS.slots),
  )

  return ({ app, caller }) => {
    const context = (principal: ServiceContext['principal']): ServiceContext => ({
      db,
      principal,
      now,
      notify,
      automaticMeet,
    })

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/bookings/{id}/conference/retry',
        security: authenticated,
        middleware: caller,
        tags: ['Bookings'],
        summary: 'Retry safe conference reconciliation for an assigned host',
        request: {
          params: z.object({ id: z.uuid() }),
          body: { required: true, content: json(z.strictObject({})) },
        },
        responses: {
          204: { description: 'Durable reconciliation requested' },
          400: invalidId,
          401: unauthorized,
          403: crossOrigin,
          404: { description: 'No such booking or conference', content: json(ErrorBody) },
          409: { description: 'conference_not_retryable', content: json(ErrorBody) },
        },
      }),
      async (c) => {
        // Hono can skip JSON validation when Content-Type is absent. The documented
        // empty-object command still requires JSON, after authentication/CSRF checks.
        if (
          c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
          'application/json'
        )
          return c.json({ error: 'invalid_request', message: 'Send an empty JSON object.' }, 400)
        await retryBookingConference(context(c.var.principal), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
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
          200: {
            description: 'The booking, with its event type and hosts',
            content: json(ManagedBooking),
          },
          404: manageNotFound,
          429: rateLimited,
        },
      }),
      async (c) => {
        const booking = await getManagedBookingDetails(
          publicContext,
          c.req.valid('header')['x-manage-token'],
        )
        return c.json(booking, 200)
      },
    )

    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/bookings/manage/slots',
        summary: 'Times the booking can move to',
        description: `The slots the booking behind the manage token can be rescheduled to, fully inside [start, end]: its event type's slots with the booking itself ignored, so they may overlap its current time. The same range limits as public slots (at most ${MAX_SLOT_RANGE_DAYS} days).`,
        middleware: manageSlotsLimit,
        request: {
          headers: ManageToken,
          query: z.object({ start: Instant, end: Instant }),
        },
        responses: {
          200: {
            description: 'Slots, sorted by start',
            content: json(z.object({ data: z.array(Slot) })),
          },
          400: error(
            'Invalid parameters (`invalid_request`), end not after start (`invalid_range`), or a range that is too long (`range_too_long`)',
          ),
          404: manageNotFound,
          409: error(
            'Already cancelled (`booking_cancelled`), already started (`booking_in_past`), the event type no longer takes bookings (`event_type_unavailable`) or the booking has no host (`booking_has_no_host`)',
          ),
          429: rateLimited,
        },
      }),
      async (c) => {
        const { start, end } = c.req.valid('query')
        const slots = await listManagedSlots(
          publicContext,
          c.req.valid('header')['x-manage-token'],
          {
            start: Temporal.Instant.from(start),
            end: Temporal.Instant.from(end),
          },
        )
        return c.json({ data: slots }, 200)
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
          400: invalidCancel,
          404: manageNotFound,
          409: error(
            "Already cancelled (`booking_cancelled`), already started (`booking_in_past`), or, with an email's token, the meeting kept being rescheduled while the request waited (`booking_changed`; try again)",
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
        return c.json(booking, 200)
      },
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/bookings/manage/reschedule',
        summary: 'Reschedule with the manage token',
        description:
          'Cancels the booking and books the new time in one step. The new time may overlap the old one. Returns the new booking and its manage token. The token returned for the old booking then shows the cancelled booking, so a retry after a lost response gets 409 `booking_cancelled`; tokens from booking emails open the new booking (and would move it again).',
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
            "Already cancelled (`booking_cancelled`), already started (`booking_in_past`), without a host (`booking_has_no_host`), the event type no longer takes bookings (`event_type_unavailable`), the time is not offered (`slot_unavailable`, `slot_taken`), or, with an email's token, the meeting kept being rescheduled while the request waited (`booking_changed`; try again)",
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
        return c.json(result, 200)
      },
    )

    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/bookings',
        summary: 'Bookings the caller hosts',
        description:
          'Bookings in the organization the caller acts in where the caller is a host, ordered by start time and id, ascending by default. Use order=desc for newest first. Paginated with a cursor: pass `nextCursor` from one page as `cursor` for the next (keep the other parameters, including order, the same).',
        security: authenticated,
        middleware: caller,
        request: { query: ListBookingsQuery },
        responses: {
          200: { description: 'A page of bookings', content: json(BookingPage) },
          400: error('Invalid parameters (`invalid_request`, `invalid_range`, `invalid_cursor`)'),
          401: unauthorized,
          429: keyRateLimited,
        },
      }),
      async (c) => {
        const q = c.req.valid('query')
        const page = await listHostBookings(context(c.var.principal), {
          order: q.order,
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
          400: invalidId,
          401: unauthorized,
          404: hostNotFound,
          429: keyRateLimited,
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
          400: invalidCancel,
          401: unauthorized,
          403: crossOrigin,
          404: hostNotFound,
          409: error(
            'Already cancelled (`booking_cancelled`) or already started (`booking_in_past`)',
          ),
          429: keyRateLimited,
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
