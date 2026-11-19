import { createRoute, z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import {
  type BookingNotifier,
  cancelMeetingPoll,
  closeMeetingPoll,
  deleteMeetingPoll,
  finalizeMeetingPoll,
  getMeetingPoll,
  getMeetingPollResults,
  listMeetingPolls,
  MEETING_POLL_PAGE_DEFAULT,
  MeetingPollAlreadyScheduledError,
  type MeetingPollHostContext,
} from '@hourmere/scheduling'
import {
  FinalizeMeetingPollBody,
  FinalizeMeetingPollOutput,
  ListMeetingPollsInput,
  MeetingPollHostId,
  MeetingPollHostOutput,
  MeetingPollHostRevision,
  MeetingPollIdempotencyKey,
  MeetingPollListOutput,
  MeetingPollResultsOutput,
} from '../meeting-poll-host-schemas.ts'
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
import {
  EXPECTED_ORGANIZATION_HEADER,
  ORGANIZATION_CONTEXT_CHANGED,
  organizationContextAccess,
  organizationContextWriteLock,
} from '../team-management.ts'

const PollListQuery = ListMeetingPollsInput.extend({
  limit: z.coerce.number().optional().openapi({
    default: MEETING_POLL_PAGE_DEFAULT,
    description: 'Page size, an integer from 1 to 100.',
  }),
})
const ExpectedOrganizationHeaders = z.object({
  'x-expected-organization-id': z.string().optional().openapi({
    description: 'Required for cookie-authenticated writes. The space where the action began.',
  }),
})
const RevisionRequest = {
  params: MeetingPollHostId,
  headers: ExpectedOrganizationHeaders,
  body: { content: json(MeetingPollHostRevision), required: true },
}
const managerAccess = 'team_management_access_denied: requires current poll management authority'
const pollNotFound = 'poll_not_found: the poll is missing or inaccessible in the current space'
const hostErrors = errorResponses({
  400: 'invalid_request or invalid_poll',
  403: `${managerAccess}; ${CROSS_ORIGIN_WRITE}`,
  404: pollNotFound,
  409: `${ORGANIZATION_CONTEXT_CHANGED}; poll_changed, poll_canceled or poll_already_scheduled`,
})
const secretError = {
  description: 'meeting_poll_key_mismatch: installation secret does not match retained data',
  content: json(ErrorBody),
}
const FinalizeConflict = ErrorBody.extend({
  poll: MeetingPollHostOutput.optional().openapi({
    description:
      'Current safe poll metadata for a competing finalization (poll_already_scheduled).',
  }),
})

/** Authenticated current-space adapters for the meeting poll host services. */
export function meetingPollHostRoutes(
  deps: ServiceDeps & {
    meetingPollSecret?: string | undefined
    notify?: BookingNotifier | undefined
  },
): RouteModule {
  const context = (principal: Principal): MeetingPollHostContext => ({
    ...serviceContext(deps, principal),
    meetingPollSecret: deps.meetingPollSecret ?? '',
    notify: deps.notify,
  })
  const writeContext = (principal: Principal, expectedOrganizationId: string | undefined) => ({
    ...context(principal),
    authorizeOrganizationWrite: async (trx: ServiceDeps['db'], organizationId: string) => {
      await organizationContextWriteLock(principal)(trx)
      await organizationContextAccess(
        principal,
        expectedOrganizationId,
        true,
        'key share',
      )(trx, organizationId)
    },
  })

  return ({ app, caller }) => {
    const read = { tags: ['Meeting polls'], security: authenticated, middleware: caller }
    const write = { ...read, middleware: callerWithBodyLimit(caller, 16_384) }
    const pollResponse = {
      description: 'Current host metadata',
      content: json(MeetingPollHostOutput),
    }
    app.openapi(
      createRoute({
        ...read,
        method: 'get',
        path: '/api/v1/meeting-polls',
        operationId: 'listMeetingPolls',
        summary: 'List meeting polls in the current organization',
        description:
          'For the personal event owner or current team owners and admins. Newest first. Pass nextAfter as after to continue. Accepts read, bookings and full API-key scopes.',
        request: { query: PollListQuery },
        responses: {
          200: { description: 'A page of polls', content: json(MeetingPollListOutput) },
          ...errorResponses({
            400: 'invalid_request, invalid_cursor or invalid_limit',
            403: managerAccess,
          }),
        },
      }),
      async (c) =>
        c.json(await listMeetingPolls(context(c.var.principal), c.req.valid('query')), 200),
    )
    app.openapi(
      createRoute({
        ...read,
        method: 'get',
        path: '/api/v1/meeting-polls/{id}',
        operationId: 'getMeetingPoll',
        summary: 'Read a meeting poll’s host metadata',
        description: 'Includes effective lifecycle state, candidates and host revision.',
        request: { params: MeetingPollHostId },
        responses: {
          200: pollResponse,
          ...errorResponses({ 400: 'invalid_request', 403: managerAccess, 404: pollNotFound }),
        },
      }),
      async (c) =>
        c.json(await getMeetingPoll(context(c.var.principal), c.req.valid('param').id), 200),
    )
    app.openapi(
      createRoute({
        ...read,
        method: 'get',
        path: '/api/v1/meeting-polls/{id}/results',
        operationId: 'getMeetingPollResults',
        summary: 'Read a meeting poll’s private results',
        description:
          'Includes the roster, separate ballot counts, results and ballot revisions, and advisory availability. Keep voter details private. Finalization revalidates current availability.',
        request: { params: MeetingPollHostId },
        responses: {
          200: { description: 'Poll results', content: json(MeetingPollResultsOutput) },
          ...errorResponses({ 400: 'invalid_request', 403: managerAccess, 404: pollNotFound }),
          503: secretError,
        },
      }),
      async (c) =>
        c.json(await getMeetingPollResults(context(c.var.principal), c.req.valid('param').id), 200),
    )
    for (const { action, operationId, service, summary } of [
      {
        action: 'close',
        operationId: 'closeMeetingPoll',
        service: closeMeetingPoll,
        summary: 'Close voting on a meeting poll',
      },
      {
        action: 'cancel',
        operationId: 'cancelMeetingPoll',
        service: cancelMeetingPoll,
        summary: 'Cancel an unscheduled meeting poll',
      },
    ] as const) {
      app.openapi(
        createRoute({
          ...write,
          method: 'post',
          path: `/api/v1/meeting-polls/{id}/${action}`,
          operationId,
          summary,
          description:
            'Requires bookings or full API-key scope, or a same-origin browser session bound to the expected organization. An already completed transition returns current state.',
          request: RevisionRequest,
          responses: { 200: pollResponse, ...hostErrors },
        }),
        async (c) =>
          c.json(
            await service(
              writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
              { id: c.req.valid('param').id, ...c.req.valid('json') },
            ),
            200,
          ),
      )
    }
    app.openapi(
      createRoute({
        ...write,
        method: 'delete',
        path: '/api/v1/meeting-polls/{id}',
        operationId: 'deleteMeetingPoll',
        summary: 'Delete a meeting poll and its voter data',
        description:
          'Uses the current host revision. A linked booking is preserved. Requires bookings or full API-key scope, or a same-origin browser session bound to the expected organization.',
        request: RevisionRequest,
        responses: { 204: { description: 'Deleted' }, ...hostErrors },
      }),
      async (c) => {
        await deleteMeetingPoll(
          writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          { id: c.req.valid('param').id, ...c.req.valid('json') },
        )
        return c.body(null, 204)
      },
    )
    app.openapi(
      createRoute({
        ...write,
        method: 'post',
        path: '/api/v1/meeting-polls/{id}/finalize',
        operationId: 'finalizeMeetingPoll',
        summary: 'Book a meeting poll’s selected time and voters',
        description:
          'Finalize in one transaction. Retain the idempotency key for an exact retry. Requires bookings or full API-key scope, or a same-origin browser session bound to the expected organization.',
        request: {
          params: MeetingPollHostId,
          headers: ExpectedOrganizationHeaders.extend({
            'idempotency-key': MeetingPollIdempotencyKey,
          }),
          body: { content: json(FinalizeMeetingPollBody), required: true },
        },
        responses: {
          200: {
            description: 'Exact replay with current booking metadata',
            content: json(FinalizeMeetingPollOutput),
          },
          201: {
            description: 'Finalized with safe booking metadata',
            content: json(FinalizeMeetingPollOutput),
          },
          ...errorResponses({
            400: 'invalid_request, invalid_poll, invalid_idempotency_key, poll_event_unsupported, poll_conditional_acknowledgment_required, too_many_guests, invalid_responses or a booking validation error',
            403: `${managerAccess}; ${CROSS_ORIGIN_WRITE}`,
            404: pollNotFound,
          }),
          409: {
            description: `${ORGANIZATION_CONTEXT_CHANGED}; poll_changed, poll_canceled, poll_already_scheduled, idempotency_key_reused, poll_event_changed, poll_attendee_ineligible, event_type_unavailable, slot_unavailable, slot_taken, calendar_sync_unavailable or location_unavailable`,
            content: json(FinalizeConflict),
          },
          503: secretError,
        },
      }),
      async (c) => {
        try {
          const result = await finalizeMeetingPoll(
            writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            {
              ...c.req.valid('json'),
              id: c.req.valid('param').id,
              idempotencyKey: c.req.valid('header')['idempotency-key'],
            },
          )
          return c.json(FinalizeMeetingPollOutput.parse(result), result.replayed ? 200 : 201)
        } catch (error) {
          if (!(error instanceof MeetingPollAlreadyScheduledError)) throw error
          return c.json({ error: error.code, poll: MeetingPollHostOutput.parse(error.poll) }, 409)
        }
      },
    )
  }
}
