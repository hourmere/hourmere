import { createRoute, z } from '@hono/zod-openapi'
import { DISPLAY_NAME_MAX_LENGTH } from '@hourmere/auth'
import {
  getProfile,
  HANDLE_MAX_LENGTH,
  HANDLE_PATTERN,
  LOCALE_MAX_LENGTH,
  putProfile,
  updateDisplayName,
} from '@hourmere/scheduling'
import { localeDescription } from '../i18n/locale-description.ts'
import {
  authenticated,
  CROSS_ORIGIN_WRITE,
  callerWithBodyLimit,
  ErrorBody,
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'

// Schemas check the JSON shape (400 invalid_request); the service checks values and answers
// with specific codes, the same for REST and MCP. Limits are documented here.

export const Profile = z
  .object({
    handle: z.string().openapi({ example: 'ada' }),
    timeZone: z.string().openapi({ example: 'Europe/Berlin' }),
    locale: z.string().openapi({ description: localeDescription, example: 'en' }),
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
      description: localeDescription,
      maxLength: LOCALE_MAX_LENGTH,
      example: 'en',
    }),
  })
  .openapi('ProfileInput')

const DisplayName = z.object({ name: z.string() }).openapi('DisplayName')
const DisplayNameInput = z
  .strictObject({
    name: z.string().openapi({
      description: 'Trimmed, well-formed Unicode on one line',
      minLength: 1,
      maxLength: DISPLAY_NAME_MAX_LENGTH,
    }),
  })
  .openapi('DisplayNameInput')

export function profileRoutes(deps: ServiceDeps): RouteModule {
  return ({ app, caller }) => {
    app.openapi(
      createRoute({
        method: 'patch',
        path: '/api/v1/profile/name',
        operationId: 'updateDisplayName',
        summary: "Update the caller's account display name",
        description:
          'Works before creating a booking-page profile and across acting organizations. Only changes the caller’s name. Requests are limited to 4096 bytes.',
        tags: ['Profile'],
        security: authenticated,
        middleware: callerWithBodyLimit(caller, 4096),
        request: { body: { content: json(DisplayNameInput), required: true } },
        responses: {
          200: { description: 'The canonical display name', content: json(DisplayName) },
          413: { description: 'Request body exceeds 4096 bytes', content: json(ErrorBody) },
          ...errorResponses({
            400: 'invalid_request or invalid_display_name',
            403: CROSS_ORIGIN_WRITE,
            404: 'user_not_found: the caller was deleted concurrently',
          }),
        },
      }),
      async (c) =>
        c.json(
          await updateDisplayName(serviceContext(deps, c.var.principal), c.req.valid('json').name),
          200,
        ),
    )

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
        operationId: 'updateProfile',
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
