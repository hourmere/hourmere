// Host results and voter removal for meeting polls: the results projection a manager reads,
// removal of one voter and bulk removal of unverified public enrollees. Internal services
// only: no transport, worker or mail sender (docs/meeting-polls.md).
//
// Every service takes the meeting-poll key fence first (meeting-poll-key.ts), then the host
// order of the lifecycle and invitation services: the organization-write hook (writes only),
// actor user, organization and membership SHARE, the poll row, then its event FOR SHARE, and
// decides with one database clock reading after those locks (the returned poll metadata
// derives its status as every host read does). Removal locks the poll FOR UPDATE before it
// touches any voter row. The results read locks the poll FOR SHARE instead, so no voter or
// host write commits between the results revision it reports and the rows it counts.
//
// Removal deletes the voter row with its votes, credentials and deliveries and records
// `removed_at` on the mailbox counter row, which alone outlives it: that digest blocks
// self-enrollment until poll deletion, and its mail counters and opt-out stay. Only a later
// host invitation re-admits the mailbox (meeting-poll-voters.ts). Removal checks only the
// host revision and advances the host and results revisions; voter writes never move the
// host revision, so a voter replacing their ballot cannot make a removal fail.
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { isUuid } from './internal.ts'
import type { MeetingPollBallotVote, MeetingPollVoteValue } from './meeting-poll-ballots.ts'
import { ensureMeetingPollKey } from './meeting-poll-key.ts'
import {
  advanceRevisions,
  hostPoll,
  type MeetingPollHostContext,
  type MeetingPollVoterState,
  pollCanceled,
  requireSecret,
} from './meeting-poll-voters.ts'
import {
  alreadyScheduled,
  type LockedPoll,
  loadPoll,
  lockAuthority,
  lockManagedPoll,
  type MeetingPoll,
  type MeetingPollCandidate,
  type MeetingPollHostWriteInput,
  manages,
  pollNotFound,
  requireHostRevision,
  requireWriteScope,
  validHostWrite,
} from './meeting-polls.ts'
import type { Responses } from './questions.ts'

/** One candidate with separate counts; a voter without a ballot is never counted as `no`. */
export interface MeetingPollCandidateResult extends MeetingPollCandidate {
  yes: number
  ifNeedBe: number
  no: number
}

/** A voter as the host sees them. Never a credential, a digest or an IP digest. */
export interface MeetingPollRosterEntry {
  voterId: string
  name: string
  email: string
  status: MeetingPollVoterState['status']
  timeZone: string
  locale: string
  /** Set for host invitees, including public enrollees upgraded to an invitation. */
  invitedAt: string | null
  verifiedAt: string | null
  withdrawnAt: string | null
  /** When an unverified public reservation expires; null for everyone else. */
  pendingExpiresAt: string | null
  ballotRevision: number
  /** The current ballot; null before the first ballot and after withdrawal. */
  submittedAt: string | null
  consentedAt: string | null
  /** One answer per candidate, in candidate order; empty without a counted ballot. */
  votes: MeetingPollBallotVote[]
  responses: Responses
}

/**
 * The host's results: per-candidate counts of counted ballots (verified, non-withdrawn voters
 * with a submitted ballot), the roster with each voter's ballot and ballot revision, the host
 * revision (in `poll`) and the results revision that finalization will check. Removed voters
 * and expired public reservations are absent.
 */
export interface MeetingPollResults {
  poll: MeetingPoll
  resultsRevision: number
  /** How many ballots the counts include. */
  countedBallots: number
  candidates: MeetingPollCandidateResult[]
  roster: MeetingPollRosterEntry[]
}

export interface RemoveMeetingPollVoterInput extends MeetingPollHostWriteInput {
  voterId: string
}

/** Host result of a removal. It never contains a credential or a removed voter's data. */
export interface MeetingPollRemovalResult {
  poll: MeetingPoll
  resultsRevision: number
  /** The voters this request removed; empty when there was nothing to remove. */
  removedVoterIds: string[]
}

