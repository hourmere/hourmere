import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import type { MeetingPollVoteValue } from './meeting-poll-ballots.ts'
import type { FinalizeMeetingPollInput } from './meeting-poll-finalize.ts'
import { ensureMeetingPollKey } from './meeting-poll-key.ts'
import { meetingPollMailboxKey } from './meeting-poll-voters.ts'
import { createMeetingPoll } from './meeting-polls.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type EventTypeFixture,
  testContext,
  weekdays,
} from './testing.ts'

type VoterOptions = {
  value?: MeetingPollVoteValue | null
  state?: 'active' | 'invited' | 'pending' | 'withdrawn'
  responses?: Record<string, unknown>
  consent?: boolean
}

type FinalizeVoter = { id: string; email: string; name: string; ballotRevision: number }

function session(principal: Principal): Principal {
  return { ...principal, kind: 'session', sessionId: randomUUID() }
}

export async function createFinalizeFixture(
  db: Db,
  options: { event?: EventTypeFixture; admissionMode?: 'public_link' | 'invited' } = {},
) {
  const { rows } = await sql<{ now: string }>`select clock_timestamp()::text as now`.execute(db)
  const clock = Temporal.Instant.from(rows[0]?.now as string)
  const start = clock.round({ smallestUnit: 'hour', roundingMode: 'ceil' }).add({ hours: 7 * 24 })
  const owner = await createTestUser(db, 'Poll Owner')
  const member = await createTestUser(db, 'Ordinary Member')
  const team = await createTestTeam(db, [
    { user: owner, role: 'owner' },
    { user: member, role: 'member' },
  ])
  const organizationId = team.id
  const fixtures = createFixtures(db)
  const allDay = [{ start: '00:00', end: '24:00' }]
  await fixtures.schedule(owner.id, {
    timeZone: 'UTC',
    weeklyHours: { ...weekdays(...allDay), saturday: allDay, sunday: allDay },
  })
  const eventTypeId = await fixtures.eventType(organizationId, null, {
    hosts: [{ userId: owner.id }],
    allowGuests: true,
    ...options.event,
  })
  const as = (principal: Principal) => ({
    ...testContext(db, session(principal), () => clock),
    meetingPollSecret: 'finalize-fixture-only-meeting-poll-secret',
  })
  const ctx = as(team.as(owner))
  const memberCtx = as(team.as(member))
  const { poll } = await createMeetingPoll(ctx, {
    eventTypeId,
    candidateStarts: [start.toString(), start.add({ hours: 24 }).toString()],
    deadlineAt: start.subtract({ hours: 48 }).toString(),
    admissionMode: options.admissionMode ?? 'public_link',
    displayTimeZone: 'UTC',
    idempotencyKey: randomUUID(),
  })
  const [chosen, alternative] = poll.candidates
  if (!chosen || !alternative) throw new Error('Expected two fixture candidates')
  const chosenId = chosen.id
  const slotIds = [chosenId, alternative.id]

  const revisions = () =>
    db
      .selectFrom('meeting_polls')
      .select(['host_revision', 'results_revision'])
      .where('id', '=', poll.id)
      .executeTakeFirstOrThrow()

  let sequence = 0
  /** Seed the persisted ballot shape and allow deliberately ineligible stored states. */
  async function addVoter({
    value = 'yes',
    state = 'active',
    responses = {},
    consent = true,
  }: VoterOptions = {}): Promise<FinalizeVoter> {
    const email = `voter-${++sequence}@example.com`
    const name = `Poll Voter ${sequence}`
    const verified = state === 'active' || state === 'withdrawn'
    const voted = value !== null && state === 'active'
    const ballotRevision = voted ? 1 : 0
    const at = clock.toString()
    return db.transaction().execute(async (trx) => {
      await ensureMeetingPollKey(trx, ctx.meetingPollSecret)
      await trx
        .selectFrom('meeting_polls')
        .select('id')
        .where('id', '=', poll.id)
        .forUpdate()
        .execute()
      const voter = await trx
        .insertInto('meeting_poll_voters')
        .values({
          organization_id: organizationId,
          poll_id: poll.id,
          name,
          email,
          email_key: meetingPollMailboxKey(ctx.meetingPollSecret, poll.id, email),
          verified_at: verified ? at : null,
          invited_at: state === 'invited' ? at : null,
          pending_expires_at: state === 'pending' ? clock.add({ minutes: 30 }).toString() : null,
          admission_ip_digest: state === 'pending' ? Buffer.alloc(32) : null,
          withdrawn_at: state === 'withdrawn' ? at : null,
          ballot_submitted_at: voted && consent ? at : null,
          join_consent_at: voted && consent ? at : null,
          responses: JSON.stringify(responses),
          ballot_revision: ballotRevision,
          time_zone: 'America/New_York',
          locale: 'en',
          created_at: at,
          updated_at: at,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      if (voted) {
        await trx
          .insertInto('meeting_poll_votes')
          .values(
            slotIds.map((id) => ({
              organization_id: organizationId,
              poll_id: poll.id,
              voter_id: voter.id,
              slot_id: id,
              value,
            })),
          )
          .execute()
      }
      await trx
        .updateTable('meeting_polls')
        .set((eb) => ({ results_revision: eb('results_revision', '+', 1) }))
        .where('id', '=', poll.id)
        .execute()
      return { id: voter.id, email, name, ballotRevision }
    })
  }

  async function input(
    voters: [FinalizeVoter, ...FinalizeVoter[]],
    overrides: Partial<FinalizeMeetingPollInput> = {},
  ): Promise<FinalizeMeetingPollInput> {
    return {
      id: poll.id,
      slotId: chosenId,
      bookerVoterId: voters[0].id,
      attendeeVoterIds: voters.map((voter) => voter.id),
      expectedBallotRevisions: Object.fromEntries(
        voters.map((voter) => [voter.id, voter.ballotRevision]),
      ),
      expectedResultsRevision: (await revisions()).results_revision,
      acknowledgeConditional: false,
      idempotencyKey: randomUUID(),
      ...overrides,
    }
  }

  return {
    db,
    ctx,
    memberCtx,
    organizationId,
    eventTypeId,
    owner,
    member,
    team,
    fixtures,
    poll,
    start,
    chosen,
    alternative,
    addVoter,
    input,
    revisions,
  }
}
