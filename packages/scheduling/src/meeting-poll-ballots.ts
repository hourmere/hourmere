// Voter ballots for meeting polls: submit or replace a complete ballot (from the withdrawn
// state this is the reactivation), withdraw, and reminder opt-out. Internal services only:
// no transport, worker or mail sender (docs/meeting-polls.md).
//
// Every write takes the public voter order of meeting-poll-voters.ts: public booking's
// organization locks (a personal owner's user SHARE, then the organization SHARE), the poll
// FOR UPDATE and its event FOR SHARE, then one database clock reading. That reading decides
// the deadline: ballots and withdrawals need an open poll whose event still exists and an
// instant strictly before the deadline. Equality is closed, and a write that waited for the
// poll lock while the deadline passed is refused. Voter writes advance the results revision
// and never the host revision.
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { DomainError } from './errors.ts'
import { isUuid, validTimeZone } from './internal.ts'
import { MEETING_POLL_LIMITS } from './meeting-poll-policy.ts'
import {
  admissionCounts,
  advanceRevisions,
  lockPublicPoll,
  type MeetingPollPublicContext,
  type MeetingPollVoterState,
  meetingPollCapabilityDigest,
  pollClosed,
  pollFull,
  requireVotingOpen,
  type VoterPoll,
  validLocale,
  validToken,
  validVoterName,
  voterState,
} from './meeting-poll-voters.ts'
import { changed, pollNotFound } from './meeting-polls.ts'
import { parseQuestions, type Responses, validateResponses } from './questions.ts'

export type MeetingPollVoteValue = 'yes' | 'if_need_be' | 'no'

export interface MeetingPollBallotVote {
  slotId: string
  value: MeetingPollVoteValue
}

export interface SubmitMeetingPollBallotInput {
  /** The voter's voting credential. */
  token: string
  /** One answer for every candidate of the poll; a partial ballot is refused. */
  votes: MeetingPollBallotVote[]
  /** Consent to join the meeting if selected. Required, and renewed by every ballot. */
  consent: boolean
  /** Answers to the event's booking questions as snapshotted when the poll was created. */
  responses?: Record<string, unknown> | undefined
  /** Optional profile edits; the mailbox never changes. */
  name?: string | undefined
  timeZone?: string | undefined
  locale?: string | undefined
  /** The ballot revision the voter last saw: 0 before the first ballot. */
  expectedBallotRevision: number
}

export interface WithdrawMeetingPollVoterInput {
  token: string
  expectedBallotRevision: number
}

/** A voter's own ballot. Never another voter's data, a credential or a digest. */
export interface MeetingPollOwnBallot {
  voter: MeetingPollVoterState
  ballotRevision: number
  /** When the current ballot was submitted; null before the first ballot and when withdrawn. */
  submittedAt: string | null
  /** When the current ballot gave join consent; null without a ballot. */
  consentedAt: string | null
  /** One answer per candidate, in candidate order; empty without a ballot. */
  votes: MeetingPollBallotVote[]
  responses: Responses
}

export interface MeetingPollReminderOptOut {
  pollId: string
  /** The mailbox's first opt-out; repeats keep it. */
  optedOutAt: string
}

const VOTE_VALUES: ReadonlySet<unknown> = new Set(['yes', 'if_need_be', 'no'])
const VOTE_FIELDS = new Set(['slotId', 'value'])
const UTC_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'

const invalidBallot = (message: string) => new DomainError('invalid', 'invalid_ballot', message)

/**
 * Submit or replace the voter's complete ballot with their voting credential: one answer
 * for every candidate, join consent, and answers to the snapshotted booking questions,
 * checked against `expectedBallotRevision`. It replaces the previous ballot whole. An
 * invitee's first ballot also confirms the mailbox. From the withdrawn state this is the
 * reactivation, which takes a place again under the 40-place cap (409 `poll_full`).
 */
