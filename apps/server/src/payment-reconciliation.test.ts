import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { checkoutSessionExpiry } from '@hourmere/scheduling'
import { createFixtures } from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileStripePayments } from './payment-reconciliation.ts'
import { StripeConfig } from './stripe-config.ts'
import { createStripeReconciliationProvider } from './stripe-reconciliation.ts'

const databaseUrl = process.env.DATABASE_URL
const accountId = 'acct_hourmerefixture'
const apiKey = ['rk', 'test', 'synthetic'.repeat(4)].join('_')
const signingSecret = ['whsec', 'synthetic'.repeat(4)].join('_')
const config = new StripeConfig(accountId, 'test', apiKey, signingSecret)
const privateEmail = 'private-checkout@example.test'
const amount = 4242
const currency = 'usd'
const list = (data: unknown[], hasMore = false) =>
  Response.json({ object: 'list', data, has_more: hasMore })
const missing = () =>
  Response.json(
    {
      error: {
        code: 'resource_missing',
        message: `Private fixture details ${privateEmail}`,
        type: 'invalid_request_error',
      },
    },
    { status: 404 },
  )

function stripeStub(route: (url: URL) => Response, credentialAccount = accountId) {
  const transport = vi.fn<typeof fetch>(async (input, request) => {
    const url = new URL(String(input))
    expect(url.origin).toBe('https://api.stripe.com')
    expect(request?.method).toBe('GET')
    expect(request?.redirect).toBe('error')
    expect(new Headers(request?.headers).has('Stripe-Account')).toBe(false)
    if (url.pathname === '/v1/account')
      return Response.json({ object: 'account', id: credentialAccount })
    return route(url)
  })
  return { provider: createStripeReconciliationProvider(config, transport), transport }
}

