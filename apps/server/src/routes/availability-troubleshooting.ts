import { createRoute, z } from '@hono/zod-openapi'
import { AVAILABILITY_REASON_CODES } from '@hourmere/core'
import { troubleshootEventAvailability } from '@hourmere/scheduling'
import {
  authenticated,
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'

const DateField = z.string().openapi({
  format: 'date',
  description: 'Local calendar date (YYYY-MM-DD) to explain, read in timeZone.',
  example: '2026-11-16',
})
const TimeZoneField = z.string().min(1).max(128).optional().openapi({
  description:
    'IANA time zone for the day’s bounds. Defaults to the caller’s profile time zone, else UTC.',
  example: 'Europe/Berlin',
})
const DurationField = z.number().int().min(1).max(1440).optional().openapi({
  description:
    'Meeting length to explain. Defaults to the event length; an unoffered length is explained as duration_not_offered.',
})

/** MCP and CLI arguments; REST reads the same fields from the path and query. */
export const TroubleshootAvailabilityArgs = z
  .object({
    eventTypeId: z.uuid(),
    date: DateField,
    timeZone: TimeZoneField,
    durationMinutes: DurationField,
  })
  .openapi('TroubleshootAvailabilityArgs')

const instant = z.string().openapi({ format: 'date-time' })

export const AvailabilityTroubleshooting = z
  .object({
    eventTypeId: z.string(),
    date: z.string().openapi({ format: 'date' }),
    timeZone: z.string(),
    durationMinutes: z
      .number()
      .int()
      .nullable()
      .openapi({ description: 'The requested length; null means the event’s default length.' }),
    rangeStart: instant,
    rangeEnd: instant.openapi({
      description: 'Exclusive. 23 or 25 hours after rangeStart on DST change days.',
    }),
    hosts: z
      .array(z.object({ userId: z.string(), name: z.string() }))
      .openapi({ description: 'Team event types: assigned hosts. Empty for personal types.' }),
    slots: z.array(
      z.object({
        start: instant,
        end: instant,
        status: z.enum(['available', 'unavailable']),
        reasons: z.array(
          z.object({
            code: z.string().openapi({
              description: `Stable reason code. Known values, in this order: ${AVAILABILITY_REASON_CODES.join(', ')}. New codes may be added within /api/v1; show unknown codes neutrally.`,
            }),
            start: instant,
            end: instant.openapi({
              description: 'The affected part of this time, clipped to it.',
            }),
            hostUserId: z
              .string()
              .optional()
              .openapi({ description: 'Team event types only: the host this reason concerns.' }),
          }),
        ),
      }),
    ),
  })
  .openapi('AvailabilityTroubleshooting')

export function availabilityTroubleshootingRoutes(deps: ServiceDeps): RouteModule {
  return ({ app, caller }) => {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/event-types/{id}/availability-troubleshooting',
        operationId: 'troubleshootAvailability',
        security: authenticated,
        middleware: caller,
        tags: ['Event types'],
        summary: 'Explain which times of one day can be booked, and why others cannot',
        description:
          'Read-only diagnostics for the personal owner or a verified team owner/admin; API keys need full scope. Every other caller, including ordinary team members, gets the same 404 event_type_not_found as a missing event type. Lists every candidate time of the local day, including past and non-working times, with status and ordered reason codes. Reasons carry only a code, the affected interval and, for team event types, the host id; never calendar event titles, attendees or booking details. Calendars that cannot be read right now answer 409 calendar_sync_unavailable rather than a reason.',
        request: {
          params: z.object({ id: z.string() }),
          query: z.strictObject({
            date: DateField,
            timeZone: TimeZoneField,
            durationMinutes: z.coerce.number().pipe(z.number().int().min(1).max(1440)).optional(),
          }),
        },
        responses: {
          200: {
            description: 'The day’s candidate times with status and reasons, ordered by start',
            content: json(AvailabilityTroubleshooting),
          },
          ...errorResponses({
            400: 'invalid_request, invalid_date, invalid_time_zone, invalid_duration, invalid_range, range_too_long',
            403: 'insufficient_scope: API keys need full scope',
            404: 'event_type_not_found (also for event types the caller may not manage)',
            409: 'calendar_sync_unavailable, location_unavailable',
          }),
        },
      }),
      async (c) => {
        const { id } = c.req.valid('param')
        const query = c.req.valid('query')
        return c.json(
          await troubleshootEventAvailability(serviceContext(deps, c.var.principal), {
            eventTypeId: id,
            ...query,
          }),
          200,
        )
      },
    )
  }
}