const UTC_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
const utcNullable = (ref: string) =>
  sql<string | null>`to_char(${sql.ref(ref)} AT TIME ZONE 'UTC', ${sql.lit(UTC_FORMAT)})`
const instant = (value: string | null) =>
  value === null ? null : Temporal.Instant.from(value).toString()

/**
 * The results of a poll the caller manages, in any state. The counts and every ballot belong
 * to the returned results revision; public reservations are judged live or expired at the
 * read's instant, since expiry moves no revision. Read keys may read results. The read takes
 * the key fence like every service that reads voter rows.
 */
export async function getMeetingPollResults(
  ctx: MeetingPollHostContext,
  id: string,
): Promise<MeetingPollResults> {
  const secret = requireSecret(ctx.meetingPollSecret)
  return ctx.db.transaction().execute(async (trx) => {
    await ensureMeetingPollKey(trx, secret)
    const poll = await lockResultsPoll(trx, ctx, id)
    const metadata = await loadPoll(trx, ctx, poll.id)
    const voters = await trx
      .selectFrom('meeting_poll_voters')
      .select([
        'id',
        'name',
        'email',
        'time_zone',
        'locale',
        'ballot_revision',
        'responses',
        sql<MeetingPollVoterState['status']>`CASE WHEN withdrawn_at IS NOT NULL THEN 'withdrawn'
          WHEN verified_at IS NOT NULL THEN 'verified'
          WHEN invited_at IS NOT NULL THEN 'invited' ELSE 'pending' END`.as('status'),
        sql<boolean>`verified_at IS NOT NULL AND withdrawn_at IS NULL
          AND ballot_submitted_at IS NOT NULL`.as('counted'),
        utcNullable('invited_at').as('invited'),
        utcNullable('verified_at').as('verified'),
        utcNullable('withdrawn_at').as('withdrawn'),
        utcNullable('pending_expires_at').as('pendingExpires'),
        utcNullable('ballot_submitted_at').as('submitted'),
        utcNullable('join_consent_at').as('consented'),
      ])
      .where('poll_id', '=', poll.id)
      .where('organization_id', '=', poll.organizationId)
      // An expired public reservation holds no place and is replaced or cleaned up.
      .where(
        sql<boolean>`(pending_expires_at IS NULL OR pending_expires_at > ${poll.at}::timestamptz)`,
      )
      .orderBy('created_at')
      .orderBy('id')
      .execute()
    const counted = new Set(voters.filter((voter) => voter.counted).map((voter) => voter.id))
    const votes = await trx
      .selectFrom('meeting_poll_votes')
      .select(['voter_id', 'slot_id', 'value'])
      .where('poll_id', '=', poll.id)
      .where('organization_id', '=', poll.organizationId)
      .execute()
    const position = new Map(metadata.candidates.map((slot) => [slot.id, slot.position]))
    const ballots = new Map<string, MeetingPollBallotVote[]>()
    const tallies = new Map(
      metadata.candidates.map((slot) => [slot.id, { yes: 0, ifNeedBe: 0, no: 0 }]),
    )
    for (const vote of votes) {
      if (!counted.has(vote.voter_id)) continue
      const value = vote.value as MeetingPollVoteValue
      const tally = tallies.get(vote.slot_id)
      if (tally) tally[value === 'if_need_be' ? 'ifNeedBe' : value] += 1
      const ballot = ballots.get(vote.voter_id) ?? []
      ballot.push({ slotId: vote.slot_id, value })
      ballots.set(vote.voter_id, ballot)
    }
    return {
      poll: metadata,
      resultsRevision: poll.resultsRevision,
      countedBallots: counted.size,
      candidates: metadata.candidates.map((slot) => ({
        ...slot,
        ...(tallies.get(slot.id) as { yes: number; ifNeedBe: number; no: number }),
      })),
      roster: voters.map((voter) => ({
        voterId: voter.id,
        name: voter.name,
        email: voter.email,
        status: voter.status,
        timeZone: voter.time_zone,
        locale: voter.locale,
        invitedAt: instant(voter.invited),
        verifiedAt: instant(voter.verified),
        withdrawnAt: instant(voter.withdrawn),
        pendingExpiresAt: instant(voter.pendingExpires),
        ballotRevision: voter.ballot_revision,
        submittedAt: instant(voter.submitted),
        consentedAt: instant(voter.consented),
        votes: (ballots.get(voter.id) ?? []).sort(
          (a, b) => (position.get(a.slotId) ?? 0) - (position.get(b.slotId) ?? 0),
        ),
        responses: voter.responses as Responses,
      })),
    }
  })
}