export async function submitMeetingPollBallot(
  ctx: MeetingPollPublicContext,
  input: SubmitMeetingPollBallotInput,
): Promise<MeetingPollOwnBallot> {
  if (!input || typeof input !== 'object') throw invalidBallot('The ballot must be an object')
  const token = validToken(input.token)
  const choices = validChoices(input.votes)
  if (input.consent !== true)
    throw invalidBallot('consent must be true: a ballot agrees to join the meeting if selected')
  const expected = validRevision(input.expectedBallotRevision)
  const name = input.name === undefined ? undefined : validVoterName(input.name)
  const timeZone = input.timeZone === undefined ? undefined : validTimeZone(input.timeZone)
  const locale = input.locale === undefined ? undefined : validLocale(input.locale)
  return ctx.db.transaction().execute(async (trx) => {
    const { poll, voter } = await lockVotingCredential(trx, token)
    requireVotingOpen(poll, pollClosed)
    const slots = await trx
      .selectFrom('meeting_poll_slots')
      .select('id')
      .where('poll_id', '=', poll.id)
      .execute()
    // All or nothing: exactly the poll's candidates, each answered once.
    if (slots.length !== choices.size || slots.some((slot) => !choices.has(slot.id)))
      throw invalidBallot('votes must answer every candidate of this poll exactly once')
    const responses = validateResponses(await snapshotQuestions(trx, poll), input.responses ?? {})
    if (voter.ballot_revision !== expected) throw changed()
    if (voter.withdrawn) {
      // Reactivation takes a place again, under the same cap and lock as admission.
      const { active } = await admissionCounts(trx, poll.id, poll.at)
      if (active >= MEETING_POLL_LIMITS.maxEnrollments) throw pollFull()
    }
    await trx
      .updateTable('meeting_poll_voters')
      .set({
        verified_at: sql<string>`coalesce(verified_at, ${poll.at}::timestamptz)`,
        withdrawn_at: null,
        ballot_submitted_at: poll.at,
        join_consent_at: poll.at,
        responses: JSON.stringify(responses),
        ballot_revision: voter.ballot_revision + 1,
        ...(name !== undefined && { name }),
        ...(timeZone !== undefined && { time_zone: timeZone }),
        ...(locale !== undefined && { locale }),
        updated_at: poll.at,
      })
      .where('id', '=', voter.id)
      .where('poll_id', '=', poll.id)
      .execute()
    await trx
      .deleteFrom('meeting_poll_votes')
      .where('poll_id', '=', poll.id)
      .where('voter_id', '=', voter.id)
      .execute()
    await trx
      .insertInto('meeting_poll_votes')
      .values(
        [...choices].map(([slotId, value]) => ({
          organization_id: poll.organizationId,
          poll_id: poll.id,
          voter_id: voter.id,
          slot_id: slotId,
          value,
          created_at: poll.at,
          updated_at: poll.at,
        })),
      )
      .execute()
    await advanceRevisions(trx, poll, { host: false })
    return ownBallot(trx, poll, voter.id)
  })
}

/**
 * Withdraw with the voting credential while voting is open, checked against
 * `expectedBallotRevision`: the ballot, answers and join consent are erased, the place is
 * freed and queued mail to the voter is skipped (withdrawal opts out of all poll mail). The
 * credential stays valid for read-only access and reactivation. A withdrawn voter's repeat
 * at the current revision returns its state without writing.
 */
export async function withdrawMeetingPollVoter(
  ctx: MeetingPollPublicContext,
  input: WithdrawMeetingPollVoterInput,
): Promise<MeetingPollOwnBallot> {
  if (!input || typeof input !== 'object') throw invalidBallot('The request must be an object')
  const token = validToken(input.token)
  const expected = validRevision(input.expectedBallotRevision)
  return ctx.db.transaction().execute(async (trx) => {
    const { poll, voter } = await lockVotingCredential(trx, token)
    requireVotingOpen(poll, pollClosed)
    if (voter.ballot_revision !== expected) throw changed()
    if (voter.withdrawn) return ownBallot(trx, poll, voter.id)
    await trx
      .updateTable('meeting_poll_voters')
      .set({
        withdrawn_at: poll.at,
        ballot_submitted_at: null,
        join_consent_at: null,
        responses: '{}',
        admission_ip_digest: null,
        ballot_revision: voter.ballot_revision + 1,
        updated_at: poll.at,
      })
      .where('id', '=', voter.id)
      .where('poll_id', '=', poll.id)
      .execute()
    await trx
      .deleteFrom('meeting_poll_votes')
      .where('poll_id', '=', poll.id)
      .where('voter_id', '=', voter.id)
      .execute()
    await skipQueuedMail(trx, poll, voter.id, 'withdrawn')
    await advanceRevisions(trx, poll, { host: false })
    return ownBallot(trx, poll, voter.id)
  })
}

