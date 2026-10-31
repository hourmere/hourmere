import { createRoute, z } from '@hono/zod-openapi'
import {
  getSelfReadiness,
  getTeamMemberReadiness,
  getTeamReadiness,
  MemberReadinessPageSchema,
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
const memberPageQuery = z.strictObject({
  memberIds: z
    .string()
    .max(3699)
    .transform((value) => value.split(','))
    .pipe(z.array(z.uuid()).min(1).max(100)),
})
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
    const memberAccess = teamManagementAccess(deps.db, caller, { memberReadScope: 'own_row' })
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
        path: '/api/v1/teams/{teamId}/member-readiness',
        summary: 'Read coarse shared health checks for visible team member rows',
        description:
          'Requires a current verified web session in this team. Owners and admins receive only the requested current-team membership rows; ordinary members receive only their own requested row. Missing, departed and other-team membership IDs are omitted without revealing existence. Reads the same cached configuration and sync evaluator as event-type readiness, with no slot search or provider request. No private schedule names, calendar names or IDs, account emails, events or busy maps are returned. Default-schedule health is user-owned and reused across teams. Conference account state is optional account health, not automatic-meeting eligibility or a booking promise. Pass 1–100 comma-separated membership IDs from the displayed members page in one request. X-Expected-Organization-Id binds this read to its opening team; a still-authorized member whose context changed receives 409 reload guidance, while inaccessible teams receive uniform 403. Every Authorization header is denied even with a valid session cookie.',
        tags: ['Readiness'],
        security: sessionSecurity,
        middleware: memberAccess.memberReadMiddleware,
        request: {
          params: z.object({ teamId: z.uuid() }),
          headers: z.object({ 'x-expected-organization-id': z.string().optional() }),
          query: memberPageQuery,
        },
        responses: {
          200: {
            description: 'Only the authorized requested member rows with coarse health checks',
            content: json(
              MemberReadinessPageSchema.openapi('MemberReadinessPage', {
                description: checkSemantics,
              }),
            ),
          },
          ...errorResponses({
            400: 'invalid_request or invalid_member_ids: provide 1–100 membership UUIDs',
            403: 'team_management_access_denied: requires current verified team membership',
            409: 'organization_context_changed: reload the page before retrying',
          }),
          500: internalError,
        },
      }),
      async (c) =>
        c.json(
          await memberAccess.readMember(
            c.var.principal,
            c.req.valid('param').teamId,
            async (db, actor) =>
              getTeamMemberReadiness(
                { db, ...actor, now: deps.now ?? (() => Temporal.Now.instant()) },
                c.req.valid('query').memberIds,
              ),
            c.req.valid('header')['x-expected-organization-id'],
          ),
          200,
        ),
    )
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
          'Rechecks a current verified owner/admin web session whose active team matches teamId on every request, including after organization switches and role changes. Returns verified, display-safe member names or the neutral label Team member, coarse reason codes and repair kinds, with no private calendar, account or schedule details. Any Authorization header is denied, even with a valid session cookie; API keys and MCP OAuth tokens are not session callers. Every access denial, including missing or invalid sessions, an ordinary member, a different team and a missing team, uses the same 403 team_management_access_denied without revealing team existence. Member and event-type pages default to 50 items each, at most 100; pass their nextCursor as memberCursor and eventTypeCursor respectively. Optional X-Expected-Organization-Id binds this read to its opening team. A caller who still owns or administers the expected team receives 409 organization_context_changed after switching to any other space, including personal or a member-only team; inaccessible expected teams retain the uniform 403. Omitting the header keeps existing reads.',
        tags: ['Readiness'],
        security: sessionSecurity,
        middleware: [...access.middleware, currentTeamSession] as [
          typeof caller,
          (typeof access.middleware)[1],
          typeof currentTeamSession,
        ],
        request: {
          params: z.object({ teamId: z.uuid() }),
          headers: z.object({
            'x-expected-organization-id': z.string().optional().openapi({
              description:
                'Optional team where the page opened; a still-authorized expected team with a different current space receives 409 reload guidance, otherwise 403',
            }),
          }),
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
          400: {
            description: 'invalid_request, invalid_limit or invalid_cursor',
            content: json(ErrorBody),
          },
          403: {
            description:
              'team_management_access_denied: requires the current team owner/admin web session without Authorization',
            content: json(ErrorBody),
          },
          409: {
            description:
              'organization_context_changed: the caller still owns or administers the expected team but the current space changed; reload before retrying',
            content: json(ErrorBody),
          },

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
