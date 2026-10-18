import { createRoute, z } from '@hono/zod-openapi'
import {
  beginGoogleConnection,
  beginMicrosoftConnection,
  type CalendarDeps,
  configureCalendar,
  disconnectCalendar,
  finishGoogleConnection,
  finishMicrosoftConnection,
  GOOGLE_CALENDAR_CALLBACK,
  listCalendarConnections,
  MICROSOFT_CALENDAR_CALLBACK,
  refreshCalendarList,
  requireCalendarSession,
  setCalendarDestination,
  syncOwnedCalendar,
} from '@hourmere/calendars'
import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { CallerEnv } from '../caller.ts'
import {
  authenticated,
  type CallerMiddleware,
  errorResponses,
  json,
  type RouteModule,
} from '../openapi.ts'
import { createRateLimiter, rateLimit } from '../rate-limit.ts'

const CalendarConnection = z
  .object({
    id: z.uuid(),
    provider: z.enum(['google', 'microsoft']),
    accountEmail: z.string().nullable(),
    status: z.enum(['active', 'needs_reauth', 'revoked']),
    lastError: z
      .enum(['provider_unavailable', 'needs_reauth', 'permissions_missing'])
      .nullable()
      .optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    syncAuthorized: z.boolean(),
    calendars: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        isPrimary: z.boolean(),
        checkConflicts: z.boolean(),
        accessRole: z.string(),
        lastSyncedAt: z.iso.datetime().nullable(),
        syncError: z.string().nullable(),
      }),
    ),
  })
  .openapi('CalendarConnection')
const ConnectionId = z.object({ id: z.uuid() })
const emptyBody = { body: { required: true, content: json(z.strictObject({})) } }
const sessionOnly = createMiddleware<CallerEnv>(async (c, next) => {
  requireCalendarSession(c.var.principal)
  await next()
})

