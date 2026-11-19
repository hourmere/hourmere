import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type MeetingPollVoteValue, submitMeetingPollBallot } from './meeting-poll-ballots.ts'
import { type FinalizeMeetingPollResult, finalizeMeetingPoll } from './meeting-poll-finalize.ts'
import {
  collideFinalizeWrites,
  createFinalizeFixture,
  FINALIZE_TEST_GATE,
  waitAtFinalizeGate,
} from './meeting-poll-finalize-fixture.ts'
import { getMeetingPollResults } from './meeting-poll-results.ts'
import { inviteMeetingPollVoters, openMeetingPollCredential } from './meeting-poll-voters.ts'
import { closeMeetingPoll } from './meeting-polls.ts'

const serverUrl = process.env.DATABASE_URL
type Fixture = Awaited<ReturnType<typeof createFinalizeFixture>>

describe.skipIf(!serverUrl)('meeting poll finalization under concurrent writes', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'poll_fin_races' })
    db = createDb(owned.pool)
    // Pause real ballot replacements after taking the poll lock and before updating the ballot.
    await sql`CREATE FUNCTION pause_poll_ballot() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(${sql.lit(FINALIZE_TEST_GATE)}, 0));
        RETURN NEW;
      END $$`.execute(db)
    await sql`CREATE TRIGGER pause_poll_ballot
      BEFORE UPDATE OF ballot_revision ON meeting_poll_voters
      FOR EACH ROW EXECUTE FUNCTION pause_poll_ballot()`.execute(db)
  }, 120_000)

  afterAll(async () => {
    await owned?.drop()
  })

  async function voter({ ctx, poll, organizationId, chosen, alternative }: Fixture) {
    const booker = { name: 'Editing Voter', email: 'editor@example.com' }
    const { entries } = await inviteMeetingPollVoters(ctx, {
      id: poll.id,
      invitees: [booker],
      idempotencyKey: randomUUID(),
    })
    const id = entries[0]?.voterId
    if (!id) throw new Error('Expected one invited voter')
    const delivery = await db
      .selectFrom('meeting_poll_deliveries')
      .select(['generation', 'capability_ciphertext'])
      .where('voter_id', '=', id)
      .where('kind', '=', 'invitation')
      .executeTakeFirstOrThrow()
    const credential = openMeetingPollCredential(
      ctx.meetingPollSecret,
      { organizationId, pollId: poll.id, voterId: id, generation: delivery.generation },
      delivery.capability_ciphertext,
    )
    if (!credential) throw new Error('Expected the invitation voting credential')
    const vote = (
      expectedBallotRevision: number,
      alternativeValue: MeetingPollVoteValue,
      chosenValue: MeetingPollVoteValue = 'yes',
    ) =>
      submitMeetingPollBallot(ctx, {
        token: credential.token,
        votes: [
          { slotId: chosen.id, value: chosenValue },
          { slotId: alternative.id, value: alternativeValue },
        ],
        expectedBallotRevision,
        consent: true,
      })
    const { ballotRevision } = await vote(0, 'yes')
    return { ...booker, id, ballotRevision, vote }
  }

  const bookingRows = ({ organizationId }: Fixture) =>
    db
      .selectFrom('bookings')
      .select(['id', 'start_at'])
      .where('organization_id', '=', organizationId)
      .execute()
  const receipts = ({ poll }: Fixture) =>
    db
      .selectFrom('meeting_poll_operations')
      .select('booking_id')
      .where('poll_id', '=', poll.id)
      .where('operation', '=', 'finalize')
      .execute()
  const deliveries = ({ poll }: Fixture) =>
    db
      .selectFrom('meeting_poll_deliveries')
      .select('voter_id')
      .where('poll_id', '=', poll.id)
      .where('kind', '=', 'selected')
      .execute()

  async function expectSingleBooking(
    fixture: Fixture,
    result: FinalizeMeetingPollResult,
    bookerId: string,
    unselectedId?: string,
  ) {
    expect(result.poll).toMatchObject({ status: 'scheduled', bookingId: result.booking.id })
    expect(await bookingRows(fixture)).toEqual([
      { id: result.booking.id, start_at: new Date(result.booking.start) },
    ])
    expect(await receipts(fixture)).toEqual([{ booking_id: result.booking.id }])
    expect(await deliveries(fixture)).toEqual(unselectedId ? [{ voter_id: unselectedId }] : [])
    const selected = await db
      .selectFrom('meeting_poll_voters')
      .select(['id', 'selected_booking_role'])
      .where('poll_id', '=', fixture.poll.id)
      .where('selected_booking_role', 'is not', null)
      .execute()
    expect(selected).toEqual([{ id: bookerId, selected_booking_role: 'booker' }])
  }

  it('refuses stale open results after a concurrent unselected voter commits', async () => {
    const fixture = await createFinalizeFixture(db)
    const booker = await fixture.addVoter()
    const editor = await voter(fixture)
    const request = await fixture.input([booker])
    const before = await getMeetingPollResults(fixture.ctx, fixture.poll.id)

    const [vote, finalize] = await collideFinalizeWrites(
      db,
      () => editor.vote(editor.ballotRevision, 'no'),
      () => finalizeMeetingPoll(fixture.ctx, request),
    )

    expect(vote).toMatchObject({ value: { ballotRevision: editor.ballotRevision + 1 } })
    expect(finalize).toMatchObject({ error: { code: 'poll_changed' } })
    const after = await getMeetingPollResults(fixture.ctx, fixture.poll.id)
    expect(after.poll).toMatchObject({
      status: 'open',
      hostRevision: before.poll.hostRevision,
      chosenSlotId: null,
      bookingId: null,
    })
    expect(after.resultsRevision).toBe(request.expectedResultsRevision + 1)
    expect(after.roster.find(({ voterId }) => voterId === editor.id)?.votes).toContainEqual({
      slotId: fixture.alternative.id,
      value: 'no',
    })
    expect(await bookingRows(fixture)).toEqual([])
    expect(await receipts(fixture)).toEqual([])
    expect(await deliveries(fixture)).toEqual([])
  }, 20_000)

  it('freezes the ballot when finalize wins against a concurrent vote', async () => {
    const fixture = await createFinalizeFixture(db)
    const booker = await voter(fixture)
    const request = await fixture.input([booker])
    const before = await getMeetingPollResults(fixture.ctx, fixture.poll.id)

    const [finalize, vote] = await collideFinalizeWrites(
      db,
      () => finalizeMeetingPoll({ ...fixture.ctx, notify: waitAtFinalizeGate }, request),
      () => booker.vote(booker.ballotRevision, 'no', 'no'),
    )

    expect(vote).toMatchObject({ error: { code: 'poll_closed' } })
    if (!('value' in finalize)) throw finalize.error
    await expectSingleBooking(fixture, finalize.value, booker.id)
    const after = await getMeetingPollResults(fixture.ctx, fixture.poll.id)
    expect(after.resultsRevision).toBe(before.resultsRevision)
    expect(after.roster).toEqual(before.roster)
  }, 20_000)

  it('commits only one finalizer when different keys choose different slots', async () => {
    const fixture = await createFinalizeFixture(db)
    const booker = await fixture.addVoter()
    const other = await fixture.addVoter()
    const request = await fixture.input([booker])
    const contender = await fixture.input([other], { slotId: fixture.alternative.id })

    const [first, second] = await collideFinalizeWrites(
      db,
      () => finalizeMeetingPoll({ ...fixture.ctx, notify: waitAtFinalizeGate }, request),
      () => finalizeMeetingPoll(fixture.ctx, contender),
    )

    if (!('value' in first)) throw first.error
    expect(first.value.poll.chosenSlotId).toBe(fixture.chosen.id)
    expect(second).toMatchObject({
      error: { code: 'poll_already_scheduled', poll: first.value.poll },
    })
    await expectSingleBooking(fixture, first.value, booker.id, other.id)
  }, 20_000)

  it('closes during one-second ballot edits and finalizes the frozen results', async () => {
    const fixture = await createFinalizeFixture(db)
    const booker = await voter(fixture)
    const beforeEdits = await getMeetingPollResults(fixture.ctx, fixture.poll.id)
    const stale = await fixture.input([booker], {
      expectedResultsRevision: beforeEdits.resultsRevision,
    })
    // The interval models edit cadence. PostgreSQL lock waits determine the close order.
    await sleep(1000)
    const edit = await booker.vote(booker.ballotRevision, 'no')
    await sleep(1000)
    const [lastEdit, close] = await collideFinalizeWrites(
      db,
      () => booker.vote(edit.ballotRevision, 'if_need_be'),
      () =>
        closeMeetingPoll(fixture.ctx, {
          id: fixture.poll.id,
          expectedHostRevision: beforeEdits.poll.hostRevision,
        }),
    )

    const finalBallotRevision = booker.ballotRevision + 2
    expect(lastEdit).toMatchObject({ value: { ballotRevision: finalBallotRevision } })
    expect(close).toMatchObject({
      value: { status: 'closed', hostRevision: beforeEdits.poll.hostRevision + 1 },
    })
    const frozen = await getMeetingPollResults(fixture.ctx, fixture.poll.id)
    expect(frozen.resultsRevision).toBe(beforeEdits.resultsRevision + 2)
    expect(frozen.roster).toMatchObject([
      {
        voterId: booker.id,
        ballotRevision: finalBallotRevision,
        votes: [
          { slotId: fixture.chosen.id, value: 'yes' },
          { slotId: fixture.alternative.id, value: 'if_need_be' },
        ],
      },
    ])
    await expect(booker.vote(finalBallotRevision, 'no')).rejects.toMatchObject({
      code: 'poll_closed',
    })
    await expect(finalizeMeetingPoll(fixture.ctx, stale)).rejects.toMatchObject({
      code: 'poll_changed',
    })
    const finalized = await finalizeMeetingPoll(fixture.ctx, {
      ...stale,
      expectedResultsRevision: frozen.resultsRevision,
      expectedBallotRevisions: { [booker.id]: finalBallotRevision },
    })
    expect(finalized.poll.closedAt).toBe(frozen.poll.closedAt)
    await expectSingleBooking(fixture, finalized, booker.id)
  }, 20_000)
})
