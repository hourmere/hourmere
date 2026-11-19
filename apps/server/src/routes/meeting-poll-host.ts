import { createRoute, z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import {
  type BookingNotifier,
  cancelMeetingPoll,
  closeMeetingPoll,
  createMeetingPoll,
  deleteMeetingPoll,
  finalizeMeetingPoll,
  getMeetingPoll,
  getMeetingPollResults,
  inviteMeetingPollVoters,
  listMeetingPolls,
  MEETING_POLL_PAGE_DEFAULT,
  MeetingPollAlreadyCreatedError,
  MeetingPollAlreadyScheduledError,
  type MeetingPollHostContext,
  MeetingPollSlotUnavailableError,
  removeMeetingPollVoter,
  removeUnverifiedMeetingPollVoters,
  resendMeetingPollInvitation,
  rotateMeetingPollLink,
} from '@hourmere/scheduling'
import {
  CreateMeetingPollBody,
  FinalizeMeetingPollBody,
  FinalizeMeetingPollOutput,
  InviteMeetingPollVotersBody,
  InviteMeetingPollVotersOutput,
  ListMeetingPollsInput,
  MeetingPollHostId,
  MeetingPollHostOutput,
  MeetingPollHostRevision,
  MeetingPollHostVoterId,
  MeetingPollIdempotencyKey,
  MeetingPollLinkOutput,
  MeetingPollListOutput,
  MeetingPollRemovalOutput,
  MeetingPollResultsOutput,
  meetingPollLinkOutput,
  ResendMeetingPollInvitationOutput,
} from '../meeting-poll-host-schemas.ts'
import { enforceMeetingPollHostAdmission } from '../meeting-poll-rate-limit.ts'
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
const IdempotencyHeaders = ExpectedOrganizationHeaders.extend({
  'idempotency-key': MeetingPollIdempotencyKey,
})
const RevisionRequest = {
  params: MeetingPollHostId,
  headers: ExpectedOrganizationHeaders,
  body: { content: json(MeetingPollHostRevision), required: true },
}
const managerAccess = 'team_management_access_denied: requires current poll management authority'
const writeAccess = `${managerAccess}; insufficient_scope; ${CROSS_ORIGIN_WRITE}`
const pollNotFound = 'poll_not_found: the poll is missing or inaccessible in the current space'
const hostErrors = errorResponses({
  400: 'invalid_request or invalid_poll',
  403: writeAccess,
  404: pollNotFound,
  409: `${ORGANIZATION_CONTEXT_CHANGED}; poll_changed, poll_canceled or poll_already_scheduled`,
})
const secretError = {
  description: 'meeting_poll_key_mismatch: installation secret does not match retained data',
  content: json(ErrorBody),
}
const hostAdmissionLimit = {
  description: 'rate_limited: host admission, API key or resend limit. Retry-After when known.',
  content: json(ErrorBody),
}
const CreateConflict = ErrorBody.extend({
  pollId: MeetingPollHostId.shape.id.nullable().optional().openapi({
    description: 'For poll_already_created, the authorized poll ID or null after deletion.',
  }),
  unavailableStarts: CreateMeetingPollBody.shape.candidateStarts.optional().openapi({
    description: 'For slot_unavailable, the candidate starts the event does not currently offer.',
  }),
})
const rosterErrors = errorResponses({
  400: 'invalid_request, invalid_poll, invalid_idempotency_key, invalid_voter, invalid_time_zone or poll_limit_exceeded',
  403: writeAccess,
  404: `${pollNotFound}; unknown or inaccessible voters also return poll_not_found`,
  409: `${ORGANIZATION_CONTEXT_CHANGED}; poll_changed, poll_full, poll_closed, poll_canceled, poll_already_scheduled, voter_withdrawn or idempotency_key_reused`,
})
const FinalizeConflict = ErrorBody.extend({
  poll: MeetingPollHostOutput.optional().openapi({
    description:
      'Current safe poll metadata for a competing finalization (poll_already_scheduled).',
  }),
})

/** Authenticated current-space adapters for the meeting poll host services. */
export function meetingPollHostRoutes(
  deps: ServiceDeps & {
    publicUrl: string
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
        ...write,
        method: 'post',
        path: '/api/v1/meeting-polls',
        operationId: 'createMeetingPoll',
        summary: 'Create a meeting poll',
        description:
          'Create an open poll over offered candidate times. Only the initial response discloses its public link, and invited polls have no public link. Requires bookings or full API-key scope, or a same-origin session bound to the expected organization.',
        request: {
          headers: IdempotencyHeaders,
          body: { content: json(CreateMeetingPollBody), required: true },
        },
        responses: {
          201: {
            description: 'Created with a one-time public link disclosure',
            content: json(MeetingPollLinkOutput),
          },
          ...errorResponses({
            400: 'invalid_request, invalid_poll, invalid_duration, invalid_time_zone, invalid_idempotency_key, poll_limit_exceeded, event_type_inactive or poll_event_unsupported',
            403: writeAccess,
            404: 'event_type_not_found: the event type is missing or inaccessible in the current space',
          }),
          409: {
            description: `${ORGANIZATION_CONTEXT_CHANGED}; poll_already_created, idempotency_key_reused, slot_unavailable, calendar_sync_unavailable, event_type_unavailable or poll_event_changed`,
            content: json(CreateConflict),
          },
          429: hostAdmissionLimit,
          503: secretError,
        },
      }),
      async (c) => {
        const ctx = writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER))
        await enforceMeetingPollHostAdmission(ctx, c.var.clientIp)
        try {
          const result = await createMeetingPoll(ctx, {
            ...c.req.valid('json'),
            idempotencyKey: c.req.valid('header')['idempotency-key'],
          })
          return c.json(
            MeetingPollLinkOutput.parse(meetingPollLinkOutput(result, deps.publicUrl)),
            201,
          )
        } catch (error) {
          if (error instanceof MeetingPollAlreadyCreatedError)
            return c.json({ error: error.code, pollId: error.pollId }, 409)
          if (error instanceof MeetingPollSlotUnavailableError)
            return c.json({ error: error.code, unavailableStarts: error.unavailableStarts }, 409)
          throw error
        }
      },
    )
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
        middleware: callerWithBodyLimit(caller, 128 * 1024),
        method: 'post',
        path: '/api/v1/meeting-polls/{id}/invitations',
        operationId: 'inviteMeetingPollVoters',
        summary: 'Invite voters to a meeting poll',
        description:
          'Admit an entire bounded batch or refuse it when there is insufficient capacity. Queues invitations only for newly admitted or upgraded host-supplied mailboxes. Exact retries return current roster outcomes for those addresses without more mail.',
        request: {
          params: MeetingPollHostId,
          headers: IdempotencyHeaders,
          body: { content: json(InviteMeetingPollVotersBody), required: true },
        },
        responses: {
          202: {
            description: 'Invitation outcomes and safe poll metadata',
            content: json(InviteMeetingPollVotersOutput),
          },
          ...rosterErrors,
          429: hostAdmissionLimit,
          503: secretError,
        },
      }),
      async (c) => {
        const ctx = writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER))
        await enforceMeetingPollHostAdmission(ctx, c.var.clientIp)
        const result = await inviteMeetingPollVoters(ctx, {
          ...c.req.valid('json'),
          id: c.req.valid('param').id,
          idempotencyKey: c.req.valid('header')['idempotency-key'],
        })
        return c.json(InviteMeetingPollVotersOutput.parse(result), 202)
      },
    )
    app.openapi(
      createRoute({
        ...write,
        method: 'post',
        path: '/api/v1/meeting-polls/{id}/invitations/{voterId}/resend',
        operationId: 'resendMeetingPollInvitation',
        summary: 'Resend a meeting poll invitation',
        description:
          'Queue a new credential for the retained invitee under mail and resend limits. The old credential is invalidated. An exact retry queues no further mail.',
        request: {
          ...RevisionRequest,
          params: MeetingPollHostVoterId,
          headers: IdempotencyHeaders,
        },
        responses: {
          202: {
            description: 'Resend accepted or replayed',
            content: json(ResendMeetingPollInvitationOutput),
          },
          ...rosterErrors,
          429: hostAdmissionLimit,
          503: secretError,
        },
      }),
      async (c) => {
        const ctx = writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER))
        await enforceMeetingPollHostAdmission(ctx, c.var.clientIp)
        const result = await resendMeetingPollInvitation(ctx, {
          ...c.req.valid('param'),
          ...c.req.valid('json'),
          idempotencyKey: c.req.valid('header')['idempotency-key'],
        })
        return c.json(ResendMeetingPollInvitationOutput.parse(result), 202)
      },
    )
    const removalResponse = {
      description: 'Current poll metadata, results revision and removed voter IDs',
      content: json(MeetingPollRemovalOutput),
    }
    app.openapi(
      createRoute({
        ...write,
        method: 'delete',
        path: '/api/v1/meeting-polls/{id}/voters/{voterId}',
        operationId: 'removeMeetingPollVoter',
        summary: 'Remove a meeting poll voter',
        description: 'Revoke voter access, delete the voter row and release capacity.',
        request: { ...RevisionRequest, params: MeetingPollHostVoterId },
        responses: { 200: removalResponse, ...hostErrors, 503: secretError },
      }),
      async (c) => {
        const result = await removeMeetingPollVoter(
          writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          { ...c.req.valid('param'), ...c.req.valid('json') },
        )
        return c.json(MeetingPollRemovalOutput.parse(result), 200)
      },
    )
    app.openapi(
      createRoute({
        ...write,
        method: 'post',
        path: '/api/v1/meeting-polls/{id}/remove-unverified',
        operationId: 'removeUnverifiedMeetingPollVoters',
        summary: 'Remove unverified public meeting poll voters',
        description: 'Remove live unverified public enrollments and preserve host invitations.',
        request: RevisionRequest,
        responses: { 200: removalResponse, ...hostErrors, 503: secretError },
      }),
      async (c) => {
        const result = await removeUnverifiedMeetingPollVoters(
          writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          { ...c.req.valid('param'), ...c.req.valid('json') },
        )
        return c.json(MeetingPollRemovalOutput.parse(result), 200)
      },
    )
    app.openapi(
      createRoute({
        ...write,
        method: 'post',
        path: '/api/v1/meeting-polls/{id}/rotate-link',
        operationId: 'rotateMeetingPollLink',
        summary: 'Replace the public link for a meeting poll',
        description:
          'Invalidates the old public link immediately. The new link is disclosed only on the first successful response. Available in public_link mode.',
        request: { ...RevisionRequest, headers: IdempotencyHeaders },
        responses: {
          200: {
            description: 'Rotated with a one-time public link disclosure',
            content: json(MeetingPollLinkOutput),
          },
          ...errorResponses({
            400: 'invalid_request, invalid_poll or invalid_idempotency_key',
            403: writeAccess,
            404: pollNotFound,
            409: `${ORGANIZATION_CONTEXT_CHANGED}; poll_changed, poll_link_unavailable, poll_link_already_rotated or idempotency_key_reused`,
          }),
        },
      }),
      async (c) => {
        const result = await rotateMeetingPollLink(
          writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          {
            ...c.req.valid('param'),
            ...c.req.valid('json'),
            idempotencyKey: c.req.valid('header')['idempotency-key'],
          },
        )
        return c.json(
          MeetingPollLinkOutput.parse(meetingPollLinkOutput(result, deps.publicUrl)),
          200,
        )
      },
    )
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
          headers: IdempotencyHeaders,
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
