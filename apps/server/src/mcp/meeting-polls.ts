// Capability authority belongs to the shared services; API keys only constrain scope.
import type { Db } from '@hourmere/db'
import {
  enrollMeetingPollVoter,
  MeetingPollKeyMismatchError,
  type MeetingPollPublicContext,
  optOutOfMeetingPollReminders,
  readMeetingPoll,
  recoverMeetingPollVoter,
  submitMeetingPollBallot,
  verifyMeetingPollVoter,
  withdrawMeetingPollVoter,
} from '@hourmere/scheduling'
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
import { defineTool, type Tool, type ToolCall } from './tools.ts'

const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
const privacy = {
  privateInput: () => true,
  privateDiagnostics: true,
  privateValidationMessage: 'Invalid meeting poll request',
}

export function meetingPollTools({
  db,
  meetingPollSecret,
}: {
  db: Db
  meetingPollSecret?: string | undefined
}): Tool[] {
  async function context(
    call: ToolCall,
    bucket: 'read' | 'admission' | 'ballot',
  ): Promise<MeetingPollPublicContext> {
    if (!meetingPollSecret) throw new MeetingPollKeyMismatchError()
    const ctx = { db, meetingPollSecret, trustedIp: call.trustedIp }
    await enforceMeetingPollRateLimit(ctx, bucket, call.trustedIp)
    return ctx
  }
  return [
    defineTool({
      name: 'read_meeting_poll',
      title: 'Read a meeting poll',
      description:
        'Read the poll named by token, a public-link or voter capability. Returns its safe snapshot and only this voter’s own ballot; aggregate counts require verified voter access and aggregate visibility. No names, mailboxes, roster or other ballots are disclosed. Voting credentials retain read access after the deadline until removal or retention. Requires read, bookings or full key scope; the key alone grants no poll access.',
      input: ReadMeetingPollInput,
      output: ReadMeetingPollOutput,
      annotations: read,
      ...privacy,
      async run(args, call) {
        return readMeetingPoll(await context(call, 'read'), args)
      },
    }),
    defineTool({
      name: 'enroll_meeting_poll_voter',
      title: 'Join a meeting poll',
      description:
        'Request mailbox verification with publicToken, name, email, timeZone and optional locale. Relay only the invitee’s request. Requires bookings or full key scope. Accepted is uniform for known and unknown mailboxes; poll_full applies uniformly to every mailbox when the poll has 40 places. Does not verify, vote or return a credential. Enrollment, recovery and verification share a durable 10-request/minute trusted-IP budget across REST and MCP; pending reservations are additionally limited to three per IP/poll. Never retry automatically.',
      input: EnrollMeetingPollInput,
      output: AcceptedMeetingPollOutput,
      annotations: { ...read, readOnlyHint: false, idempotentHint: false, openWorldHint: true },
      ...privacy,
      async run(args, call) {
        return enrollMeetingPollVoter(await context(call, 'admission'), args)
      },
    }),
    defineTool({
      name: 'recover_meeting_poll_voter',
      title: 'Recover a meeting poll email',
      description:
        'On the voter’s explicit request, submit pollId and email without any valid token. Requires bookings or full key scope. Always answers accepted without revealing whether the poll or mailbox exists or mail was sent. Eligible recipients receive the unchanged current credential under persistent mail cooldowns and caps; recovery never enrolls an uninvited address, rotates a credential or extends expiry. Shares the admission request budget. Never retry automatically.',
      input: RecoverMeetingPollInput,
      output: AcceptedMeetingPollOutput,
      annotations: { ...read, readOnlyHint: false, idempotentHint: false, openWorldHint: true },
      ...privacy,
      async run(args, call) {
        return recoverMeetingPollVoter(await context(call, 'admission'), args)
      },
    }),
    defineTool({
      name: 'verify_meeting_poll_voter',
      title: 'Verify a meeting poll mailbox',
      description:
        'Explicitly confirm the voter’s emailed token while voting is open, only with their permission. Requires bookings or full key scope. A public verification token is consumed once; its replacement votingToken is returned once and mailed privately. Repeats mint and send nothing. Invitation voting credentials stay unchanged. Does not submit a ballot or consent. Keep any returned token private; shares the admission request budget.',
      input: MeetingPollTokenInput,
      output: VerifyMeetingPollOutput,
      annotations: { ...read, readOnlyHint: false, openWorldHint: true },
      ...privacy,
      async run(args, call) {
        return verifyMeetingPollVoter(await context(call, 'admission'), args)
      },
    }),
    defineTool({
      name: 'submit_meeting_poll_vote',
      title: 'Submit a meeting poll ballot',
      description:
        'Relay only the voter’s explicit choices using their voting token, one yes/if_need_be/no vote per candidate, consent:true, booking-question responses and expectedBallotRevision (0 initially). Optional name/timeZone/locale edits do not change email. Requires bookings or full key scope. Replaces the complete ballot; from withdrawn state it reactivates with renewed consent and an atomic capacity check. Returns only the own ballot and revision. A stale or lost-response retry returns poll_changed; read before reconciling. Shares a durable 30-request/minute trusted-IP budget with withdraw and opt-out. No automatic retry.',
      input: SubmitMeetingPollVoteInput,
      output: MeetingPollBallotOutput,
      annotations: { ...read, readOnlyHint: false, idempotentHint: false, destructiveHint: true },
      ...privacy,
      async run(args, call) {
        return submitMeetingPollBallot(await context(call, 'ballot'), args)
      },
    }),
    defineTool({
      name: 'withdraw_meeting_poll_vote',
      title: 'Withdraw a meeting poll ballot',
      description:
        'Withdraw with the voter’s explicit permission, their voting token and expectedBallotRevision while the poll is open. Requires bookings or full key scope. Clears votes, answers and consent, frees the place and stops poll mail. Returns only the own withdrawn state. Retains the credential for reading and explicit reactivation by a new consented ballot; stale revisions return poll_changed. Shares the ballot request budget.',
      input: WithdrawMeetingPollInput,
      output: MeetingPollBallotOutput,
      annotations: { ...read, readOnlyHint: false, destructiveHint: true },
      ...privacy,
      async run(args, call) {
        return withdrawMeetingPollVoter(await context(call, 'ballot'), args)
      },
    }),
    defineTool({
      name: 'opt_out_meeting_poll_reminder',
      title: 'Stop meeting poll reminders',
      description:
        'Use only the purpose-limited reminder-opt-out token from the email, with the recipient’s permission, to stop reminders. Requires bookings or full key scope. Returns opted-out state; never verifies a mailbox or reads/writes a ballot. Repeats preserve the first opt-out instant, including after poll closure. Voting and verification tokens cannot perform this operation. Shares the ballot request budget.',
      input: MeetingPollTokenInput,
      output: OptOutMeetingPollOutput,
      annotations: { ...read, readOnlyHint: false },
      ...privacy,
      async run(args, call) {
        return optOutOfMeetingPollReminders(await context(call, 'ballot'), args)
      },
    }),
  ]
}
