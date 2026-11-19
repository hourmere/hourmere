import { randomUUID } from 'node:crypto'
import {
  bookingCalendarJob,
  bookingConferenceJob,
  calendarBookingNotifier,
  conferenceBookingNotifier,
  GOOGLE_CALENDAR_SYNC_SCOPES,
} from '@hourmere/calendars'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { bookingNotificationJob, bookingNotifier } from '@hourmere/notifications'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { cancelHostBooking, MAX_GUESTS, rescheduleHostBooking } from './bookings.ts'
import type { BookingNotifier } from './context.ts'
import { submitMeetingPollBallot } from './meeting-poll-ballots.ts'
import { finalizeMeetingPoll } from './meeting-poll-finalize.ts'
import { createFinalizeFixture } from './meeting-poll-finalize-fixture.ts'
import { inviteMeetingPollVoters, openMeetingPollCredential } from './meeting-poll-voters.ts'
import { closeMeetingPoll } from './meeting-polls.ts'

const serverUrl = process.env.DATABASE_URL
const question = {
  id: 'topic',
  label: 'What should we discuss?',
  type: 'short_text',
  required: true,
}
const meet = { kind: 'google_meet', autoCreate: true }

type Fixture = Awaited<ReturnType<typeof createFinalizeFixture>>

