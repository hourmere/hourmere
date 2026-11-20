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
      title: 'Read a meeting poll by token',
      description:
        'Read an existing poll with its public-link, verification or voting token. A voting token can return its voter’s own profile and ballot. Aggregate counts require a verified, non-withdrawn voter and aggregate visibility. Omits the host roster and other voters’ details. API keys need read, bookings or full scope and grant no access by themselves.',
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
        'With the voter’s permission, request verification mail using publicToken on an existing poll. Acceptance is uniform for all mailboxes, as is poll_full at capacity. Does not create a poll or return a voter credential. API keys need bookings or full scope.',
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
        'Request recovery mail on the voter’s behalf using pollId and email. Valid requests return accepted without confirming delivery. Eligible recipients receive the same credential, subject to cooldowns and caps. Does not enroll voters or disclose, rotate or extend credentials. API keys need bookings or full scope.',
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
        'Verify the voter’s mailbox with their permission and emailed token while voting is open. Consuming a verification token returns a new votingToken once and emails it privately. Invitation voting tokens stay valid without replacement. Does not submit a ballot or consent. API keys need bookings or full scope.',
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
        'Replace the voter’s complete ballot with their voting token and explicit consent. Supply one yes/if_need_be/no vote per slot and expectedBallotRevision (0 initially). If poll_changed occurs, read and reconcile before resubmitting. Does not change the voter’s email or book a time. API keys need bookings or full scope.',
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
        'Withdraw with the voter’s permission, voting token and expectedBallotRevision while voting is open. Clears votes, answers and consent and stops poll mail. The credential remains usable for reads and reactivation by a new consented ballot. API keys need bookings or full scope.',
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
        'Stop reminders with the recipient’s permission and the reminder-opt-out token from their poll email. Works after poll closure and preserves the first opt-out time on retry. Does not verify mailboxes or access ballots. API keys need bookings or full scope.',
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