/**
 * Remove one voter while the poll is open or closed: verified or not, invited or public,
 * withdrawn or active. The voter row goes with its votes, credentials and queued mail, its
 * place is freed and no mail is sent; only the mailbox counter row stays, marked removed.
 * The removal targets the voter, not a ballot: it checks only `expectedHostRevision`, after
 * the voter lookup, so a retry after a lost response gets 404 `poll_not_found`.
 */
export async function removeMeetingPollVoter(
  ctx: MeetingPollHostContext,
  input: RemoveMeetingPollVoterInput,
): Promise<MeetingPollRemovalResult> {
  requireWriteScope(ctx)
  const secret = requireSecret(ctx.meetingPollSecret)
  const request = validHostWrite(input)
  const voterId = input.voterId
  return ctx.db.transaction().execute(async (trx) => {
    await ensureMeetingPollKey(trx, secret)
    const locked = await lockManagedPoll(trx, ctx, request.id)
    requireRemovable(locked)
    if (!isUuid(voterId)) throw pollNotFound()
    const voters = await trx
      .selectFrom('meeting_poll_voters')
      .select(['id', 'email_key'])
      .where('id', '=', voterId)
      .where('poll_id', '=', locked.id)
      .where('organization_id', '=', locked.organization_id)
      // An expired public reservation is already gone for the host, as in the results.
      .where(
        sql<boolean>`(pending_expires_at IS NULL OR pending_expires_at > ${locked.at}::timestamptz)`,
      )
      .execute()
    if (voters.length === 0) throw pollNotFound()
    requireHostRevision(locked, request.expectedHostRevision)
    await removeVoters(trx, locked, voters)
    return removalResult(trx, ctx, locked, voters)
  })
}

/**
 * Remove every unverified public enrollee holding a live reservation while the poll is open
 * or closed. Host invitations (verified or not), verified voters and withdrawn voters stay;
 * expired reservations hold no place and are left to cleanup. Each removed mailbox keeps its
 * counter row, marked removed. Nothing to remove writes nothing.
 */
export async function removeUnverifiedMeetingPollVoters(
  ctx: MeetingPollHostContext,
  input: MeetingPollHostWriteInput,
): Promise<MeetingPollRemovalResult> {
  requireWriteScope(ctx)
  const secret = requireSecret(ctx.meetingPollSecret)
  const request = validHostWrite(input)
  return ctx.db.transaction().execute(async (trx) => {
    await ensureMeetingPollKey(trx, secret)
    const locked = await lockManagedPoll(trx, ctx, request.id)
    requireRemovable(locked)
    requireHostRevision(locked, request.expectedHostRevision)
    const voters = await trx
      .selectFrom('meeting_poll_voters')
      .select(['id', 'email_key'])
      .where('poll_id', '=', locked.id)
      .where('organization_id', '=', locked.organization_id)
      .where('verified_at', 'is', null)
      .where('invited_at', 'is', null)
      .where('withdrawn_at', 'is', null)
      .where(sql<boolean>`pending_expires_at > ${locked.at}::timestamptz`)
      .orderBy('id')
      .execute()
    if (voters.length > 0) await removeVoters(trx, locked, voters)
    return removalResult(trx, ctx, locked, voters)
  })
}

