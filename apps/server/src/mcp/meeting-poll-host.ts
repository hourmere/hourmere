import { z } from '@hono/zod-openapi'
import {
  cancelMeetingPoll,
  closeMeetingPoll,
  deleteMeetingPoll,
  finalizeMeetingPoll,
  getMeetingPoll,
  getMeetingPollResults,
  listMeetingPolls,
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
import { defineTool, type McpCaller, type Tool } from './tools.ts'

const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
const write = { ...read, readOnlyHint: false, destructiveHint: true }
const privacy = {
  privateInput: () => true,
  privateDiagnostics: true,
  privateValidationMessage: 'Invalid meeting poll request',
}
const revisionInput = z.strictObject({
  ...MeetingPollHostId.shape,
  ...MeetingPollHostRevision.shape,
})

type HostToolDeps = Pick<
  MeetingPollHostContext,
  'db' | 'notify' | 'automaticMeet' | 'automaticZoom' | 'smsRemindersAvailable'
> & { meetingPollSecret?: string | undefined }

export function meetingPollHostTools({ meetingPollSecret = '', ...deps }: HostToolDeps): Tool[] {
  const context = (principal: McpCaller): MeetingPollHostContext => ({
    ...deps,
    meetingPollSecret,
    principal,
    now: () => Temporal.Now.instant(),
  })
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
  ]
}