describe.skipIf(!serverUrl)('atomic meeting poll finalization', () => {
  let owned: TestDatabase
  let db: Db
  const send = vi.fn(async () => {})
  const queue = () =>
    createJobs({
      connectionString: owned.url,
      definitions: [
        bookingCalendarJob({ db }),
        bookingConferenceJob({ db }),
        bookingNotificationJob({
          db,
          mailer: { send },
          secret: 'synthetic-booking-notification-secret',
          publicUrl: 'https://hourmere.example',
        }),
      ],
      maxConnections: 2,
      work: false,
      migrate: true,
    })
  let jobs: ReturnType<typeof queue>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'poll_finalize' })
    db = createDb(owned.pool)
    jobs = queue()
    await jobs.start()
  }, 120_000)

  afterAll(async () => {
    try {
      await jobs?.stop()
    } finally {
      await owned?.drop()
    }
  })

  async function withBookingIntents(fixture: Fixture) {
    const { owner } = fixture
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: owner.id,
        provider: 'google',
        external_account_id: 'synthetic-meet-organizer',
        credentials: Buffer.from('synthetic-cache-only-credential'),
        scopes: [...GOOGLE_CALENDAR_SYNC_SCOPES],
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const calendar = await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: 'work',
        name: 'Work',
        access_role: 'owner',
        supports_google_meet: true,
        check_conflicts: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('profiles')
      .values({
        user_id: owner.id,
        handle: `host-${owner.id.slice(0, 8)}`,
        time_zone: 'UTC',
        destination_calendar_id: calendar.id,
      })
      .execute()

    const calendarNotify = calendarBookingNotifier(jobs)
    const conferenceNotify = conferenceBookingNotifier(jobs)
    const mailNotify = bookingNotifier(jobs)
    const notify: BookingNotifier = async (trx, event, now) => {
      await conferenceNotify(trx, event)
      await mailNotify(trx, event, now)
      if (event.type === 'created') await calendarNotify(trx, event)
    }
    return { ...fixture.ctx, automaticMeet: true, notify }
  }

  async function castBookerBallot(fixture: Fixture) {
    const { ctx, poll, organizationId } = fixture
    const booker = { email: 'booker@example.com', name: 'Confirmed Booker' }
    const { entries } = await inviteMeetingPollVoters(ctx, {
      id: poll.id,
      invitees: [{ ...booker, locale: 'zh-CN', timeZone: 'Asia/Taipei' }],
      idempotencyKey: randomUUID(),
    })
    const voterId = entries[0]?.voterId
    if (!voterId) throw new Error('Expected one invitation recipient')
    const delivery = await db
      .selectFrom('meeting_poll_deliveries')
      .select(['generation', 'capability_ciphertext'])
      .where('voter_id', '=', voterId)
      .where('kind', '=', 'invitation')
      .executeTakeFirstOrThrow()
    const credential = openMeetingPollCredential(
      ctx.meetingPollSecret,
      { organizationId, pollId: poll.id, voterId, generation: delivery.generation },
      delivery.capability_ciphertext,
    )
    if (!credential) throw new Error('Expected a voting credential')
    await submitMeetingPollBallot(ctx, {
      token: credential.token,
      votes: poll.candidates.map(({ id }) => ({ slotId: id, value: 'yes' })),
      expectedBallotRevision: 0,
      consent: true,
      responses: { topic: 'The booker answers this question' },
    })
    return { ...booker, id: voterId, ballotRevision: 1 }
  }

  async function outbox(bookingId: string) {
    const { rows } = await sql<{ name: string }>`
      select distinct name from pgboss.job
      where data->>'bookingId' = ${bookingId} or data->>'rootBookingId' = ${bookingId}
      order by name`.execute(db)
    return rows.map(({ name }) => name)
  }

  const bookingRows = ({ organizationId }: Fixture) =>
    db.selectFrom('bookings').selectAll().where('organization_id', '=', organizationId).execute()
  const receiptRows = ({ poll }: Fixture) =>
    db
      .selectFrom('meeting_poll_operations')
      .select(['booking_id', 'poll_id'])
      .where('poll_id', '=', poll.id)
      .where('operation', '=', 'finalize')
      .execute()
  const selectedDeliveries = ({ poll }: Fixture) =>
    db
      .selectFrom('meeting_poll_deliveries')
      .select(['voter_id', 'state', 'capability_ciphertext'])
      .where('poll_id', '=', poll.id)
      .where('kind', '=', 'selected')
      .orderBy('voter_id')
      .execute()
  const pollRow = ({ poll }: Fixture) =>
    db.selectFrom('meeting_polls').selectAll().where('id', '=', poll.id).executeTakeFirstOrThrow()

  it('books one explicitly selected booker and MAX_GUESTS guests with atomic delivery intents', async () => {
    const fixture = await createFinalizeFixture(db, {
      event: { questions: [question], location: meet },
    })
    const ctx = await withBookingIntents(fixture)
    const booker = await castBookerBallot(fixture)
    const guests = []
    for (let i = 0; i < MAX_GUESTS; i++) {
      guests.push(
        await fixture.addVoter({
          value: i === 0 ? 'if_need_be' : 'yes',
          responses: { topic: `Private guest answer ${i}` },
        }),
      )
    }
    const nonselected = await fixture.addVoter({ value: 'no' })
    const invited = await fixture.addVoter({ state: 'invited' })
    await fixture.addVoter({ state: 'withdrawn' })
    await fixture.addVoter({ state: 'pending' })
    const before = await fixture.revisions()
    const input = await fixture.input([booker, ...guests], { acknowledgeConditional: true })
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected provider call'))
    try {
      const result = await finalizeMeetingPoll(ctx, input)
      const bookingId = result.booking.id
      expect(Object.keys(result).sort()).toEqual(['booking', 'poll', 'replayed'])
      expect(result.replayed).toBe(false)
      expect(result.booking).toEqual({
        id: bookingId,
        eventTypeId: fixture.eventTypeId,
        start: expect.any(String),
        end: expect.any(String),
        status: 'confirmed',
        source: 'web',
      })
      expect(Temporal.Instant.from(result.booking.start).equals(fixture.start)).toBe(true)
      expect(
        Temporal.Instant.from(result.booking.end).equals(fixture.start.add({ minutes: 30 })),
      ).toBe(true)
      expect(result.poll).toMatchObject({
        ...fixture.poll,
        status: 'scheduled',
        scheduledAt: expect.any(String),
        updatedAt: expect.any(String),
        chosenSlotId: input.slotId,
        bookingId,
        hostRevision: before.host_revision + 1,
      })
      expect(Object.keys(result.poll).sort()).toEqual(Object.keys(fixture.poll).sort())
      expect(JSON.stringify(result)).not.toContain(booker.name)
      expect(await fixture.revisions()).toEqual({
        host_revision: before.host_revision + 1,
        results_revision: before.results_revision,
      })
      expect(await bookingRows(fixture)).toEqual([
        expect.objectContaining({
          id: bookingId,
          responses: { topic: 'The booker answers this question' },
          manage_token_hash: expect.any(Buffer),
          notification_snapshot: expect.any(Object),
        }),
      ])
      const attendees = await db
        .selectFrom('booking_attendees')
        .select(['email', 'is_booker', 'time_zone', 'locale'])
        .where('booking_id', '=', bookingId)
        .execute()
      expect(attendees).toHaveLength(MAX_GUESTS + 1)
      expect(attendees.filter(({ is_booker }) => is_booker)).toEqual([
        { email: booker.email, is_booker: true, time_zone: 'Asia/Taipei', locale: 'zh-CN' },
      ])
      expect(
        attendees
          .filter(({ is_booker }) => !is_booker)
          .map(({ email }) => email)
          .sort(),
      ).toEqual(guests.map(({ email }) => email).sort())
      const selected = await db
        .selectFrom('meeting_poll_voters')
        .select(['id', 'selected_booking_role', 'responses'])
        .where('poll_id', '=', fixture.poll.id)
        .where('selected_booking_role', 'is not', null)
        .orderBy('id')
        .execute()
      expect(selected).toHaveLength(MAX_GUESTS + 1)
      expect(selected.find(({ id }) => id === booker.id)?.selected_booking_role).toBe('booker')
      for (const [index, guest] of guests.entries()) {
        expect(selected.find(({ id }) => id === guest.id)).toEqual({
          id: guest.id,
          selected_booking_role: 'guest',
          responses: { topic: `Private guest answer ${index}` },
        })
      }
      expect(await receiptRows(fixture)).toEqual([
        { booking_id: bookingId, poll_id: fixture.poll.id },
      ])
      expect(await selectedDeliveries(fixture)).toEqual(
        [nonselected.id, invited.id].sort().map((voterId) => ({
          voter_id: voterId,
          state: 'pending',
          capability_ciphertext: null,
        })),
      )
      expect(await outbox(bookingId)).toEqual([
        'booking-calendar',
        'booking-conference',
        'booking-notification',
      ])
      expect(
        await db
          .selectFrom('booking_conferences')
          .select(['provider', 'state'])
          .where('root_booking_id', '=', bookingId)
          .executeTakeFirst(),
      ).toEqual({
        provider: 'google_meet',
        state: 'pending',
      })
      expect(fetch).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
    }
  })

  it('rejects one attendee past MAX_GUESTS + 1 without reserving the slot', async () => {
    const fixture = await createFinalizeFixture(db)
    const booker = await fixture.addVoter()
    const guests = []
    for (let i = 0; i < MAX_GUESTS + 1; i++) guests.push(await fixture.addVoter())
    await expect(
      finalizeMeetingPoll(fixture.ctx, await fixture.input([booker, ...guests])),
    ).rejects.toMatchObject({ code: 'too_many_guests' })
    expect(await bookingRows(fixture)).toEqual([])
    expect(await receiptRows(fixture)).toEqual([])
    expect((await pollRow(fixture)).status).toBe('open')
  })

  it('rejects a no voter, a missing ballot, unverified and withdrawn voters, and a voter without consent', async () => {
    const fixture = await createFinalizeFixture(db)
    const booker = await fixture.addVoter()
    const no = await fixture.addVoter({ value: 'no' })
    const unanswered = await fixture.addVoter({ value: null })
    const invited = await fixture.addVoter({ state: 'invited' })
    const withdrawn = await fixture.addVoter({ state: 'withdrawn' })
    const conditionalWithoutConsent = await fixture.addVoter({
      value: 'if_need_be',
      consent: false,
    })
    for (const voter of [no, unanswered, invited, withdrawn, conditionalWithoutConsent]) {
      await expect(
        finalizeMeetingPoll(
          fixture.ctx,
          await fixture.input([booker, voter], { acknowledgeConditional: true }),
        ),
      ).rejects.toMatchObject({ code: 'poll_attendee_ineligible' })
    }
    await expect(
      finalizeMeetingPoll(fixture.ctx, await fixture.input([no, booker])),
    ).rejects.toMatchObject({ code: 'poll_attendee_ineligible' })
    const other = await createFinalizeFixture(db)
    const foreignVoter = await other.addVoter()
    await expect(
      finalizeMeetingPoll(fixture.ctx, await fixture.input([booker, foreignVoter])),
    ).rejects.toMatchObject({ code: 'poll_attendee_ineligible' })
    expect(await bookingRows(fixture)).toEqual([])
    expect(await selectedDeliveries(fixture)).toEqual([])
  })

  it('requires host acknowledgment for a consenting conditional vote and validates ballot revisions', async () => {
    const fixture = await createFinalizeFixture(db)
    const booker = await fixture.addVoter({ value: 'if_need_be' })
    const guest = await fixture.addVoter()
    const input = await fixture.input([booker, guest])
    await expect(finalizeMeetingPoll(fixture.ctx, input)).rejects.toMatchObject({
      code: 'poll_conditional_acknowledgment_required',
    })
    await expect(
      finalizeMeetingPoll(fixture.ctx, {
        ...input,
        acknowledgeConditional: true,
        expectedBallotRevisions: { ...input.expectedBallotRevisions, [guest.id]: 0 },
      }),
    ).rejects.toMatchObject({ code: 'poll_changed' })
    await expect(
      finalizeMeetingPoll(fixture.ctx, {
        ...input,
        acknowledgeConditional: true,
        expectedResultsRevision: input.expectedResultsRevision - 1,
      }),
    ).rejects.toMatchObject({ code: 'poll_changed' })
    const { host_revision } = await fixture.revisions()
    await closeMeetingPoll(fixture.ctx, {
      id: fixture.poll.id,
      expectedHostRevision: host_revision,
    })
    const finalized = await finalizeMeetingPoll(fixture.ctx, {
      ...input,
      acknowledgeConditional: true,
    })
    expect(finalized.poll.status).toBe('scheduled')
    expect(finalized.poll.closedAt).toEqual(expect.any(String))
  })

  it('makes a retry mail-free and returns the safe current booking lifecycle only for an exact replay', async () => {
    const fixture = await createFinalizeFixture(db)
    const booker = await fixture.addVoter()
    const guest = await fixture.addVoter()
    await fixture.addVoter({ value: 'no' })
    const notify = vi.fn(bookingNotifier(jobs))
    const ctx = { ...fixture.ctx, notify }
    const input = await fixture.input([booker, guest])
    const first = await finalizeMeetingPoll(ctx, input)
    const before = await selectedDeliveries(fixture)
    expect(
      await finalizeMeetingPoll(ctx, {
        ...input,
        attendeeVoterIds: [...input.attendeeVoterIds].reverse(),
      }),
    ).toEqual({ ...first, replayed: true })
    await expect(
      finalizeMeetingPoll(ctx, { ...input, slotId: fixture.alternative.id }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
    await expect(
      finalizeMeetingPoll(ctx, { ...input, bookerVoterId: guest.id }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
    await expect(
      finalizeMeetingPoll(ctx, { ...input, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'poll_already_scheduled' })

    const moved = await rescheduleHostBooking(fixture.ctx, first.booking.id, {
      start: Temporal.Instant.from(fixture.alternative.startAt),
    })
    const cancelled = await cancelHostBooking(fixture.ctx, moved.booking.id)
    expect(await finalizeMeetingPoll(ctx, input)).toEqual({
      poll: first.poll,
      replayed: true,
      booking: {
        id: cancelled.id,
        eventTypeId: cancelled.eventTypeId,
        start: cancelled.start,
        end: cancelled.end,
        status: 'cancelled',
        source: cancelled.source,
      },
    })
    expect((await bookingRows(fixture)).map(({ id }) => id).sort()).toEqual(
      [first.booking.id, moved.booking.id].sort(),
    )
    expect(await receiptRows(fixture)).toEqual([
      { poll_id: fixture.poll.id, booking_id: first.booking.id },
    ])
    expect(await selectedDeliveries(fixture)).toEqual(before)
    expect(notify).toHaveBeenCalledOnce()
  })

  it('enforces current organization, manager role, and write scope before any booking or replay', async () => {
    const fixture = await createFinalizeFixture(db)
    const booker = await fixture.addVoter()
    const request = await fixture.input([booker])
    const differentOrg = await createFinalizeFixture(db)
    await expect(finalizeMeetingPoll(differentOrg.ctx, request)).rejects.toMatchObject({
      code: 'poll_not_found',
    })
    await expect(finalizeMeetingPoll(fixture.memberCtx, request)).rejects.toMatchObject({
      code: 'team_management_access_denied',
    })
    const principal = fixture.team.as(fixture.owner)
    if (principal.kind !== 'api_key') throw new Error('Expected an API-key fixture principal')
    await expect(
      finalizeMeetingPoll(
        {
          ...fixture.ctx,
          principal: { ...principal, apiKeyScope: 'read' },
        },
        request,
      ),
    ).rejects.toMatchObject({ error: 'insufficient_scope' })
    expect(await bookingRows(fixture)).toEqual([])
    await finalizeMeetingPoll(fixture.ctx, request)
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', fixture.organizationId)
      .where('userId', '=', fixture.owner.id)
      .execute()
    await expect(finalizeMeetingPoll(fixture.ctx, request)).rejects.toMatchObject({
      code: 'team_management_access_denied',
    })
    expect(await bookingRows(fixture)).toHaveLength(1)
    expect(await receiptRows(fixture)).toHaveLength(1)
  })

  it('rolls back booking, poll and voter updates, receipt and both outboxes on a late write failure', async () => {
    const fixture = await createFinalizeFixture(db, { event: { location: meet } })
    const booker = await fixture.addVoter()
    await fixture.addVoter({ value: 'no' })
    const input = await fixture.input([booker])
    const ctx = await withBookingIntents(fixture)
    const before = await pollRow(fixture)
    let insertedBookingId: string | undefined
    const notify: BookingNotifier = async (trx, event, now) => {
      insertedBookingId = event.bookingId
      await ctx.notify(trx, event, now)
    }
    await sql`CREATE FUNCTION fail_poll_finalize_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM meeting_polls p JOIN bookings b ON b.id = p.booking_id
          JOIN meeting_poll_operations r ON r.poll_id = p.id AND r.booking_id = b.id
          JOIN booking_attendees a ON a.booking_id = b.id AND a.is_booker
          JOIN meeting_poll_voters v ON v.poll_id = p.id AND v.selected_booking_role = 'booker'
          JOIN booking_conferences c ON c.root_booking_id = b.id
          JOIN pgboss.job j ON j.data->>'bookingId' = b.id::text AND j.name = 'booking-notification'
          WHERE p.id = NEW.poll_id AND p.status = 'scheduled' AND r.operation = 'finalize'
        ) THEN
          RAISE EXCEPTION 'complete finalization was not staged';
        END IF;
        RAISE EXCEPTION 'injected failure after staging poll finalization';
      END $$`.execute(db)
    await sql`CREATE CONSTRAINT TRIGGER fail_poll_finalize_test AFTER INSERT ON meeting_poll_deliveries
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (NEW.kind = 'selected' AND NEW.poll_id = ${sql.lit(fixture.poll.id)}::uuid)
      EXECUTE FUNCTION fail_poll_finalize_test()`.execute(db)
    try {
      await expect(finalizeMeetingPoll({ ...ctx, notify }, input)).rejects.toThrow(
        'injected failure after staging poll finalization',
      )
      if (!insertedBookingId) throw new Error('Expected the core to stage a booking')
      expect((await bookingRows(fixture)).length).toBe(0)
      expect(await pollRow(fixture)).toEqual(before)
      expect(await receiptRows(fixture)).toEqual([])
      expect(await selectedDeliveries(fixture)).toEqual([])
      expect(await outbox(insertedBookingId)).toEqual([])
      expect(
        await db
          .selectFrom('booking_conferences')
          .select('root_booking_id')
          .where('root_booking_id', '=', insertedBookingId)
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
    } finally {
      await sql`DROP TRIGGER fail_poll_finalize_test ON meeting_poll_deliveries`.execute(db)
      await sql`DROP FUNCTION fail_poll_finalize_test()`.execute(db)
    }
    expect((await finalizeMeetingPoll(ctx, input)).poll.status).toBe('scheduled')
  })
})
