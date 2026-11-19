// Capability-only reads shared by REST, MCP and CLI. Reads never verify a mailbox or
// submit consent, and every projection is explicit: no host metadata or roster escapes.
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import {
  type LocationOption,
  type PublicLocationOption,
  publicLocationOptions,
} from './location-options.ts'
import { type MeetingPollOwnBallot, ownBallot } from './meeting-poll-ballots.ts'
import { ensureMeetingPollKey } from './meeting-poll-key.ts'
import {
  lockPublicPoll,
  type MeetingPollPublicContext,
  meetingPollCapabilityDigest,
  requireSecret,
  validToken,
} from './meeting-poll-voters.ts'
import {
  type MeetingPollAdmissionMode,
  type MeetingPollCandidate,
  type MeetingPollStatus,
  type MeetingPollVisibility,
  meetingPollPublicTokenDigest,
  pollNotFound,
} from './meeting-polls.ts'
import { parseQuestions, type Question } from './questions.ts'

export interface PublicMeetingPoll {
  id: string
  title: string
  durationMinutes: number
  displayTimeZone: string
  admissionMode: MeetingPollAdmissionMode
  visibility: MeetingPollVisibility
  status: MeetingPollStatus
  deadlineAt: string
  readOnly: boolean
  candidates: MeetingPollCandidate[]
  chosenSlotId: string | null
  questions: Question[]
  locations: PublicLocationOption[] | null
  allowGuests: boolean
  ownBallot: MeetingPollOwnBallot | null
  /** Aggregate counts require opt-in visibility and a verified, non-withdrawn voting credential. */
  counts: { slotId: string; yes: number; ifNeedBe: number; no: number }[] | null
}

const FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
const instant = (value: string) => Temporal.Instant.from(value).toString()

/**
 * Read by a public-link or emailed verification/voting capability, never by poll ID alone.
 * Voting digests remain usable after the deadline for read-only access until revocation or
 * deletion; verification credentials lose access on consumption/expiry. Opt-out tokens do
 * not grant access. The common poll lock gives metadata, own ballot and counts one snapshot.
 */
