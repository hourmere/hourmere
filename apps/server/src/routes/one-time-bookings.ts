import { createRoute, z } from '@hono/zod-openapi'
import {
  createOneTimeBooking,
  getOneTimeBookingPage,
  listOneTimeBookingSlots,
  type PublicContext,
} from '@hourmere/scheduling'
import { routeBodyLimit } from '../body-limit.ts'
import { ErrorBody, json, type RouteModule } from '../openapi.ts'
import { createRateLimiter, PUBLIC_RATE_LIMITS, rateLimit } from '../rate-limit.ts'
import { Instant, SelectedDurationMinutes, Slot } from './bookings.ts'
import {
  BOOKING_BODY_LIMIT,
  CreateBooking,
  PublicBookingResult,
  PublicEventType,
  type PublicRoutesDeps,
} from './public.ts'

// Validate the capability in the service so malformed and unknown values have the
// same opaque failure. Never include a real capability in documentation examples.
const TokenParams = z.object({ token: z.string() })
const unavailable = {
  description: 'This booking link is unavailable (`one_time_link_not_found`)',
  content: json(ErrorBody),
}
const invalid = { description: 'Invalid booking parameters', content: json(ErrorBody) }
const rateLimited = { description: 'Too many requests; see Retry-After', content: json(ErrorBody) }
export const OneTimeBookingPage = z
  .object({
    eventType: PublicEventType,
    prefill: z.object({ name: z.string().nullable(), email: z.string().nullable() }),
  })
  .openapi('OneTimeBookingPage')

/** Public consumption only; link generation and administration have separate authorization. */
export function oneTimeBookingRoutes({
  db,
  now = () => Temporal.Now.instant(),
  notify,
  automaticMeet,
  automaticZoom,
  successRedirectPolicy,
  rateLimits = {},
}: PublicRoutesDeps): RouteModule {
  const ctx: PublicContext = {
    db,
    now,
    notify,
    automaticMeet,
    automaticZoom,
    successRedirectPolicy,
  }
  const limit = (group: 'page' | 'slots' | 'book') =>
    rateLimit(createRateLimiter(rateLimits[group] ?? PUBLIC_RATE_LIMITS[group]))
  return ({ app }) => {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/book/{token}',
        summary: 'Open a one-time booking link',
        description:
          'The capability is carried only in the URL path. Reads never consume it. Prefill is editable convenience, not proof of identity. All unavailable states have the same response. This page cannot be embedded.',
        middleware: limit('page'),
        request: { params: TokenParams },
        responses: {
          200: {
            description: 'Booking form and optional prefill',
            content: json(OneTimeBookingPage),
          },
          404: unavailable,
          429: rateLimited,
        },
      }),
      async (c) => c.json(await getOneTimeBookingPage(ctx, c.req.valid('param').token), 200),
    )
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/book/{token}/slots',
        summary: 'Available slots through a one-time link',
        middleware: limit('slots'),
        request: {
          params: TokenParams,
          query: z.object({
            start: Instant,
            end: Instant,
            durationMinutes: z.coerce.number().pipe(SelectedDurationMinutes).optional(),
          }),
        },
        responses: {
          200: { description: 'Available slots', content: json(z.object({ data: z.array(Slot) })) },
          400: invalid,
          404: unavailable,
          429: rateLimited,
        },
      }),
      async (c) => {
        const { start, end, durationMinutes } = c.req.valid('query')
        return c.json(
          {
            data: await listOneTimeBookingSlots(ctx, {
              token: c.req.valid('param').token,
              start: Temporal.Instant.from(start),
              end: Temporal.Instant.from(end),
              durationMinutes,
            }),
          },
          200,
        )
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/book/{token}/bookings',
        operationId: 'createOneTimeBooking',
        summary: 'Book through a one-time link',
        description:
          'Claims the link atomically with the booking. An unavailable link receives the same neutral error for every state. Exact Idempotency-Key replay returns the original booking without claiming again. Cancellation or rescheduling never reactivates the link; use the returned manage link.',
        middleware: [limit('book'), routeBodyLimit(BOOKING_BODY_LIMIT)],
        request: {
          params: TokenParams,
          headers: z.object({ 'idempotency-key': z.string().optional() }),
          body: { content: json(CreateBooking.omit({ source: true })), required: true },
        },
        responses: {
          201: { description: 'Booked and link consumed', content: json(PublicBookingResult) },
          200: { description: 'Exact idempotent replay', content: json(PublicBookingResult) },
          400: invalid,
          404: unavailable,
          409: {
            description: 'Slot unavailable or idempotency key reused',
            content: json(ErrorBody),
          },
          429: rateLimited,
        },
      }),
      async (c) => {
        const body = c.req.valid('json')
        const { replayed, ...result } = await createOneTimeBooking(ctx, {
          token: c.req.valid('param').token,
          start: Temporal.Instant.from(body.start),
          durationMinutes: body.durationMinutes,
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
