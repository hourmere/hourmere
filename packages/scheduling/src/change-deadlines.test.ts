// Invitee change deadlines against real Postgres: the boundary instant, daylight saving days,
// the per-booking snapshot, hosts and team admins, reschedule requests, a reschedule racing
// the deadline, replays, paid bookings and group seats.
import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cancelHostBooking,
  cancelManagedBooking,
  cancelTeamBookingInTransaction,
  createPublicBooking,
  requestReschedule,
  rescheduleHostBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
import { assertInviteeChangeOpen, changeDeadline, validCutoff } from './change-deadlines.ts'
import type { PublicContext, ServiceContext } from './context.ts'
import { updateEventType } from './event-types.ts'
import { getManagedBookingDetails, listManagedSlots } from './manage.ts'
import { confirmPaymentHold, createPaymentHold } from './payments.ts'
import { createFixtures, type EventTypeFixture, type Fixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const instant = Temporal.Instant.from
const RESCHEDULE_CLOSED = { code: 'booking_reschedule_deadline_passed' }
const CANCEL_CLOSED = { code: 'booking_cancel_deadline_passed' }

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing fixture value')
  return value
}

describe('change deadline arithmetic', () => {
  it('is elapsed minutes before the start and closes at the deadline instant itself', () => {
    const start = instant('2026-11-02T09:00:00Z')
    const cutoffs = { rescheduleCutoffMinutes: 120, cancelCutoffMinutes: null }
    expect(changeDeadline(start, 120)?.toString()).toBe('2026-11-02T07:00:00Z')
    expect(changeDeadline(start, null)).toBeNull()
    expect(() =>
      assertInviteeChangeOpen('reschedule', start, cutoffs, instant('2026-11-02T06:59:59.999Z')),
    ).not.toThrow()
    expect(() =>
      assertInviteeChangeOpen('reschedule', start, cutoffs, instant('2026-11-02T07:00:00Z')),
    ).toThrow(expect.objectContaining(RESCHEDULE_CLOSED))
    // No cancel deadline: open until the start (booking_in_past is checked elsewhere).
    expect(() =>
      assertInviteeChangeOpen('cancel', start, cutoffs, instant('2026-11-02T08:59:59Z')),
    ).not.toThrow()
  })

  it('accepts null or whole minutes from 1 to one year', () => {
    expect(validCutoff(null, 'x')).toBeNull()
    expect(validCutoff(1, 'x')).toBe(1)
    expect(validCutoff(525_600, 'x')).toBe(525_600)
    for (const bad of [0, -1, 1.5, 525_601, '60', Number.NaN])
      expect(() => validCutoff(bad, 'x')).toThrow(
        expect.objectContaining({ code: 'invalid_event_type' }),
      )
  })
})

