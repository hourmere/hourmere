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
        'List polls in the acting organization that you manage as a personal event owner or current team owner/admin. Newest first. When nextAfter is present, pass it as after. Requires full, read or bookings key scope.',
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
        'Read managed poll metadata including candidates, current state and hostRevision. Requires full, read or bookings key scope.',
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
        'Read private roster and ballots, separate vote counts, hostRevision, resultsRevision and ballot revisions. Candidate availability is advisory and finalization rechecks it. Requires full, read or bookings key scope.',
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
        'Stop voting using expectedHostRevision. The poll stays available for finalization. A repeat for an already closed poll returns its current state. Requires full or bookings key scope.',
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
        'Cancel an open or closed poll using expectedHostRevision. A repeat for an already canceled poll returns its current state. Requires full or bookings key scope.',
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
        'Permanently delete a poll and its voter data using expectedHostRevision. Any linked booking is preserved. Requires full or bookings key scope.',
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
        'Book the chosen slot using the results revision and the selected voters’ ballot revisions. Include the booker in attendeeVoterIds and explicitly acknowledge conditional votes when selecting those voters. Keep the idempotencyKey for exact replay. Returns poll and safe booking metadata. Requires full or bookings key scope.',
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
        'Create an open poll for an event type you manage, with candidate starts and a voting deadline. Retain the random idempotencyKey. A public_link poll returns its voting link once. Invited mode returns publicLink: null. An exact retry returns poll_already_created with the authorized poll ID. Requires full or bookings key scope.',
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
        'Queue invitations for up to 40 supplied mailboxes while voting is open. Retain the random idempotencyKey. Returns an outcome for each supplied address. An exact retry reports current roster state and queues no mail. Requires full or bookings key scope.',
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
        'Queue a fresh invitation for a retained invitee, revoking their previous voting credential. Use expectedHostRevision and retain a random idempotencyKey. Exact retries queue no mail. Cooldowns and send budgets apply. Requires full or bookings key scope.',
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
        'Remove a voter, their ballot and credentials using expectedHostRevision. Returns removed voter IDs and current revisions. Requires full or bookings key scope.',
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
        'Remove unverified public-link enrollments using expectedHostRevision. Host invitations and abuse counters are preserved. Requires full or bookings key scope.',
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
        'Replace a public-link poll’s link using expectedHostRevision and a retained random idempotencyKey. The old link stops working immediately. Save the replacement link from this response. An exact retry returns poll_link_already_rotated. Invited polls return poll_link_unavailable. Requires full or bookings key scope.',
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
