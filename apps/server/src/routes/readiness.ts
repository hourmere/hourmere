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
const checkSemantics =
  'Unknown required checks use not_checked with completeness=partial and checkedAt=null; attempted checks that fail use check_failed with a safe reason and attempt time. Neither means satisfied or no available slots. availability remains not_checked because no slot search is performed.'
const internalError = {
  description: 'internal_error: subject reads or another unexpected server operation failed',
  content: json(ErrorBody),
}

/** Web-session projections of the shared cached readiness facts; never provider checks. */
export function readinessRoutes(deps: ServiceDeps): RouteModule {
  return ({ app, caller }) => {
    const sessionOnly = createMiddleware<CallerEnv>(async (c, next) => {
      if (c.var.principal.kind !== 'session')
        throw new DomainError('forbidden', 'readiness_access_denied')
      await next()
    })
    const access = teamManagementAccess(deps.db, caller)
    const currentTeamSession = createMiddleware<CallerEnv>(async (c, next) => {
      const principal = c.var.principal
      if (principal.kind !== 'session')
        throw new DomainError('forbidden', 'team_management_access_denied')
      // A switch committed after caller resolution must not return the previous team's data.
      const current = await deps.db
        .selectFrom('auth.session')
        .select('id')
        .where('id', '=', principal.sessionId)
        .where('userId', '=', principal.user.id)
        .where('activeOrganizationId', '=', principal.organization.id)
        .executeTakeFirst()
      if (!current) throw new DomainError('forbidden', 'team_management_access_denied')
      await next()
    })
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/readiness/self',
        summary: "Read the session member's own booking readiness",
        description:
          "Rechecks the current verified session, effective organization and membership on every request. Returns only the caller's private member detail and, in their personal organization, their personal event types. Private schedules and calendars appear once in member.details; event-type details retain empty arrays for compatibility. Uses cached configuration and sync facts, without a live provider request or a slot availability promise. Authorization takes precedence over cookies, so an API key plus a session cookie is refused. Pages default to 50 items, at most 100; pass eventTypes.nextCursor as eventTypeCursor.",
        tags: ['Readiness'],
        security: sessionSecurity,
        middleware: [caller, sessionOnly] as [typeof caller, typeof sessionOnly],
        request: { query: selfPageQuery },
        responses: {
          200: {
            description: 'Own member detail and a page of personal event-type readiness',
            content: json(
              SelfReadinessPageSchema.openapi('SelfReadinessPage', {
                description: checkSemantics,
              }),
            ),
          },
          ...errorResponses({
            400: 'invalid_request, invalid_limit or invalid_cursor',
            403: 'readiness_access_denied: requires a current verified web session and membership',
          }),
          500: internalError,
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
          'Rechecks a current verified owner/admin web session whose active team matches teamId on every request, including after organization switches and role changes. Returns verified, display-safe member names or the neutral label Team member, coarse reason codes and repair kinds, with no private calendar, account or schedule details. Every access denial after authentication, including an ordinary member, a different team and a missing team, uses team_management_access_denied. Authorization takes precedence over cookies; API keys and MCP OAuth tokens are not session callers. Member and event-type pages default to 50 items each, at most 100; pass their nextCursor as memberCursor and eventTypeCursor respectively.',
        tags: ['Readiness'],
        security: sessionSecurity,
        middleware: [access.middleware[0], access.middleware[1], currentTeamSession] as [
          typeof caller,
          typeof currentTeamSession,
          typeof currentTeamSession,
        ],
        request: {
          params: z.object({ teamId: z.uuid() }),
          query: teamPageQuery,
        },
        responses: {
          200: {
            description: 'Minimal member and event-type summaries scoped to this team',
            content: json(
              TeamReadinessPageSchema.openapi('TeamReadinessPage', {
                description: checkSemantics,
              }),
            ),
          },
          ...errorResponses({
            400: 'invalid_request, invalid_limit or invalid_cursor',
            403: 'team_management_access_denied: requires the current team owner/admin web session',
          }),
          500: internalError,
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
