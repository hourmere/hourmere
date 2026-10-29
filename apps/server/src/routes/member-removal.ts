import { createRoute, z } from '@hono/zod-openapi'
import { removeTeamMemberInTransaction, TeamManagementError } from '@hourmere/auth'
import {
  getLatestTeamMemberRemovalHandling,
  getTeamMemberRemovalHandling,
  MemberDepartureBookingSchema,
  MemberRemovalHandlingSchema,
  TeamAdminBookingSchema,
} from '@hourmere/scheduling'
import { DomainError } from '@hourmere/scheduling/errors'
import {
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'
import { EXPECTED_ORGANIZATION_HEADER, teamManagementAccess } from '../team-management.ts'

const Removal = z
  .object({
    operationId: z.uuid(),
    memberUserId: z.uuid(),
    deactivatedEventTypeIds: z.array(z.uuid()),
  })
  .openapi('MemberRemoval')
const HandlingBooking = z.object({
  ...MemberDepartureBookingSchema.shape,
  eventType: z.object(TeamAdminBookingSchema.shape.eventType.unwrap().shape).nullable(),
  hosts: z.array(z.object(TeamAdminBookingSchema.shape.hosts.element.shape)),
  attendees: z.array(z.object(TeamAdminBookingSchema.shape.attendees.element.shape)),
})
const RemovalHandling = z
  .object({
    ...MemberRemovalHandlingSchema.shape,
    bookings: z.object({
      ...MemberRemovalHandlingSchema.shape.bookings.shape,
      data: z.array(HandlingBooking),
    }),
  })
  .openapi('MemberRemovalHandling')
const HandlingQuery = z.strictObject({
  teamId: z.uuid(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(1024).optional(),
})

export function memberRemovalRoutes(deps: ServiceDeps): RouteModule {
  return ({ app, caller }) => {
    const access = teamManagementAccess(deps.db, caller)
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/team/members/{memberUserId}/removal',
        summary: 'Revoke a team membership immediately',
        description:
          'Requires a current verified owner/admin browser session and X-Expected-Organization-Id matching the requested team and current session. Owners may remove admins and members; admins may remove members. Owner targets are refused. In one transaction, revokes membership and deactivates team event types that lose their sole host, last current round-robin host or a required collective host. Existing bookings and saved hosts are preserved. Follow operationId through the handling-list route; affected event types require explicit repair and reactivation.',
        tags: ['Team members'],
        security: [{ session: [] }],
        middleware: caller,
        request: {
          params: z.strictObject({ memberUserId: z.uuid() }),
          headers: z.object({ 'x-expected-organization-id': z.string().optional() }),
          body: { required: true, content: json(z.strictObject({ teamId: z.uuid() })) },
        },
        responses: {
          200: { description: 'Membership revoked and removal recorded', content: json(Removal) },
          ...errorResponses({
            400: 'Invalid parameters (invalid_request)',
            403: 'team_management_access_denied: inaccessible team or disallowed member target',
            409: 'organization_context_changed: reload the page before trying again',
          }),
        },
      }),
      async (c) => {
        const { teamId } = c.req.valid('json')
        const { memberUserId } = c.req.valid('param')
        try {
          const result = await access.write(
            c.var.principal,
            teamId,
            (trx, actor) => removeTeamMemberInTransaction(trx, actor, { memberUserId }),
            { expectedOrganizationId: c.req.header(EXPECTED_ORGANIZATION_HEADER) ?? '' },
          )
          return c.json(result, 200)
        } catch (error) {
          if (!(error instanceof TeamManagementError)) throw error
          throw new DomainError('forbidden', 'team_management_access_denied')
        }
      },
    )
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/team/member-removals/{operationId}',
        summary: "Unfinished bookings requiring handling after a member's removal",
        description:
          'Requires a current verified owner/admin browser session in the requested team. The removal record remains readable after membership revocation. Returns the current confirmed bookings hosted by that removed member in this team and ending after evaluatedAt, including meetings in progress. Saved hosts and booking history are retained. In-progress bookings require waiting until the end or offline coordination; future cancellation retains existing authorization and time rules. Bookings are ordered by precise start time and id. Follow nextCursor as cursor with the same team and operation; limit defaults to 50 and is bounded to 100. Uses the team-administration field whitelist.',
        tags: ['Team members'],
        security: [{ session: [] }],
        middleware: access.middleware,
        request: {
          params: z.strictObject({ operationId: z.uuid() }),
          query: HandlingQuery,
        },
        responses: {
          200: { description: 'Current removal handling list', content: json(RemovalHandling) },
          ...errorResponses({
            400: 'Invalid parameters (invalid_request, invalid_cursor or invalid_limit)',
            403: 'team_management_access_denied: inaccessible team or removal record',
          }),
        },
      }),
      async (c) => {
        const result = await getTeamMemberRemovalHandling(serviceContext(deps, c.var.principal), {
          ...c.req.valid('query'),
          operationId: c.req.valid('param').operationId,
        })
        return c.json(result, 200)
      },
    )
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/team/members/{memberUserId}/removal-handling',
        summary: "Handling list for a member's latest recorded removal",
        description:
          'Requires a current verified owner/admin browser session in the requested team. Discovers the latest removal record for the known removed user, including removal through the native Better Auth endpoint. Uses the same current unfinished-booking whitelist, handling reasons and bounded pagination as the removal-record route. Keep the team and member unchanged while following cursors; use the returned id with the removal-record route to pin a particular record.',
        tags: ['Team members'],
        security: [{ session: [] }],
        middleware: access.middleware,
        request: {
          params: z.strictObject({ memberUserId: z.uuid() }),
          query: HandlingQuery,
        },
        responses: {
          200: { description: 'Latest removal handling list', content: json(RemovalHandling) },
          ...errorResponses({
            400: 'Invalid parameters (invalid_request, invalid_cursor or invalid_limit)',
            403: 'team_management_access_denied: inaccessible team or removal record',
          }),
        },
      }),
      async (c) => {
        const result = await getLatestTeamMemberRemovalHandling(
          serviceContext(deps, c.var.principal),
          { ...c.req.valid('query'), memberUserId: c.req.valid('param').memberUserId },
        )
        return c.json(result, 200)
      },
    )
  }
}
