import { createHmac, randomUUID } from 'node:crypto'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  type BookingNotifier,
  cancelPaymentHold,
  createPaymentHold,
  FakePaymentProvider,
} from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AppDeps, createApp } from './app.ts'
import { StripeConfig } from './stripe-config.ts'

const databaseUrl = process.env.DATABASE_URL
const path = '/api/webhooks/stripe'
const accountId = 'acct_hourmerefixture'
const apiKey = ['rk', 'test', 'synthetic'.repeat(4)].join('_')
const signingSecret = ['whsec', 'synthetic'.repeat(4)].join('_')
const oldSigningSecret = ['whsec', 'retiredfixture'.repeat(3)].join('_')
const stripe = new StripeConfig(accountId, 'test', apiKey, signingSecret)
const price = { amountMinor: 4242, currency: 'usd' }
const eventId = () => `evt_${randomUUID().replaceAll('-', '')}`
const nowSeconds = () => Math.floor(Date.now() / 1000)

// Stripe snapshot event envelope and event-type-specific data.object shapes:
// https://docs.stripe.com/api/events/object
// https://docs.stripe.com/api/events/types
function event<T>(type: string, object: T, id = eventId()) {
  return {
    id,
    object: 'event',
    created: nowSeconds(),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  }
}

// Match Stripe's exact timestamp-and-body signing protocol, independently of the SDK.
// https://docs.stripe.com/webhooks/signature
function signature(body: string, timestamp = nowSeconds(), secrets = [signingSecret]) {
  const signatures = secrets.map(
    (secret) => `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`,
  )
  return [`t=${timestamp}`, ...signatures].join(',')
}

function postRaw(app: ReturnType<typeof createApp>, body: string, stripeSignature?: string) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(stripeSignature === undefined ? {} : { 'Stripe-Signature': stripeSignature }),
    },
    body,
  })
}

function post(app: ReturnType<typeof createApp>, value: unknown) {
  const body = JSON.stringify(value)
  return postRaw(app, body, signature(body))
}

async function expectAcknowledged(response: Response) {
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ received: true })
}

