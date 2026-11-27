import '@hono/zod-openapi'
import { createHmac, randomUUID } from 'node:crypto'
import type { EventPayment } from '@hourmere/core/payment'
import { createDb, createPool, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  type BookingNotifier,
  checkoutSessionExpiry,
  FakePaymentProvider,
} from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.ts'
import { StripeConfig } from '../stripe-config.ts'
import { bookingRoutes } from './bookings.ts'
import { publicRoutes } from './public.ts'

const databaseUrl = process.env.DATABASE_URL
const statusPath = '/api/v1/public/checkout/status'
const cancelPath = '/api/v1/public/checkout/cancel'
const accountId = 'acct_hourmerefixture'
const signingSecret = ['whsec', 'synthetic'.repeat(4)].join('_')
const stripe = new StripeConfig(
  accountId,
  'test',
  ['rk', 'test', 'synthetic'.repeat(4)].join('_'),
  signingSecret,
)
const timeZone = 'America/New_York'
let fallSunday = Temporal.PlainDate.from({
  year: Temporal.Now.plainDateISO('UTC').year + 1,
  month: 11,
  day: 1,
})
while (fallSunday.dayOfWeek !== 7) fallSunday = fallSunday.add({ days: 1 })
const admission = fallSunday.toZonedDateTime({ timeZone: 'UTC', plainTime: '05:45' }).toInstant()
const deadline = admission.add({ minutes: 30 })
// The scheduler offers the earlier occurrence of an ambiguous time. The first
// ordinary start after a 01:45 EDT admission is 02:00 EST.
const start = admission.add({ minutes: 75 })
const statusSecret = 'synthetic-status-signing-seed'
type StartedCheckout = { statusToken: string; expiresAt: string; checkoutUrl?: string }

