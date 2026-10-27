import { createRoute, z } from '@hono/zod-openapi'
import {
  getSelfReadiness,
  getTeamReadiness,
  SelfReadinessPageSchema,
  TeamReadinessPageSchema,
} from '@hourmere/scheduling'
import { DomainError } from '@hourmere/scheduling/errors'
import { createMiddleware } from 'hono/factory'
import type { CallerEnv } from '../caller.ts'
import {
  ErrorBody,
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'
import { teamManagementAccess } from '../team-management.ts'

const selfPageQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  eventTypeCursor: z.uuid().optional(),
})
const teamPageQuery = selfPageQuery.extend({ memberCursor: z.uuid().optional() })
const sessionSecurity = [{ session: [] }]

/** Web-session projections of the shared cached readiness facts; never provider checks. */
export function readinessRoutes(deps: ServiceDeps): RouteModule {
  return ({ app, caller }) => {
    const sessionOnly = createMiddleware<CallerEnv>(async (c, next) => {
      if (c.var.principal.kind !== 'session')
        throw new DomainError('forbidden', 'readiness_access_denied')
      await next()
    })
    const access = teamManagementAccess(deps.db, caller)
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/readiness/self',
        summary: "Read the session member's own booking readiness",
        description:
          "Checks the current verified session and membership. Returns only the caller's private member detail and, in their personal organization, their personal event types. Uses cached configuration and sync facts, without a live provider request or a slot availability promise. Pages default to 50 items, at most 100; pass eventTypes.nextCursor as eventTypeCursor.",
        tags: ['Readiness'],
        security: sessionSecurity,
        middleware: [caller, sessionOnly] as [typeof caller, typeof sessionOnly],
        request: { query: selfPageQuery },
        responses: {
          200: {
            description: 'Own member detail and a page of personal event-type readiness',
            content: json(SelfReadinessPageSchema.openapi('SelfReadinessPage')),
          },
          ...errorResponses({
            400: 'invalid_request, invalid_limit or invalid_cursor',
            403: 'readiness_access_denied: requires a current verified web session and membership',
          }),
        },
      }),
      async (c) =>
        c.json(
          await getSelfReadiness(serviceContext(deps, c.var.principal), c.req.valid('query')),
          200,
        ),
    )
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/teams/{teamId}/readiness',
        summary: 'Read a minimal booking readiness summary for the acting team',
        description:
          'Requires a current verified owner/admin web session in this team. Any Authorization header selects API-key/OAuth authentication and is denied, even with a valid session cookie. Returns coarse reason codes and repair kinds, with no private calendar, account or schedule details. Every access denial, including missing or invalid sessions, an ordinary member, a different team and a missing team, uses the same 403 team_management_access_denied without revealing team existence. Member and event-type pages default to 50 items each, at most 100; pass their nextCursor as memberCursor and eventTypeCursor respectively.',
        tags: ['Readiness'],
        security: sessionSecurity,
        middleware: access.middleware,
        request: {
          params: z.object({ teamId: z.uuid() }),
          query: teamPageQuery,
        },
        responses: {
          200: {
            description: 'Minimal member and event-type summaries scoped to this team',
            content: json(TeamReadinessPageSchema.openapi('TeamReadinessPage')),
          },
          400: {
            description: 'invalid_request, invalid_limit or invalid_cursor',
            content: json(ErrorBody),
          },
          403: {
            description:
              'team_management_access_denied: requires the current team owner/admin web session without Authorization',
            content: json(ErrorBody),
          },
        },
      }),
      async (c) => {
        const result = await access.read(
          c.var.principal,
          c.req.valid('param').teamId,
          async (db, actor) =>
            getTeamReadiness(
              {
                db,
                organizationId: actor.organizationId,
                now: deps.now ?? (() => Temporal.Now.instant()),
                automaticMeet: deps.automaticMeet,
                automaticZoom: deps.automaticZoom,
              },
              c.req.valid('query'),
            ),
        )
        return c.json(result, 200)
      },
    )
  }
}
