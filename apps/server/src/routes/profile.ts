import { createRoute, z } from '@hono/zod-openapi'
import {
  getProfile,
  HANDLE_MAX_LENGTH,
  HANDLE_PATTERN,
  LOCALE_MAX_LENGTH,
  putProfile,
} from '@hourmere/scheduling'
import {
  authenticated,
  CROSS_ORIGIN_WRITE,
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'

// Schemas check the JSON shape (400 invalid_request); the service checks values and answers
// with specific codes, the same for REST and MCP. Limits are documented here.

const Profile = z
  .object({
    handle: z.string().openapi({ example: 'ada' }),
    timeZone: z.string().openapi({ example: 'Europe/Berlin' }),
    locale: z.string().openapi({ example: 'en' }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Profile')

const ProfileInput = z
  .strictObject({
    handle: z.string().openapi({
      description:
        'Forms the booking URLs (/{handle}/{slug}): lowercase letters, digits and hyphens, starting and ending with a letter or digit. Some handles are reserved.',
      pattern: HANDLE_PATTERN.source,
      maxLength: HANDLE_MAX_LENGTH,
      example: 'ada',
    }),
    timeZone: z.string().openapi({ description: 'IANA time zone name', example: 'Europe/Berlin' }),
    locale: z.string().openapi({
      description: 'BCP 47 language tag',
      maxLength: LOCALE_MAX_LENGTH,
      example: 'en',
    }),
  })
  .openapi('ProfileInput')

export function profileRoutes(deps: ServiceDeps): RouteModule {
  return ({ app, caller }) => {
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/profile',
        summary: "The caller's profile",
        tags: ['Profile'],
        security: authenticated,
        middleware: caller,
        responses: {
          200: { description: 'The profile', content: json(Profile) },
          ...errorResponses({ 404: 'profile_not_found: no profile yet (see PUT)' }),
        },
      }),
      async (c) => c.json(await getProfile(serviceContext(deps, c.var.principal)), 200),
    )

    app.openapi(
      createRoute({
        method: 'put',
        path: '/api/v1/profile',
        summary: "Create or replace the caller's profile",
        description:
          'The time zone and locale are stored normalized (europe/berlin → Europe/Berlin).',
        tags: ['Profile'],
        security: authenticated,
        middleware: caller,
        request: { body: { content: json(ProfileInput), required: true } },
        responses: {
          200: { description: 'The profile was replaced', content: json(Profile) },
          201: { description: 'The profile was created', content: json(Profile) },
          ...errorResponses({
            400: 'invalid_request, invalid_handle, handle_reserved, invalid_time_zone or invalid_locale',
            403: CROSS_ORIGIN_WRITE,
            409: 'handle_taken: another user has this handle',
          }),
        },
      }),
      async (c) => {
        const { profile, created } = await putProfile(
          serviceContext(deps, c.var.principal),
          c.req.valid('json'),
        )
        return created ? c.json(profile, 201) : c.json(profile, 200)
      },
    )
  }
}