describe.skipIf(!databaseUrl)('public paid booking (real database and fake Stripe)', () => {
  let testDb: TestDatabase
  let db: Db
  let timedDb: Db

  beforeAll(async () => {
    testDb = await createTestDatabase(databaseUrl as string, undefined, { tag: 'public_checkout' })
    db = createDb(testDb.pool)
    await sql`CREATE SCHEMA checkout_test_clock`.execute(db)
    await sql`CREATE TABLE checkout_test_clock.frozen (at timestamptz)`.execute(db)
    await sql`INSERT INTO checkout_test_clock.frozen VALUES (${admission.toString()})`.execute(db)
    await sql`CREATE FUNCTION checkout_test_clock.clock_timestamp() RETURNS timestamptz
      LANGUAGE sql VOLATILE AS $$ SELECT at FROM checkout_test_clock.frozen $$`.execute(db)
    const url = new URL(testDb.url)
    url.searchParams.set('options', '-c search_path=checkout_test_clock,pg_catalog,public')
    timedDb = createDb(createPool(url.toString()))
  })

  afterAll(async () => {
    await timedDb?.destroy()
    await testDb?.drop()
  })

  async function setup() {
    await sql`UPDATE checkout_test_clock.frozen SET at = ${admission.toString()}`.execute(db)
    const f = createFixtures(db)
    const host = await f.host({ timeZone })
    await f.schedule(host.userId, {
      timeZone,
      weeklyHours: { sunday: [{ start: '00:00', end: '06:00' }] },
    })
    const eventTypeId = await f.eventType(host.organizationId, host.userId, {
      slug: 'paid',
      location: { kind: 'link', url: 'https://meeting.example.invalid/private' },
      slotStepMinutes: 15,
    })
    const payment = { currency: 'usd', prices: [{ durationMinutes: 30, amountMinor: 4242 }] }
    await db
      .updateTable('event_types')
      .set({ payment: JSON.stringify(payment), sms_reminders_enabled: true })
      .where('id', '=', eventTypeId)
      .execute()
    const base = `/api/v1/public/${host.handle}/paid`
    const provider = new FakePaymentProvider(accountId)
    const sessionCreations = vi.spyOn(provider, 'createCheckout')
    const notify = vi.fn<BookingNotifier>(async () => {})
    const makeApp = (available: boolean) =>
      createApp({
        checkDb: async () => {},
        authHandler: async () => new Response(null, { status: 404 }),
        resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
        publicUrl: 'https://hourmere.invalid',
        stripeWebhook: { db: timedDb, config: stripe, enabled: true, notify },
        routes: [
          publicRoutes({
            db: timedDb,
            now: () => admission,
            paidBookingsEnabled: available,
            smsRemindersAvailable: true,
            paymentProvider: available ? provider : undefined,
            paymentStatusSecret: statusSecret,
          }),
          bookingRoutes({ db: timedDb, now: () => admission }),
        ],
      })
    const app = makeApp(true)
    function post(route: string, body: unknown, key?: string, target = app) {
      return target.request(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key && { 'Idempotency-Key': key }) },
        body: JSON.stringify(body),
      })
    }
    const booking = {
      start: start.toString(),
      invitee: { name: 'Test Invitee', email: 'invitee@example.invalid', timeZone },
    }
    const quote = {
      ...booking,
      expectedAmountMinor: 4242,
      expectedCurrency: 'usd',
      inviteePhone: '+14155552671',
      smsConsent: true,
    }

    async function signedPayment(expiresAt: string) {
      const operation = sessionCreations.mock.calls[0]?.[0]
      if (!operation) throw new Error('No Stripe fake operation dispatched')
      const { session_id } = await db
        .selectFrom('payment_checkout_attempts')
        .select('session_id')
        .where('id', '=', operation.attemptId)
        .executeTakeFirstOrThrow()
      const timestamp = Math.floor(Date.now() / 1000)
      // https://docs.stripe.com/api/events/object
      // https://docs.stripe.com/api/checkout/sessions/object
      const body = JSON.stringify({
        id: `evt_${randomUUID().replaceAll('-', '')}`,
        object: 'event',
        type: 'checkout.session.completed',
        created: timestamp,
        livemode: false,
        data: {
          object: {
            id: session_id,
            object: 'checkout.session',
            client_reference_id: operation.attemptId,
            metadata: {
              hourmere_checkout_attempt_id: operation.attemptId,
              hourmere_booking_id: operation.bookingId,
            },
            amount_total: operation.amountMinor,
            currency: operation.currency,
            livemode: false,
            mode: 'payment',
            ui_mode: 'hosted_page',
            payment_method_types: ['card'],
            expires_at: checkoutSessionExpiry(expiresAt),
            status: 'complete',
            payment_status: 'paid',
            payment_intent: `pi_${randomUUID().replaceAll('-', '')}`,
            url: null,
          },
        },
      })
      const hash = createHmac('sha256', signingSecret).update(`${timestamp}.${body}`).digest('hex')
      return () =>
        app.request('/api/webhooks/stripe', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Stripe-Signature': `t=${timestamp},v1=${hash}`,
          },
          body,
        })
    }

    return {
      app,
      makeApp,
      base,
      post,
      booking,
      quote,
      payment,
      sessionCreations,
      signedPayment,
      notify,
      eventTypeId,
    }
  }

  it('reserves the displayed price across a DST fold and reveals a manage link only after verified payment', async () => {
    const {
      app,
      makeApp,
      base,
      post,
      booking,
      quote,
      payment,
      sessionCreations,
      signedPayment,
      notify,
      eventTypeId,
    } = await setup()
    const page = (await (await app.request(base)).json()) as { payment: EventPayment }
    expect(page).toMatchObject({ payment, paymentAvailable: true })
    const off = makeApp(false)
    expect(await (await off.request(base)).json()).toMatchObject({
      payment,
      paymentAvailable: false,
    })
    const query = new URLSearchParams({
      start: admission.toString(),
      end: start.add({ hours: 1 }).toString(),
    })
    const offered = (await (await app.request(`${base}/slots?${query}`)).json()) as {
      data: { start: string }[]
    }
    expect(offered.data[0]?.start).toBe(start.toString({ fractionalSecondDigits: 3 }))
    expect(await (await off.request(`${base}/slots?${query}`)).json()).toEqual({ data: [] })
    const ordinary = await post(`${base}/bookings`, booking)
    expect(ordinary.status).toBe(409)
    expect(await ordinary.json()).toMatchObject({ error: 'payment_required' })
    expect((await post(`${base}/checkout`, quote, randomUUID(), off)).status).toBe(409)
    expect(
      (await post(`${base}/checkout`, { ...quote, source: 'embed', guests: [] }, randomUUID()))
        .status,
    ).toBe(400)
    const changed = await post(
      `${base}/checkout`,
      { ...quote, expectedAmountMinor: 4243 },
      randomUUID(),
    )
    expect(changed.status).toBe(409)
    expect(await changed.json()).toMatchObject({ error: 'payment_price_changed' })
    expect(sessionCreations).not.toHaveBeenCalled()

    const key = randomUUID()
    const racing = await Promise.all([
      post(`${base}/checkout`, quote, key),
      post(`${base}/checkout`, quote, key),
    ])
    expect(racing.some((response) => response.status === 200)).toBe(true)
    const retry = await post(`${base}/checkout`, quote, key)
    expect(retry.status).toBe(200)
    const attempt = (await retry.json()) as StartedCheckout
    expect(attempt).toEqual({
      statusToken: expect.any(String),
      checkoutUrl: 'https://checkout.invalid/fake',
      expiresAt: deadline.toString({ fractionalSecondDigits: 3 }),
    })
    expect(sessionCreations).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        amountMinor: page.payment.prices[0]?.amountMinor,
        currency: page.payment.currency,
        publicReturn: true,
      }),
    )
    await db
      .updateTable('event_types')
      .set({
        payment: JSON.stringify({
          ...payment,
          prices: [{ durationMinutes: 30, amountMinor: 5050 }],
        }),
      })
      .where('id', '=', eventTypeId)
      .execute()
    const replayAfterPriceEdit = await post(`${base}/checkout`, quote, key)
    expect(replayAfterPriceEdit.status).toBe(200)
    expect(await replayAfterPriceEdit.json()).toEqual(attempt)
    expect(sessionCreations).toHaveBeenCalledTimes(1)
    const token = attempt.statusToken
    const operation = sessionCreations.mock.calls[0]?.[0]
    if (!operation) throw new Error('Expected a dispatched Checkout Session')
    expect(token.startsWith(operation.attemptId)).toBe(true)
    expect(token).not.toContain(operation.bookingId)
    expect(
      await db
        .selectFrom('booking_attendees')
        .select(['sms_consent', 'sms_phone'])
        .where('booking_id', '=', operation.bookingId)
        .executeTakeFirst(),
    ).toEqual({ sms_consent: true, sms_phone: '+14155552671' })
    const pending = await post(statusPath, { token }, undefined, off)
    expect(pending.headers.get('cache-control')).toBe('no-store')
    expect(await pending.json()).toEqual({ status: 'pending_payment' })
    const manageBeforePayment = createHmac('sha256', statusSecret)
      .update(`paid-checkout:manage:${operation.bookingId}:checkout:v1:${key}`)
      .digest('base64url')
    const manage = (manageToken: string) =>
      app.request('/api/v1/bookings/manage', {
        headers: { 'X-Manage-Token': manageToken },
      })
    expect((await manage(manageBeforePayment)).status).toBe(404)
    const dot = token.indexOf('.') + 1
    const replacement = token[dot] === 'a' ? 'b' : 'a'
    expect(
      (await post(statusPath, { token: token.slice(0, dot) + replacement + token.slice(dot + 1) }))
        .status,
    ).toBe(404)
    expect((await post(statusPath, { token, sessionId: 'cs_synthetic_forged' })).status).toBe(400)
    expect(notify).not.toHaveBeenCalled()
    const deliver = await signedPayment(attempt.expiresAt)
    expect((await deliver()).status).toBe(200)
    expect((await deliver()).status).toBe(200)
    const paid = await (await post(statusPath, { token })).json()
    expect(paid).toEqual({ status: 'paid', manageToken: manageBeforePayment })
    const managed = await manage(manageBeforePayment)
    expect(managed.status).toBe(200)
    expect(JSON.stringify(await managed.json())).toContain(
      'https://meeting.example.invalid/private',
    )
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it.each(['cancelled', 'expired'] as const)(
    'keeps a hold %s when payment arrives and reports a requested refund',
    async (status) => {
      const { base, post, quote, signedPayment, notify } = await setup()
      const response = await post(`${base}/checkout`, quote, randomUUID())
      expect(response.status).toBe(200)
      const { statusToken: token, expiresAt } = (await response.json()) as StartedCheckout
      if (status === 'expired')
        await sql`UPDATE checkout_test_clock.frozen SET at = ${expiresAt}`.execute(db)
      expect(await (await post(cancelPath, { token })).json()).toEqual({ status })
      const deliver = await signedPayment(expiresAt)
      expect((await deliver()).status).toBe(200)
      expect(await (await post(statusPath, { token })).json()).toEqual({
        status,
        latePayment: true,
        refundStatus: 'requested',
      })
      expect(notify).not.toHaveBeenCalled()
    },
  )
})
