import { z } from '@hono/zod-openapi'
import { MEETING_POLL_PAGE_DEFAULT } from '@hourmere/scheduling'

// Let services decide whether an ID or cursor is valid so REST and MCP keep the same codes.
const PollId = z.string().openapi({ format: 'uuid' })
const Instant = z.string().openapi({ format: 'date-time' })

export const MeetingPollHostId = z.strictObject({ id: PollId })
export const ListMeetingPollsInput = z.strictObject({
  limit: z.number().optional().openapi({
    default: MEETING_POLL_PAGE_DEFAULT,
    description: 'Page size, an integer from 1 to 100.',
  }),
  after: z.string().optional().openapi({ description: 'The previous page’s nextAfter cursor.' }),
})
export const MeetingPollHostRevision = z.strictObject({ expectedHostRevision: z.number() })
export const MeetingPollIdempotencyKey = z.string().openapi({
  description:
    'A retained random key for this finalization attempt (1–255 printable ASCII characters).',
})
export const FinalizeMeetingPollBody = z.strictObject({
  slotId: PollId,
  bookerVoterId: PollId,
  attendeeVoterIds: z
    .array(PollId)
    .openapi({ description: 'Selected voters, including the booker.' }),
  expectedResultsRevision: z.number(),
  expectedBallotRevisions: z.record(z.string(), z.number()).openapi({
    description: 'The current ballot revision of each selected voter, keyed by voter ID.',
  }),
  acknowledgeConditional: z.boolean().openapi({
    description: 'Explicitly accept a selected voter’s if_need_be response at the chosen time.',
  }),
  locationOptionId: z.string().optional(),
})

const Candidate = z.object({
  id: PollId,
  startAt: Instant,
  endAt: Instant,
  position: z.number().int(),
})
export const MeetingPollHostOutput = z
  .object({
    id: PollId,
    organizationId: PollId,
    eventTypeId: PollId,
    title: z.string(),
    durationMinutes: z.number().int(),
    displayTimeZone: z.string(),
    admissionMode: z.enum(['public_link', 'invited']),
    visibility: z.enum(['private', 'aggregate']),
    deadlineAt: Instant,
    status: z.enum(['open', 'closed', 'scheduled', 'canceled']),
    closedAt: Instant.nullable(),
    canceledAt: Instant.nullable(),
    scheduledAt: Instant.nullable(),
    chosenSlotId: PollId.nullable(),
    bookingId: PollId.nullable(),
    hostRevision: z.number().int(),
    createdByUserId: PollId.nullable(),
    source: z.enum(['web', 'api', 'mcp']),
    createdAt: Instant,
    updatedAt: Instant,
    candidates: z.array(Candidate),
  })
  .openapi('MeetingPollHost')

export const MeetingPollListOutput = z
  .object({ data: z.array(MeetingPollHostOutput), nextAfter: z.string().nullable() })
  .openapi('MeetingPollHostPage')

const RosterEntry = z.object({
  voterId: PollId,
  name: z.string(),
  email: z.string(),
  status: z.enum(['pending', 'invited', 'verified', 'withdrawn']),
  timeZone: z.string(),
  locale: z.string(),
  invitedAt: Instant.nullable(),
  verifiedAt: Instant.nullable(),
  withdrawnAt: Instant.nullable(),
  pendingExpiresAt: Instant.nullable(),
  ballotRevision: z.number().int(),
  submittedAt: Instant.nullable(),
  consentedAt: Instant.nullable(),
  votes: z.array(z.object({ slotId: PollId, value: z.enum(['yes', 'if_need_be', 'no']) })),
  responses: z.record(z.string(), z.unknown()),
})

export const MeetingPollResultsOutput = z
  .object({
    poll: MeetingPollHostOutput,
    resultsRevision: z.number().int(),
    countedBallots: z.number().int(),
    candidates: z.array(
      Candidate.extend({
        yes: z.number().int(),
        ifNeedBe: z.number().int(),
        no: z.number().int(),
        availability: z.enum(['available', 'unavailable', 'unknown']).openapi({
          description: 'Advisory current availability. Finalization checks availability again.',
        }),
      }),
    ),
    roster: z.array(RosterEntry),
  })
  .openapi('MeetingPollHostResults')

export const FinalizeMeetingPollOutput = z
  .object({
    poll: MeetingPollHostOutput,
    booking: z.object({
      id: PollId,
      eventTypeId: PollId.nullable(),
      status: z.enum(['confirmed', 'cancelled']),
      start: Instant,
      end: Instant,
      source: z.enum(['web', 'embed', 'api', 'mcp', 'import']),
    }),
    replayed: z.boolean(),
  })
  .openapi('MeetingPollFinalization')