describe.skipIf(!serverUrl)('invitee change deadlines', () => {
  let owned: TestDatabase
  let db: Db
  let f: Fixtures
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    f = createFixtures(db)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(
    rules: EventTypeFixture = {},
    { timeZone = 'Europe/Berlin', at = '2026-10-29T12:00:00Z' } = {},
  ) {
    const clock = { now: instant(at) }
    const host = await f.host({ timeZone })
    await f.schedule(host.userId, { timeZone })
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      slug: 'intro',
      ...rules,
    })
    const pub: PublicContext = { db, now: () => clock.now }
    const ctx: ServiceContext = {
      ...pub,
      principal: {
        kind: 'session',
        sessionId: 'test',
        user: { id: host.userId, name: 'Host', email: 'host@example.com' },
        organization: { id: host.organizationId, name: 'Org', slug: 'org', personal: true },
      },
    }
    const book = async (start: string) => {
      const created = await createPublicBooking(pub, {
        handle: host.handle,
        slug: 'intro',
        start: instant(start),
        invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone },
      })
      return { id: created.booking.id, token: required(created.manageToken) }
    }
    const at$ = (value: string) => {
      clock.now = instant(value)
    }
    return { clock, host, eventTypeId, pub, ctx, book, at: at$ }
  }

  const snapshot = (id: string) =>
    db
      .selectFrom('bookings')
      .select(['status', 'reschedule_cutoff_minutes', 'cancel_cutoff_minutes'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  const slotRange = (from: string) => ({
    start: instant(from),
    end: instant(from).add({ hours: 24 }),
  })

  it('refuses at exactly the deadline and allows one millisecond before it', async () => {
    const s = await setup({ rescheduleCutoffMinutes: 120, cancelCutoffMinutes: 60 })
    const b = await s.book('2026-11-02T09:00:00Z')
    expect((await getManagedBookingDetails(s.pub, b.token)).changeDeadlines).toEqual({
      rescheduleBy: '2026-11-02T07:00:00.000Z',
      cancelBy: '2026-11-02T08:00:00.000Z',
    })

    s.at('2026-11-02T07:00:00Z')
    await expect(
      listManagedSlots(s.pub, b.token, slotRange('2026-11-02T00:00:00Z')),
    ).rejects.toMatchObject(RESCHEDULE_CLOSED)
    await expect(
      rescheduleManagedBooking(s.pub, b.token, { start: instant('2026-11-02T10:00:00Z') }),
    ).rejects.toMatchObject(RESCHEDULE_CLOSED)
    expect((await snapshot(b.id)).status).toBe('confirmed')

    s.at('2026-11-02T06:59:59.999Z')
    await expect(
      listManagedSlots(s.pub, b.token, slotRange('2026-11-02T00:00:00Z')),
    ).resolves.not.toHaveLength(0)
    const moved = await rescheduleManagedBooking(s.pub, b.token, {
      start: instant('2026-11-02T10:00:00Z'),
    })
    const next = required(moved.manageToken)

    // Cancel: its own deadline is one hour before the new start.
    s.at('2026-11-02T09:00:00Z')
    await expect(cancelManagedBooking(s.pub, next)).rejects.toMatchObject(CANCEL_CLOSED)
    s.at('2026-11-02T08:59:59.999Z')
    await expect(cancelManagedBooking(s.pub, next)).resolves.toMatchObject({
      status: 'cancelled',
    })
  })

  it('keeps the two deadlines independent', async () => {
    const s = await setup({ rescheduleCutoffMinutes: 2880, cancelCutoffMinutes: 60 })
    const b = await s.book('2026-11-02T09:00:00Z')
    s.at('2026-11-01T12:00:00Z')
    await expect(
      rescheduleManagedBooking(s.pub, b.token, { start: instant('2026-11-02T10:00:00Z') }),
    ).rejects.toMatchObject(RESCHEDULE_CLOSED)
    await expect(cancelManagedBooking(s.pub, b.token)).resolves.toMatchObject({
      status: 'cancelled',
    })

    const open = await setup({ rescheduleCutoffMinutes: null, cancelCutoffMinutes: 2880 })
    const c = await open.book('2026-11-02T09:00:00Z')
    open.at('2026-11-01T12:00:00Z')
    await expect(cancelManagedBooking(open.pub, c.token)).rejects.toMatchObject(CANCEL_CLOSED)
    await expect(
      rescheduleManagedBooking(open.pub, c.token, { start: instant('2026-11-02T10:00:00Z') }),
    ).resolves.toHaveProperty('manageToken')
  })

  it('counts elapsed minutes across both daylight saving changes', async () => {
    // Spring forward in Los Angeles: 2027-03-14. Monday 09:00 PDT is 16:00Z; 48 hours
    // earlier is Saturday 08:00 PST, not 09:00 local.
    const spring = await setup(
      { rescheduleCutoffMinutes: 2880, cancelCutoffMinutes: 2880 },
      { timeZone: 'America/Los_Angeles', at: '2027-03-10T12:00:00Z' },
    )
    const a = await spring.book('2027-03-15T16:00:00Z')
    expect((await getManagedBookingDetails(spring.pub, a.token)).changeDeadlines).toEqual({
      rescheduleBy: '2027-03-13T16:00:00.000Z',
      cancelBy: '2027-03-13T16:00:00.000Z',
    })
    spring.at('2027-03-13T15:59:59.999Z')
    await expect(
      listManagedSlots(spring.pub, a.token, slotRange('2027-03-15T00:00:00Z')),
    ).resolves.not.toHaveLength(0)
    spring.at('2027-03-13T16:00:00Z')
    await expect(cancelManagedBooking(spring.pub, a.token)).rejects.toMatchObject(CANCEL_CLOSED)

    // Fall back: 2026-11-01. Monday 09:00 PST is 17:00Z; 48 hours earlier is Saturday
    // 10:00 PDT.
    const fall = await setup(
      { rescheduleCutoffMinutes: 2880, cancelCutoffMinutes: 2880 },
      { timeZone: 'America/Los_Angeles', at: '2026-10-28T12:00:00Z' },
    )
    const b = await fall.book('2026-11-02T17:00:00Z')
    expect((await getManagedBookingDetails(fall.pub, b.token)).changeDeadlines.rescheduleBy).toBe(
      '2026-10-31T17:00:00.000Z',
    )
    fall.at('2026-10-31T17:00:00Z')
    await expect(
      rescheduleManagedBooking(fall.pub, b.token, { start: instant('2026-11-02T18:00:00Z') }),
    ).rejects.toMatchObject(RESCHEDULE_CLOSED)
    fall.at('2026-10-31T16:59:59.999Z')
    await expect(cancelManagedBooking(fall.pub, b.token)).resolves.toMatchObject({
      status: 'cancelled',
    })
  })

  it('keeps the deadlines each booking was booked with when the event type changes', async () => {
    const s = await setup()
    const before = await s.book('2026-11-02T09:00:00Z')
    await updateEventType(s.ctx, s.eventTypeId, {
      rescheduleCutoffMinutes: 1440,
      cancelCutoffMinutes: 600,
    })
    const after = await s.book('2026-11-02T11:00:00Z')
    expect(await snapshot(before.id)).toMatchObject({
      reschedule_cutoff_minutes: null,
      cancel_cutoff_minutes: null,
    })
    expect(await snapshot(after.id)).toMatchObject({
      reschedule_cutoff_minutes: 1440,
      cancel_cutoff_minutes: 600,
    })

    s.at('2026-11-02T08:00:00Z')
    // Booked before the change: still changeable until it starts.
    expect((await getManagedBookingDetails(s.pub, before.token)).changeDeadlines).toEqual({
      rescheduleBy: null,
      cancelBy: null,
    })
    const moved = await rescheduleManagedBooking(s.pub, before.token, {
      start: instant('2026-11-02T13:00:00Z'),
    })
    // Its successor keeps "no deadline" although the event type now has one.
    expect(await snapshot(moved.booking.id)).toMatchObject({
      reschedule_cutoff_minutes: null,
      cancel_cutoff_minutes: null,
    })
    // Booked after the change: closed.
    await expect(cancelManagedBooking(s.pub, after.token)).rejects.toMatchObject(CANCEL_CLOSED)

    // Removing the deadline later does not reopen a booking made under it.
    await updateEventType(s.ctx, s.eventTypeId, {
      rescheduleCutoffMinutes: null,
      cancelCutoffMinutes: null,
    })
    await expect(
      rescheduleManagedBooking(s.pub, after.token, { start: instant('2026-11-02T14:00:00Z') }),
    ).rejects.toMatchObject(RESCHEDULE_CLOSED)
    expect(await snapshot(after.id)).toMatchObject({ status: 'confirmed' })
  })

  it('carries the deadlines along a reschedule and counts them from the new start', async () => {
    const s = await setup({ rescheduleCutoffMinutes: 1440, cancelCutoffMinutes: 1440 })
    const b = await s.book('2026-11-05T09:00:00Z')
    s.at('2026-11-02T08:00:00Z')
    // Minimum notice (0) decides where it may go: a time already inside its own deadline.
    const moved = await rescheduleManagedBooking(s.pub, b.token, {
      start: instant('2026-11-02T10:00:00Z'),
    })
    const next = required(moved.manageToken)
    expect(await snapshot(moved.booking.id)).toMatchObject({
      reschedule_cutoff_minutes: 1440,
      cancel_cutoff_minutes: 1440,
    })
    expect((await getManagedBookingDetails(s.pub, next)).changeDeadlines).toEqual({
      rescheduleBy: '2026-11-01T10:00:00.000Z',
      cancelBy: '2026-11-01T10:00:00.000Z',
    })
    // The booking now inside its deadline can no longer be moved or cancelled by the invitee.
    await expect(
      rescheduleManagedBooking(s.pub, next, { start: instant('2026-11-02T11:00:00Z') }),
    ).rejects.toMatchObject(RESCHEDULE_CLOSED)
    await expect(cancelManagedBooking(s.pub, next)).rejects.toMatchObject(CANCEL_CLOSED)
  })

  it('never limits hosts or team admins, and a host move keeps the snapshot', async () => {
    const s = await setup({ rescheduleCutoffMinutes: 1440, cancelCutoffMinutes: 1440 })
    const b = await s.book('2026-11-02T09:00:00Z')
    s.at('2026-11-02T08:00:00Z')
    const moved = await rescheduleHostBooking(s.ctx, b.id, {
      start: instant('2026-11-02T10:00:00Z'),
    })
    expect(moved.manageToken).toBeNull()
    expect(await snapshot(moved.booking.id)).toMatchObject({
      reschedule_cutoff_minutes: 1440,
      cancel_cutoff_minutes: 1440,
    })
    // The invitee's link follows the host move and is still closed.
    await expect(cancelManagedBooking(s.pub, b.token)).rejects.toMatchObject(CANCEL_CLOSED)
    await expect(cancelHostBooking(s.ctx, moved.booking.id)).resolves.toMatchObject({
      status: 'cancelled',
    })

    const team = await s.book('2026-11-02T13:00:00Z')
    await db
      .transaction()
      .execute((trx) =>
        cancelTeamBookingInTransaction(
          trx,
          { userId: s.host.userId, organizationId: s.host.organizationId },
          team.id,
          s.pub.now,
        ),
      )
    expect((await snapshot(team.id)).status).toBe('cancelled')
  })

  it('caps reschedule requests at the deadline, refuses them after it, and fences answers', async () => {
    const s = await setup({ rescheduleCutoffMinutes: 60, cancelCutoffMinutes: 600 })
    const b = await s.book('2026-11-02T09:00:00Z')
    s.at('2026-11-02T00:00:00Z')
    const requested = await requestReschedule(s.ctx, b.id, { idempotencyKey: randomUUID() })
    const request = required(requested.pendingReschedule)
    // 48 hours would be later than the deadline, one hour before the start.
    expect(request.expiresAt).toBe('2026-11-02T08:00:00.000Z')

    // Cancelling while the request is open but after the cancel deadline is refused.
    await expect(
      cancelManagedBooking(s.pub, b.token, { rescheduleRequestId: request.id }),
    ).rejects.toMatchObject(CANCEL_CLOSED)

    // At the deadline the request is closed: the answer cannot move the booking.
    s.at('2026-11-02T08:00:00Z')
    await expect(
      rescheduleManagedBooking(s.pub, b.token, {
        start: instant('2026-11-02T10:00:00Z'),
        rescheduleRequestId: request.id,
      }),
    ).rejects.toMatchObject({ code: 'reschedule_request_changed' })
    expect((await snapshot(b.id)).status).toBe('confirmed')
    // A new request would be unanswerable.
    await expect(
      requestReschedule(s.ctx, b.id, { idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject(RESCHEDULE_CLOSED)
  })

  it('replays an answer made before the deadline after it has passed', async () => {
    const s = await setup({ rescheduleCutoffMinutes: 60, cancelCutoffMinutes: 60 })
    const b = await s.book('2026-11-02T09:00:00Z')
    s.at('2026-11-02T00:00:00Z')
    const request = required(
      (await requestReschedule(s.ctx, b.id, { idempotencyKey: randomUUID() })).pendingReschedule,
    )
    const answer = { start: instant('2026-11-02T10:00:00Z'), rescheduleRequestId: request.id }
    const first = await rescheduleManagedBooking(s.pub, b.token, answer)
    s.at('2026-11-02T09:30:00Z')
    await expect(rescheduleManagedBooking(s.pub, b.token, answer)).resolves.toMatchObject({
      booking: { id: first.booking.id },
      manageToken: null,
    })

    // A cancel answer replays too.
    const c = await s.book('2026-11-02T13:00:00Z')
    s.at('2026-11-02T00:00:00Z')
    const second = required(
      (await requestReschedule(s.ctx, c.id, { idempotencyKey: randomUUID() })).pendingReschedule,
    )
    await cancelManagedBooking(s.pub, c.token, { rescheduleRequestId: second.id })
    s.at('2026-11-02T12:30:00Z')
    await expect(
      cancelManagedBooking(s.pub, c.token, { rescheduleRequestId: second.id }),
    ).resolves.toMatchObject({ id: c.id, status: 'cancelled' })
  })

  it('decides with the clock read after the locks when a change races the deadline', async () => {
    const s = await setup({ rescheduleCutoffMinutes: 60, cancelCutoffMinutes: 60 })
    // A reschedule also waits for the event type row (a settings save can hold it).
    for (const [kind, held, at] of [
      ['reschedule', 'bookings', '2026-11-02T09:00:00Z'],
      ['reschedule', 'event_types', '2026-11-03T09:00:00Z'],
      ['cancel', 'bookings', '2026-11-02T13:00:00Z'],
    ] as const) {
      s.at('2026-10-29T12:00:00Z')
      const b = await s.book(at)
      const start = instant(at)
      s.clock.now = start.subtract({ minutes: 61 })
      const blocker = await owned.pool.connect()
      try {
        await blocker.query('BEGIN')
        await blocker.query(`SELECT id FROM ${held} WHERE id = $1 FOR UPDATE`, [
          held === 'bookings' ? b.id : s.eventTypeId,
        ])
        const pending =
          kind === 'reschedule'
            ? rescheduleManagedBooking(s.pub, b.token, { start: start.add({ hours: 2 }) })
            : cancelManagedBooking(s.pub, b.token)
        const settled = pending.then(
          () => 'done',
          (error: unknown) => error,
        )
        // Wait until the change is queued behind the row lock.
        for (let i = 0; i < 200; i++) {
          const { rows } = await owned.pool.query<{ waiting: number }>(
            `SELECT count(*)::int AS waiting FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          )
          if ((rows[0]?.waiting ?? 0) > 0) break
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        // The deadline passes while it waits.
        s.clock.now = start.subtract({ minutes: 60 })
        await blocker.query('COMMIT')
        expect(await settled).toMatchObject(
          kind === 'reschedule' ? RESCHEDULE_CLOSED : CANCEL_CLOSED,
        )
      } finally {
        await blocker.query('ROLLBACK').catch(() => {})
        blocker.release()
      }
      expect((await snapshot(b.id)).status).toBe('confirmed')
    }
  })

  it('answers unknown links with booking_not_found and cancelled or started ones as before', async () => {
    const s = await setup({ rescheduleCutoffMinutes: 600, cancelCutoffMinutes: 600 })
    const b = await s.book('2026-11-02T09:00:00Z')
    s.at('2026-11-02T08:00:00Z')
    const unknown = 'A'.repeat(43)
    for (const token of [unknown, 'short', undefined]) {
      await expect(cancelManagedBooking(s.pub, token)).rejects.toMatchObject({
        code: 'booking_not_found',
      })
      await expect(
        rescheduleManagedBooking(s.pub, token, { start: instant('2026-11-02T10:00:00Z') }),
      ).rejects.toMatchObject({ code: 'booking_not_found' })
      await expect(
        listManagedSlots(s.pub, token, slotRange('2026-11-02T00:00:00Z')),
      ).rejects.toMatchObject({ code: 'booking_not_found' })
    }
    // The denial carries a constant message and nothing about the booking.
    const denial = await cancelManagedBooking(s.pub, b.token).catch((error: unknown) => error)
    expect(denial).toMatchObject({
      code: 'booking_cancel_deadline_passed',
      detail:
        'The deadline for cancelling this booking online has passed. Contact the host to cancel it.',
    })
    // Precedence: a cancelled booking still says booking_cancelled, a started one
    // booking_in_past.
    await cancelHostBooking(s.ctx, b.id)
    await expect(cancelManagedBooking(s.pub, b.token)).rejects.toMatchObject({
      code: 'booking_cancelled',
    })
    const c = await s.book('2026-11-02T13:00:00Z')
    s.at('2026-11-02T13:00:00Z')
    await expect(cancelManagedBooking(s.pub, c.token)).rejects.toMatchObject({
      code: 'booking_in_past',
    })
  })

  it('stores the snapshot on paid holds, whose management stays unavailable', async () => {
    // Payment holds read the database clock, so book a real future Monday.
    const today = Temporal.Now.zonedDateTimeISO('UTC').toPlainDate()
    const monday = today.add({ days: 14 - (today.dayOfWeek - 1) })
    const start = Temporal.ZonedDateTime.from({
      timeZone: 'UTC',
      year: monday.year,
      month: monday.month,
      day: monday.day,
      hour: 9,
    }).toInstant()
    const s = await setup(
      { rescheduleCutoffMinutes: 1440, cancelCutoffMinutes: 720 },
      { at: Temporal.Now.instant().toString() },
    )
    s.clock.now = Temporal.Now.instant()
    const hold = await createPaymentHold(
      { ...s.pub, now: () => Temporal.Now.instant(), paidBookingsEnabled: true },
      {
        handle: s.host.handle,
        slug: 'intro',
        start,
        invitee: { name: 'Payer', email: 'payer@example.com', timeZone: 'UTC' },
        idempotencyKey: randomUUID(),
      },
    )
    expect(await snapshot(hold.id)).toMatchObject({
      reschedule_cutoff_minutes: 1440,
      cancel_cutoff_minutes: 720,
    })
    await confirmPaymentHold({ ...s.pub, paidBookingsEnabled: true }, hold.id, 'pi_test123')
    s.clock.now = start.subtract({ minutes: 60 })
    await expect(cancelHostBooking(s.ctx, hold.id)).rejects.toMatchObject({
      code: 'paid_booking_management_unavailable',
    })
  })

  it('keeps a deadline per group seat and refuses only real invitee seat moves', async () => {
    const s = await setup({ rescheduleCutoffMinutes: 600, cancelCutoffMinutes: 600 })
    await db
      .updateTable('event_types')
      .set({ booking_mode: 'group', group_capacity: 3 })
      .where('id', '=', s.eventTypeId)
      .execute()
    const seat = async (email: string) => {
      const created = await createPublicBooking(s.pub, {
        handle: s.host.handle,
        slug: 'intro',
        start: instant('2026-11-02T09:00:00Z'),
        invitee: { name: email, email, timeZone: 'UTC' },
        idempotencyKey: randomUUID(),
      })
      return { id: created.booking.id, token: required(created.manageToken) }
    }
    const a = await seat('a@example.com')
    const b = await seat('b@example.com')
    expect(await snapshot(a.id)).toMatchObject({
      reschedule_cutoff_minutes: 600,
      cancel_cutoff_minutes: 600,
    })

    s.at('2026-11-01T12:00:00Z')
    const key = randomUUID()
    const moved = await rescheduleManagedBooking(s.pub, a.token, {
      start: instant('2026-11-02T10:00:00Z'),
      idempotencyKey: key,
    })
    expect(await snapshot(moved.booking.id)).toMatchObject({
      reschedule_cutoff_minutes: 600,
      cancel_cutoff_minutes: 600,
    })

    s.at('2026-11-02T08:00:00Z')
    // The same seat move replays after the deadline.
    await expect(
      rescheduleManagedBooking(s.pub, a.token, {
        start: instant('2026-11-02T10:00:00Z'),
        idempotencyKey: key,
      }),
    ).resolves.toMatchObject({ booking: { id: moved.booking.id } })
    // A real move of another seat is refused; a "move" to its own time changes nothing.
    await expect(
      rescheduleManagedBooking(s.pub, b.token, {
        start: instant('2026-11-02T10:00:00Z'),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject(RESCHEDULE_CLOSED)
    await expect(
      rescheduleManagedBooking(s.pub, b.token, {
        start: instant('2026-11-02T09:00:00Z'),
        idempotencyKey: randomUUID(),
      }),
    ).resolves.toMatchObject({ booking: { id: b.id } })
    await expect(cancelManagedBooking(s.pub, b.token)).rejects.toMatchObject(CANCEL_CLOSED)
    // The host may still cancel the seat.
    await expect(cancelHostBooking(s.ctx, b.id)).resolves.toMatchObject({ status: 'cancelled' })
  })
})
