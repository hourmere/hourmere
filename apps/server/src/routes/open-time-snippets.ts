import { createRoute, z } from '@hono/zod-openapi'
import { localeRegistry } from '@hourmere/core/locales'
import { generateOpenTimeSnippet } from '@hourmere/scheduling'
import {
  authenticated,
  callerWithBodyLimit,
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'

export const GenerateOpenTimeSnippet = z
  .object({
    eventTypeId: z
      .uuid()
      .optional()
      .openapi({ description: 'Supply exactly one of eventTypeId or slug.' }),
    slug: z.string().min(1).max(64).optional().openapi({
      description:
        'A unique manageable event slug in the caller’s organization. Use its id if ambiguous.',
    }),
    from: z
      .string()
      .openapi({ format: 'date-time', description: 'Inclusive RFC 3339 instant with an offset.' }),
    to: z.string().openapi({
      format: 'date-time',
      description: 'Exclusive RFC 3339 instant; at most 31 elapsed days after from.',
    }),
    count: z.number().int().min(1).max(10).optional().openapi({ default: 3 }),
    locale: z
      .enum(
        Object.keys(localeRegistry) as [
          keyof typeof localeRegistry,
          ...Array<keyof typeof localeRegistry>,
        ],
      )
      .optional(),
    displayTimeZone: z.string().max(128).optional(),
    durationMinutes: z.number().int().min(1).max(1440).optional(),
  })
  .openapi('GenerateOpenTimeSnippet')

export const OpenTimeSnippet = z
  .object({
    bookingUrl: z.string(),
    durationMinutes: z.number().int(),
    locale: z.string(),
    displayTimeZone: z.string(),
    slots: z.array(
      z.object({ start: z.string(), end: z.string(), label: z.string(), url: z.string() }),
    ),
    text: z.string(),
    html: z.string(),
  })
  .openapi('OpenTimeSnippet')

export function openTimeSnippetRoutes(
  deps: ServiceDeps & { publicUrl: string; slotSnippetsEnabled: boolean },
): RouteModule {
  return ({ app, caller }) => {
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/open-time-snippets',
        operationId: 'generateOpenTimeSnippet',
        security: authenticated,
        middleware: callerWithBodyLimit(caller, 16_384),
        tags: ['Event types'],
        summary: 'Generate an open-time email snippet',
        description:
          'Read-only generation for personal owners and team owners/admins; read, bookings and full API keys are accepted. Requires SLOT_SNIPPETS_ENABLED. Chooses the earliest available alternatives, up to count, from a range of at most 31 elapsed days. Uses the ordinary slot engine and shared email formatter. Active hidden events are allowed; links can be forwarded. No booking, reservation or private capability is created. Taken links offer the ordinary booking page to choose another time. Omitted locale and displayTimeZone use profile preferences; duration defaults to the event length.',
        request: { body: { required: true, content: json(GenerateOpenTimeSnippet) } },
        responses: {
          200: {
            description: 'Chosen open times with direct links and plain-text/HTML snippets',
            content: json(OpenTimeSnippet),
          },
          ...errorResponses({
            400: 'invalid_request, invalid_event_type_selector, ambiguous_event_type_slug, invalid_slug, invalid_range, range_too_long, invalid_count, invalid_duration, invalid_locale, invalid_time_zone',
            403: 'insufficient_role',
            404: 'slot_snippets_disabled, event_type_not_found',
            409: 'no_available_slots',
          }),
        },
      }),
      async (c) =>
        c.json(
          await generateOpenTimeSnippet(
            serviceContext(deps, c.var.principal),
            c.req.valid('json'),
            deps,
          ),
          200,
        ),
    )
  }
}
