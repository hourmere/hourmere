import { createRoute, z } from '@hono/zod-openapi'
import { type CalendarDeps, requireCalendarSession } from '@hourmere/calendars'
import {
  CalDavError,
  discoverCalDavConnection,
  saveCalDavConnection,
} from '@hourmere/calendars/caldav'
import { DomainError } from '@hourmere/scheduling/errors'
import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import { routeBodyLimit } from '../body-limit.ts'
import type { CallerEnv } from '../caller.ts'
import { type CallerMiddleware, errorResponses, json, type RouteModule } from '../openapi.ts'
import { createRateLimiter, rateLimit } from '../rate-limit.ts'

const credentials = z.strictObject({
  serverUrl: z.string().min(1).max(8192),
  username: z.string().min(1).max(1024),
  password: z.string().min(1).max(8192).openapi({ format: 'password', writeOnly: true }),
  connectionId: z.uuid().optional(),
})
const selectionKey = z.string().regex(/^[a-f0-9]{64}$/)
const saveInput = credentials.extend({
  calendarKeys: z.array(selectionKey).max(256),
  conflictCalendarKeys: z.array(selectionKey).max(20),
  destinationCalendarKey: selectionKey.nullable(),
})
const discovered = z.object({
  calendars: z.array(
    z.object({
      key: selectionKey,
      displayName: z.string(),
      color: z.string().nullable(),
      canWrite: z.boolean(),
    }),
  ),
})
const sessionOnly = createMiddleware<CallerEnv>(async (c, next) => {
  requireCalendarSession(c.var.principal)
  await next()
})
async function safe<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw new DomainError(
      'conflict',
      error instanceof CalDavError && error.code === 'unauthorized'
        ? 'caldav_needs_reauth'
        : 'caldav_provider_unavailable',
    )
  }
}

export function caldavRoutes(deps: CalendarDeps): RouteModule {
  const limit = rateLimit(createRateLimiter({ limit: 10, windowSeconds: 60 }))
  const configured = () => {
    if (!deps.caldav) throw new DomainError('conflict', 'caldav_calendar_disabled')
    return {
      db: deps.db,
      client: deps.caldav.discoveryClient,
      encryptionKey: deps.caldav.encryptionKey,
      enqueueSync: deps.caldav.enqueueSync,
      enqueueWritebackRecovery: deps.caldav.enqueueWritebackRecovery,
      ...(deps.now ? { now: deps.now } : {}),
    }
  }
  return ({ app, caller }) => {
    const middleware: [
      CallerMiddleware,
      MiddlewareHandler<CallerEnv>,
      MiddlewareHandler<CallerEnv>,
      MiddlewareHandler<CallerEnv>,
    ] = [caller, sessionOnly, limit, routeBodyLimit(256 * 1024)]
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/calendar-connections/caldav/discover',
        operationId: 'discoverCalDavConnection',
        tags: ['Calendars'],
        summary: 'Discover CalDAV calendars without saving credentials',
        description:
          'Requires a live same-origin browser session. Returns opaque selection keys and sanitized metadata, never usernames, passwords or provider URLs. Reconnect discovery requires ownership of connectionId.',
        security: [{ session: [] }],
        middleware,
        request: { body: { required: true, content: json(credentials) } },
        responses: {
          200: { description: 'Discovered event calendars', content: json(discovered) },
          ...errorResponses({
            400: 'invalid_request',
            403: 'session_required or a cross-origin write',
            404: 'calendar_connection_not_found',
            409: 'caldav_calendar_disabled, caldav_needs_reauth or caldav_provider_unavailable',
          }),
        },
      }),
      async (c) =>
        c.json(
          await safe(() =>
            discoverCalDavConnection(configured(), c.var.principal, c.req.valid('json')),
          ),
          200,
        ),
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/calendar-connections/caldav',
        operationId: 'saveCalDavConnection',
        tags: ['Calendars'],
        summary: 'Save or reconnect CalDAV credentials and calendar selections',
        description:
          'Requires a live same-origin browser session. Rediscovery validates opaque selections, then saves encrypted credentials, conflict checks and destination atomically. Reconnect preserves identities and pinned booking targets. A null destination clears only this connection’s existing default.',
        security: [{ session: [] }],
        middleware,
        request: { body: { required: true, content: json(saveInput) } },
        responses: {
          200: {
            description: 'Saved connection identity only',
            content: json(z.object({ id: z.uuid() })),
          },
          ...errorResponses({
            400: 'invalid_request or caldav_calendar_selection_invalid',
            403: 'session_required or a cross-origin write',
            404: 'calendar_connection_not_found or profile_not_found',
            409: 'caldav_calendar_disabled, caldav_needs_reauth, caldav_provider_unavailable, caldav_connection_identity_changed or calendar_selection_limit',
          }),
        },
      }),
      async (c) =>
        c.json(
          await safe(() =>
            saveCalDavConnection(configured(), c.var.principal, c.req.valid('json')),
          ),
          200,
        ),
    )
  }
}