/**
 * Record a reminder opt-out with the purpose-limited opt-out credential, without login or
 * verification. The mailbox counter row keeps the first opt-out for the poll's lifetime,
 * across withdrawal, removal and re-invitation, and queued reminders to the voter are
 * skipped. It grants no ballot access and moves no revision. A mail preference, so it is
 * honoured whatever the poll's state.
 */
export async function optOutOfMeetingPollReminders(
  ctx: MeetingPollPublicContext,
  input: { token: string },
): Promise<MeetingPollReminderOptOut> {
  const token = validToken(input?.token)
  const digest = meetingPollCapabilityDigest('reminder_opt_out', token)
  return ctx.db.transaction().execute(async (trx) => {
    const named = await trx
      .selectFrom('meeting_poll_capabilities')
      .select(['id', 'poll_id', 'organization_id'])
      .where('purpose', '=', 'reminder_opt_out')
      .where('token_digest', '=', digest)
      .executeTakeFirst()
    if (!named) throw pollNotFound()
    const poll = await lockPublicPoll(trx, {
      id: named.poll_id,
      organization_id: named.organization_id,
    })
    if (!poll) throw pollNotFound()
    const voter = await credentialVoter(trx, poll, named.id)
    if (!voter) throw pollNotFound()
    await trx
      .insertInto('meeting_poll_mailbox_counters')
      .values({
        organization_id: poll.organizationId,
        poll_id: poll.id,
        email_key: voter.email_key,
        reminder_opted_out_at: poll.at,
        created_at: poll.at,
        updated_at: poll.at,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['poll_id', 'email_key'])
          .doUpdateSet({ reminder_opted_out_at: poll.at, updated_at: poll.at })
          .where('meeting_poll_mailbox_counters.reminder_opted_out_at', 'is', null),
      )
      .execute()
    await skipQueuedMail(trx, poll, voter.id, 'opted_out', 'reminder')
    const counter = await trx
      .selectFrom('meeting_poll_mailbox_counters')
      .select(
        sql<string>`to_char(reminder_opted_out_at AT TIME ZONE 'UTC', ${sql.lit(UTC_FORMAT)})`.as(
          'optedOutAt',
        ),
      )
      .where('poll_id', '=', poll.id)
      .where('email_key', '=', voter.email_key)
      .executeTakeFirstOrThrow()
    return { pollId: poll.id, optedOutAt: Temporal.Instant.from(counter.optedOutAt).toString() }
  })
}

// --- Helpers ---------------------------------------------------------------------------------

/**
 * The voter behind a voting credential, under the public voter locks. Unknown, revoked and
 * other-purpose credentials are 404 alike. An expired voting credential still names its
 * voter: it expires at the deadline, which the caller refuses as 409 `poll_closed`.
 */
async function lockVotingCredential(trx: Db, token: string) {
  const named = await trx
    .selectFrom('meeting_poll_capabilities')
    .select(['id', 'poll_id', 'organization_id'])
    .where('purpose', '=', 'voting')
    .where('token_digest', '=', meetingPollCapabilityDigest('voting', token))
    .executeTakeFirst()
  if (!named) throw pollNotFound()
  const poll = await lockPublicPoll(trx, {
    id: named.poll_id,
    organization_id: named.organization_id,
  })
  if (!poll) throw pollNotFound()
  const voter = await credentialVoter(trx, poll, named.id)
  if (!voter) throw pollNotFound()
  return { poll, voter }
}

/** Read under the poll lock: a credential revoked or deleted while waiting names no one. */
async function credentialVoter(trx: Db, poll: VoterPoll, credentialId: string) {
  return trx
    .selectFrom('meeting_poll_capabilities as c')
    .innerJoin('meeting_poll_voters as v', (join) =>
      join.onRef('v.id', '=', 'c.voter_id').onRef('v.poll_id', '=', 'c.poll_id'),
    )
    .select([
      'v.id',
      'v.email_key',
      'v.ballot_revision',
      sql<boolean>`v.withdrawn_at IS NOT NULL`.as('withdrawn'),
    ])
    .where('c.id', '=', credentialId)
    .where('c.poll_id', '=', poll.id)
    .where('c.revoked_at', 'is', null)
    .executeTakeFirst()
}