describe.skipIf(!databaseUrl)('Stripe reconciliation (real Postgres, stubbed Stripe HTTP)', () => {
  let database: TestDatabase
  let db: Db
  let organizationId: string
  let eventTypeId: string

  beforeEach(async () => {
    database = await createTestDatabase(databaseUrl as string, undefined, {
      tag: 'stripe_reconcile',
    })
    db = createDb(database.pool)
    const fixtures = createFixtures(db)
    const host = await fixtures.host()
    organizationId = host.organizationId
    eventTypeId = await fixtures.eventType(organizationId, host.userId, { slug: 'reconcile' })
  })

  afterEach(async () => database?.drop())

  async function seed(
    label: string,
    options: {
      status?: 'pending_payment' | 'expired' | 'confirmed' | 'cancelled'
      deadlinePassed?: boolean
      missingSession?: boolean
      noAttempt?: boolean
      account?: string
    } = {},
  ) {
    const status = options.status ?? 'pending_payment'
    const paidLocally = status === 'confirmed' || status === 'cancelled'
    const bookingId = randomUUID()
    const attemptId = randomUUID()
    const sessionId = `cs_test_${label}`
    const paymentReference = `pi_${label}`
    const now = Date.now()
    const deadline = new Date(now + (options.deadlinePassed ? -600_000 : 600_000))
    const booking = {
      organization_id: organizationId,
      event_type_id: eventTypeId,
      start_at: new Date(now + 7_200_000),
      end_at: new Date(now + 9_000_000),
      source: 'web',
      title: privateEmail,
    }
    await db
      .insertInto('bookings')
      .values({
        ...booking,
        id: bookingId,
        status: paidLocally ? 'confirmed' : status,
        payment_hold_expires_at: deadline,
        payment_reference: paidLocally ? paymentReference : null,
      })
      .execute()
    if (status === 'cancelled')
      await db
        .updateTable('bookings')
        .set({ status, cancelled_at: new Date(now) })
        .where('id', '=', bookingId)
        .execute()
    if (!options.noAttempt) {
      await db
        .insertInto('payment_checkout_attempts')
        .values({
          id: attemptId,
          booking_id: bookingId,
          account_id: options.account ?? accountId,
          mode: 'test',
          amount_minor: amount,
          currency,
          idempotency_key: `checkout_${attemptId}`,
          started_at: new Date(deadline.getTime() - 30 * 60_000),
          session_id: options.missingSession ? null : sessionId,
        })
        .execute()
    }

    // Stripe object fixtures keep the IDs and financial fields relevant to reconciliation.
    // https://docs.stripe.com/api/checkout/sessions/object
    // https://docs.stripe.com/api/payment_intents/object
    const session = {
      id: sessionId,
      object: 'checkout.session',
      livemode: false,
      mode: 'payment',
      ui_mode: 'hosted_page',
      amount_total: amount,
      currency,
      expires_at: checkoutSessionExpiry(deadline.toISOString()),
      status: 'complete',
      payment_status: 'paid',
      payment_intent: paymentReference,
      client_reference_id: attemptId,
      metadata: { hourmere_checkout_attempt_id: attemptId, hourmere_booking_id: bookingId },
      customer_details: { email: privateEmail },
    }
    const intent = {
      id: paymentReference,
      object: 'payment_intent',
      livemode: false,
      amount,
      amount_received: amount,
      currency,
      status: 'succeeded',
    }
    return {
      bookingId,
      attemptId,
      session,
      intent,
      async successor() {
        const { id } = await db
          .insertInto('bookings')
          .values({
            ...booking,
            rescheduled_from_id: bookingId,
            status: 'confirmed',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        await db
          .updateTable('payment_checkout_attempts')
          .set({ current_booking_id: id })
          .where('id', '=', attemptId)
          .execute()
        return id
      },
      async obligation(state: 'pending' | 'succeeded' | 'failed') {
        const refundId = `re_${label}`
        const { id } = await db
          .insertInto('payment_refund_obligations')
          .values({
            attempt_id: attemptId,
            account_id: accountId,
            mode: 'test',
            payment_reference: paymentReference,
            amount_minor: amount,
            currency,
            state,
            stripe_refund_id: refundId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        // https://docs.stripe.com/api/refunds/object
        return {
          id: refundId,
          object: 'refund',
          amount,
          currency,
          payment_intent: paymentReference,
          status: state,
          metadata: { hourmere_refund_obligation_id: id },
        }
      },
    }
  }

  const reportCodes = (
    report: Awaited<ReturnType<typeof reconcileStripePayments>>,
    bookingId: string,
  ) =>
    report.findings
      .filter((finding) => finding.bookingId === bookingId)
      .map(({ code }) => code)
      .sort()

  const localState = async () => ({
    bookings: await db.selectFrom('bookings').selectAll().orderBy('id').execute(),
    attempts: await db.selectFrom('payment_checkout_attempts').selectAll().orderBy('id').execute(),
    obligations: await db
      .selectFrom('payment_refund_obligations')
      .selectAll()
      .orderBy('id')
      .execute(),
    events: await db.selectFrom('payment_stripe_events').selectAll().orderBy('event_id').execute(),
  })

  it('compares sessions, captured payments and refund obligations without changing any state', async () => {
    const moved = await seed('moved', { status: 'cancelled' })
    await moved.successor()
    const wrongAssociation = await seed('wrongassoc', { status: 'cancelled' })
    const wrongSuccessor = await wrongAssociation.successor()
    const unrelated = randomUUID()
    await db
      .insertInto('bookings')
      .columns(['id', 'organization_id', 'event_type_id', 'start_at', 'end_at', 'source', 'title'])
      .expression((eb) =>
        eb
          .selectFrom('bookings')
          .select([
            sql<string>`${unrelated}::uuid`.as('id'),
            'organization_id',
            'event_type_id',
            'start_at',
            'end_at',
            'source',
            'title',
          ])
          .where('id', '=', wrongSuccessor),
      )
      .execute()
    await db
      .updateTable('payment_checkout_attempts')
      .set({ current_booking_id: unrelated })
      .where('id', '=', wrongAssociation.attemptId)
      .execute()
    const stale = await seed('stale', { deadlinePassed: true })
    const premature = await seed('premature')
    const late = await seed('late', { status: 'expired', deadlinePassed: true })
    const lost = await seed('lost', { missingSession: true })
    const missingRecords = await seed('missing', { status: 'cancelled' })
    const wrongBinding = await seed('wrongbinding')
    const wrongIntent = await seed('wrongintent', { status: 'confirmed' })
    const refunds = await seed('refunds', { status: 'cancelled' })
    const updatedRefund = await refunds.obligation('pending')
    const missingRefund = await seed('missingrefund', { status: 'cancelled' })
    await missingRefund.obligation('succeeded')
    const failedRefund = await seed('failedrefund', { status: 'cancelled' })
    const wrongRefund = await failedRefund.obligation('failed')
    const unrecordedRefund = await seed('unrecordedrefund', { status: 'cancelled' })
    const externalResult = await unrecordedRefund.obligation('failed')
    await db
      .updateTable('payment_refund_obligations')
      .set({ stripe_refund_id: null, last_error: 'retry_exhausted' })
      .where('id', '=', externalResult.metadata.hourmere_refund_obligation_id)
      .execute()
    const otherAccount = await seed('other', { account: 'acct_other' })
    const noAttempt = await seed('noattempt', { noAttempt: true })
    const providerUnavailable = await seed('unavailable')

    const unpaid = { payment_status: 'unpaid', payment_intent: null }
    const sessions = new Map<
      string,
      Omit<typeof moved.session, 'payment_intent'> & { payment_intent: string | null }
    >([
      ...[
        moved,
        wrongAssociation,
        late,
        refunds,
        missingRefund,
        failedRefund,
        unrecordedRefund,
        wrongIntent,
      ].map(({ session }) => [session.id, session] as const),
      [stale.session.id, { ...stale.session, ...unpaid, status: 'open' }],
      [premature.session.id, { ...premature.session, ...unpaid, status: 'expired' }],
      [
        wrongBinding.session.id,
        { ...wrongBinding.session, expires_at: wrongBinding.session.expires_at - 1 },
      ],
    ])
    const intents = new Map(
      [
        moved,
        wrongAssociation,
        late,
        lost,
        refunds,
        missingRefund,
        failedRefund,
        unrecordedRefund,
        wrongIntent,
      ].map(({ intent }) => [intent.id, intent] as const),
    )
    intents.set(wrongIntent.intent.id, { ...wrongIntent.intent, amount_received: 1 })
    const { provider, transport } = stripeStub((url) => {
      if (url.pathname === '/v1/checkout/sessions') {
        expect(url.searchParams.get('limit')).toBe('100')
        expect(Number(url.searchParams.get('created[lte]'))).toBe(lost.session.expires_at - 1800)
        return list([
          { ...lost.session, id: 'cs_test_unrelated', client_reference_id: null, metadata: {} },
          lost.session,
        ])
      }
      if (url.pathname.startsWith('/v1/checkout/sessions/')) {
        const id = url.pathname.split('/').at(-1) ?? ''
        expect(id).not.toBe(otherAccount.session.id)
        if (id === providerUnavailable.session.id)
          return Response.json(
            { error: { type: 'api_error', message: privateEmail } },
            { status: 500 },
          )
        const session = sessions.get(id)
        return session ? Response.json(session) : missing()
      }
      if (url.pathname.startsWith('/v1/payment_intents/')) {
        const id = url.pathname.split('/').at(-1) ?? ''
        expect(id).not.toBe(wrongBinding.intent.id)
        const intent = intents.get(id)
        return intent ? Response.json(intent) : missing()
      }
      expect(url.pathname).toBe('/v1/refunds')
      const intentId = url.searchParams.get('payment_intent')
      if (intentId === refunds.intent.id)
        return list([
          { ...updatedRefund, status: 'succeeded' },
          { ...updatedRefund, id: 're_dashboard', amount: 200, metadata: {}, status: 'succeeded' },
        ])
      if (intentId === failedRefund.intent.id) return list([{ ...wrongRefund, amount: 123 }])
      if (intentId === unrecordedRefund.intent.id) return list([externalResult])
      return list([])
    })

    const before = await localState()
    const report = await reconcileStripePayments(db, provider)
    expect(report).toMatchObject({
      checkedBookings: 16,
      checkedWebhookFindings: 0,
      stripeError: null,
      nextCursor: null,
    })
    expect(reportCodes(report, moved.bookingId)).toEqual([])
    expect(reportCodes(report, wrongAssociation.bookingId)).toEqual([
      'local_payment_association_mismatch',
    ])
    expect(reportCodes(report, stale.bookingId)).toEqual([
      'local_hold_overdue',
      'stripe_checkout_open_after_release',
    ])
    expect(reportCodes(report, premature.bookingId)).toEqual([
      'stripe_checkout_expired_before_deadline',
    ])
    expect(reportCodes(report, late.bookingId)).toEqual(['stripe_payment_after_release'])
    expect(reportCodes(report, lost.bookingId)).toEqual([
      'local_checkout_session_missing',
      'stripe_payment_unconfirmed',
    ])
    expect(reportCodes(report, missingRecords.bookingId)).toEqual([
      'local_refund_obligation_missing',
      'stripe_checkout_missing',
      'stripe_payment_intent_missing',
    ])
    expect(reportCodes(report, wrongBinding.bookingId)).toEqual([
      'stripe_checkout_binding_mismatch',
    ])
    expect(reportCodes(report, wrongIntent.bookingId)).toEqual(['stripe_payment_intent_mismatch'])
    expect(reportCodes(report, refunds.bookingId)).toEqual([
      'stripe_external_refund',
      'stripe_refund_state_mismatch',
    ])
    expect(reportCodes(report, missingRefund.bookingId)).toEqual(['stripe_refund_missing'])
    expect(reportCodes(report, failedRefund.bookingId)).toEqual([
      'local_refund_failed',
      'stripe_refund_binding_mismatch',
    ])
    expect(
      report.findings.filter(({ bookingId }) => bookingId === unrecordedRefund.bookingId),
    ).toMatchObject([
      { code: 'local_refund_failed', reason: 'retry_exhausted' },
      { code: 'local_stripe_refund_id_missing', refundId: externalResult.id },
    ])
    expect(reportCodes(report, otherAccount.bookingId)).toEqual([
      'local_stripe_account_or_mode_mismatch',
    ])
    expect(reportCodes(report, noAttempt.bookingId)).toEqual(['local_checkout_attempt_missing'])
    expect(reportCodes(report, providerUnavailable.bookingId)).toEqual(['stripe_unavailable'])
    expect(
      transport.mock.calls.filter(([url]) => String(url).endsWith('/v1/account')),
    ).toHaveLength(1)
    expect(JSON.stringify(report)).not.toContain(privateEmail)
    expect(JSON.stringify(report)).not.toContain(apiKey)
    expect(await localState()).toEqual(before)
  })

  it('pages signed binding findings by account and never reads another merchant', async () => {
    const booking = await seed('own')
    const { provider, transport } = stripeStub(() => {
      throw new Error('Account binding must precede Stripe resource reads')
    }, 'acct_different')
    const mismatch = {
      finding: 'checkout_binding_mismatch',
      account_id: accountId,
      mode: 'test',
      session_id: booking.session.id,
      payment_reference: booking.intent.id,
    }
    await db
      .insertInto('payment_stripe_events')
      .values([
        { ...mismatch, event_id: 'evt_1' },
        { ...mismatch, event_id: 'evt_2' },
        { ...mismatch, account_id: 'acct_other', event_id: 'evt_3' },
        { ...mismatch, mode: 'live', event_id: 'evt_4' },
        { event_id: 'evt_5' },
      ])
      .execute()

    const first = await reconcileStripePayments(db, provider, { limit: 1 })
    expect(first).toEqual({
      checkedBookings: 1,
      checkedWebhookFindings: 0,
      stripeError: 'stripe_account_mismatch',
      nextCursor: `booking:${booking.bookingId}`,
      findings: [],
    })
    const second = await reconcileStripePayments(db, provider, {
      limit: 1,
      after: first.nextCursor ?? '',
    })
    expect(second).toMatchObject({
      checkedBookings: 0,
      checkedWebhookFindings: 1,
      nextCursor: 'event:evt_1',
      findings: [{ code: 'signed_paid_checkout_binding_mismatch', eventId: 'evt_1' }],
    })
    const third = await reconcileStripePayments(db, provider, {
      limit: 1,
      after: second.nextCursor ?? '',
    })
    expect(third).toMatchObject({
      checkedBookings: 0,
      checkedWebhookFindings: 1,
      nextCursor: null,
      findings: [{ code: 'signed_paid_checkout_binding_mismatch', eventId: 'evt_2' }],
    })
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('bounds provider scans and only reports missing records after complete scans', async () => {
    const unresolved = await seed('unresolved', { missingSession: true })
    const manyRefunds = await seed('manyrefunds', { status: 'cancelled' })
    const refund = await manyRefunds.obligation('pending')
    let sessionPages = 0
    let refundPages = 0
    const { provider } = stripeStub((url) => {
      const after = url.searchParams.get('starting_after')
      if (url.pathname === '/v1/checkout/sessions') {
        expect(after).toBe(sessionPages ? `cs_test_unrelated${sessionPages}` : null)
        sessionPages++
        return list(
          [
            {
              ...unresolved.session,
              id: `cs_test_unrelated${sessionPages}`,
              client_reference_id: null,
              metadata: {},
            },
          ],
          true,
        )
      }
      if (url.pathname === `/v1/checkout/sessions/${manyRefunds.session.id}`)
        return Response.json(manyRefunds.session)
      if (url.pathname === `/v1/payment_intents/${manyRefunds.intent.id}`)
        return Response.json(manyRefunds.intent)
      expect(url.pathname).toBe('/v1/refunds')
      expect(after).toBe(refundPages ? `re_unrelated${refundPages}` : null)
      refundPages++
      return list([{ ...refund, id: `re_unrelated${refundPages}`, metadata: {} }], true)
    })

    const report = await reconcileStripePayments(db, provider)
    expect(sessionPages).toBe(3)
    expect(refundPages).toBe(3)
    expect(reportCodes(report, unresolved.bookingId)).toEqual(['stripe_checkout_scan_incomplete'])
    expect(reportCodes(report, manyRefunds.bookingId)).toEqual([
      'stripe_external_refund',
      'stripe_refund_scan_incomplete',
    ])
  })
})