describe.skipIf(!databaseUrl)('Stripe webhook (real Postgres, fake Checkout)', () => {
  let database: TestDatabase
  let db: Db
  let timedDb: Db

  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string, undefined, { tag: 'stripe_webhook' })
    db = createDb(database.pool)
    await sql`CREATE SCHEMA stripe_test_clock`.execute(db)
    await sql`CREATE TABLE stripe_test_clock.frozen (at timestamptz)`.execute(db)
    await sql`INSERT INTO stripe_test_clock.frozen VALUES (NULL)`.execute(db)
    await sql`CREATE FUNCTION stripe_test_clock.clock_timestamp() RETURNS timestamptz
      LANGUAGE sql VOLATILE AS $$
        SELECT coalesce((SELECT at FROM stripe_test_clock.frozen), pg_catalog.clock_timestamp())
      $$`.execute(db)
    const url = new URL(database.url)
    url.searchParams.set('options', '-c search_path=stripe_test_clock,pg_catalog,public')
    timedDb = createDb(createPool(url.toString()))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await sql`UPDATE stripe_test_clock.frozen SET at = NULL`.execute(db)
  })

  afterAll(async () => {
    await timedDb?.destroy()
    await database?.drop()
  })

  function composition(options: Partial<NonNullable<AppDeps['stripeWebhook']>> = {}) {
    return createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      publicUrl: 'https://hourmere.invalid',
      stripeWebhook: { db: timedDb, config: stripe, enabled: true, ...options },
    })
  }

  async function paidHold(
    provider = new FakePaymentProvider(accountId),
    admission?: Temporal.Instant,
  ) {
    const f = createFixtures(db)
    const host = await f.host()
    await f.schedule(host.userId)
    const slug = 'paid'
    await f.eventType(host.organizationId, host.userId, { slug, durationMinutes: 30 })
    const today =
      admission?.toZonedDateTimeISO('UTC').toPlainDate() ?? Temporal.Now.plainDateISO('UTC')
    let date = today.add({ days: 3 })
    while (date.dayOfWeek !== 1) date = date.add({ days: 1 })
    const start = date
      .toZonedDateTime({ timeZone: 'Europe/Berlin', plainTime: '12:00' })
      .toInstant()
    const ctx = {
      db: admission ? timedDb : db,
      paidBookingsEnabled: true,
      paymentProvider: provider,
      now: () => Temporal.Now.instant(),
    }
    const hold = await createPaymentHold(
      ctx,
      {
        handle: host.handle,
        slug,
        start,
        idempotencyKey: 'synthetic-hold',
        invitee: { name: 'Invitee', email: 'invitee@example.test', timeZone: 'Europe/Berlin' },
      },
      price,
    )
    const attempt = await db
      .selectFrom('payment_checkout_attempts')
      .select(['id', 'session_id'])
      .where('booking_id', '=', hold.id)
      .executeTakeFirstOrThrow()
    expect(attempt.session_id).toBe(hold.checkout?.sessionId)
    const intent = `pi_${randomUUID().replaceAll('-', '')}`
    // https://docs.stripe.com/api/checkout/sessions/object
    const complete = {
      id: attempt.session_id,
      object: 'checkout.session',
      client_reference_id: attempt.id,
      metadata: { hourmere_checkout_attempt_id: attempt.id, hourmere_booking_id: hold.id },
      amount_total: price.amountMinor,
      currency: price.currency,
      livemode: false,
      mode: 'payment',
      ui_mode: 'hosted_page',
      payment_method_types: ['card'],
      expires_at: Math.ceil(Date.parse(hold.expiresAt) / 1000) + 15,
      status: 'complete',
      payment_status: 'paid',
      payment_intent: intent,
      customer_details: { name: 'Synthetic private Örder', email: 'private-order@example.test' },
      url: null,
    }
    return {
      hold,
      ctx,
      attempt,
      intent,
      complete,
      expired: { ...complete, status: 'expired', payment_status: 'unpaid', payment_intent: null },
    }
  }

  function booking(id: string) {
    return db
      .selectFrom('bookings')
      .select(['status', 'payment_reference', 'payment_confirmed_at', 'payment_refund_required'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }

  async function receipts(...ids: string[]) {
    const { rows } = await sql<{ event_id: string }>`
      SELECT event_id FROM payment_stripe_events WHERE event_id IN (${sql.join(ids)}) ORDER BY event_id
    `.execute(db)
    return rows.map((row) => row.event_id)
  }

  async function passDeadline(hold: { expiresAt: string }) {
    await sql`UPDATE stripe_test_clock.frozen SET at = ${hold.expiresAt}::timestamptz + interval '16 seconds'`.execute(
      db,
    )
  }

  async function freezeDatabaseClock(instant: Temporal.Instant) {
    await sql`UPDATE stripe_test_clock.frozen SET at = ${instant.toString()}::timestamptz`.execute(
      db,
    )
  }

  function obligations(attemptId: string) {
    return db
      .selectFrom('payment_refund_obligations')
      .selectAll()
      .where('attempt_id', '=', attemptId)
      .execute()
  }

  it('confirms a priced hold with a rotated signature on the exact UTF-8 body', async () => {
    const notify = vi.fn<BookingNotifier>(async () => {})
    const app = composition({ notify })
    const { hold, complete, intent } = await paidHold()
    const completed = event('checkout.session.completed', complete)
    const body = ` ${JSON.stringify(completed, null, 2)}\n`
    const signed = signature(body, nowSeconds(), [oldSigningSecret, signingSecret])

    await expectAcknowledged(await postRaw(app, body, signed))

    expect(await booking(hold.id)).toEqual({
      status: 'confirmed',
      payment_reference: intent,
      payment_confirmed_at: expect.any(Date),
      payment_refund_required: false,
    })
    expect(await receipts(completed.id)).toEqual([completed.id])
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ type: 'created', bookingId: hold.id }),
      expect.anything(),
    )
  })

  it('uniformly refuses missing, invalid, stale and body-mismatched signatures without writes or payload logs', async () => {
    const notify = vi.fn<BookingNotifier>(async () => {})
    const app = composition({ notify })
    const { hold, complete } = await paidHold()
    const completed = event('checkout.session.completed', complete)
    const body = JSON.stringify(completed)
    const signed = signature(body)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const response of [
      await postRaw(app, body),
      await postRaw(app, body, 't=0,v1=malformed'),
      await postRaw(app, body, signature(body, nowSeconds(), [oldSigningSecret])),
      await postRaw(app, body, signature(body, nowSeconds() - 301)),
      await postRaw(app, body, signature(body, nowSeconds() + 600)),
      await postRaw(app, `${body}\n`, signed),
      await postRaw(app, `\uFEFF${body}`, signed),
    ]) {
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_signature' })
    }
    const signedMalformed = await post(app, { ...completed, object: 'checkout.session' })
    expect(signedMalformed.status).toBe(400)
    expect(await signedMalformed.json()).toEqual({ error: 'invalid_request' })
    const logs = [log, warn, error].flatMap((spy) => spy.mock.calls.flat()).join('\n')
    expect(logs).not.toContain(complete.customer_details.name)
    expect(logs).not.toContain(complete.customer_details.email)
    expect(logs).not.toContain(signed)
    expect(await booking(hold.id)).toMatchObject({
      status: 'pending_payment',
      payment_reference: null,
    })
    expect(await receipts(completed.id)).toEqual([])
    expect(notify).not.toHaveBeenCalled()
  })

  it('deduplicates replayed event IDs before processing a second otherwise valid observation', async () => {
    const notify = vi.fn<BookingNotifier>(async () => {})
    const app = composition({ notify })
    const first = await paidHold()
    const other = await paidHold()
    const completed = event('checkout.session.completed', first.complete)
    const body = JSON.stringify(completed)

    await expectAcknowledged(await postRaw(app, body, signature(body, nowSeconds() - 2)))
    await expectAcknowledged(await postRaw(app, body, signature(body)))
    await expectAcknowledged(
      await post(app, event('checkout.session.completed', other.complete, completed.id)),
    )
    await expectAcknowledged(await post(app, event('checkout.session.completed', first.complete)))

    expect(await receipts(completed.id)).toEqual([completed.id])
    expect(await booking(first.hold.id)).toMatchObject({
      status: 'confirmed',
      payment_reference: first.intent,
    })
    expect(await booking(other.hold.id)).toMatchObject({
      status: 'pending_payment',
      payment_reference: null,
    })
    expect(notify).toHaveBeenCalledOnce()
  })

  it('serializes concurrent duplicates and distinct events for one payment', async () => {
    const notify = vi.fn<BookingNotifier>(async () => {})
    const app = composition({ notify })
    const { hold, complete, intent } = await paidHold()
    const completed = event('checkout.session.completed', complete)
    const additional = event('checkout.session.completed', complete)
    const responses = await Promise.all([
      post(app, completed),
      post(app, completed),
      post(app, additional),
    ])
    for (const response of responses) await expectAcknowledged(response)
    expect(await receipts(completed.id, additional.id)).toEqual(
      [completed.id, additional.id].sort(),
    )
    expect(await booking(hold.id)).toMatchObject({ status: 'confirmed', payment_reference: intent })
    expect(notify).toHaveBeenCalledOnce()
  })

  it('recovers a missing Session ID only after the Checkout attempt was submitted', async () => {
    const app = composition()
    const { hold, attempt, complete, intent } = await paidHold()
    const setAttempt = (startedAt: Date | null) =>
      db
        .updateTable('payment_checkout_attempts')
        .set({ session_id: null, started_at: startedAt })
        .where('id', '=', attempt.id)
        .execute()

    await setAttempt(null)
    await expectAcknowledged(await post(app, event('checkout.session.completed', complete)))
    expect(await booking(hold.id)).toMatchObject({
      status: 'pending_payment',
      payment_reference: null,
    })

    await setAttempt(new Date())
    await expectAcknowledged(await post(app, event('checkout.session.completed', complete)))
    expect(await booking(hold.id)).toMatchObject({ status: 'confirmed', payment_reference: intent })
    expect(
      await db
        .selectFrom('payment_checkout_attempts')
        .select('session_id')
        .where('id', '=', attempt.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ session_id: attempt.session_id })
  })

  it('rolls back the receipt and booking if transactional notification enqueue fails', async () => {
    const notify = vi.fn<BookingNotifier>(async () => {})
    const privateDiagnostic = 'synthetic private customer diagnostic'
    notify.mockRejectedValueOnce(new Error(privateDiagnostic))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = composition({ notify })
    const { hold, complete, intent } = await paidHold()
    const completed = event('checkout.session.completed', complete)

    const failed = await post(app, completed)
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain(privateDiagnostic)
    expect(error.mock.calls.flat().join('\n')).not.toContain(privateDiagnostic)
    expect(await receipts(completed.id)).toEqual([])
    expect(await booking(hold.id)).toMatchObject({
      status: 'pending_payment',
      payment_reference: null,
    })

    await expectAcknowledged(await post(app, completed))
    expect(await receipts(completed.id)).toEqual([completed.id])
    expect(await booking(hold.id)).toMatchObject({ status: 'confirmed', payment_reference: intent })
  })

  it('keeps a confirmed booking when an expiry event arrives afterwards', async () => {
    const notify = vi.fn<BookingNotifier>(async () => {})
    const app = composition({ notify })
    const { hold, complete, expired } = await paidHold()
    await expectAcknowledged(await post(app, event('checkout.session.completed', complete)))
    const confirmed = await booking(hold.id)
    expect(confirmed.status).toBe('confirmed')
    await passDeadline(hold)
    await expectAcknowledged(await post(app, event('checkout.session.expired', expired)))
    expect(await booking(hold.id)).toEqual(confirmed)
    expect(notify).toHaveBeenCalledOnce()
  })

  it('keeps a manually expired Stripe Session held until its database deadline across DST', async () => {
    const zone = 'Europe/Berlin'
    const year = Temporal.Now.plainDateISO(zone).year + 1
    let sunday = Temporal.PlainDate.from({ year, month: 3, day: 31 })
    while (sunday.dayOfWeek !== 7) sunday = sunday.subtract({ days: 1 })
    const admitted = sunday.toZonedDateTime({ timeZone: zone, plainTime: '01:45' }).toInstant()
    await freezeDatabaseClock(admitted)
    const { hold, expired } = await paidHold(undefined, admitted)
    const deadline = Temporal.Instant.from(hold.expiresAt)
    expect(deadline.equals(admitted.add({ minutes: 30 }))).toBe(true)
    expect(deadline.toZonedDateTimeISO(zone).toPlainTime().toString()).toBe('03:15:00')
    const app = composition()
    await freezeDatabaseClock(deadline.subtract({ milliseconds: 1 }))
    await expectAcknowledged(await post(app, event('checkout.session.expired', expired)))
    expect((await booking(hold.id)).status).toBe('pending_payment')

    await freezeDatabaseClock(deadline)
    await expectAcknowledged(await post(app, event('checkout.session.expired', expired)))
    expect((await booking(hold.id)).status).toBe('expired')
  })

  it.each(['overdue', 'expired', 'cancelled'] as const)(
    'records late success as refundable without reviving the %s hold',
    async (state) => {
      const notify = vi.fn<BookingNotifier>(async () => {})
      const app = composition({ notify })
      const { hold, ctx, attempt, complete, expired, intent } = await paidHold()
      if (state === 'cancelled') {
        await cancelPaymentHold(ctx, hold.id)
      } else {
        await passDeadline(hold)
        if (state === 'expired')
          await expectAcknowledged(await post(app, event('checkout.session.expired', expired)))
      }
      expect((await booking(hold.id)).status).toBe(state === 'overdue' ? 'pending_payment' : state)
      const completed =
        state === 'cancelled'
          ? {
              ...event('checkout.session.completed', { ...complete, ui_mode: 'hosted' }),
              account: null,
            }
          : event('checkout.session.completed', complete)
      await expectAcknowledged(await post(app, completed))
      await expectAcknowledged(await post(app, completed))
      await expectAcknowledged(await post(app, event('checkout.session.completed', complete)))
      expect(await booking(hold.id)).toEqual({
        status: state === 'cancelled' ? 'cancelled' : 'expired',
        payment_reference: intent,
        payment_confirmed_at: null,
        payment_refund_required: true,
      })
      expect(await receipts(completed.id)).toEqual([completed.id])
      expect(await obligations(attempt.id)).toMatchObject([
        { state: 'requested', payment_reference: intent, amount_minor: price.amountMinor },
      ])
      expect(notify).not.toHaveBeenCalled()
    },
  )

  it('checks account, mode, Session, attempt metadata, payment status, amount and currency before confirming', async () => {
    const notify = vi.fn<BookingNotifier>(async () => {})
    const app = composition({ notify })
    const { hold, complete } = await paidHold()
    const completed = () => event('checkout.session.completed', complete)
    for (const mismatched of [
      { ...completed(), account: 'acct_unrelatedfixture' },
      { ...completed(), livemode: true },
      { ...completed(), context: 'acct_unrelatedfixture' },
      event('checkout.session.completed', { ...complete, livemode: true }),
      event('checkout.session.completed', { ...complete, id: 'cs_wrongfixture' }),
      event('checkout.session.completed', { ...complete, client_reference_id: randomUUID() }),
      event('checkout.session.completed', {
        ...complete,
        metadata: { ...complete.metadata, hourmere_booking_id: randomUUID() },
      }),
      event('checkout.session.completed', { ...complete, payment_status: 'unpaid' }),
      event('checkout.session.completed', { ...complete, payment_intent: null }),
      event('checkout.session.completed', { ...complete, amount_total: price.amountMinor + 1 }),
      event('checkout.session.completed', { ...complete, currency: 'eur' }),
    ]) {
      await expectAcknowledged(await post(app, mismatched))
    }
    expect(await booking(hold.id)).toMatchObject({
      status: 'pending_payment',
      payment_reference: null,
    })
    expect(notify).not.toHaveBeenCalled()
  })

  it('records a signed paid Session with mismatched expires_at for reconciliation without confirming or refunding it', async () => {
    const app = composition()
    const { hold, attempt, complete, intent } = await paidHold()
    const mismatched = event('checkout.session.completed', {
      ...complete,
      expires_at: complete.expires_at + 1,
    })
    await expectAcknowledged(await post(app, mismatched))
    await expectAcknowledged(await post(app, mismatched))
    expect(await booking(hold.id)).toMatchObject({
      status: 'pending_payment',
      payment_reference: null,
    })
    expect(await obligations(attempt.id)).toEqual([])
    expect(
      await db
        .selectFrom('payment_stripe_events')
        .selectAll()
        .where('event_id', '=', mismatched.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      finding: 'paid_checkout_binding_mismatch',
      account_id: accountId,
      mode: 'test',
      session_id: complete.id,
      payment_reference: intent,
    })
  })

  it('records malformed Hourmere bindings without retaining unrelated Checkout identifiers', async () => {
    const app = composition()
    const { complete } = await paidHold()
    const missingMetadata = event('checkout.session.completed', {
      ...complete,
      client_reference_id: null,
      metadata: {},
    })
    const unrelated = event('checkout.session.completed', {
      ...missingMetadata.data.object,
      id: 'cs_unrelated',
    })
    await expectAcknowledged(await post(app, missingMetadata))
    await expectAcknowledged(await post(app, unrelated))
    const findings = await db
      .selectFrom('payment_stripe_events')
      .select(['event_id', 'session_id', 'payment_reference', 'finding'])
      .where('event_id', 'in', [missingMetadata.id, unrelated.id])
      .execute()
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_id: missingMetadata.id,
          session_id: complete.id,
          payment_reference: complete.payment_intent,
          finding: 'paid_checkout_binding_mismatch',
        }),
        {
          event_id: unrelated.id,
          session_id: null,
          payment_reference: null,
          finding: null,
        },
      ]),
    )
  })

  it('reports concurrent observations that try to bind one PaymentIntent to two holds', async () => {
    const notify = vi.fn<BookingNotifier>(async () => {})
    const app = composition({ notify })
    const first = await paidHold()
    const second = await paidHold()
    const completed = [
      event('checkout.session.completed', first.complete),
      event('checkout.session.completed', { ...second.complete, payment_intent: first.intent }),
    ]
    for (const response of await Promise.all(completed.map((snapshot) => post(app, snapshot))))
      await expectAcknowledged(response)

    const bookings = await Promise.all([booking(first.hold.id), booking(second.hold.id)])
    expect(bookings.map(({ status }) => status).sort()).toEqual(['confirmed', 'pending_payment'])
    const findings = await db
      .selectFrom('payment_stripe_events')
      .select(['finding', 'payment_reference'])
      .where(
        'event_id',
        'in',
        completed.map(({ id }) => id),
      )
      .where('finding', 'is not', null)
      .execute()
    expect(findings).toEqual([
      {
        finding: 'paid_checkout_binding_mismatch',
        payment_reference: first.intent,
      },
    ])
    expect(notify).toHaveBeenCalledOnce()
  })

  it('applies only bound Refund snapshots and keeps terminal state through out-of-order events', async () => {
    const app = composition()
    const { hold, ctx, attempt, complete, intent } = await paidHold()
    await cancelPaymentHold(ctx, hold.id)
    await expectAcknowledged(await post(app, event('checkout.session.completed', complete)))
    const [obligation] = await obligations(attempt.id)
    expect(obligation?.state).toBe('requested')
    if (!obligation) throw new Error('Missing refund obligation')
    const id = `re_${randomUUID().replaceAll('-', '')}`
    // https://docs.stripe.com/api/refunds/object
    // https://docs.stripe.com/refunds#refund-events
    const refund = {
      object: 'refund',
      id,
      amount: price.amountMinor,
      currency: price.currency,
      payment_intent: intent,
      status: 'succeeded',
      metadata: { hourmere_refund_obligation_id: obligation.id },
    }
    await expectAcknowledged(await post(app, event('refund.updated', refund)))
    expect((await obligations(attempt.id))[0]?.state).toBe('requested')
    // Represent a committed worker dispatch whose Stripe response was lost after the POST.
    await db
      .updateTable('payment_refund_obligations')
      .set({ attempts: 1, first_attempted_at: sql`clock_timestamp()` })
      .where('id', '=', obligation.id)
      .execute()
    for (const mismatched of [
      event('refund.updated', { ...refund, amount: price.amountMinor - 1 }),
      event('refund.updated', { ...refund, payment_intent: 'pi_other' }),
      event('refund.updated', { ...refund, metadata: {} }),
      { ...event('refund.updated', refund), account: 'acct_other' },
      { ...event('refund.updated', refund), livemode: true },
    ])
      await expectAcknowledged(await post(app, mismatched))
    expect((await obligations(attempt.id))[0]?.state).toBe('requested')

    const succeeded = event('refund.updated', refund)
    await expectAcknowledged(await post(app, succeeded))
    await expectAcknowledged(
      await post(app, event('refund.created', { ...refund, status: 'pending' })),
    )
    await expectAcknowledged(
      await post(app, event('refund.failed', { ...refund, status: 'failed' }, succeeded.id)),
    )
    expect(await obligations(attempt.id)).toMatchObject([
      { state: 'succeeded', stripe_refund_id: id },
    ])

    const failed = event('refund.failed', { ...refund, status: 'failed' })
    await expectAcknowledged(await post(app, failed))
    await expectAcknowledged(await post(app, failed))
    await expectAcknowledged(await post(app, event('refund.updated', refund)))
    expect(await receipts(succeeded.id, failed.id)).toEqual([succeeded.id, failed.id].sort())
    expect(await obligations(attempt.id)).toMatchObject([{ state: 'failed', stripe_refund_id: id }])
  })

  it('acknowledges unrelated events and handles non-Session notifications without changing the hold', async () => {
    const notify = vi.fn<BookingNotifier>(async () => {})
    const app = composition({ notify })
    const { hold, complete, intent } = await paidHold()
    // https://docs.stripe.com/api/payment_intents/object
    const succeeded = event('payment_intent.succeeded', {
      id: intent,
      object: 'payment_intent',
      livemode: false,
      amount: price.amountMinor,
      amount_received: price.amountMinor,
      currency: price.currency,
      status: 'succeeded',
      payment_method_types: ['card'],
      metadata: {},
    })
    // https://docs.stripe.com/api/refunds/object
    const refund = {
      id: 're_syntheticrefund',
      object: 'refund',
      amount: price.amountMinor,
      currency: price.currency,
      payment_intent: intent,
      status: 'succeeded',
    }
    const updated = event('refund.updated', refund)
    const failed = event('refund.failed', { ...refund, status: 'failed' })
    const unknown = event('checkout.session.async_payment_succeeded', complete)
    for (const observed of [succeeded, failed, updated, unknown]) {
      await expectAcknowledged(await post(app, observed))
    }
    expect(await receipts(succeeded.id, updated.id, failed.id, unknown.id)).toEqual(
      [succeeded.id, updated.id, failed.id].sort(),
    )
    expect(await booking(hold.id)).toMatchObject({
      status: 'pending_payment',
      payment_reference: null,
    })
    expect(notify).not.toHaveBeenCalled()
  })

  it('rejects declared and streaming oversized bodies even with valid signatures', async () => {
    const app = composition()
    const { hold, complete } = await paidHold()
    const completed = event('checkout.session.completed', complete)
    const body = `${JSON.stringify(completed)}${' '.repeat(64 * 1024)}`
    const signed = signature(body)
    const declared = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Length': String(Buffer.byteLength(body)), 'Stripe-Signature': signed },
      body,
    })
    expect(declared.status).toBe(413)
    expect((await postRaw(app, body, signed)).status).toBe(413)
    expect(await receipts(completed.id)).toEqual([])
    expect((await booking(hold.id)).status).toBe('pending_payment')
  })

  it('leaves the webhook unavailable while disabled or missing Stripe configuration', async () => {
    const { hold, complete } = await paidHold()
    const completed = event('checkout.session.completed', complete)
    for (const app of [composition({ enabled: false }), composition({ config: undefined })]) {
      expect((await post(app, completed)).status).toBe(404)
    }
    expect(await receipts(completed.id)).toEqual([])
    expect((await booking(hold.id)).status).toBe('pending_payment')
  })
})
