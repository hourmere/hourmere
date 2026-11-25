import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  cancelHostBooking,
  cancelManagedBooking,
  getHostBooking,
  newManageToken,
  requestReschedule,
  rescheduleHostBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
import type { PublicContext, ServiceContext } from './context.ts'
import { getManagedBookingDetails, listHostBookingSlots, listManagedSlots } from './manage.ts'
import { setAttendeeNoShow } from './no-show.ts'
import { checkoutSessionExpiry, FakePaymentProvider } from './payment-provider.ts'
import { createPaymentHold, recordStripePaymentEvent } from './payments.ts'
import { createFixtures, createTestUser } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const price = { amountMinor: 1250, currency: 'usd' }

describe.skipIf(!serverUrl)('confirmed paid booking lifecycle', () => {
  let owned: TestDatabase
  let db: Db

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup() {
    const fixtures = createFixtures(db)
    const host = await fixtures.host({ timeZone: 'UTC' })
    await fixtures.schedule(host.userId, { timeZone: 'UTC' })
    const eventTypeId = await fixtures.eventType(host.organizationId, host.userId, {
      slug: 'paid',
      durationMinutes: 30,
      cancelCutoffMinutes: 60,
    })
    let day = Temporal.Now.plainDateISO('UTC').add({ days: 3 })
    while (day.dayOfWeek !== 1) day = day.add({ days: 1 })
    const start = day.toZonedDateTime({ timeZone: 'UTC', plainTime: '12:00' }).toInstant()
    const provider = new FakePaymentProvider()
    const create = vi.spyOn(provider, 'createCheckout')
    const clock = { now: Temporal.Now.instant() }
    const notify = vi.fn<NonNullable<PublicContext['notify']>>(async () => {})
    // The rollout switch applies to new admission. Existing paid bookings drain normally.
    const publicCtx = { db, now: () => clock.now, paidBookingsEnabled: false, notify }
    const admission = { ...publicCtx, paymentProvider: provider, paidBookingsEnabled: true }
    const { id, expiresAt } = await createPaymentHold(
      admission,
      {
        handle: host.handle,
        slug: 'paid',
        start,
        invitee: { name: 'Invitee', email: 'invitee@example.test', timeZone: 'UTC' },
        idempotencyKey: 'lifecycle-test-hold',
      },
      price,
    )
    const paymentReference = `pi_${id.replaceAll('-', '')}`
    const hostCtx: ServiceContext = {
      ...publicCtx,
      principal: {
        kind: 'session',
        sessionId: 'test-session',
        user: { id: host.userId, name: 'Host', email: 'host@example.test' },
        organization: { id: host.organizationId, name: 'Org', slug: 'org', personal: true },
      },
    }
    const attempt = () =>
      db
        .selectFrom('payment_checkout_attempts')
        .selectAll()
        .where('booking_id', '=', id)
        .executeTakeFirstOrThrow()
    const original = await attempt()
    const observePayment = () =>
      recordStripePaymentEvent(publicCtx, provider, `evt_${randomUUID().replaceAll('-', '')}`, {
        checkout: {
          attemptId: original.id,
          bookingId: id,
          sessionId: original.session_id as string,
          expiresAtSeconds: checkoutSessionExpiry(expiresAt),
          paymentReference,
          ...price,
        },
      })
    await observePayment()
    await expect(getHostBooking(hostCtx, id)).resolves.toMatchObject({ status: 'confirmed' })
    const refunds = () =>
      db
        .selectFrom('payment_refund_obligations')
        .select(['payment_reference', 'amount_minor', 'currency', 'state'])
        .where('attempt_id', '=', original.id)
        .execute()
    const expectedRefund = {
      payment_reference: paymentReference,
      amount_minor: price.amountMinor,
      currency: price.currency,
      state: 'requested',
    }
    return {
      id,
      start,
      eventTypeId,
      clock,
      publicCtx,
      hostCtx,
      attempt,
      refunds,
      expectedRefund,
      observePayment,
      create,
    }
  }

  async function emailedToken(id: string, requestId?: string) {
    const { token, hash } = newManageToken()
    const attendee = await db
      .selectFrom('booking_attendees')
      .select('id')
      .where('booking_id', '=', id)
      .where('is_booker', '=', true)
      .executeTakeFirstOrThrow()
    await db
      .insertInto('booking_notifications')
      .values({
        booking_id: id,
        kind: requestId ? 'reschedule_requested' : 'confirmed',
        message_key: requestId ?? '',
        recipient: `attendee:${attendee.id}`,
        manage_token_hash: hash,
      })
      .execute()
    return token
  }

  it('authorizes actual cancellation actors and records one refund across host concurrency and replay', async () => {
    const { id, start, clock, publicCtx, hostCtx, refunds, expectedRefund } = await setup()
    const stranger = await createTestUser(db)
    const unauthorizedHost = {
      ...hostCtx,
      principal: { ...hostCtx.principal, user: stranger.principal.user },
    }
    await expect(cancelHostBooking(unauthorizedHost, id)).rejects.toMatchObject({
      code: 'booking_not_found',
    })
    await expect(cancelManagedBooking(publicCtx, newManageToken().token)).rejects.toMatchObject({
      code: 'booking_not_found',
    })
    const token = await emailedToken(id)
    clock.now = start.subtract({ minutes: 60 })
    await expect(cancelManagedBooking(publicCtx, token)).rejects.toMatchObject({
      code: 'booking_cancel_deadline_passed',
    })
    await expect(
      cancelHostBooking(
        {
          ...hostCtx,
          notify: async () => {
            throw new Error('Notification enqueue failed')
          },
        },
        id,
      ),
    ).rejects.toThrow('Notification enqueue failed')
    await expect(getHostBooking(hostCtx, id)).resolves.toMatchObject({ status: 'confirmed' })
    expect(await refunds()).toEqual([])

    const cancellations = await Promise.allSettled([
      cancelHostBooking(hostCtx, id),
      cancelHostBooking(hostCtx, id),
    ])
    expect(cancellations).toContainEqual({
      status: 'fulfilled',
      value: expect.objectContaining({ id, status: 'cancelled' }),
    })
    expect(cancellations).toContainEqual({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'booking_cancelled' }),
    })
    await expect(cancelManagedBooking(publicCtx, token)).rejects.toMatchObject({
      code: 'booking_cancelled',
    })
    expect(await refunds()).toEqual([expectedRefund])
    await expect(
      db.selectFrom('booking_hosts').select('active').where('booking_id', '=', id).execute(),
    ).resolves.toEqual([{ active: false }])
  })

  it('preserves the payment through moves and refunds only when the invitee cancels the current booking', async () => {
    const {
      id,
      start,
      eventTypeId,
      publicCtx,
      hostCtx,
      attempt,
      refunds,
      expectedRefund,
      observePayment,
      create,
    } = await setup()
    await db
      .updateTable('event_types')
      .set({ duration_minutes: 60, allowed_durations_minutes: [60, 90] })
      .where('id', '=', eventTypeId)
      .execute()
    const request = (await requestReschedule(hostCtx, id, { idempotencyKey: randomUUID() }))
      .pendingReschedule
    expect(request).toBeDefined()
    const requestId = request?.id as string
    const token = await emailedToken(id, requestId)
    const original = await attempt()
    const move = start.add({ hours: 24 })
    const range = { start: move, end: move.add({ minutes: 30 }) }
    await expect(
      listManagedSlots(publicCtx, token, { ...range, durationMinutes: 30 }),
    ).resolves.toHaveLength(1)
    await expect(
      listHostBookingSlots(hostCtx, id, { ...range, durationMinutes: 60 }),
    ).rejects.toMatchObject({ code: 'invalid_duration' })
    await expect(
      rescheduleHostBooking(hostCtx, id, { start: move, durationMinutes: 60 }),
    ).rejects.toMatchObject({ code: 'invalid_duration' })
    await expect(
      rescheduleManagedBooking(publicCtx, token, {
        start: move.add({ hours: 12 }),
        rescheduleRequestId: requestId,
      }),
    ).rejects.toMatchObject({ code: 'slot_unavailable' })
    expect(await attempt()).toEqual(original)
    await expect(getHostBooking(hostCtx, id)).resolves.toMatchObject({ status: 'confirmed' })
    expect(await refunds()).toEqual([])

    const first = await rescheduleManagedBooking(publicCtx, token, {
      start: move,
      durationMinutes: 30,
      rescheduleRequestId: requestId,
    })
    await expect(
      rescheduleManagedBooking(publicCtx, token, { start: move, rescheduleRequestId: requestId }),
    ).resolves.toMatchObject({ booking: { id: first.booking.id }, manageToken: null })
    const nextStart = move.add({ hours: 24 })
    await expect(
      rescheduleManagedBooking({ ...publicCtx, bookingMaxInviteeReschedules: 1 }, token, {
        start: nextStart,
      }),
    ).rejects.toMatchObject({ code: 'booking_reschedule_limit' })
    const second = await rescheduleHostBooking(hostCtx, first.booking.id, { start: nextStart })
    expect(second.booking).toMatchObject({
      status: 'confirmed',
      eventTypeId,
      rescheduledFromId: first.booking.id,
    })
    expect(Temporal.Instant.from(second.booking.end).since(nextStart).total('minutes')).toBe(30)
    expect(await attempt()).toEqual({ ...original, current_booking_id: second.booking.id })
    await observePayment()
    expect(await refunds()).toEqual([])
    await expect(getManagedBookingDetails(publicCtx, token)).resolves.toMatchObject({
      id: second.booking.id,
      eventType: { durationMinutes: 30 },
    })
    expect((await getManagedBookingDetails(publicCtx, token)).eventType).not.toHaveProperty(
      'allowedDurationsMinutes',
    )
    await expect(cancelHostBooking(hostCtx, id)).rejects.toMatchObject({
      code: 'booking_cancelled',
    })
    await expect(cancelHostBooking(hostCtx, first.booking.id)).rejects.toMatchObject({
      code: 'booking_cancelled',
    })
    const afterStart = { ...hostCtx, now: () => nextStart.add({ minutes: 1 }) }
    const detail = await getHostBooking(afterStart, second.booking.id)
    expect(detail.canManageNoShow).toBe(false)
    await expect(
      setAttendeeNoShow(afterStart, second.booking.id, detail.attendees[0]?.id as string, true),
    ).rejects.toMatchObject({ code: 'paid_booking_management_unavailable' })
    expect(await refunds()).toEqual([])

    await expect(cancelManagedBooking(publicCtx, token)).resolves.toMatchObject({
      id: second.booking.id,
      status: 'cancelled',
    })
    expect(await refunds()).toEqual([expectedRefund])
    expect(create).toHaveBeenCalledOnce()
    await expect(
      db
        .selectFrom('bookings')
        .select('id')
        .where('payment_reference', '=', expectedRefund.payment_reference)
        .execute(),
    ).resolves.toEqual([{ id }])
  })
})
