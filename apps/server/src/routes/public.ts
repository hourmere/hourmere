import { createRoute, z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import {
  createPublicBooking,
  getPublicEventType,
  listPublicSlots,
  MAX_GUESTS,
  MAX_SLOT_RANGE_DAYS,
  type PublicContext,
  QuestionSchema,
} from '@hourmere/scheduling'
import { routeBodyLimit } from '../body-limit.ts'
import { ErrorBody, json, type RouteModule } from '../openapi.ts'
import { createRateLimiter, PUBLIC_RATE_LIMITS, type RateLimit, rateLimit } from '../rate-limit.ts'
import { BookingWithToken, Instant, LocationKind, Responses } from './bookings.ts'

const Question = QuestionSchema.openapi('Question', {
  description:
    'A booking-form field beyond name and email. Its answer goes in `responses` under `id`: text for short_text, long_text and phone; one of `options` for select; a list of distinct `options` for multi_select; true or false for checkbox (a required checkbox must be true).',
})

export const PublicEventType = z
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

export const Slot = z.object({ start: Instant, end: Instant }).openapi('Slot')

const name = z.string().min(1).max(200)
const email = z.email().max(254)

export const CreateBooking = z
  .strictObject({
    start: Instant.openapi({ description: 'The start of an offered slot' }),
    invitee: z.strictObject({
      name,
      email,
      timeZone: z.string().min(1).max(64).openapi({ description: 'IANA time zone' }),
      locale: z.string().max(35).optional(),
    }),
    guests: z.array(z.strictObject({ name, email })).max(MAX_GUESTS).optional(),
    responses: Responses.optional(),
  })
  .openapi('CreateBooking')

export const PageParams = z.object({
  handle: z.string().openapi({ example: 'ada' }),
  slug: z.string().openapi({ example: 'intro-call' }),
})

/**
 * The largest legal booking request, with every string at its maximum length and every
 * character escaped as \uXXXX (6 bytes), is about 1.23 MB: 20 multi_select answers, each
 * choosing all 50 options of 200 characters (20 × 50 × (200 × 6 + 3) ≈ 1.20 MB), plus a
 * 200-character name for the invitee and each of 10 guests (≈ 15 KB) and fixed-size fields.
 * (Long text answers come to at most 20 × 5000 × 6 = 600 KB.) Rounded up.
 */
export const BOOKING_BODY_LIMIT = 2 * 1024 * 1024

const error = (description: string) => ({ description, content: json(ErrorBody) })
const rateLimited = error('Too many requests from this address (`rate_limited`); see Retry-After')
const eventTypeNotFound = error('No such public event type (`event_type_not_found`)')

export interface PublicRoutesDeps {
  db: Db
  now?: () => Temporal.Instant
  /** Replaces PUBLIC_RATE_LIMITS.page, .slots and .book, e.g. in tests. */
  rateLimits?: Partial<Record<keyof typeof PUBLIC_RATE_LIMITS, RateLimit>>
}

/**
 * Unauthenticated routes of public booking pages. Each group is rate limited per client IP,
 * in memory (see rate-limit.ts). The invitee's manage endpoints are in bookings.ts.
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
            content: json(z.object({ data: z.array(Slot) })),
          },
          400: error(
            "Invalid parameters (`invalid_request`), end not after start (`invalid_range`), or a range that is too long (`range_too_long`: over 62 days, or over 20000 possible start times at the event type's step in its bookable part)",
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
        return c.json({ data: slots }, 200)
      },
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/public/{handle}/{slug}/bookings',
        summary: 'Book a slot',
        description:
          "Books an offered slot and returns the booking with the secret of the invitee's manage link (`manageToken`, returned only this once). Send an `Idempotency-Key` to make retries safe: a retry with the same key and the same request returns the original booking (200) instead of booking again. All anonymous callers share one key space per organization, so the key must be random (e.g. a UUIDv4), never derived from the request.",
        middleware: [bookLimit, routeBodyLimit(BOOKING_BODY_LIMIT)],
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
        return replayed ? c.json(result, 200) : c.json(result, 201)
      },
    )
  }
}
