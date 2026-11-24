import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { finalizeMeetingPoll } from './meeting-poll-finalize.ts'
import { createFinalizeFixture } from './meeting-poll-finalize-fixture.ts'

const serverUrl = process.env.DATABASE_URL
type Fixture = Awaited<ReturnType<typeof createFinalizeFixture>>

describe.skipIf(!serverUrl)('meeting poll finalize uses current event policy', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'finalize_policy' })
    db = createDb(owned.pool)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function state({ poll, organizationId }: Fixture) {
    return Promise.all([
      db
        .selectFrom('meeting_polls')
        .select(['status', 'host_revision', 'results_revision', 'chosen_slot_id', 'booking_id'])
        .where('id', '=', poll.id)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('meeting_poll_voters')
        .select(['id', 'ballot_revision', 'selected_booking_role'])
        .where('poll_id', '=', poll.id)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('meeting_poll_operations')
        .select('id')
        .where('poll_id', '=', poll.id)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('meeting_poll_deliveries')
        .select('id')
        .where('poll_id', '=', poll.id)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('bookings')
        .select('id')
        .where('organization_id', '=', organizationId)
        .orderBy('id')
        .execute(),
    ])
  }

  async function expectsRefusal(
    fixture: Fixture,
    input: Awaited<ReturnType<Fixture['input']>>,
    code: string,
  ) {
    const before = await state(fixture)
    await expect(finalizeMeetingPoll(fixture.ctx, input)).rejects.toMatchObject({ code })
    expect(await state(fixture)).toEqual(before)
  }

  it('rejects guests when the disclosed policy permits only the booker', async () => {
    const fixture = await createFinalizeFixture(db, { event: { allowGuests: false } })
    const booker = await fixture.addVoter()
    const guest = await fixture.addVoter()
    const request = await fixture.input([booker, guest])

    await expectsRefusal(fixture, request, 'guests_not_allowed')
    const alone = await fixture.input([booker], { idempotencyKey: request.idempotencyKey })
    await expect(finalizeMeetingPoll(fixture.ctx, alone)).resolves.toMatchObject({
      poll: { status: 'scheduled' },
      replayed: false,
    })
  })

  it('requires the booker’s answers even if a guest supplied the required answer', async () => {
    const fixture = await createFinalizeFixture(db, {
      event: { questions: [{ id: 'topic', label: 'Topic', type: 'short_text', required: true }] },
    })
    const booker = await fixture.addVoter()
    const guest = await fixture.addVoter({ responses: { topic: 'Guest’s answer' } })

    await expectsRefusal(fixture, await fixture.input([booker, guest]), 'invalid_responses')
  })

  it('requires a new poll when the selected duration is no longer offered', async () => {
    const fixture = await createFinalizeFixture(db)
    const request = await fixture.input([await fixture.addVoter()])
    await db
      .updateTable('event_types')
      .set({ duration_minutes: 45, allowed_durations_minutes: [45] })
      .where('id', '=', fixture.eventTypeId)
      .execute()

    await expectsRefusal(fixture, request, 'poll_event_changed')
  })

  it('sees a settings change committed while it waits for the host booking lock', async () => {
    const fixture = await createFinalizeFixture(db)
    const request = await fixture.input([await fixture.addVoter()])
    const before = await state(fixture)
    const blocker = await owned.pool.connect()

    try {
      await blocker.query('BEGIN')
      const { rows } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `booking-host:${fixture.owner.id}`,
      ])
      const outcome = finalizeMeetingPoll(fixture.ctx, request).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )

      try {
        await expect
          .poll(
            async () =>
              (
                await owned.pool.query<{ waiting: boolean }>(
                  `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                    WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))) AS waiting`,
                  [rows[0]?.pid],
                )
              ).rows[0]?.waiting,
            { timeout: 3000 },
          )
          .toBe(true)
        // The event row must still be writable while finalize is waiting for its host locks.
        await blocker.query('SELECT id FROM event_types WHERE id = $1 FOR UPDATE NOWAIT', [
          fixture.eventTypeId,
        ])
        await blocker.query('UPDATE event_types SET title = $1 WHERE id = $2', [
          'Title changed after poll creation',
          fixture.eventTypeId,
        ])
        await blocker.query('COMMIT')
      } finally {
        try {
          await blocker.query('ROLLBACK')
        } finally {
          await outcome
        }
      }

      expect(await outcome).toMatchObject({ error: { code: 'poll_event_changed' } })
      expect(await state(fixture)).toEqual(before)
    } finally {
      blocker.release()
    }
  })

  it('refuses a candidate when a mirrored calendar conflict appeared after voting', async () => {
    const fixture = await createFinalizeFixture(db)
    const request = await fixture.input([await fixture.addVoter()])
    const { calendarId } = await fixture.fixtures.calendarBusy(
      fixture.owner.id,
      [[fixture.start.toString(), fixture.start.add({ minutes: 15 }).toString()]],
      { now: fixture.ctx.now() },
    )

    await expectsRefusal(fixture, request, 'slot_unavailable')
    await db.deleteFrom('calendar_busy').where('calendar_id', '=', calendarId).execute()
    await expect(finalizeMeetingPoll(fixture.ctx, request)).resolves.toMatchObject({
      poll: { status: 'scheduled' },
      replayed: false,
    })
  })

  it('refuses a candidate when the host calendar has no usable sync', async () => {
    const fixture = await createFinalizeFixture(db)
    const request = await fixture.input([await fixture.addVoter()])
    const connection = await db
      .insertInto('calendar_connections')
      .values({
        user_id: fixture.owner.id,
        provider: 'google',
        external_account_id: `acct-${randomUUID()}`,
        credentials: Buffer.from('synthetic-cache-only-credential'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: `cal-${randomUUID()}`,
        name: 'Work',
        check_conflicts: true,
      })
      .execute()

    await expectsRefusal(fixture, request, 'calendar_sync_unavailable')
  })

  it('honors a shortened booking window', async () => {
    const fixture = await createFinalizeFixture(db)
    const request = await fixture.input([await fixture.addVoter()])
    await db
      .updateTable('event_types')
      .set({ booking_window_days: 1 })
      .where('id', '=', fixture.eventTypeId)
      .execute()

    await expectsRefusal(fixture, request, 'slot_unavailable')
  })

  it('counts a distant same-period booking against the current monthly limit', async () => {
    const fixture = await createFinalizeFixture(db)
    const request = await fixture.input([await fixture.addVoter()])
    const { start, organizationId, owner, eventTypeId } = fixture
    const day = start.toZonedDateTimeISO('UTC').day
    // The booking is in the same UTC month but outside the slot's normal busy window.
    const occupied = start.add({ hours: (day <= 15 ? 7 : -7) * 24 })
    await fixture.fixtures.booking(
      organizationId,
      [owner.id],
      occupied.toString(),
      occupied.add({ minutes: 30 }).toString(),
      { eventTypeId },
    )
    await db
      .updateTable('event_types')
      .set({ max_bookings_per_month: 1 })
      .where('id', '=', eventTypeId)
      .execute()

    await expectsRefusal(fixture, request, 'slot_unavailable')
  })

  it('honors the current buffer between two bookings that do not overlap', async () => {
    const fixture = await createFinalizeFixture(db)
    const request = await fixture.input([await fixture.addVoter()])
    const { start, organizationId, owner, eventTypeId } = fixture
    await fixture.fixtures.booking(
      organizationId,
      [owner.id],
      start.subtract({ minutes: 35 }).toString(),
      start.subtract({ minutes: 5 }).toString(),
    )
    await db
      .updateTable('event_types')
      .set({ buffer_before_minutes: 10 })
      .where('id', '=', eventTypeId)
      .execute()

    await expectsRefusal(fixture, request, 'slot_unavailable')
    await db
      .updateTable('event_types')
      .set({ buffer_before_minutes: 5 })
      .where('id', '=', eventTypeId)
      .execute()
    await expect(finalizeMeetingPoll(fixture.ctx, request)).resolves.toMatchObject({
      poll: { status: 'scheduled' },
      replayed: false,
    })
  })
})
