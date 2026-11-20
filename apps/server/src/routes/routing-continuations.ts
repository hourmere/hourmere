import { randomBytes } from 'node:crypto'
import { createRoute, z } from '@hono/zod-openapi'
import {
  listRoutingContinuationSlots,
  type RoutingContinuationContext,
  resolveRoutingContinuation,
  routingRequestKey,
} from '@hourmere/scheduling'
import { ErrorBody, json, type RouteModule } from '../openapi.ts'
import { createRateLimiter, PUBLIC_RATE_LIMITS, type RateLimit, rateLimit } from '../rate-limit.ts'
import { routingFormsGuard } from '../routing-forms.ts'
import { Instant, SelectedDurationMinutes, Slot } from './bookings.ts'
import { PublicEventType } from './public.ts'
import { ROUTING_FORMS_DISABLED } from './routing-forms.ts'

export const RoutingContinuationInput = z
  .strictObject({
    routeToken: z
      .string()
      .openapi({ description: 'Private bearer capability from route submission' }),
  })
  .openapi('RoutingContinuationInput')

export const RoutingContinuationSlotsInput = z
  .strictObject({
    ...RoutingContinuationInput.shape,
    start: Instant,
    end: Instant,
    durationMinutes: SelectedDurationMinutes.optional(),
    locationOptionId: z.string().optional(),
  })
  .openapi('RoutingContinuationSlotsInput')

export const RoutingContinuation = z
  .object({
    eventType: PublicEventType.pick({
      title: true,
      description: true,
      durationMinutes: true,
      allowedDurationsMinutes: true,
      location: true,
      locations: true,
      questions: true,
      allowGuests: true,
      smsRemindersEnabled: true,
    }).extend({ host: PublicEventType.shape.host.optional() }),
    prefill: z.object({
      inviteeName: z.string().optional(),
      inviteeEmail: z.string().optional(),
      responses: z.record(z.string(), z.string()),
    }),
    expiresAt: z.iso.datetime(),
  })
  .openapi('RoutingContinuation')

export const RoutingContinuationSlots = z
  .object({ slots: z.array(Slot) })
  .openapi('RoutingContinuationSlots')

export function readRoutingContinuation(
  ctx: RoutingContinuationContext,
  input: z.infer<typeof RoutingContinuationInput>,
) {
  return resolveRoutingContinuation(ctx, input.routeToken)
}

export async function findRoutingContinuationSlots(
  ctx: RoutingContinuationContext,
  {
    routeToken,
    start,
    end,
    durationMinutes,
    locationOptionId,
  }: z.infer<typeof RoutingContinuationSlotsInput>,
) {
  const slots = await listRoutingContinuationSlots(ctx, {
    routeToken,
    start: Temporal.Instant.from(start),
    end: Temporal.Instant.from(end),
    durationMinutes,
    locationOptionId,
  })
  return { slots }
}

export function routingContinuationRoutes(
  ctx: RoutingContinuationContext,
  rate: RateLimit = PUBLIC_RATE_LIMITS.routingContinuation,
): RouteModule {
  const bucket = createRateLimiter(rate)
  // Hard-off and OpenAPI fixtures may omit the server secret.
  const key = ctx.routingSecret ?? randomBytes(32).toString('base64url')
  const limit = rateLimit(
    { hit: (client) => bucket.hit(routingRequestKey(key, 'routingContinuation', client)) },
    { beforeBodyLimit: true },
  )
  const security: Record<string, string[]>[] = [{}, { apiKey: [] }]
  const base = {
    method: 'post' as const,
    tags: ['Public'],
    security,
    middleware: [limit, routingFormsGuard(ctx.routingFormsEnabled === true)],
  }
  const errors = {
    400: { description: 'invalid_request', content: json(ErrorBody) },
    404: { description: 'routing_forms_disabled', content: json(ErrorBody) },
    409: { description: 'routing_unavailable', content: json(ErrorBody) },
    413: { description: 'payload_too_large (maximum 65,536 bytes)', content: json(ErrorBody) },
    429: { description: 'rate_limited; see Retry-After', content: json(ErrorBody) },
  }
  const access =
    'Anonymous access is allowed. A supplied bearer must be a valid bookings or full API key.'
  return ({ app }) => {
    app.openapi(
      createRoute({
        ...base,
        path: '/api/v1/routing-continuations/resolve',
        operationId: 'resolveRoutingContinuation',
        summary: 'Resolve a routing continuation',
        description: `${ROUTING_FORMS_DISABLED} Reads the selected event's current booking fields and editable prefill. The capability expires 30 minutes after issuance. Reads do not consume or renew it. ${access}`,
        request: { body: { required: true, content: json(RoutingContinuationInput) } },
        responses: {
          ...errors,
          200: {
            description: 'Current booking fields and editable prefill',
            content: json(RoutingContinuation),
          },
        },
      }),
      async (c) => c.json(await readRoutingContinuation(ctx, c.req.valid('json')), 200),
    )
    app.openapi(
      createRoute({
        ...base,
        path: '/api/v1/routing-continuations/slots',
        operationId: 'findRoutedSlots',
        summary: 'Find slots for the selected event',
        description: `${ROUTING_FORMS_DISABLED} Offers ordinary availability in the given instant range for the event selected by the capability. Availability may change. ${access}`,
        request: { body: { required: true, content: json(RoutingContinuationSlotsInput) } },
        responses: {
          ...errors,
          200: { description: 'Available slots', content: json(RoutingContinuationSlots) },
          400: {
            description: 'invalid_request, invalid_range, range_too_long or invalid_duration',
            content: json(ErrorBody),
          },
          409: {
            description: 'routing_unavailable, location_unavailable or calendar_sync_unavailable',
            content: json(ErrorBody),
          },
        },
      }),
      async (c) => c.json(await findRoutingContinuationSlots(ctx, c.req.valid('json')), 200),
    )
  }
}
