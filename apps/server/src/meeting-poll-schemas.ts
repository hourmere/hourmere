import { z } from '@hono/zod-openapi'
import { Question } from './openapi.ts'
import { PublicEventType } from './routes/public.ts'

const PublicLocationOption = PublicEventType.shape.locations.unwrap().element

// Tokens deliberately accept any bounded string: services give malformed, revoked and
// unknown capabilities the same opaque response. Never put capabilities in examples.
const Token = z.string().max(512)
export const MeetingPollTokenInput = z.object({ token: Token }).strict()
export const ReadMeetingPollInput = MeetingPollTokenInput
export const EnrollMeetingPollInput = z
  .object({
    publicToken: Token,
    name: z.string().max(200),
    email: z.string().max(320),
    timeZone: z.string().max(100),
    locale: z.string().max(35).optional(),
  })
  .strict()
export const RecoverMeetingPollInput = z
  .object({
    pollId: z.string().max(100),
    email: z.string().max(320),
  })
  .strict()
const Vote = z.object({ slotId: z.string(), value: z.enum(['yes', 'if_need_be', 'no']) })
export const SubmitMeetingPollVoteInput = z
  .object({
    token: Token,
    votes: z.array(Vote.strict()).max(20),
    consent: z.boolean(),
    responses: z.record(z.string(), z.unknown()).optional(),
    name: z.string().max(200).optional(),
    timeZone: z.string().max(100).optional(),
    locale: z.string().max(35).optional(),
    expectedBallotRevision: z.number().int().nonnegative(),
  })
  .strict()
export const WithdrawMeetingPollInput = z
  .object({
    token: Token,
    expectedBallotRevision: z.number().int().nonnegative(),
  })
  .strict()
export const MeetingPollVoterOutput = z
  .object({
    pollId: z.string().uuid(),
    voterId: z.string().uuid(),
    name: z.string(),
    email: z.string(),
    timeZone: z.string(),
    locale: z.string(),
    status: z.enum(['pending', 'invited', 'verified', 'withdrawn']),
    deadlineAt: z.string(),
  })
  .openapi('MeetingPollVoter')
export const AcceptedMeetingPollOutput = z
  .object({ accepted: z.literal(true) })
  .openapi('MeetingPollAccepted')
export const VerifyMeetingPollOutput = z
  .object({ voter: MeetingPollVoterOutput, votingToken: z.string().nullable() })
  .openapi('MeetingPollVerification')
export const MeetingPollBallotOutput = z
  .object({
    voter: MeetingPollVoterOutput,
    ballotRevision: z.number().int(),
    submittedAt: z.string().nullable(),
    consentedAt: z.string().nullable(),
    votes: z.array(Vote),
    responses: z.record(z.string(), z.unknown()),
  })
  .openapi('MeetingPollOwnBallot')
export const OptOutMeetingPollOutput = z
  .object({ pollId: z.string().uuid(), optedOutAt: z.string() })
  .openapi('MeetingPollReminderOptOut')

export const ReadMeetingPollOutput = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    durationMinutes: z.number().int(),
    displayTimeZone: z.string(),
    admissionMode: z.enum(['public_link', 'invited']),
    visibility: z.enum(['private', 'aggregate']),
    status: z.enum(['open', 'closed', 'canceled', 'scheduled']),
    deadlineAt: z.string(),
    readOnly: z.boolean(),
    candidates: z.array(
      z.object({
        id: z.string().uuid(),
        position: z.number().int(),
        startAt: z.string(),
        endAt: z.string(),
      }),
    ),
    chosenSlotId: z.string().uuid().nullable(),
    questions: z.array(Question),
    locations: z.array(PublicLocationOption).nullable(),
    allowGuests: z.boolean(),
    ownBallot: MeetingPollBallotOutput.nullable(),
    counts: z
      .array(
        z.object({
          slotId: z.string().uuid(),
          yes: z.number().int(),
          ifNeedBe: z.number().int(),
          no: z.number().int(),
        }),
      )
      .nullable(),
  })
  .openapi('PublicMeetingPoll')
