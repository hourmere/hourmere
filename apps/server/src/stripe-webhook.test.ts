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

  async function paidHold(provider = new FakePaymentProvider(accountId)) {
    const f = createFixtures(db)
    const host = await f.host()
    await f.schedule(host.userId)
    const slug = 'paid'
    await f.eventType(host.organizationId, host.userId, { slug, durationMinutes: 30 })
    let date = Temporal.Now.plainDateISO('UTC').add({ days: 3 })
    while (date.dayOfWeek !== 1) date = date.add({ days: 1 })
    const start = date
      .toZonedDateTime({ timeZone: 'Europe/Berlin', plainTime: '12:00' })
      .toInstant()
    const ctx = {
      db,
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

  it.each(['overdue', 'expired', 'cancelled'] as const)(
    'records late success as refundable without reviving the %s hold',
    async (state) => {
      const notify = vi.fn<BookingNotifier>(async () => {})
      const app = composition({ notify })
      const { hold, ctx, complete, expired, intent } = await paidHold()
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
      expect(await booking(hold.id)).toEqual({
        status: state === 'cancelled' ? 'cancelled' : 'expired',
        payment_reference: intent,
        payment_confirmed_at: null,
        payment_refund_required: true,
      })
      expect(await receipts(completed.id)).toEqual([completed.id])
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
