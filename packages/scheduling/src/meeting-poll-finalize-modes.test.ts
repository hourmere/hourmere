import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPublicTeamBooking } from './bookings.ts'
import { finalizeMeetingPoll } from './meeting-poll-finalize.ts'
import { createFinalizeFixture } from './meeting-poll-finalize-fixture.ts'

const serverUrl = process.env.DATABASE_URL

async function bookedHosts(db: Db, bookingId: string) {
  const rows = await db
    .selectFrom('booking_hosts')
    .select('user_id')
    .where('booking_id', '=', bookingId)
    .orderBy('user_id')
    .execute()
  return rows.map(({ user_id }) => user_id)
}

async function fairness(db: Db, eventTypeId: string) {
  const state = await db
    .selectFrom('round_robin_state')
    .select('next_sequence')
    .where('event_type_id', '=', eventTypeId)
    .executeTakeFirstOrThrow()
  const hosts = await db
    .selectFrom('event_type_hosts')
    .select('last_assigned_sequence')
    .where('event_type_id', '=', eventTypeId)
    .orderBy('user_id')
    .execute()
  return {
    next: state.next_sequence,
    assignments: hosts.map(({ last_assigned_sequence }) => last_assigned_sequence),
  }
}

describe.skipIf(!serverUrl)('meeting poll finalization scheduling modes', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'poll_fin_modes' })
    db = createDb(owned.pool)
  }, 120_000)

  afterAll(async () => {
    await owned?.drop()
  })

  it('rolls back all pinned collective hosts and the poll when the outcome write fails at commit', async () => {
    const fixture = await createFinalizeFixture(db, { schedulingType: 'collective' })
    const booker = await fixture.addVoter()
    const guest = await fixture.addVoter()
    await fixture.addVoter({ value: 'no' })
    const input = await fixture.input([booker, guest])
    const expectedHosts = [fixture.owner.id, fixture.member.id].sort()
    const pollRow = () =>
      db
        .selectFrom('meeting_polls')
        .selectAll()
        .where('id', '=', fixture.poll.id)
        .executeTakeFirstOrThrow()
    const before = await pollRow()

    await sql`CREATE FUNCTION reject_collective_poll_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected collective poll outcome failure';
      END $$`.execute(db)
    await sql`CREATE CONSTRAINT TRIGGER reject_collective_poll_outcome
      AFTER INSERT ON meeting_poll_deliveries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (NEW.kind = 'selected' AND NEW.poll_id = ${sql.lit(fixture.poll.id)}::uuid)
      EXECUTE FUNCTION reject_collective_poll_outcome()`.execute(db)

    let failedBookingId: string | undefined
    try {
      await expect(
        finalizeMeetingPoll(
          {
            ...fixture.ctx,
            notify: async (trx, event) => {
              failedBookingId = event.bookingId
              expect(await bookedHosts(trx, event.bookingId)).toEqual(expectedHosts)
            },
          },
          input,
        ),
      ).rejects.toThrow('injected collective poll outcome failure')
    } finally {
      await sql`DROP TRIGGER reject_collective_poll_outcome ON meeting_poll_deliveries`.execute(db)
      await sql`DROP FUNCTION reject_collective_poll_outcome()`.execute(db)
    }

    expect(await pollRow()).toEqual(before)
    if (!failedBookingId) throw new Error('Expected a staged collective booking')
    expect(await bookedHosts(db, failedBookingId)).toEqual([])
    expect(
      await db.selectFrom('bookings').select('id').where('id', '=', failedBookingId).execute(),
    ).toEqual([])
    expect(
      await db
        .selectFrom('booking_attendees')
        .select('email')
        .where('booking_id', '=', failedBookingId)
        .execute(),
    ).toEqual([])
    expect(
      await db
        .selectFrom('meeting_poll_voters')
        .select('id')
        .where('poll_id', '=', fixture.poll.id)
        .where('selected_booking_role', 'is not', null)
        .execute(),
    ).toEqual([])
    expect(
      await db
        .selectFrom('meeting_poll_operations')
        .select('booking_id')
        .where('poll_id', '=', fixture.poll.id)
        .where('operation', '=', 'finalize')
        .execute(),
    ).toEqual([])
    expect(
      await db
        .selectFrom('meeting_poll_deliveries')
        .select('voter_id')
        .where('poll_id', '=', fixture.poll.id)
        .where('kind', '=', 'selected')
        .execute(),
    ).toEqual([])

    const finalized = await finalizeMeetingPoll(fixture.ctx, input)
    expect(finalized.replayed).toBe(false)
    expect(finalized.poll).toMatchObject({ status: 'scheduled', bookingId: finalized.booking.id })
    expect(await bookedHosts(db, finalized.booking.id)).toEqual(expectedHosts)
  })

  it('shares round-robin fairness with ordinary bookings and advances it only on commit', async () => {
    const fixture = await createFinalizeFixture(db, { schedulingType: 'round_robin' })
    const { ctx, eventTypeId } = fixture
    const { slug } = await db
      .selectFrom('event_types')
      .select('slug')
      .where('id', '=', eventTypeId)
      .executeTakeFirstOrThrow()
    const ordinaryBooking = (start: Temporal.Instant) =>
      createPublicTeamBooking(
        { db, now: ctx.now },
        {
          handle: ctx.principal.organization.slug,
          slug,
          start,
          invitee: { name: 'Ordinary Booker', email: 'ordinary@example.com', timeZone: 'UTC' },
        },
      )
    const [firstHost, secondHost] = [fixture.owner.id, fixture.member.id].sort()
    const initial = await ordinaryBooking(fixture.start.subtract({ hours: 1 }))
    expect(await bookedHosts(db, initial.booking.id)).toEqual([firstHost])
    expect(await fairness(db, eventTypeId)).toEqual({ next: '1', assignments: ['1', '0'] })

    const booker = await fixture.addVoter()
    const input = await fixture.input([booker])
    await expect(
      finalizeMeetingPoll(
        {
          ...ctx,
          notify: async (trx, event) => {
            expect(await bookedHosts(trx, event.bookingId)).toEqual([secondHost])
            expect(await fairness(trx, eventTypeId)).toEqual({ next: '2', assignments: ['1', '2'] })
            throw new Error('injected round-robin notification failure')
          },
        },
        input,
      ),
    ).rejects.toThrow('injected round-robin notification failure')
    expect(await fairness(db, eventTypeId)).toEqual({ next: '1', assignments: ['1', '0'] })

    const finalized = await finalizeMeetingPoll(ctx, input)
    expect(finalized.replayed).toBe(false)
    expect(await bookedHosts(db, finalized.booking.id)).toEqual([secondHost])
    expect(await fairness(db, eventTypeId)).toEqual({ next: '2', assignments: ['1', '2'] })
    expect(await finalizeMeetingPoll(ctx, input)).toEqual({ ...finalized, replayed: true })
    expect(await fairness(db, eventTypeId)).toEqual({ next: '2', assignments: ['1', '2'] })

    const next = await ordinaryBooking(Temporal.Instant.from(fixture.alternative.startAt))
    expect(await bookedHosts(db, next.booking.id)).toEqual([firstHost])
    expect(await fairness(db, eventTypeId)).toEqual({ next: '3', assignments: ['3', '2'] })
  })
})
