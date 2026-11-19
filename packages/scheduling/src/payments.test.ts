import { createHash, randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { findSlots } from './availability.ts'
import { canonicalJson, createPublicBooking, insertBooking } from './bookings.ts'
import { NO_CHANGE_CUTOFFS } from './change-deadlines.ts'
import { notificationSnapshot } from './notification-settings.ts'
import { expirePaymentHolds } from './payment-expiry.ts'
import { type CheckoutSession, FakePaymentProvider } from './payment-provider.ts'
import {
  cancelPaymentHold,
  confirmPaymentHold,
  createPaymentCheckout,
  createPaymentHold,
} from './payments.ts'
import { createFixtures } from './testing.ts'

const url = process.env.DATABASE_URL
const price = { amountMinor: 1250, currency: 'usd' }

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
  it('reuses the persisted Checkout Session and opaque idempotency key on identical retry', async () => {
    const { ctx, input } = await setup()
    const provider = new FakePaymentProvider()
    const create = vi.spyOn(provider, 'createCheckout')
    const retrieve = vi.spyOn(provider, 'retrieveCheckout')
    const checkoutCtx = { ...ctx, paymentProvider: provider }
    const hold = await createPaymentHold(checkoutCtx, input, price)
    expect(await createPaymentHold(checkoutCtx, input, price)).toEqual(hold)
    const attempt = await db
      .selectFrom('payment_checkout_attempts')
      .selectAll()
      .where('booking_id', '=', hold.id)
      .executeTakeFirstOrThrow()
    expect(attempt).toMatchObject({
      account_id: provider.accountId,
      mode: provider.mode,
      amount_minor: price.amountMinor,
      currency: price.currency,
      session_id: hold.checkout?.sessionId,
      idempotency_key: `hourmere_checkout_${attempt.id}`,
    })
    expect(attempt.id).not.toBe(hold.id)
    expect(attempt.idempotency_key).not.toContain(input.invitee.email)
    expect(attempt.idempotency_key).not.toContain(input.idempotencyKey)
    expect(create).toHaveBeenCalledExactlyOnceWith({
      ...price,
      attemptId: attempt.id,
      bookingId: hold.id,
      idempotencyKey: attempt.idempotency_key,
      accountId: provider.accountId,
      mode: provider.mode,
      expiresAt: hold.expiresAt,
      startedAt: attempt.started_at?.toISOString(),
    })
    expect(retrieve).toHaveBeenCalledOnce()
    expect(ctx.notify).not.toHaveBeenCalled()
  })

  it('rejects changed input or price under a retained hold key', async () => {
    const { ctx, input } = await setup()
    const provider = new FakePaymentProvider()
    const create = vi.spyOn(provider, 'createCheckout')
    const checkoutCtx = { ...ctx, paymentProvider: provider }
    await createPaymentHold(checkoutCtx, input, price)
    await expect(
      createPaymentHold(checkoutCtx, input, { ...price, amountMinor: price.amountMinor + 1 }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
    await expect(
      createPaymentHold(
        checkoutCtx,
        { ...input, invitee: { ...input.invitee, name: 'Another invitee' } },
        price,
      ),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
    expect(create).toHaveBeenCalledOnce()
  })

  it('reconciles a lost Checkout response before returning the original Session', async () => {
    const { ctx, input } = await setup()
    const provider = new FakePaymentProvider()
    const original = provider.createCheckout.bind(provider)
    let lostSession: CheckoutSession | undefined
    const create = vi
      .spyOn(provider, 'createCheckout')
      .mockImplementationOnce(async (operation) => {
        lostSession = await original(operation)
        throw new Error('Lost provider response')
      })
    const reconcile = vi.spyOn(provider, 'findCheckout')
    const checkoutCtx = { ...ctx, paymentProvider: provider }
    await expect(createPaymentHold(checkoutCtx, input, price)).rejects.toMatchObject({
      code: 'payment_checkout_unavailable',
    })
    const hold = await createPaymentHold(checkoutCtx, input, price)
    expect(lostSession).toBeDefined()
    expect(hold.checkout).toEqual(lostSession)
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(create.mock.calls[0]?.[0])
    expect(create).toHaveBeenCalledOnce()
  })

  it('keeps an inconclusive Checkout operation unresolved instead of submitting again', async () => {
    const { ctx, input } = await setup()
    const provider = new FakePaymentProvider()
    const create = vi.spyOn(provider, 'createCheckout').mockRejectedValueOnce(new Error('Timeout'))
    const checkoutCtx = { ...ctx, paymentProvider: provider }
    await expect(createPaymentHold(checkoutCtx, input, price)).rejects.toMatchObject({
      code: 'payment_checkout_unavailable',
    })
    await expect(createPaymentHold(checkoutCtx, input, price)).rejects.toMatchObject({
      code: 'payment_checkout_unresolved',
    })
    expect(create).toHaveBeenCalledOnce()
  })

  it('checks the retained mode and account before any provider call', async () => {
    const { ctx, input } = await setup()
    const provider = new FakePaymentProvider()
    const { id } = await createPaymentHold({ ...ctx, paymentProvider: provider }, input, price)
    for (const mismatch of [
      new FakePaymentProvider(provider.accountId, 'live'),
      new FakePaymentProvider('acct_other', provider.mode),
    ]) {
      const retrieve = vi.spyOn(mismatch, 'retrieveCheckout')
      await expect(
        createPaymentCheckout({ ...ctx, paymentProvider: mismatch }, id),
      ).rejects.toMatchObject({
        code: 'payment_provider_binding_mismatch',
      })
      expect(retrieve).not.toHaveBeenCalled()
    }
  })

  it('keeps a Session binding and withholds its URL when cancellation wins during create', async () => {
    const { ctx, input } = await setup()
    const provider = new FakePaymentProvider()
    const original = provider.createCheckout.bind(provider)
    let createdSession: CheckoutSession | undefined
    vi.spyOn(provider, 'createCheckout').mockImplementationOnce(async (operation) => {
      await cancelPaymentHold(ctx, operation.bookingId)
      createdSession = await original(operation)
      return createdSession
    })
    const checkoutCtx = { ...ctx, paymentProvider: provider }
    await expect(createPaymentHold(checkoutCtx, input, price)).rejects.toMatchObject({
      code: 'payment_hold_inactive',
    })
    const hold = await createPaymentHold(checkoutCtx, input, price)
    expect(hold).toMatchObject({ status: 'cancelled' })
    expect(hold).not.toHaveProperty('checkout')
    await expect(createPaymentCheckout(checkoutCtx, hold.id)).rejects.toMatchObject({
      code: 'payment_hold_inactive',
    })
    const attempt = await db
      .selectFrom('payment_checkout_attempts')
      .select('session_id')
      .where('booking_id', '=', hold.id)
      .executeTakeFirstOrThrow()
    expect(createdSession).toBeDefined()
    expect(attempt.session_id).toBe(createdSession?.sessionId)
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
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'slot_unavailable' },
    })
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
  it('holds store the chosen location option like a confirmed booking and fingerprint it', async () => {
    const { ctx, input, eventTypeId } = await setup()
    const options = [
      { id: 'office', kind: 'in_person', address: 'Private office', isDefault: true },
      { id: 'video', kind: 'link', url: 'https://meet.example.test/room', label: 'Video link' },
      { id: 'call', kind: 'phone', askInvitee: true },
    ]
    await db
      .updateTable('event_types')
      .set({ locations: JSON.stringify(options) })
      .where('id', '=', eventTypeId)
      .execute()
    const stored = (id: string) =>
      db
        .selectFrom('bookings')
        .select(['status', 'location', 'location_option'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    const holds = () =>
      db.selectFrom('bookings').select('id').where('event_type_id', '=', eventTypeId).execute()
    await expect(
      createPaymentHold(ctx, { ...input, idempotencyKey: 'removed', locationOptionId: 'removed' }),
    ).rejects.toMatchObject({ code: 'invalid_location_choice' })
    // Phone locations stay outside the payment foundation, chosen or default.
    await expect(
      createPaymentHold(ctx, {
        ...input,
        idempotencyKey: 'call',
        locationOptionId: 'call',
        inviteePhone: '+14155550123',
      }),
    ).rejects.toMatchObject({ code: 'payment_flow_unsupported' })
    expect(await holds()).toEqual([])
    const chosen = { ...input, locationOptionId: 'video' }
    const hold = await createPaymentHold(ctx, chosen)
    expect(await stored(hold.id)).toEqual({
      status: 'pending_payment',
      location: { kind: 'link', url: 'https://meet.example.test/room' },
      location_option: options[1],
    })
    expect((await createPaymentHold(ctx, chosen)).id).toBe(hold.id)
    await expect(
      createPaymentHold(ctx, { ...input, locationOptionId: 'office' }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' })
    expect(await confirmPaymentHold(ctx, hold.id, 'pi_test_location')).toMatchObject({
      outcome: 'confirmed',
    })
    expect(await stored(hold.id)).toEqual({
      status: 'confirmed',
      location: { kind: 'link', url: 'https://meet.example.test/room' },
      location_option: options[1],
    })
    expect(await holds()).toEqual([{ id: hold.id }])
  })
  it('holds without a choice store the default option snapshot', async () => {
    const { ctx, input, eventTypeId } = await setup()
    const options = [
      { id: 'call', kind: 'phone', askInvitee: true },
      { id: 'office', kind: 'in_person', address: 'Private office', isDefault: true },
    ]
    await db
      .updateTable('event_types')
      .set({ locations: JSON.stringify(options) })
      .where('id', '=', eventTypeId)
      .execute()
    const { id } = await createPaymentHold(ctx, input)
    expect(
      await db
        .selectFrom('bookings')
        .select(['location', 'location_option'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      location: { kind: 'in_person', address: 'Private office' },
      location_option: options[1],
    })
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
        changeCutoffs: NO_CHANGE_CUTOFFS,
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
        changeCutoffs: NO_CHANGE_CUTOFFS,
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
        payment_idempotency_key: input.idempotencyKey,
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
  it('rejects Checkout creation for an overdue hold even before the expiry worker runs', async () => {
    const { id, ctx } = await expiredHold()
    const provider = new FakePaymentProvider()
    const create = vi.spyOn(provider, 'createCheckout')
    const attemptId = randomUUID()
    await db
      .insertInto('payment_checkout_attempts')
      .values({
        id: attemptId,
        booking_id: id,
        account_id: provider.accountId,
        mode: provider.mode,
        amount_minor: price.amountMinor,
        currency: price.currency,
        idempotency_key: `hourmere_checkout_${attemptId}`,
      })
      .execute()
    await expect(
      createPaymentCheckout({ ...ctx, paymentProvider: provider }, id),
    ).rejects.toMatchObject({
      code: 'payment_hold_inactive',
    })
    expect(create).not.toHaveBeenCalled()
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
    attemptId: 'attempt',
    bookingId: 'fake',
    accountId: fake.accountId,
    mode: fake.mode,
    amountMinor: 100,
    currency: 'usd',
    expiresAt: 'future',
    idempotencyKey: 'checkout',
    startedAt: 'now',
  }
  expect(await fake.createCheckout(checkout)).toEqual(await fake.createCheckout(checkout))
  await expect(fake.createCheckout({ ...checkout, amountMinor: 200 })).rejects.toThrow(
    'Idempotency key reused',
  )
  const refund = { paymentReference: 'pi_fake', idempotencyKey: 'refund' }
  expect(await fake.refund(refund)).toEqual(await fake.refund(refund))
  await expect(fake.verifyWebhook('{}', 'invalid')).rejects.toThrow('Invalid signature')
})