/** The booking questions the voter answers: the snapshot taken when the poll was created. */
async function snapshotQuestions(trx: Db, poll: VoterPoll) {
  const row = await trx
    .selectFrom('meeting_polls')
    .select(sql<unknown>`settings_snapshot -> 'questions'`.as('questions'))
    .where('id', '=', poll.id)
    .executeTakeFirstOrThrow()
  return parseQuestions(row.questions ?? [])
}

/** Skip the voter's queued mail (of one kind, when given); its ciphertext is erased. */
async function skipQueuedMail(
  trx: Db,
  poll: VoterPoll,
  voterId: string,
  reason: 'withdrawn' | 'opted_out',
  kind?: 'reminder',
) {
  await trx
    .updateTable('meeting_poll_deliveries')
    .set({
      state: 'skipped',
      terminal_at: poll.at,
      capability_ciphertext: null,
      error_class: reason,
      updated_at: poll.at,
    })
    .where('poll_id', '=', poll.id)
    .where('voter_id', '=', voterId)
    .where('state', '=', 'pending')
    .$if(kind !== undefined, (query) => query.where('kind', '=', kind as string))
    .execute()
}

async function ownBallot(trx: Db, poll: VoterPoll, voterId: string): Promise<MeetingPollOwnBallot> {
  const row = await trx
    .selectFrom('meeting_poll_voters')
    .select([
      'ballot_revision',
      'responses',
      sql<
        string | null
      >`to_char(ballot_submitted_at AT TIME ZONE 'UTC', ${sql.lit(UTC_FORMAT)})`.as('submittedAt'),
      sql<string | null>`to_char(join_consent_at AT TIME ZONE 'UTC', ${sql.lit(UTC_FORMAT)})`.as(
        'consentedAt',
      ),
    ])
    .where('id', '=', voterId)
    .where('poll_id', '=', poll.id)
    .executeTakeFirstOrThrow()
  const votes = await trx
    .selectFrom('meeting_poll_votes as vote')
    .innerJoin('meeting_poll_slots as slot', (join) =>
      join.onRef('slot.id', '=', 'vote.slot_id').onRef('slot.poll_id', '=', 'vote.poll_id'),
    )
    .select(['vote.slot_id', 'vote.value'])
    .where('vote.poll_id', '=', poll.id)
    .where('vote.voter_id', '=', voterId)
    .orderBy('slot.position')
    .execute()
  const instant = (value: string | null) =>
    value === null ? null : Temporal.Instant.from(value).toString()
  return {
    voter: await voterState(trx, poll, voterId),
    ballotRevision: row.ballot_revision,
    submittedAt: instant(row.submittedAt),
    consentedAt: instant(row.consentedAt),
    votes: votes.map((vote) => ({
      slotId: vote.slot_id,
      value: vote.value as MeetingPollVoteValue,
    })),
    responses: row.responses as Responses,
  }
}

// --- Validation ------------------------------------------------------------------------------

/** Distinct candidate IDs (lowercase) with their answers; the set is checked under the lock. */
function validChoices(votes: unknown): Map<string, MeetingPollVoteValue> {
  if (!Array.isArray(votes) || votes.length === 0)
    throw invalidBallot('votes must answer every candidate of this poll')
  if (votes.length > MEETING_POLL_LIMITS.maxCandidates)
    throw invalidBallot(`A poll has at most ${MEETING_POLL_LIMITS.maxCandidates} candidates`)
  const choices = new Map<string, MeetingPollVoteValue>()
  for (const entry of votes) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw invalidBallot('Each vote must be an object')
    for (const field of Object.keys(entry))
      if (!VOTE_FIELDS.has(field)) throw invalidBallot(`Unknown vote field ${field}`)
    const { slotId, value } = entry as { slotId?: unknown; value?: unknown }
    if (!isUuid(slotId)) throw invalidBallot('slotId must be a candidate ID of this poll')
    if (!VOTE_VALUES.has(value)) throw invalidBallot('value must be yes, if_need_be or no')
    const id = slotId.toLowerCase()
    if (choices.has(id)) throw invalidBallot('Each candidate takes exactly one vote')
    choices.set(id, value as MeetingPollVoteValue)
  }
  return choices
}

function validRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw invalidBallot('expectedBallotRevision must be the ballot revision you last saw')
  return value
}
