import { createHash } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { findSlots } from './availability.ts'
import { canonicalJson, createPublicBooking, insertBooking } from './bookings.ts'
import { notificationSnapshot } from './notification-settings.ts'
import { expirePaymentHolds } from './payment-expiry.ts'
import { FakePaymentProvider } from './payment-provider.ts'
import { cancelPaymentHold, confirmPaymentHold, createPaymentHold } from './payments.ts'
import { createFixtures } from './testing.ts'

const url = process.env.DATABASE_URL

describe.skipIf(!url)('payment holds', () => {
  let testDb: TestDatabase
  let db: Db
  beforeAll(async () => {
    testDb = await createTestDatabase(url as string)
    db = createDb(testDb.pool)
  })
  afterAll(async () => {
    await testDb?.drop()
  })
  async function setup() {
    const f = createFixtures(db)
    const host = await f.host()
    await f.schedule(host.userId)
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      slug: 'paid',
      durationMinutes: 30,
    })
    let date = Temporal.Now.plainDateISO('UTC').add({ days: 3 })
    while (date.dayOfWeek !== 1) date = date.add({ days: 1 })
    const start = date
      .toZonedDateTime({ timeZone: 'Europe/Berlin', plainTime: '12:00' })
      .toInstant()
    const input = {
      handle: host.handle,
      slug: 'paid',
      start,
      idempotencyKey: 'test-hold',
      invitee: { name: 'Invitee', email: 'invitee@example.com', timeZone: 'Europe/Berlin' },
    }
    const ctx = {
      db,
      now: () => Temporal.Now.instant(),
      paidBookingsEnabled: true,
      notify: vi.fn(async () => {}),
    }
    return { host, eventTypeId, start, input, ctx }
  }
  it('defaults off and creates no booking', async () => {
    const { ctx, input } = await setup()
    await expect(
      createPaymentHold({ ...ctx, paidBookingsEnabled: undefined }, input),
    ).rejects.toMatchObject({ code: 'paid_bookings_disabled' })
  })
  it('serializes two invitees, blocks discovery and ordinary booking, replays without side effects', async () => {
    const { ctx, input, host, eventTypeId, start } = await setup()
    const results = await Promise.allSettled([
      createPaymentHold(ctx, input),
      createPaymentHold(ctx, {
        ...input,
        idempotencyKey: 'second',
        invitee: { ...input.invitee, email: 'other@example.com' },
      }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    const winner = results.find((r) => r.status === 'fulfilled')
    expect(winner?.status).toBe('fulfilled')
    expect(
      await findSlots(db, {
        eventTypeId,
        hostUserId: host.userId,
        rangeStart: start,
        rangeEnd: start.add({ minutes: 30 }),
        now: ctx.now(),
      }),
    ).toHaveLength(0)
    await expect(
      createPublicBooking(ctx, { ...input, idempotencyKey: 'ordinary' }),
    ).rejects.toMatchObject({ code: 'slot_unavailable' })
    expect(ctx.notify).not.toHaveBeenCalled()
    if (results[0]?.status === 'fulfilled')
      expect((await createPaymentHold(ctx, input)).id).toBe(results[0].value.id)
  })
  it('confirms exactly once, rejects payment mismatch, cancel and ordinary reschedule remain separate', async () => {
    const { ctx, input } = await setup()
    const hold = await createPaymentHold(ctx, input)
    expect(await confirmPaymentHold(ctx, hold.id, 'pi_test_paid')).toMatchObject({
      outcome: 'confirmed',
    })
    expect(await confirmPaymentHold(ctx, hold.id, 'pi_test_paid')).toMatchObject({
      outcome: 'confirmed',
    })
    expect(ctx.notify).toHaveBeenCalledTimes(1)
    await expect(confirmPaymentHold(ctx, hold.id, 'pi_other')).rejects.toMatchObject({
      code: 'payment_reference_mismatch',
    })
    await expect(cancelPaymentHold(ctx, hold.id)).rejects.toMatchObject({
      code: 'payment_already_confirmed',
    })
  })
  it('cancel is idempotent and late success retains refund intent without notification', async () => {
    const { ctx, input } = await setup()
    const hold = await createPaymentHold(ctx, input)
    ctx.paidBookingsEnabled = false
    await cancelPaymentHold(ctx, hold.id)
    expect(await cancelPaymentHold(ctx, hold.id)).toMatchObject({ status: 'cancelled' })
    expect(await confirmPaymentHold(ctx, hold.id, 'pi_cancelled')).toMatchObject({
      outcome: 'refund_required',
    })
    expect(await confirmPaymentHold(ctx, hold.id, 'pi_cancelled')).toMatchObject({
      outcome: 'refund_required',
    })
    expect(ctx.notify).not.toHaveBeenCalled()
  })
  it('pins the event notification policy when the hold starts', async () => {
    const { ctx, input, eventTypeId } = await setup()
    const disabledRules = { reminders: [], followUps: [] }
    await db
      .updateTable('event_types')
      .set({ notifications: JSON.stringify(disabledRules) })
      .where('id', '=', eventTypeId)
      .execute()
    const { id } = await createPaymentHold(ctx, input)
    const expected = { version: 1, executionMode: 'configurable', notifications: disabledRules }
    const snapshot = () =>
      db
        .selectFrom('bookings')
        .select('notification_snapshot')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    expect((await snapshot()).notification_snapshot).toEqual(expected)
    await db
      .updateTable('event_types')
      .set({
        notifications: JSON.stringify({
          reminders: [
            {
              id: 'changed',
              offsetMinutes: 60,
              recipients: { invitee: true, host: true, guests: false },
            },
          ],
          followUps: [],
        }),
      })
      .where('id', '=', eventTypeId)
      .execute()
    await confirmPaymentHold(ctx, id, 'pi_snapshot')
    expect((await snapshot()).notification_snapshot).toEqual(expected)
    expect(ctx.notify).toHaveBeenCalledTimes(1)
  })
  it('prevents switching an event with a pending hold to group mode', async () => {
    const { ctx, input, eventTypeId } = await setup()
    await createPaymentHold(ctx, input)
    await expect(
      db
        .updateTable('event_types')
        .set({ booking_mode: 'group', group_capacity: 2 })
        .where('id', '=', eventTypeId)
        .execute(),
    ).rejects.toMatchObject({ constraint: 'event_types_group_mode_work' })
  })
  it('rechecks the database deadline after waiting for a row lock', async () => {
    const { host, eventTypeId, start, ctx } = await setup()
    const { rows } = await sql<{
      deadline: Date
    }>`SELECT clock_timestamp() + interval '1 second' AS deadline`.execute(db)
    const { id } = await db.transaction().execute((trx) =>
      insertBooking(trx, {
        organizationId: host.organizationId,
        eventTypeId,
        start,
        end: start.add({ minutes: 30 }),
        title: 'Lock boundary',
        location: null,
        responses: {},
        source: 'web',
        apiKeyId: null,
        hostUserIds: [host.userId],
        hostsUseDefaultSchedule: false,
        attendees: [],
        notificationSnapshot: notificationSnapshot(null),
        manageTokenHash: null,
        paymentHoldExpiresAt: (rows[0] as { deadline: Date }).deadline.toISOString(),
      }),
    )
    let ready: () => void = () => {}
    const locked = new Promise<void>((resolve) => {
      ready = resolve
    })
    const blocker = db.transaction().execute(async (trx) => {
      await trx.selectFrom('bookings').select('id').where('id', '=', id).forUpdate().execute()
      ready()
      await sql`SELECT pg_sleep(1.2)`.execute(trx)
    })
    await locked
    ctx.paidBookingsEnabled = false
    expect(await confirmPaymentHold(ctx, id, 'pi_lock_boundary')).toMatchObject({
      outcome: 'refund_required',
    })
    await blocker
    expect(ctx.notify).not.toHaveBeenCalled()
  })
  async function expiredHold() {
    const setupData = await setup()
    const { host, eventTypeId, start } = setupData
    const { rows } = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db)
    const { id } = await db.transaction().execute((trx) =>
      insertBooking(trx, {
        organizationId: host.organizationId,
        eventTypeId,
        start,
        end: start.add({ minutes: 30 }),
        title: 'Expired hold',
        location: null,
        responses: {},
        source: 'web',
        apiKeyId: null,
        hostUserIds: [host.userId],
        hostsUseDefaultSchedule: false,
        attendees: [],
        notificationSnapshot: notificationSnapshot(null),
        manageTokenHash: null,
        paymentHoldExpiresAt: (rows[0] as { now: Date }).now.toISOString(),
      }),
    )
    return { ...setupData, id }
  }
  it('admits a group slot after another event payment hold expires', async () => {
    const { ctx, input, host } = await expiredHold()
    const f = createFixtures(db)
    const groupId = await f.eventType(host.organizationId, host.userId, {
      slug: 'group-after-hold',
      durationMinutes: 30,
    })
    await db
      .updateTable('event_types')
      .set({ booking_mode: 'group', group_capacity: 2 })
      .where('id', '=', groupId)
      .execute()
    await expect(
      createPublicBooking(ctx, {
        ...input,
        slug: 'group-after-hold',
        idempotencyKey: 'group-replacement',
      }),
    ).resolves.toHaveProperty('booking.status', 'confirmed')
  })
  it('replaying an overdue hold returns expired without renewing its deadline', async () => {
    const { id, ctx, input } = await expiredHold()
    const fingerprint = createHash('sha256')
      .update(canonicalJson({ ...input, start: input.start.toString() }))
      .digest()
    await db
      .updateTable('bookings')
      .set({
        idempotency_key: `payment:${input.idempotencyKey}`,
        idempotency_fingerprint: fingerprint,
      })
      .where('id', '=', id)
      .execute()
    const before = await db
      .selectFrom('bookings')
      .select('payment_hold_expires_at')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(await createPaymentHold(ctx, input)).toMatchObject({
      id,
      status: 'expired',
      expiresAt: before.payment_hold_expires_at?.toISOString(),
    })
  })
  it('deadline is exclusive; discovery and admission release overdue occupancy before cron', async () => {
    const { id, ctx, input, host, eventTypeId, start } = await expiredHold()
    expect(
      await findSlots(db, {
        eventTypeId,
        hostUserId: host.userId,
        rangeStart: start,
        rangeEnd: start.add({ minutes: 30 }),
        now: ctx.now(),
      }),
    ).toHaveLength(1)
    await expect(
      createPublicBooking(ctx, { ...input, idempotencyKey: 'replacement' }),
    ).resolves.toHaveProperty('booking.id')
    expect(
      (
        await db
          .selectFrom('bookings')
          .select('status')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('expired')
    expect(await confirmPaymentHold(ctx, id, 'pi_late')).toMatchObject({
      outcome: 'refund_required',
    })
    expect(await confirmPaymentHold(ctx, id, 'pi_late')).toMatchObject({
      outcome: 'refund_required',
    })
  })
  it('expiry drains atomically and idempotently, independent of new-hold flag', async () => {
    const { id, ctx, host } = await expiredHold()
    const expiry = { db: ctx.db, hostUserId: host.userId }
    const counts = await Promise.all([expirePaymentHolds(expiry), expirePaymentHolds(expiry)])
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1)
    expect(await expirePaymentHolds(expiry)).toBe(0)
    expect(
      (
        await db
          .selectFrom('booking_hosts')
          .select('active')
          .where('booking_id', '=', id)
          .executeTakeFirstOrThrow()
      ).active,
    ).toBe(false)
  })
})
it('fake provider replays checkout/refund and rejects invalid signatures and changed keys', async () => {
  const fake = new FakePaymentProvider()
  const checkout = {
    bookingId: 'fake',
    amountMinor: 100,
    currency: 'usd',
    expiresAt: 'future',
    idempotencyKey: 'checkout',
  }
  expect(await fake.createCheckout(checkout)).toEqual(await fake.createCheckout(checkout))
  await expect(fake.createCheckout({ ...checkout, amountMinor: 200 })).rejects.toThrow(
    'Idempotency key reused',
  )
  const refund = { paymentReference: 'pi_fake', idempotencyKey: 'refund' }
  expect(await fake.refund(refund)).toEqual(await fake.refund(refund))
  await expect(fake.verifyWebhook('{}', 'invalid')).rejects.toThrow('Invalid signature')
})
