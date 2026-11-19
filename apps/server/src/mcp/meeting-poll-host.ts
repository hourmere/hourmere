import { z } from '@hono/zod-openapi'
import {
  cancelMeetingPoll,
  closeMeetingPoll,
  createMeetingPoll,
  deleteMeetingPoll,
  finalizeMeetingPoll,
  getMeetingPoll,
  getMeetingPollResults,
  inviteMeetingPollVoters,
  listMeetingPolls,
  type MeetingPollHostContext,
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
import { defineTool, type McpCaller, type Tool, type ToolCall } from './tools.ts'

const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
const write = { ...read, readOnlyHint: false, destructiveHint: true }
const invite = { ...read, readOnlyHint: false, openWorldHint: true }
const privacy = {
  privateInput: () => true,
  privateDiagnostics: true,
  privateValidationMessage: 'Invalid meeting poll request',
}
const revisionInput = z.strictObject({
  ...MeetingPollHostId.shape,
  ...MeetingPollHostRevision.shape,
})
const voterRevisionInput = z.strictObject({
  ...MeetingPollHostVoterId.shape,
  ...MeetingPollHostRevision.shape,
})

type HostToolDeps = Pick<
  MeetingPollHostContext,
  'db' | 'notify' | 'automaticMeet' | 'automaticZoom' | 'smsRemindersAvailable'
> & { meetingPollSecret?: string | undefined; publicUrl: string }

export function meetingPollHostTools({
  meetingPollSecret = '',
  publicUrl,
  ...deps
}: HostToolDeps): Tool[] {
  const context = (principal: McpCaller): MeetingPollHostContext => ({
    ...deps,
    meetingPollSecret,
    principal,
    now: () => Temporal.Now.instant(),
  })
  async function admissionContext(call: ToolCall): Promise<MeetingPollHostContext> {
    const ctx = context(call.caller)
    await enforceMeetingPollHostAdmission(ctx, call.trustedIp)
    return ctx
  }
  return [
    defineTool({
      name: 'list_meeting_polls',
      title: 'List managed meeting polls',
      description:
        'List managed polls as a personal event owner or current team owner/admin, newest first. Pass nextAfter as after. Omits voter rosters and voting links. API keys need read, bookings or full scope.',
      input: ListMeetingPollsInput,
      output: MeetingPollListOutput,
      annotations: read,
      ...privacy,
      async run(args, call) {
        return listMeetingPolls(context(call.caller), args)
      },
    }),
    defineTool({
      name: 'get_meeting_poll',
      title: 'Read a managed meeting poll',
      description:
        'Read a managed poll’s candidates, status and hostRevision. Omits ballots and voting links. Use get_meeting_poll_results for the roster and votes. API keys need read, bookings or full scope.',
      input: MeetingPollHostId,
      output: MeetingPollHostOutput,
      annotations: read,
      ...privacy,
      async run({ id }, call) {
        return getMeetingPoll(context(call.caller), id)
      },
    }),
    defineTool({
      name: 'get_meeting_poll_results',
      title: 'Read managed meeting poll results',
      description:
        'Read a managed poll’s private roster, ballots, vote counts and current revisions. Availability is advisory and reserves no time. Use these revisions to finalize. API keys need read, bookings or full scope.',
      input: MeetingPollHostId,
      output: MeetingPollResultsOutput,
      annotations: read,
      ...privacy,
      async run({ id }, call) {
        return getMeetingPollResults(context(call.caller), id)
      },
    }),
    defineTool({
      name: 'close_meeting_poll',
      title: 'Close meeting poll voting',
      description:
        'Stop voting using expectedHostRevision. Closing creates no booking and leaves the poll eligible for finalization. An already closed poll returns its current state. API keys need bookings or full scope.',
      input: revisionInput,
      output: MeetingPollHostOutput,
      annotations: write,
      ...privacy,
      async run(args, call) {
        return closeMeetingPoll(context(call.caller), args)
      },
    }),
    defineTool({
      name: 'cancel_meeting_poll',
      title: 'Cancel a meeting poll',
      description:
        'Cancel an unscheduled poll using expectedHostRevision. Cannot cancel a linked booking. An already canceled poll returns its current state. API keys need bookings or full scope.',
      input: revisionInput,
      output: MeetingPollHostOutput,
      annotations: { ...write, openWorldHint: true },
      ...privacy,
      async run(args, call) {
        return cancelMeetingPoll(context(call.caller), args)
      },
    }),
    defineTool({
      name: 'delete_meeting_poll',
      title: 'Delete a meeting poll',
      description:
        'Permanently delete a managed poll and its voter data using expectedHostRevision. Preserves any linked booking. API keys need bookings or full scope.',
      input: revisionInput,
      output: z.object({ deleted: z.literal(true) }),
      annotations: write,
      ...privacy,
      async run(args, call) {
        await deleteMeetingPoll(context(call.caller), args)
        return { deleted: true as const }
      },
    }),
    defineTool({
      name: 'finalize_meeting_poll',
      title: 'Finalize a meeting poll',
      description:
        'Book the chosen slot using current results and selected voters’ ballot revisions. Include the booker in attendeeVoterIds and acknowledge selected if_need_be votes. If the response is lost, replay the exact input with the original idempotencyKey. Omits booking management links and tokens. API keys need bookings or full scope.',
      input: z.strictObject({
        ...MeetingPollHostId.shape,
        ...FinalizeMeetingPollBody.shape,
        idempotencyKey: MeetingPollIdempotencyKey,
      }),
      output: FinalizeMeetingPollOutput,
      annotations: { ...write, openWorldHint: true },
      ...privacy,
      async run(args, call) {
        return finalizeMeetingPoll(context(call.caller), args, { source: 'mcp' })
      },
    }),
    defineTool({
      name: 'create_meeting_poll',
      title: 'Create a meeting poll',
      description:
        'Create an open poll for an event type you manage, using offered starts and a voting deadline. Sends no invitations and reserves no time. Returns a publicLink once in public_link mode. Exact retries return poll_already_created. API keys need bookings or full scope.',
      input: z.strictObject({
        ...CreateMeetingPollBody.shape,
        idempotencyKey: MeetingPollIdempotencyKey,
      }),
      output: MeetingPollLinkOutput,
      annotations: { ...read, readOnlyHint: false },
      ...privacy,
      async run(args, call) {
        const result = await createMeetingPoll(await admissionContext(call), args, {
          source: 'mcp',
        })
        return meetingPollLinkOutput(result, publicUrl)
      },
    }),
    defineTool({
      name: 'invite_meeting_poll_voters',
      title: 'Invite meeting poll voters',
      description:
        'Queue invitations for up to 40 supplied addresses while voting is open. Returns outcomes for those addresses without voter credentials. Replay with the original idempotencyKey to read current outcomes without sending again. API keys need bookings or full scope.',
      input: z.strictObject({
        ...MeetingPollHostId.shape,
        ...InviteMeetingPollVotersBody.shape,
        idempotencyKey: MeetingPollIdempotencyKey,
      }),
      output: InviteMeetingPollVotersOutput,
      annotations: invite,
      ...privacy,
      async run(args, call) {
        return inviteMeetingPollVoters(await admissionContext(call), args)
      },
    }),
    defineTool({
      name: 'resend_meeting_poll_invitation',
      title: 'Resend a meeting poll invitation',
      description:
        'Queue a replacement invitation for a current invitee while voting is open, using expectedHostRevision. Revokes the previous credential and returns no replacement credential. Exact retries with the original idempotencyKey queue no mail. API keys need bookings or full scope.',
      input: z.strictObject({
        ...voterRevisionInput.shape,
        idempotencyKey: MeetingPollIdempotencyKey,
      }),
      output: ResendMeetingPollInvitationOutput,
      annotations: { ...invite, destructiveHint: true },
      ...privacy,
      async run(args, call) {
        return resendMeetingPollInvitation(await admissionContext(call), args)
      },
    }),
    defineTool({
      name: 'remove_meeting_poll_voter',
      title: 'Remove a meeting poll voter',
      description:
        'Remove the specified voter, their ballot and credentials using expectedHostRevision. Returns removed voter IDs and current revisions. Does not remove a booked attendee from a linked booking. API keys need bookings or full scope.',
      input: voterRevisionInput,
      output: MeetingPollRemovalOutput,
      annotations: write,
      ...privacy,
      async run(args, call) {
        return removeMeetingPollVoter(context(call.caller), args)
      },
    }),
    defineTool({
      name: 'remove_unverified_meeting_poll_voters',
      title: 'Remove unverified public poll voters',
      description:
        'Remove unverified public-link enrollments using expectedHostRevision. Preserves host invitations and abuse counters. API keys need bookings or full scope.',
      input: revisionInput,
      output: MeetingPollRemovalOutput,
      annotations: write,
      ...privacy,
      async run(args, call) {
        return removeUnverifiedMeetingPollVoters(context(call.caller), args)
      },
    }),
    defineTool({
      name: 'rotate_meeting_poll_link',
      title: 'Rotate a meeting poll link',
      description:
        'Replace a public-link poll’s link using expectedHostRevision and idempotencyKey. Revokes the old link and returns its replacement once. An exact retry returns poll_link_already_rotated without a link. Unavailable for invited polls. API keys need bookings or full scope.',
      input: z.strictObject({
        ...revisionInput.shape,
        idempotencyKey: MeetingPollIdempotencyKey,
      }),
      output: MeetingPollLinkOutput,
      annotations: write,
      ...privacy,
      async run(args, call) {
        const result = await rotateMeetingPollLink(context(call.caller), args)
        return meetingPollLinkOutput(result, publicUrl)
      },
    }),
  ]
}
