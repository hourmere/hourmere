import { createRoute } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import {
  enrollMeetingPollVoter,
  optOutOfMeetingPollReminders,
  readMeetingPoll,
  recoverMeetingPollVoter,
  submitMeetingPollBallot,
  verifyMeetingPollVoter,
  withdrawMeetingPollVoter,
} from '@hourmere/scheduling'
import { routeBodyLimit } from '../body-limit.ts'
import { enforceMeetingPollRateLimit } from '../meeting-poll-rate-limit.ts'
import {
  AcceptedMeetingPollOutput,
  EnrollMeetingPollInput,
  MeetingPollBallotOutput,
  MeetingPollTokenInput,
  OptOutMeetingPollOutput,
  ReadMeetingPollInput,
  ReadMeetingPollOutput,
  RecoverMeetingPollInput,
  SubmitMeetingPollVoteInput,
  VerifyMeetingPollOutput,
  WithdrawMeetingPollInput,
} from '../meeting-poll-schemas.ts'
import { ErrorBody, json, type RouteModule } from '../openapi.ts'

const errors = {
  400: {
    description:
      'invalid_request, invalid_voter, invalid_time_zone, invalid_ballot or invalid_responses',
    content: json(ErrorBody),
  },
  404: {
    description: 'poll_not_found: invalid, expired, revoked, removed or unknown capability',
    content: json(ErrorBody),
  },
  409: {
    description: 'poll_full, poll_closed, poll_canceled or poll_changed',
    content: json(ErrorBody),
  },
  429: { description: 'rate_limited; Retry-After when known', content: json(ErrorBody) },
  503: {
    description: 'meeting_poll_key_mismatch: installation secret does not match retained data',
    content: json(ErrorBody),
  },
}

/** Public capabilities authorize each request; optional keys never replace a capability. */
export function meetingPollRoutes({
  db,
  meetingPollSecret = '',
}: {
  db: Db
  meetingPollSecret?: string
}): RouteModule {
  const context = (trustedIp: string | undefined) => ({ db, meetingPollSecret, trustedIp })
  return ({ app }) => {
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/public/meeting-polls/read',
        operationId: 'readMeetingPoll',
        summary: 'Read a meeting poll and your own ballot',
        middleware: routeBodyLimit(256 * 1024),
        request: { body: { required: true, content: json(ReadMeetingPollInput) } },
        responses: {
          200: {
            description: 'Privacy-filtered poll; no other voter identities',
            content: json(ReadMeetingPollOutput),
          },
          ...errors,
        },
      }),
      async (c) => {
        await enforceMeetingPollRateLimit(context(c.var.clientIp), 'read', c.var.clientIp)
        return c.json(await readMeetingPoll(context(c.var.clientIp), c.req.valid('json')), 200)
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/public/meeting-polls/enroll',
        operationId: 'enrollMeetingPollVoter',
        summary: 'Request mailbox verification to join a public poll',
        middleware: routeBodyLimit(256 * 1024),
        request: { body: { required: true, content: json(EnrollMeetingPollInput) } },
        responses: {
          202: {
            description: 'Uniform acceptance, without revealing mailbox membership',
            content: json(AcceptedMeetingPollOutput),
          },
          ...errors,
        },
      }),
      async (c) => {
        await enforceMeetingPollRateLimit(context(c.var.clientIp), 'admission', c.var.clientIp)
        return c.json(
          await enrollMeetingPollVoter(context(c.var.clientIp), c.req.valid('json')),
          202,
        )
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/public/meeting-polls/recover',
        operationId: 'recoverMeetingPollVoter',
        summary: 'Recover a lost voter link by poll ID and mailbox',
        middleware: routeBodyLimit(256 * 1024),
        request: { body: { required: true, content: json(RecoverMeetingPollInput) } },
        responses: {
          202: {
            description:
              'Uniform acceptance; no valid capability required and no credential rotation',
            content: json(AcceptedMeetingPollOutput),
          },
          ...errors,
        },
      }),
      async (c) => {
        await enforceMeetingPollRateLimit(context(c.var.clientIp), 'admission', c.var.clientIp)
        return c.json(
          await recoverMeetingPollVoter(context(c.var.clientIp), c.req.valid('json')),
          202,
        )
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/public/meeting-polls/verify',
        operationId: 'verifyMeetingPollVoter',
        summary: 'Explicitly verify a voter mailbox',
        middleware: routeBodyLimit(256 * 1024),
        request: { body: { required: true, content: json(MeetingPollTokenInput) } },
        responses: {
          200: {
            description: 'Own voter state; new voting token returned only once',
            content: json(VerifyMeetingPollOutput),
          },
          ...errors,
        },
      }),
      async (c) => {
        await enforceMeetingPollRateLimit(context(c.var.clientIp), 'admission', c.var.clientIp)
        return c.json(
          await verifyMeetingPollVoter(context(c.var.clientIp), c.req.valid('json')),
          200,
        )
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/public/meeting-polls/vote',
        operationId: 'submitMeetingPollVote',
        summary: 'Submit or replace a complete ballot, or reactivate after withdrawal',
        middleware: routeBodyLimit(256 * 1024),
        request: { body: { required: true, content: json(SubmitMeetingPollVoteInput) } },
        responses: {
          200: {
            description: 'Own ballot and new revision; stale revisions return poll_changed',
            content: json(MeetingPollBallotOutput),
          },
          ...errors,
        },
      }),
      async (c) => {
        await enforceMeetingPollRateLimit(context(c.var.clientIp), 'ballot', c.var.clientIp)
        return c.json(
          await submitMeetingPollBallot(context(c.var.clientIp), c.req.valid('json')),
          200,
        )
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/public/meeting-polls/withdraw',
        operationId: 'withdrawMeetingPollVote',
        summary: 'Withdraw your ballot and opt out of poll mail',
        middleware: routeBodyLimit(256 * 1024),
        request: { body: { required: true, content: json(WithdrawMeetingPollInput) } },
        responses: {
          200: {
            description: 'Own withdrawn state and ballot revision',
            content: json(MeetingPollBallotOutput),
          },
          ...errors,
        },
      }),
      async (c) => {
        await enforceMeetingPollRateLimit(context(c.var.clientIp), 'ballot', c.var.clientIp)
        return c.json(
          await withdrawMeetingPollVoter(context(c.var.clientIp), c.req.valid('json')),
          200,
        )
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/public/meeting-polls/reminder-opt-out',
        operationId: 'optOutMeetingPollReminder',
        summary: 'Opt out of reminders with a purpose-limited mail capability',
        middleware: routeBodyLimit(256 * 1024),
        request: { body: { required: true, content: json(MeetingPollTokenInput) } },
        responses: {
          200: {
            description: 'Opted-out state, without voter or ballot data',
            content: json(OptOutMeetingPollOutput),
          },
          ...errors,
        },
      }),
      async (c) => {
        await enforceMeetingPollRateLimit(context(c.var.clientIp), 'ballot', c.var.clientIp)
        return c.json(
          await optOutOfMeetingPollReminders(context(c.var.clientIp), c.req.valid('json')),
          200,
        )
      },
    )
  }
}