export function calendarRoutes(deps: CalendarDeps): RouteModule {
  const limit = rateLimit(createRateLimiter({ limit: 30, windowSeconds: 60 }))
  return ({ app, caller }) => {
    const protectedWrite: [
      CallerMiddleware,
      MiddlewareHandler<CallerEnv>,
      MiddlewareHandler<CallerEnv>,
    ] = [caller, sessionOnly, limit]
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/calendar-connections',
        tags: ['Calendars'],
        summary: "The caller's connected Google and Microsoft accounts and calendars",
        security: authenticated,
        middleware: caller,
        responses: {
          200: {
            description: 'Connection metadata only; never OAuth credentials',
            content: json(
              z.object({
                googleEnabled: z.boolean(),
                microsoftEnabled: z.boolean(),
                destinationCalendarId: z.uuid().nullable(),
                data: z.array(CalendarConnection),
              }),
            ),
          },
          ...errorResponses({}),
        },
      }),
      async (c) => c.json(await listCalendarConnections(deps, c.var.principal), 200),
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/calendar-connections/google/authorize',
        tags: ['Calendars'],
        summary: 'Start a separate Google Calendar connection',
        description:
          'Requires a browser session and same-origin request. Follow authorizationUrl; the attempt expires after ten minutes and can only finish in this session. Default access=list requests identity and calendar-list access. access=sync additionally requests event read access and event writes on owned calendars; reconnect existing accounts to upgrade.',
        security: [{ session: [] }],
        middleware: protectedWrite,
        request: {
          body: {
            required: true,
            content: json(z.strictObject({ access: z.enum(['list', 'sync']).optional() })),
          },
        },
        responses: {
          200: {
            description: 'The fixed Google authorization endpoint with state and PKCE',
            content: json(z.object({ authorizationUrl: z.url() })),
          },
          ...errorResponses({
            400: 'invalid_request',
            403: 'session_required or a cross-origin write',
            409: 'google_calendar_disabled',
          }),
        },
      }),
      async (c) =>
        c.json(await beginGoogleConnection(deps, c.var.principal, c.req.valid('json').access), 200),
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/calendar-connections/microsoft/authorize',
        tags: ['Calendars'],
        summary: 'Start a separate Microsoft Calendar connection',
        description:
          'Requires a same-origin browser session. Requests identity, continuing access and Calendars.ReadBasic to list calendars. This connection does not synchronize busy times or write events.',
        security: [{ session: [] }],
        middleware: protectedWrite,
        request: emptyBody,
        responses: {
          200: {
            description:
              'The fixed Microsoft authorization endpoint with session-bound state and PKCE',
            content: json(z.object({ authorizationUrl: z.url() })),
          },
          ...errorResponses({
            400: 'invalid_request',
            403: 'session_required or a cross-origin write',
            409: 'microsoft_calendar_disabled',
          }),
        },
      }),
      async (c) => c.json(await beginMicrosoftConnection(deps, c.var.principal), 200),
    )

    app.openapi(
      createRoute({
        method: 'patch',
        path: '/api/v1/calendars/{id}',
        tags: ['Calendars'],
        summary: 'Select a calendar for busy-time conflict checks',
        security: [{ session: [] }],
        middleware: protectedWrite,
        request: {
          params: ConnectionId,
          body: { required: true, content: json(z.strictObject({ checkConflicts: z.boolean() })) },
        },
        responses: {
          204: { description: 'Selection saved; enabled calendars synchronize in the background' },
          ...errorResponses({
            400: 'invalid_request',
            403: 'session_required',
            404: 'calendar_not_found',
            409: 'google_calendar_permissions_missing or calendar_events_unreadable',
          }),
        },
      }),
      async (c) => {
        await configureCalendar(
          deps,
          c.var.principal,
          c.req.valid('param').id,
          c.req.valid('json').checkConflicts,
        )
        return c.body(null, 204)
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/calendars/{id}/sync',
        tags: ['Calendars'],
        summary: 'Synchronize selected calendar busy intervals now',
        security: [{ session: [] }],
        middleware: protectedWrite,
        request: { ...emptyBody, params: ConnectionId },
        responses: {
          204: { description: 'Busy intervals synchronized' },
          ...errorResponses({
            403: 'session_required',
            404: 'calendar_not_found',
            409: 'calendar_sync_disabled or google_calendar_provider_unavailable',
          }),
        },
      }),
      async (c) => {
        await syncOwnedCalendar(deps, c.var.principal, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    app.openapi(
      createRoute({
        method: 'put',
        path: '/api/v1/calendar-destination',
        tags: ['Calendars'],
        summary: 'Choose the owned Google calendar for new booking events',
        security: [{ session: [] }],
        middleware: protectedWrite,
        request: {
          body: {
            required: true,
            content: json(z.strictObject({ calendarId: z.uuid().nullable() })),
          },
        },
        responses: {
          204: { description: 'Default booking calendar saved' },
          ...errorResponses({
            403: 'session_required',
            404: 'calendar_not_found or profile_not_found',
            409: 'calendar_not_writable',
          }),
        },
      }),
      async (c) => {
        await setCalendarDestination(deps, c.var.principal, c.req.valid('json').calendarId)
        return c.body(null, 204)
      },
    )

    app.openapi(
      createRoute({
        method: 'delete',
        path: '/api/v1/calendar-connections/{id}',
        tags: ['Calendars'],
        summary: 'Disconnect a calendar account and delete its local credentials and calendars',
        description:
          'Requires a browser session. Cancels outstanding connection attempts. Does not revoke the provider-wide grant, which may also be used by other connections; access can be removed in the Google or Microsoft account settings.',
        security: [{ session: [] }],
        middleware: [caller, sessionOnly] as const,
        request: { params: ConnectionId },
        responses: {
          204: { description: 'Connection and local calendar data deleted' },
          ...errorResponses({
            400: 'invalid_request',
            403: 'session_required or a cross-origin write',
            404: 'calendar_connection_not_found',
          }),
        },
      }),
      async (c) => {
        await disconnectCalendar(deps, c.var.principal, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/calendar-connections/{id}/refresh',
        tags: ['Calendars'],
        summary: 'Refresh the connected account’s calendar list',
        description:
          'Refreshes an expired access token when necessary. Does not fetch events or busy intervals.',
        security: [{ session: [] }],
        middleware: protectedWrite,
        request: { ...emptyBody, params: ConnectionId },
        responses: {
          204: { description: 'The calendar list was refreshed' },
          ...errorResponses({
            400: 'invalid_request',
            403: 'session_required or a cross-origin write',
            404: 'calendar_connection_not_found',
            409: 'The provider calendar integration is disabled, needs reauthorization, lacks permissions or is unavailable',
          }),
        },
      }),
      async (c) => {
        await refreshCalendarList(deps, c.var.principal, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )

    // OAuth's own protocol, outside /api/v1; no provider text or secrets reach the SPA.
    const callbackHeaders = createMiddleware(async (c, next) => {
      c.header('Cache-Control', 'no-store')
      c.header('Referrer-Policy', 'no-referrer')
      await next()
      if (c.res.status === 401 || c.res.status === 403)
        c.res = c.redirect('/app/calendars?connection=session_required', 303)
    })
    app.get(GOOGLE_CALENDAR_CALLBACK, callbackHeaders, limit, caller, sessionOnly, async (c) => {
      const outcome = await finishGoogleConnection(
        deps,
        c.var.principal,
        new URL(c.req.url).searchParams,
      )
      return c.redirect(`/app/calendars?connection=${outcome}`, 303)
    })
    app.get(MICROSOFT_CALENDAR_CALLBACK, callbackHeaders, limit, caller, sessionOnly, async (c) => {
      const outcome = await finishMicrosoftConnection(
        deps,
        c.var.principal,
        new URL(c.req.url).searchParams,
      )
      return c.redirect(`/app/calendars?connection=${outcome}&provider=microsoft`, 303)
    })
  }
}