// --- Helpers ---------------------------------------------------------------------------------

/** Managers remove voters while the poll is open or closed; scheduled polls use the booking. */
function requireRemovable(poll: LockedPoll) {
  if (poll.status === 'scheduled') throw alreadyScheduled()
  if (poll.status === 'canceled') throw pollCanceled()
}

/**
 * Delete the voter rows, cascading their votes, credentials and deliveries, and mark each
 * mailbox removed on its counter row. Resend and recovery counts, the reminder receipt and
 * the opt-out stay as they are. One host write: both revisions advance once.
 */
async function removeVoters(
  trx: Db,
  locked: LockedPoll,
  voters: readonly { id: string; email_key: Buffer }[],
) {
  await trx
    .deleteFrom('meeting_poll_voters')
    .where('poll_id', '=', locked.id)
    .where('organization_id', '=', locked.organization_id)
    .where(
      'id',
      'in',
      voters.map((voter) => voter.id),
    )
    .execute()
  await trx
    .insertInto('meeting_poll_mailbox_counters')
    .values(
      voters.map((voter) => ({
        organization_id: locked.organization_id,
        poll_id: locked.id,
        email_key: voter.email_key,
        removed_at: locked.at,
        created_at: locked.at,
        updated_at: locked.at,
      })),
    )
    .onConflict((conflict) =>
      conflict.columns(['poll_id', 'email_key']).doUpdateSet({
        removed_at: locked.at,
        updated_at: locked.at,
      }),
    )
    .execute()
  await advanceRevisions(trx, hostPoll(locked), {
    host: true,
    hostRevision: locked.host_revision,
  })
}

async function removalResult(
  trx: Db,
  ctx: MeetingPollHostContext,
  locked: LockedPoll,
  voters: readonly { id: string }[],
): Promise<MeetingPollRemovalResult> {
  const row = await trx
    .selectFrom('meeting_polls')
    .select('results_revision')
    .where('id', '=', locked.id)
    .executeTakeFirstOrThrow()
  return {
    poll: await loadPoll(trx, ctx, locked.id),
    resultsRevision: row.results_revision,
    removedVoterIds: voters.map((voter) => voter.id),
  }
}

/**
 * Host results take the host read order: the actor's authority SHARE locks, then the poll
 * FOR SHARE and its event FOR SHARE, then one clock reading. No write hook: this is a read.
 */
async function lockResultsPoll(trx: Db, ctx: MeetingPollHostContext, id: string) {
  const authority = await lockAuthority(trx, ctx)
  if (!isUuid(id)) throw pollNotFound()
  const poll = await trx
    .selectFrom('meeting_polls')
    .select(['id', 'organization_id', 'event_type_id'])
    .where('id', '=', id)
    .where('organization_id', '=', ctx.principal.organization.id)
    .forShare()
    .executeTakeFirst()
  if (!poll) throw pollNotFound()
  const event = await trx
    .selectFrom('event_types')
    .select('owner_user_id')
    .where('id', '=', poll.event_type_id)
    .where('organization_id', '=', poll.organization_id)
    .forShare()
    .executeTakeFirst()
  if (!event || !manages(authority, event.owner_user_id)) throw pollNotFound()
  const { rows } = await sql<{ at: string; resultsRevision: number }>`
    WITH decision AS MATERIALIZED (SELECT clock_timestamp() AS t)
    SELECT to_char(decision.t AT TIME ZONE 'UTC', ${sql.lit(UTC_FORMAT)}) AS at,
      poll.results_revision AS "resultsRevision"
    FROM meeting_polls AS poll CROSS JOIN decision
    WHERE poll.id = ${poll.id}`.execute(trx)
  const { at, resultsRevision } = rows[0] as (typeof rows)[number]
  return { id: poll.id, organizationId: poll.organization_id, at, resultsRevision }
}
