// What an invitee's request email link reports, and what answering a request releases.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cancelHostBooking,
  cancelManagedBooking,
  createPublicBooking,
  expireRescheduleRequest,
  requestReschedule,
  rescheduleHostBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
import type { BookingEvent, PublicContext, ServiceContext } from './context.ts'
import { getManagedBookingDetails } from './manage.ts'
import { createFixtures } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const instant = Temporal.Instant.from
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('Missing fixture')
  return value
}

describe.skipIf(!serverUrl)('reschedule request links for invitees', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(start = '2026-11-02T09:00:00Z', at = '2026-11-01T12:00:00Z') {
    const clock = { now: instant(at) }
    const f = createFixtures(db)
    const host = await f.host()
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, { slug: 'intro' })
    const events: BookingEvent[] = []
    const pub: PublicContext = {
      db,
      now: () => clock.now,
      notify: async (_trx, event) => {
        events.push(event)
      },
    }
    const ctx: ServiceContext = {
      ...pub,
      principal: {
        kind: 'session',
        sessionId: 'test',
        user: { id: host.userId, name: 'Host', email: 'host@example.com' },
        organization: { id: host.organizationId, name: 'Org', slug: 'org', personal: true },
      },
    }
    const created = await createPublicBooking(pub, {
      handle: host.handle,
      slug: 'intro',
      start: instant(start),
      invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'Europe/Berlin' },
    })
    const request = async (idempotencyKey = randomUUID()) =>
      required(
        (await requestReschedule(ctx, created.booking.id, { idempotencyKey })).pendingReschedule,
      ).id
    return { clock, host, events, pub, ctx, created, request }
  }

  /** The token a reschedule request email carries, as the notification sender stores it. */
  async function emailToken(bookingId: string, requestId: string, kind = 'reschedule_requested') {
    const token = randomBytes(32).toString('base64url')
    const attendee = await db
      .selectFrom('booking_attendees')
      .select('id')
      .where('booking_id', '=', bookingId)
      .where('is_booker', '=', true)
      .executeTakeFirstOrThrow()
    await db
      .insertInto('booking_notifications')
      .values({
        booking_id: bookingId,
        kind,
        message_key: kind === 'confirmed' ? '' : requestId,
        recipient: `attendee:${attendee.id}`,
        manage_token_hash: createHash('sha256').update(token).digest(),
      })
      .execute()
    return token
  }

  const state = async (pub: PublicContext, token: string) =>
    (await getManagedBookingDetails(pub, token)).rescheduleRequest

  const requestRow = (id: string) =>
    db
      .selectFrom('booking_reschedule_requests')
      .select(['state', 'picked_booking_id'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  it('reports only the request email link’s own request: pending, replaced and expired', async () => {
    const s = await setup()
    const first = await s.request()
    const firstLink = await emailToken(s.created.booking.id, first)
    expect(await state(s.pub, firstLink)).toEqual({ id: first, state: 'pending' })
    // Other links of the same booking say nothing about requests beyond pendingReschedule.
    const own = await getManagedBookingDetails(s.pub, required(s.created.manageToken))
    expect(own.pendingReschedule?.id).toBe(first)
    expect(own).not.toHaveProperty('rescheduleRequest')
    const confirmation = await emailToken(s.created.booking.id, first, 'confirmed')
    expect(await getManagedBookingDetails(s.pub, confirmation)).not.toHaveProperty(
      'rescheduleRequest',
    )
    // Only the request email names its request, even if another kind carried the same key.
    const notice = await emailToken(s.created.booking.id, first, 'reschedule_request_expired')
    expect(await getManagedBookingDetails(s.pub, notice)).not.toHaveProperty('rescheduleRequest')

    const second = await s.request()
    const secondLink = await emailToken(s.created.booking.id, second)
    const replaced = await getManagedBookingDetails(s.pub, firstLink)
    expect(replaced.rescheduleRequest).toEqual({ id: first, state: 'replaced' })
    expect(replaced.pendingReschedule?.id).toBe(second)
    expect(await state(s.pub, secondLink)).toEqual({ id: second, state: 'pending' })

    // A notification about another booking never reveals this booking's request.
    const other = await setup()
    const forged = await emailToken(other.created.booking.id, second)
    expect(await getManagedBookingDetails(other.pub, forged)).not.toHaveProperty(
      'rescheduleRequest',
    )

    // The deadline closes the request before the expiry job runs, and after it.
    s.clock.now = instant(s.created.booking.start).subtract({ milliseconds: 1 })
    expect(await state(s.pub, secondLink)).toEqual({ id: second, state: 'pending' })
    s.clock.now = instant(s.created.booking.start)
    const expired = await getManagedBookingDetails(s.pub, secondLink)
    expect(expired.rescheduleRequest).toEqual({ id: second, state: 'expired' })
    expect(expired.pendingReschedule).toBeUndefined()
    expect(expired.status).toBe('confirmed')
    await expireRescheduleRequest(s.pub, second)
    expect(await requestRow(second)).toMatchObject({ state: 'expired' })
    expect(await state(s.pub, secondLink)).toEqual({ id: second, state: 'expired' })
    expect(await state(s.pub, firstLink)).toEqual({ id: first, state: 'replaced' })
  })

  it('reports rescheduled after an invitee pick or a host move, and cancelled after either cancel', async () => {
    const picked = await setup()
    const pickedId = await picked.request()
    const pickedLink = await emailToken(picked.created.booking.id, pickedId)
    const moved = await rescheduleManagedBooking(picked.pub, pickedLink, {
      start: instant('2026-11-02T10:00:00Z'),
      rescheduleRequestId: pickedId,
    })
    const afterPick = await getManagedBookingDetails(picked.pub, pickedLink)
    expect(afterPick.id).toBe(moved.booking.id)
    expect(afterPick.rescheduleRequest).toEqual({ id: pickedId, state: 'rescheduled' })

    const hostMoved = await setup()
    const hostMovedId = await hostMoved.request()
    const hostMovedLink = await emailToken(hostMoved.created.booking.id, hostMovedId)
    const successor = await rescheduleHostBooking(hostMoved.ctx, hostMoved.created.booking.id, {
      start: instant('2026-11-02T11:00:00Z'),
    })
    const afterHostMove = await getManagedBookingDetails(hostMoved.pub, hostMovedLink)
    expect(afterHostMove.id).toBe(successor.booking.id)
    expect(afterHostMove.rescheduleRequest).toEqual({ id: hostMovedId, state: 'rescheduled' })

    for (const by of ['host', 'invitee'] as const) {
      const s = await setup()
      const id = await s.request()
      const link = await emailToken(s.created.booking.id, id)
      if (by === 'host') await cancelHostBooking(s.ctx, s.created.booking.id)
      else await cancelManagedBooking(s.pub, link, { rescheduleRequestId: id })
      const cancelled = await getManagedBookingDetails(s.pub, link)
      expect(cancelled.status).toBe('cancelled')
      expect(cancelled.rescheduleRequest).toEqual({ id, state: 'cancelled' })
    }
  })

  it('reports a move made after the request closed instead of the older state', async () => {
    const expired = await setup('2026-11-06T09:00:00Z')
    const expiredId = await expired.request()
    const expiredLink = await emailToken(expired.created.booking.id, expiredId)
    expired.clock.now = instant('2026-11-03T12:00:00Z')
    await expireRescheduleRequest(expired.pub, expiredId)
    expect(await state(expired.pub, expiredLink)).toEqual({ id: expiredId, state: 'expired' })
    const hostMove = await rescheduleHostBooking(expired.ctx, expired.created.booking.id, {
      start: instant('2026-11-06T10:00:00Z'),
    })
    const afterHostMove = await getManagedBookingDetails(expired.pub, expiredLink)
    expect(afterHostMove.id).toBe(hostMove.booking.id)
    expect(afterHostMove.rescheduleRequest).toEqual({ id: expiredId, state: 'rescheduled' })
    expect(await requestRow(expiredId)).toMatchObject({ state: 'expired' })

    const replaced = await setup()
    const replacedId = await replaced.request()
    const replacedLink = await emailToken(replaced.created.booking.id, replacedId)
    await replaced.request()
    // An ordinary move through the booking's own link answers the newer request.
    const own = await rescheduleManagedBooking(
      replaced.pub,
      required(replaced.created.manageToken),
      { start: instant('2026-11-02T10:00:00Z') },
    )
    const afterOwnMove = await getManagedBookingDetails(replaced.pub, replacedLink)
    expect(afterOwnMove.id).toBe(own.booking.id)
    expect(afterOwnMove.rescheduleRequest).toEqual({ id: replacedId, state: 'rescheduled' })
  })

  it('decides the pending request and the link state at one instant', async () => {
    const s = await setup()
    const id = await s.request()
    const link = await emailToken(s.created.booking.id, id)
    const deadline = instant(s.created.booking.start)
    // Every later reading of this clock is at the deadline.
    let first = true
    const advancing: PublicContext = {
      ...s.pub,
      now: () => {
        const at = first ? deadline.subtract({ milliseconds: 1 }) : deadline
        first = false
        return at
      },
    }
    const details = await getManagedBookingDetails(advancing, link)
    expect(details.pendingReschedule?.id).toBe(id)
    expect(details.rescheduleRequest).toEqual({ id, state: 'pending' })
  })

  it('frees the original time, its host block and its reminders when the invitee picks', async () => {
    const s = await setup()
    const original = s.created.booking
    await db
      .insertInto('booking_scheduled_messages')
      .values({
        booking_id: original.id,
        organization_id: s.host.organizationId,
        kind: 'reminder',
        rule_id: 'day-before',
        anchor_start_at: original.start,
        anchor_end_at: original.end,
        due_at: instant(original.start).subtract({ hours: 24 }).toString(),
        expires_at: original.start,
        next_attempt_at: instant(original.start).subtract({ hours: 24 }).toString(),
      })
      .execute()
    const other = (start: string) =>
      createPublicBooking(s.pub, {
        handle: s.host.handle,
        slug: 'intro',
        start: instant(start),
        invitee: { name: 'Other', email: 'other@example.com', timeZone: 'UTC' },
      })
    const id = await s.request()
    // While the request is open, the original time stays booked.
    await expect(other(original.start)).rejects.toMatchObject({ kind: 'conflict' })
    const moved = await rescheduleManagedBooking(s.pub, required(s.created.manageToken), {
      start: instant('2026-11-02T10:00:00Z'),
      rescheduleRequestId: id,
    })
    expect(
      await db
        .selectFrom('booking_hosts')
        .select('active')
        .where('booking_id', '=', original.id)
        .execute(),
    ).toEqual([{ active: false }])
    expect(
      await db
        .selectFrom('booking_scheduled_messages')
        .select(['state', 'skip_reason'])
        .where('booking_id', '=', original.id)
        .execute(),
    ).toEqual([{ state: 'skipped', skip_reason: 'booking_replaced' }])
    // Calendar copies, meeting links and the new reminders follow this event.
    expect(s.events).toContainEqual(
      expect.objectContaining({ type: 'rescheduled', bookingId: moved.booking.id }),
    )
    expect(await requestRow(id)).toEqual({ state: 'picked', picked_booking_id: moved.booking.id })
    const rebooked = await other(original.start)
    expect(rebooked.booking).toMatchObject({ status: 'confirmed', start: original.start })
  })

  it('refuses an answer to a replaced or expired request and keeps the original booking', async () => {
    const s = await setup()
    const first = await s.request()
    const second = await s.request()
    const token = required(s.created.manageToken)
    const pick = (rescheduleRequestId: string) =>
      rescheduleManagedBooking(s.pub, token, {
        start: instant('2026-11-02T10:00:00Z'),
        rescheduleRequestId,
      })
    await expect(pick(first)).rejects.toMatchObject({ code: 'reschedule_request_changed' })
    await expect(
      cancelManagedBooking(s.pub, token, { rescheduleRequestId: first }),
    ).rejects.toMatchObject({ code: 'reschedule_request_changed' })
    expect(await requestRow(second)).toMatchObject({ state: 'pending' })

    s.clock.now = instant(s.created.booking.start)
    await expect(pick(second)).rejects.toMatchObject({ code: 'reschedule_request_changed' })
    await expect(
      cancelManagedBooking(s.pub, token, { rescheduleRequestId: second }),
    ).rejects.toMatchObject({ code: 'reschedule_request_changed' })
    expect(
      await db
        .selectFrom('bookings')
        .select(['id', 'status'])
        .where('organization_id', '=', s.host.organizationId)
        .execute(),
    ).toEqual([{ id: s.created.booking.id, status: 'confirmed' }])
  })

  it('replays a request and a pick with the same keys without a second outcome', async () => {
    const s = await setup()
    const key = randomUUID()
    const id = await s.request(key)
    const link = await emailToken(s.created.booking.id, id)
    expect(await s.request(key)).toBe(id)
    expect(s.events.filter((e) => e.type === 'reschedule_requested')).toHaveLength(1)
    const start = instant('2026-11-02T10:00:00Z')
    const first = await rescheduleManagedBooking(s.pub, link, { start, rescheduleRequestId: id })
    const replay = await rescheduleManagedBooking(s.pub, link, { start, rescheduleRequestId: id })
    expect(replay).toEqual({ booking: first.booking, manageToken: null })
    expect(s.events.filter((e) => e.type === 'rescheduled')).toHaveLength(1)
    await expect(
      rescheduleManagedBooking(s.pub, link, {
        start: instant('2026-11-02T11:00:00Z'),
        rescheduleRequestId: id,
      }),
    ).rejects.toMatchObject({ code: 'reschedule_request_changed' })
    // Replaying the host's request after the answer creates nothing new.
    await requestReschedule(s.ctx, s.created.booking.id, { idempotencyKey: key })
    expect(
      await db
        .selectFrom('booking_reschedule_requests')
        .select('id')
        .where('booking_id', 'in', [s.created.booking.id, first.booking.id])
        .execute(),
    ).toEqual([{ id }])
    expect(await state(s.pub, link)).toEqual({ id, state: 'rescheduled' })
  })

  it('resolves a pick racing a host move or the expiry to exactly one outcome', async () => {
    for (let round = 0; round < 20; round++) {
      const s = await setup()
      const id = await s.request()
      const link = await emailToken(s.created.booking.id, id)
      const race = await Promise.allSettled([
        rescheduleManagedBooking(s.pub, required(s.created.manageToken), {
          start: instant('2026-11-02T10:00:00Z'),
          rescheduleRequestId: id,
        }),
        rescheduleHostBooking(s.ctx, s.created.booking.id, {
          start: instant('2026-11-02T11:00:00Z'),
        }),
      ])
      expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const loser = race.find((r) => r.status === 'rejected')
      expect(loser?.reason).toMatchObject({
        code: race[0].status === 'rejected' ? 'reschedule_request_changed' : 'booking_cancelled',
      })
      expect(
        await db
          .selectFrom('bookings')
          .select('start_at')
          .where('rescheduled_from_id', '=', s.created.booking.id)
          .execute(),
      ).toHaveLength(1)
      expect(await requestRow(id)).toMatchObject({ state: 'picked' })
      expect(await state(s.pub, link)).toEqual({ id, state: 'rescheduled' })

      const e = await setup('2026-11-06T09:00:00Z')
      const expiring = await e.request()
      const expiringLink = await emailToken(e.created.booking.id, expiring)
      const deadline = { ...e.pub, now: () => instant('2026-11-03T12:00:00Z') }
      const outcome = await Promise.allSettled([
        rescheduleManagedBooking(e.pub, required(e.created.manageToken), {
          start: instant('2026-11-06T10:00:00Z'),
          rescheduleRequestId: expiring,
        }),
        expireRescheduleRequest(deadline, expiring),
      ])
      const terminal = await requestRow(expiring)
      expect(outcome[0].status).toBe(terminal.state === 'picked' ? 'fulfilled' : 'rejected')
      expect(await state(deadline, expiringLink)).toEqual({
        id: expiring,
        state: terminal.state === 'picked' ? 'rescheduled' : 'expired',
      })
    }
  }, 120000)

  it('caps 48 elapsed hours by the meeting start across the Berlin fall-back', async () => {
    // Berlin leaves summer time at 2026-10-25T01:00Z. 48 wall-clock hours from 14:00 CEST
    // would end at 13:00Z; 48 elapsed hours end at 12:00Z.
    const asked = '2026-10-24T12:00:00Z'
    const late = await setup('2026-10-26T12:30:00Z', asked)
    const lateId = await late.request()
    const lateLink = await emailToken(late.created.booking.id, lateId)
    const early = await setup('2026-10-26T08:00:00Z', asked)
    const earlyId = await early.request()
    const earlyLink = await emailToken(early.created.booking.id, earlyId)
    for (const [s, link, id, expiresAt] of [
      [late, lateLink, lateId, '2026-10-26T12:00:00.000Z'],
      [early, earlyLink, earlyId, '2026-10-26T08:00:00.000Z'],
    ] as const) {
      const pending = await getManagedBookingDetails(s.pub, link)
      expect(pending.pendingReschedule?.expiresAt).toBe(expiresAt)
      s.clock.now = instant(expiresAt).subtract({ milliseconds: 1 })
      expect(await state(s.pub, link)).toEqual({ id, state: 'pending' })
      s.clock.now = instant(expiresAt)
      const closed = await getManagedBookingDetails(s.pub, link)
      expect(closed.rescheduleRequest).toEqual({ id, state: 'expired' })
      expect(closed.pendingReschedule).toBeUndefined()
      await expect(
        rescheduleManagedBooking(s.pub, link, {
          start: instant('2026-10-27T10:00:00Z'),
          rescheduleRequestId: id,
        }),
      ).rejects.toMatchObject({ code: 'reschedule_request_changed' })
    }
    expect(
      instant('2026-10-26T12:00:00Z').since(instant(asked)).total('hours'),
      'elapsed hours, not wall-clock hours',
    ).toBe(48)
  })
})
