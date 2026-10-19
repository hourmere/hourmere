import { createRoute, z } from '@hono/zod-openapi'
import {
  authorizeZoomMeetings,
  beginZoomConnection,
  type ConferenceDeps,
  disconnectConference,
  finishZoomConnection,
  listConferenceConnections,
  refreshConference,
  requireConferenceSession,
  ZOOM_CALLBACK,
} from '@hourmere/conferences'
import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import { routeBodyLimit } from '../body-limit.ts'
import type { CallerEnv } from '../caller.ts'
import {
  authenticated,
  type CallerMiddleware,
  errorResponses,
  json,
  type RouteModule,
} from '../openapi.ts'
import { createRateLimiter, rateLimit } from '../rate-limit.ts'

export const Connection = z
  .object({
    id: z.uuid(),
    provider: z.literal('zoom'),
    mode: z.enum(['identity', 'meetings']),
    accountEmail: z.string().nullable(),
    displayName: z.string().nullable(),
    status: z.enum(['active', 'refreshing', 'needs_reauth', 'disconnected']),
    lastError: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('ConferenceConnection')
export const ConferenceConnections = z.object({
  zoomEnabled: z.boolean(),
  zoomMeetingsEnabled: z.boolean(),
  pendingAttempts: z.number().int(),
  maximumConnections: z.number().int(),
  data: z.array(Connection),
})
const Id = z.object({ id: z.uuid() })
const emptyBody = { body: { required: true, content: json(z.strictObject({})) } }
const sessionOnly = createMiddleware<CallerEnv>(async (c, next) => {
  requireConferenceSession(c.var.principal)
  await next()
})
const privateHeaders = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  await next()
})
const jsonCommand = createMiddleware(async (c, next) => {
  if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
    return c.json({ error: 'invalid_request', message: 'Send an empty JSON object.' }, 400)
  await next()
})
export function conferenceRoutes(deps: ConferenceDeps): RouteModule {
  const limit = rateLimit(createRateLimiter({ limit: 20, windowSeconds: 60 }))
  return ({ app, caller }) => {
    const metadata: [CallerMiddleware, MiddlewareHandler<CallerEnv>] = [privateHeaders, caller]
    const session: [CallerMiddleware, MiddlewareHandler<CallerEnv>, MiddlewareHandler<CallerEnv>] =
      [privateHeaders, caller, sessionOnly]
    const write: [
      ...typeof session,
      MiddlewareHandler<CallerEnv>,
      MiddlewareHandler<CallerEnv>,
      MiddlewareHandler<CallerEnv>,
    ] = [...session, limit, routeBodyLimit(1024), jsonCommand]
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/conference-connections',
        tags: ['Conferences'],
        summary: 'List personal Zoom connection metadata, without credentials',
        security: authenticated,
        middleware: metadata,
        responses: {
          200: {
            description:
              'Owned personal metadata only; OAuth attempts are browser-session-specific',
            content: json(ConferenceConnections),
          },
          ...errorResponses({ 403: 'conference_access_denied or conference_session_required' }),
        },
      }),
      async (c) => c.json(await listConferenceConnections(deps, c.var.principal), 200),
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/conference-connections/zoom/authorize',
        tags: ['Conferences'],
        summary: 'Begin an independent Zoom identity connection',
        description:
          'Browser session and same-origin required. Requests only user:read:user with S256 PKCE, expires after ten minutes, and cannot sign in or create meetings.',
        security: [{ session: [] }],
        middleware: write,
        request: emptyBody,
        responses: {
          200: {
            description: 'Fixed official Zoom authorization URL',
            content: json(z.object({ authorizationUrl: z.url() })),
          },
          ...errorResponses({
            400: 'invalid_request',
            403: 'conference_session_required',
            409: 'zoom_disabled or zoom_connection_limit',
          }),
        },
      }),
      async (c) => c.json(await beginZoomConnection(deps, c.var.principal), 200),
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/conference-connections/{id}/reconnect',
        tags: ['Conferences'],
        summary: 'Reconnect the same Zoom identity with its saved permissions',
        description:
          'Retains the stored identity or meeting authorization mode. A changed instance flag does not widen a saved identity grant.',
        security: [{ session: [] }],
        middleware: write,
        request: { ...emptyBody, params: Id },
        responses: {
          200: {
            description: 'Expected-identity OAuth attempt',
            content: json(z.object({ authorizationUrl: z.url() })),
          },
          ...errorResponses({
            400: 'invalid_request',
            403: 'conference_session_required',
            404: 'zoom_connection_not_found',
            409: 'zoom_disabled',
          }),
        },
      }),
      async (c) =>
        c.json(await beginZoomConnection(deps, c.var.principal, c.req.valid('param').id), 200),
    )
    for (const existing of [false, true] as const)
      app.openapi(
        createRoute({
          method: 'post',
          path: existing
            ? '/api/v1/conference-connections/{id}/authorize-meetings'
            : '/api/v1/conference-connections/zoom/authorize-meetings',
          tags: ['Conferences'],
          summary: 'Explicitly authorize automatic single-host Zoom meetings',
          description:
            'Session-only opt-in. Requests exact identity plus meeting create/read/update/delete scopes, bound to one short-lived PKCE attempt. Reconnecting does not silently change its stored mode.',
          security: [{ session: [] }],
          middleware: write,
          request: { ...emptyBody, ...(existing ? { params: Id } : {}) },
          responses: {
            200: {
              description: 'Explicit meeting-permission OAuth attempt',
              content: json(z.object({ authorizationUrl: z.url() })),
            },
            ...errorResponses({
              400: 'invalid_request',
              403: 'conference_session_required',
              404: 'zoom_connection_not_found',
              409: 'zoom_disabled, zoom_meetings_disabled or zoom_connection_limit',
            }),
          },
        }),
        async (c) =>
          c.json(
            await authorizeZoomMeetings(
              deps,
              c.var.principal,
              existing ? c.req.param('id') : undefined,
            ),
            200,
          ),
      )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/conference-connections/{id}/refresh',
        tags: ['Conferences'],
        summary: 'Explicitly rotate Zoom credentials and refresh identity metadata',
        description:
          'Old credentials are durably retired before the provider call. Unknown or failed rotation requires reconnection. Only identity metadata is fetched; each connection retains its explicitly authorized mode.',
        security: [{ session: [] }],
        middleware: write,
        request: { ...emptyBody, params: Id },
        responses: {
          204: { description: 'Credentials and identity metadata refreshed' },
          ...errorResponses({
            400: 'invalid_request',
            403: 'conference_session_required',
            404: 'zoom_connection_not_found',
            409: 'zoom_disabled, zoom_needs_reauth, zoom_refresh_incomplete, zoom_identity_mismatch or a safe provider failure. Busy account operations return errorAlias=zoom_operation_busy alongside error=zoom_refresh_in_progress (legacy code deprecated for one release); retry shortly.',
          }),
        },
      }),
      async (c) => {
        await refreshConference(deps, c.var.principal, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    app.openapi(
      createRoute({
        method: 'delete',
        path: '/api/v1/conference-connections/{id}',
        tags: ['Conferences'],
        summary: 'Disconnect local Zoom access and invalidate pending attempts',
        description:
          'Wipes local credentials and retains an owned tombstone. Does not revoke an app-wide provider grant. Remove the app separately in Zoom.',
        security: [{ session: [] }],
        middleware: write,
        request: { ...emptyBody, params: Id },
        responses: {
          204: { description: 'Local access disconnected' },
          ...errorResponses({
            400: 'invalid_request',
            403: 'conference_session_required',
            404: 'zoom_connection_not_found',
          }),
        },
      }),
      async (c) => {
        await disconnectConference(deps, c.var.principal, c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
    const callback = createMiddleware(async (c, next) => {
      await next()
      if (c.res.status !== 303) {
        const outcome =
          c.res.status === 401 || c.res.status === 403
            ? 'session_required'
            : c.res.status === 429
              ? 'rate_limited'
              : 'provider_unavailable'
        c.res = c.redirect(`/app/conferences?zoom=${outcome}`, 303)
      }
      c.header('Cache-Control', 'no-store')
      c.header('Referrer-Policy', 'no-referrer')
    })
    app.get(ZOOM_CALLBACK, callback, limit, caller, sessionOnly, async (c) => {
      const outcome = await finishZoomConnection(
        deps,
        c.var.principal,
        new URL(c.req.url).searchParams,
      )
      return c.redirect(`/app/conferences?zoom=${outcome}`, 303)
    })
  }
}
