import { createRoute, z } from '@hono/zod-openapi'
import {
  MemberDepartureOwnerRequiredError,
  removeTeamMember,
  TeamManagementError,
} from '@hourmere/auth'
import {
  getLatestTeamMemberRemovalHandling,
  getTeamMemberRemovalHandling,
  MemberDepartureBookingSchema,
  MemberRemovalHandlingSchema,
  TeamAdminBookingSchema,
} from '@hourmere/scheduling'
import { DomainError } from '@hourmere/scheduling/errors'
import {
  ErrorBody,
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'
import {
  EXPECTED_ORGANIZATION_HEADER,
  ORGANIZATION_CONTEXT_CHANGED,
  teamManagementAccess,
} from '../team-management.ts'

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

// These session-only routes convert authentication failures to the uniform 403.
function sessionErrorResponses(...args: Parameters<typeof errorResponses>) {
  const responses = errorResponses(...args)
  delete responses[401]
  return responses
}

const contextChanged = () =>
  new DomainError(
    'conflict',
    'organization_context_changed',
    'Your team context changed. Reload the page before trying again.',
  )

export function memberRemovalRoutes(deps: ServiceDeps): RouteModule {
  return ({ app, caller }) => {
    const access = teamManagementAccess(deps.db, caller)
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/team/members/{memberUserId}/removal',
        operationId: 'removeTeamMember',
        summary: 'Revoke a team membership immediately',
        description:
          'Requires a current verified owner/admin browser session and a same-origin Origin or Referer. Any Authorization header is denied before credential resolution, even with a valid session cookie. Missing or invalid sessions receive the same 403 team_management_access_denied without a WWW-Authenticate challenge. X-Expected-Organization-Id and body teamId must match the team where the action started and the current session team; missing context returns 409 organization_context_changed. A caller who still owns or administers the expected team receives the same 409 after switching to any other space, including personal or a member-only team; inaccessible expected teams retain the uniform 403. Owners may remove admins and members; admins may remove members. Owner targets and administrative self-removal receive the uniform 403 team_management_access_denied; owners may only use safe self departure. A defensive owner count preserves at least one current owner. The owner check runs after the same organization FOR UPDATE lock used by leave and role changes, inside the membership write transaction. In that transaction, revokes membership and deactivates team event types that lose their sole host, last current round-robin host or a required collective host. Existing bookings and saved hosts are preserved. Follow operationId through the handling-list route; affected event types require explicit repair and reactivation.',
        tags: ['Team members'],
        security: [{ session: [] }],
        middleware: access.middleware,
        request: {
          params: z.strictObject({ memberUserId: z.uuid() }),
          headers: z.object({
            'x-expected-organization-id': z
              .string()
              .optional()
              .openapi({
                description: 'Required: the organization where this removal action started',
                param: { required: true },
              }),
          }),
          body: { required: true, content: json(z.strictObject({ teamId: z.uuid() })) },
        },
        responses: {
          200: { description: 'Membership revoked and removal recorded', content: json(Removal) },
          ...sessionErrorResponses({
            400: 'Invalid parameters (invalid_request)',
            403: 'team_management_access_denied: requires a current team owner/admin session without Authorization and an accessible allowed member target; forbidden: cookie writes require same-origin Origin or Referer',
          }),
          409: {
            description: `${ORGANIZATION_CONTEXT_CHANGED}; member_departure_owner_required: add another owner first`,
            content: json(
              ErrorBody.extend({
                handling: z
                  .object({
                    owner: z.literal('another_owner_is_needed_before_you_can_leave').optional(),
                    nextStep: z.literal('add_another_owner_first').optional(),
                  })
                  .optional(),
              }),
            ),
          },
        },
      }),
      async (c) => {
        const { teamId } = c.req.valid('json')
        const { memberUserId } = c.req.valid('param')
        const expectedOrganizationId = c.req.header(EXPECTED_ORGANIZATION_HEADER) ?? ''
        if (teamId.toLowerCase() !== c.var.principal.organization.id.toLowerCase())
          throw contextChanged()
        try {
          const result = await access.write(
            c.var.principal,
            teamId,
            (trx, actor) =>
              removeTeamMember(trx, c.var.principal, {
                teamId: actor.organizationId,
                memberUserId,
                expectedOrganizationId,
              }),
            { expectedOrganizationId },
          )
          return c.json(result, 200)
        } catch (error) {
          if (error instanceof MemberDepartureOwnerRequiredError) {
            return c.json(
              { error: error.code, message: error.message, handling: error.handling },
              409,
            )
          }
          if (!(error instanceof TeamManagementError)) throw error
          if (error.code === 'organization_context_changed') throw contextChanged()
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
          'Requires a current verified owner/admin browser session in the requested team. The removal record remains readable after membership revocation. Returns the current confirmed bookings hosted by that removed member in this team and ending after evaluatedAt, including meetings in progress. Saved hosts and booking history are retained. In-progress bookings require waiting until the end or offline coordination; future cancellation retains existing authorization and time rules. Bookings are ordered by precise start time and id. Follow nextCursor as cursor with the same team and operation; limit defaults to 50 and is bounded to 100. Uses the team-administration field whitelist. Optional X-Expected-Organization-Id binds this read to its opening team. A caller who still owns or administers the expected team receives 409 organization_context_changed after switching to any other space, including personal or a member-only team; inaccessible expected teams retain the uniform 403. Omitting the header keeps existing reads.',
        tags: ['Team members'],
        security: [{ session: [] }],
        middleware: access.middleware,
        request: {
          params: z.strictObject({ operationId: z.uuid() }),
          headers: z.object({
            'x-expected-organization-id': z.string().optional().openapi({
              description:
                'Optional team where the page opened; a still-authorized expected team with a different current space receives 409 reload guidance, otherwise 403',
            }),
          }),
          query: HandlingQuery,
        },
        responses: {
          200: { description: 'Current removal handling list', content: json(RemovalHandling) },
          ...sessionErrorResponses({
            400: 'Invalid parameters (invalid_request, invalid_cursor or invalid_limit)',
            403: 'team_management_access_denied: inaccessible team or removal record',
          }),
          409: {
            description:
              'organization_context_changed: the caller still owns or administers the expected team but the current space changed; reload before retrying',
            content: json(ErrorBody),
          },
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
          'Requires a current verified owner/admin browser session in the requested team. Discovers the latest removal record for the known removed user, including removal through the native Better Auth endpoint. Uses the same current unfinished-booking whitelist, handling reasons and bounded pagination as the removal-record route. Keep the team and member unchanged while following cursors; use the returned id with the removal-record route to pin a particular record. Optional X-Expected-Organization-Id binds this read to its opening team. A caller who still owns or administers the expected team receives 409 organization_context_changed after switching to any other space, including personal or a member-only team; inaccessible expected teams retain the uniform 403. Omitting the header keeps existing reads.',
        tags: ['Team members'],
        security: [{ session: [] }],
        middleware: access.middleware,
        request: {
          params: z.strictObject({ memberUserId: z.uuid() }),
          headers: z.object({
            'x-expected-organization-id': z.string().optional().openapi({
              description:
                'Optional team where the page opened; a still-authorized expected team with a different current space receives 409 reload guidance, otherwise 403',
            }),
          }),
          query: HandlingQuery,
        },
        responses: {
          200: { description: 'Latest removal handling list', content: json(RemovalHandling) },
          ...sessionErrorResponses({
            400: 'Invalid parameters (invalid_request, invalid_cursor or invalid_limit)',
            403: 'team_management_access_denied: inaccessible team or removal record',
          }),
          409: {
            description:
              'organization_context_changed: the caller still owns or administers the expected team but the current space changed; reload before retrying',
            content: json(ErrorBody),
          },
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
