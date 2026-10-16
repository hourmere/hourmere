import { createRoute, z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import {
  cancelManagedBooking,
  createPublicBooking,
  getManagedBooking,
  getPublicEventType,
  listPublicSlots,
  MAX_GUESTS,
  MAX_SLOT_RANGE_DAYS,
  type PublicContext,
  QUESTION_TYPES,
  rescheduleManagedBooking,
} from '@hourmere/scheduling'
import type { Context } from 'hono'
import { ErrorBody, json, type RouteModule } from '../openapi.ts'
import { createRateLimiter, PUBLIC_RATE_LIMITS, type RateLimit, rateLimit } from '../rate-limit.ts'
import { Booking, CancelBody, Instant, LocationKind, ResponseValue } from './bookings.ts'

const Question = z
  .object({
    id: z.string().openapi({ description: 'Key of the answer in `responses`' }),
    label: z.string(),
    type: z.enum(QUESTION_TYPES).openapi({
      description:
        'Answer type: text for short_text, long_text and phone; one option for select; a list of options for multi_select; true/false for checkbox (a required checkbox must be true)',
    }),
    required: z.boolean(),
    options: z.array(z.string()).optional().openapi({ description: 'For select and multi_select' }),
  })
  .openapi('Question')

const PublicEventType = z
  .object({
    handle: z.string(),
    slug: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    durationMinutes: z.number().int(),
    location: z.object({ kind: LocationKind }).nullable().openapi({
      description: 'Only the kind; details such as a phone number come with the booking',
    }),
    questions: z
      .array(Question)
      .openapi({ description: 'Booking-form fields beyond name and email' }),
    host: z.object({
      name: z.string(),
      timeZone: z.string().openapi({ description: "The host's IANA time zone" }),
    }),
  })
  .openapi('PublicEventType')

const Slot = z.object({ start: Instant, end: Instant }).openapi('Slot')

const Person = z.object({ name: z.string().min(1).max(200), email: z.email().max(254) })

const CreateBooking = z
  .object({
    start: Instant.openapi({ description: 'The start of an offered slot' }),
    invitee: Person.extend({
      timeZone: z.string().min(1).max(64).openapi({ description: 'IANA time zone' }),
      locale: z.string().max(35).optional(),
    }),
    guests: z.array(Person).max(MAX_GUESTS).optional(),
    responses: z.record(z.string(), ResponseValue).optional().openapi({
      description: "Answers to the event type's questions, keyed by question id",
    }),
  })
  .openapi('CreateBooking')

const BookingWithToken = z
  .object({
    booking: Booking,
    manageToken: z.string().nullable().openapi({
      description:
        "The secret of the invitee's manage link (/api/v1/bookings/manage/{token}). Returned only once: it is not stored, so a replayed request gets null.",
    }),
  })
  .openapi('BookingWithToken')

const PageParams = z.object({
  handle: z.string().openapi({ example: 'ada' }),
  slug: z.string().openapi({ example: 'intro-call' }),
})
const TokenParams = z.object({
  token: z.string().openapi({ description: 'The secret from the manage link' }),
})

const error = (description: string) => ({ description, content: json(ErrorBody) })
const rateLimited = error('Too many requests from this address (`rate_limited`); see Retry-After')
const eventTypeNotFound = error('No such public event type (`event_type_not_found`)')
const bookingNotFound = error('No booking has this manage token (`booking_not_found`)')

/** The invitee's data is behind a secret URL; keep it out of shared caches and history. */
const noStore = (c: Context) => c.header('Cache-Control', 'no-store')

export interface PublicRoutesDeps {
  db: Db
  now?: () => Temporal.Instant
  /** Replaces PUBLIC_RATE_LIMITS per group, e.g. in tests. */
  rateLimits?: Partial<Record<keyof typeof PUBLIC_RATE_LIMITS, RateLimit>>
}

/**
 * Unauthenticated routes: public booking pages and the invitee's manage link. Each group
 * is rate limited per client IP, in memory (see rate-limit.ts).
 */
export function publicRoutes({
  db,
  now = () => Temporal.Now.instant(),
  rateLimits = {},
}: PublicRoutesDeps): RouteModule {
  const ctx: PublicContext = { db, now }
  const limit = (group: keyof typeof PUBLIC_RATE_LIMITS) =>
    rateLimit(createRateLimiter(rateLimits[group] ?? PUBLIC_RATE_LIMITS[group]))
  const pageLimit = limit('page')
  const slotsLimit = limit('slots')
  const bookLimit = limit('book')
  const manageLimit = limit('manage')

  return ({ app }) => {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/public/{handle}/{slug}',
        summary: 'A public event type',
        description: 'What the booking page at /{handle}/{slug} shows.',
        middleware: pageLimit,
        request: { params: PageParams },
        responses: {
          200: { description: 'The event type', content: json(PublicEventType) },
          404: eventTypeNotFound,
          429: rateLimited,
        },
      }),
      async (c) => c.json(await getPublicEventType(ctx, c.req.valid('param')), 200),
    )

    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/public/{handle}/{slug}/slots',
        summary: 'Available slots',
        description: `Bookable slots that lie fully inside [start, end]. The range may span at most ${MAX_SLOT_RANGE_DAYS} days.`,
        middleware: slotsLimit,
        request: {
          params: PageParams,
          query: z.object({ start: Instant, end: Instant }),
        },
        responses: {
          200: {
            description: 'Slots, sorted by start',
            content: json(z.object({ slots: z.array(Slot) })),
          },
          400: error(
            'Invalid parameters (`invalid_request`), end not after start (`invalid_range`) or a range that is too long (`range_too_long`)',
          ),
          404: eventTypeNotFound,
          429: rateLimited,
        },
      }),
      async (c) => {
        const { start, end } = c.req.valid('query')
        const slots = await listPublicSlots(ctx, {
          ...c.req.valid('param'),
          start: Temporal.Instant.from(start),
          end: Temporal.Instant.from(end),
        })
        return c.json({ slots }, 200)
      },
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/public/{handle}/{slug}/bookings',
        summary: 'Book a slot',
        description:
          "Books an offered slot and returns the booking with the secret of the invitee's manage link. Send an `Idempotency-Key` to make retries safe: a retry with the same key and the same request returns the original booking (200) instead of booking again. All anonymous callers share one key space per organization, so the key must be random (e.g. a UUIDv4), never derived from the request.",
        middleware: bookLimit,
        request: {
          params: PageParams,
          headers: z.object({
            'idempotency-key': z.string().optional().openapi({
              description: 'A random key (1–255 printable ASCII characters), e.g. a UUIDv4',
            }),
          }),
          body: { content: json(CreateBooking), required: true },
        },
        responses: {
          201: { description: 'Booked', content: json(BookingWithToken) },
          200: {
            description: 'A retry of an earlier request with the same Idempotency-Key',
            content: json(BookingWithToken),
          },
          400: error(
            'Invalid request (`invalid_request`, `invalid_responses`, `invalid_invitee`, `invalid_guests`, `invalid_time_zone`, `too_many_guests`, `invalid_idempotency_key`)',
          ),
          404: eventTypeNotFound,
          409: error(
            'The time is not offered (`slot_unavailable`) or was just booked by someone else (`slot_taken`), or the Idempotency-Key was used for a different request (`idempotency_key_reused`)',
          ),
          429: rateLimited,
        },
      }),
      async (c) => {
        const body = c.req.valid('json')
        const { replayed, ...result } = await createPublicBooking(ctx, {
          ...c.req.valid('param'),
          start: Temporal.Instant.from(body.start),
          invitee: body.invitee,
          guests: body.guests,
          responses: body.responses,
          idempotencyKey: c.req.valid('header')['idempotency-key'],
        })
        noStore(c)
        return replayed ? c.json(result, 200) : c.json(result, 201)
      },
    )

    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/bookings/manage/{token}',
        summary: "The booking behind an invitee's manage link",
        middleware: manageLimit,
        request: { params: TokenParams },
        responses: {
          200: { description: 'The booking', content: json(Booking) },
          404: bookingNotFound,
          429: rateLimited,
        },
      }),
      async (c) => {
        const booking = await getManagedBooking(ctx, c.req.valid('param').token)
        noStore(c)
        return c.json(booking, 200)
      },
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/bookings/manage/{token}/cancel',
        summary: 'Cancel through the manage link',
        middleware: manageLimit,
        request: {
          params: TokenParams,
          body: { content: json(CancelBody), required: false },
        },
        responses: {
          200: { description: 'The cancelled booking', content: json(Booking) },
          400: error('Invalid request'),
          404: bookingNotFound,
          409: error(
            'Already cancelled (`booking_cancelled`) or already started (`booking_in_past`)',
          ),
          429: rateLimited,
        },
      }),
      async (c) => {
        const { reason } = (c.req.valid('json') as z.infer<typeof CancelBody> | undefined) ?? {}
        const booking = await cancelManagedBooking(ctx, c.req.valid('param').token, { reason })
        noStore(c)
        return c.json(booking, 200)
      },
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/bookings/manage/{token}/reschedule',
        summary: 'Reschedule through the manage link',
        description:
          'Cancels the booking and books the new time in one step. The new time may overlap the old one. Returns the new booking and its manage token; the old link then shows the cancelled booking.',
        middleware: manageLimit,
        request: {
          params: TokenParams,
          body: {
            content: json(z.object({ start: Instant }).openapi('Reschedule')),
            required: true,
          },
        },
        responses: {
          200: { description: 'The new booking', content: json(BookingWithToken) },
          400: error('Invalid request'),
          404: bookingNotFound,
          409: error(
            'Already cancelled (`booking_cancelled`), already started (`booking_in_past`), the event type no longer takes bookings (`event_type_unavailable`), or the time is not offered (`slot_unavailable`, `slot_taken`)',
          ),
          429: rateLimited,
        },
      }),
      async (c) => {
        const result = await rescheduleManagedBooking(ctx, c.req.valid('param').token, {
          start: Temporal.Instant.from(c.req.valid('json').start),
        })
        noStore(c)
        return c.json(result, 200)
      },
    )
  }
}