export async function readMeetingPoll(
  ctx: MeetingPollPublicContext,
  input: { token: string },
): Promise<PublicMeetingPoll> {
  const secret = requireSecret(ctx.meetingPollSecret)
  const token = validToken(input?.token)
  return ctx.db.transaction().execute(async (trx) => {
    await ensureMeetingPollKey(trx, secret)
    const digest = meetingPollPublicTokenDigest(token)
    const publicPoll = await trx
      .selectFrom('meeting_polls')
      .select(['id', 'organization_id'])
      .where('admission_mode', '=', 'public_link')
      .where('public_token_digest', '=', digest)
      .executeTakeFirst()
    const credential = publicPoll
      ? undefined
      : await trx
          .selectFrom('meeting_poll_capabilities')
          .select(['id', 'poll_id', 'organization_id'])
          .where((eb) =>
            eb.or([
              eb.and([
                eb('purpose', '=', 'voting'),
                eb('token_digest', '=', meetingPollCapabilityDigest('voting', token)),
              ]),
              eb.and([
                eb('purpose', '=', 'verification'),
                eb('token_digest', '=', meetingPollCapabilityDigest('verification', token)),
              ]),
            ]),
          )
          .executeTakeFirst()
    const named =
      publicPoll ??
      (credential && { id: credential.poll_id, organization_id: credential.organization_id })
    if (!named) throw pollNotFound()
    const poll = await lockPublicPoll(trx, named, publicPoll ? digest : undefined)
    if (!poll) throw pollNotFound()
    // Recheck under the poll lock: removal, revocation and verification can race discovery.
    const voter = credential
      ? await trx
          .selectFrom('meeting_poll_capabilities as c')
          .innerJoin('meeting_poll_voters as v', 'v.id', 'c.voter_id')
          .select([
            'v.id',
            'c.purpose',
            sql<boolean>`v.verified_at IS NOT NULL`.as('verified'),
            sql<boolean>`v.withdrawn_at IS NULL`.as('active'),
          ])
          .where('c.id', '=', credential.id)
          .where('c.poll_id', '=', poll.id)
          .where('c.revoked_at', 'is', null)
          .where((eb) =>
            eb.or([
              eb('c.purpose', '=', 'voting'),
              eb.and([
                eb('c.consumed_at', 'is', null),
                eb('c.expires_at', '>', sql<Date>`${poll.at}::timestamptz`),
              ]),
            ]),
          )
          .where((eb) =>
            eb.or([
              eb('v.pending_expires_at', 'is', null),
              eb('v.pending_expires_at', '>', sql<Date>`${poll.at}::timestamptz`),
            ]),
          )
          .executeTakeFirst()
      : undefined
    if (credential && !voter) throw pollNotFound()
    const row = await trx
      .selectFrom('meeting_polls')
      .select([
        'title',
        'duration_minutes',
        'display_time_zone',
        'admission_mode',
        'visibility',
        'chosen_slot_id',
        'settings_snapshot',
      ])
      .where('id', '=', poll.id)
      .executeTakeFirstOrThrow()
    const slots = await trx
      .selectFrom('meeting_poll_slots')
      .select([
        'id',
        'position',
        sql<string>`to_char(start_at AT TIME ZONE 'UTC', ${sql.lit(FORMAT)})`.as('start'),
        sql<string>`to_char(end_at AT TIME ZONE 'UTC', ${sql.lit(FORMAT)})`.as('end'),
      ])
      .where('poll_id', '=', poll.id)
      .orderBy('position')
      .execute()
    const candidates = slots.map((slot) => ({
      id: slot.id,
      position: slot.position,
      startAt: instant(slot.start),
      endAt: instant(slot.end),
    }))
    const snapshot = row.settings_snapshot as Record<string, unknown>
    const status =
      poll.status === 'open' && (poll.deadlinePassed || poll.eventDeleted)
        ? 'closed'
        : (poll.status as MeetingPollStatus)
    return {
      id: poll.id,
      title: row.title,
      durationMinutes: row.duration_minutes,
      displayTimeZone: row.display_time_zone,
      admissionMode: row.admission_mode as MeetingPollAdmissionMode,
      visibility: row.visibility as MeetingPollVisibility,
      status,
      deadlineAt: instant(poll.deadline),
      readOnly: status !== 'open',
      candidates,
      chosenSlotId: row.chosen_slot_id,
      questions: parseQuestions(snapshot.questions ?? []),
      locations: publicLocationOptions((snapshot.locations ?? null) as LocationOption[] | null),
      allowGuests: snapshot.allowGuests === true,
      ownBallot: voter?.purpose === 'voting' ? await ownBallot(trx, poll, voter.id) : null,
      // Only a currently participating verified voter sees totals; a withdrawn voter, an
      // unverified enrollee and a public-link reader get the same null as private polls.
      counts:
        row.visibility === 'aggregate' &&
        voter?.verified &&
        voter.purpose === 'voting' &&
        voter.active
          ? await counts(trx, poll.id, candidates)
          : null,
    }
  })
}

async function counts(db: Db, pollId: string, candidates: MeetingPollCandidate[]) {
  const votes = await db
    .selectFrom('meeting_poll_votes as vote')
    .innerJoin('meeting_poll_voters as voter', (join) =>
      join.onRef('voter.id', '=', 'vote.voter_id').onRef('voter.poll_id', '=', 'vote.poll_id'),
    )
    .select(['vote.slot_id', 'vote.value'])
    .where('vote.poll_id', '=', pollId)
    .where('voter.verified_at', 'is not', null)
    .where('voter.withdrawn_at', 'is', null)
    .where('voter.ballot_submitted_at', 'is not', null)
    .execute()
  return candidates.map((slot) => ({
    slotId: slot.id,
    yes: votes.filter((vote) => vote.slot_id === slot.id && vote.value === 'yes').length,
    ifNeedBe: votes.filter((vote) => vote.slot_id === slot.id && vote.value === 'if_need_be')
      .length,
    no: votes.filter((vote) => vote.slot_id === slot.id && vote.value === 'no').length,
  }))
}
