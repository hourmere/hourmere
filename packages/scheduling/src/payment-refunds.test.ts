import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { seedCheckoutHolds } from '../../db/src/payment-checkout-attempt-fixtures.ts'
import {
  ensurePaymentRefund,
  type PaymentRefundProvider,
  PaymentRefundProviderError,
  runPaymentRefunds,
} from './payment-refunds.ts'

const serverUrl = process.env.DATABASE_URL
const payment = {
  accountId: 'acct_refunds',
  mode: 'test',
  paymentReference: 'pi_refund_fixture',
  amountMinor: 5000,
  currency: 'usd',
} as const

describe.skipIf(!serverUrl)('durable Stripe refund execution', () => {
  let database: TestDatabase
  let db: Db
  const attemptId = randomUUID()

  beforeAll(async () => {
    database = await createTestDatabase(serverUrl as string)
    db = createDb(database.pool)
    const [bookingId] = await seedCheckoutHolds(database.pool)
    await db
      .updateTable('bookings')
      .set({
        status: 'cancelled',
        cancelled_at: sql`clock_timestamp()`,
        payment_reference: payment.paymentReference,
        payment_refund_required: true,
      })
      .where('id', '=', bookingId as string)
      .execute()
    await db
      .insertInto('payment_checkout_attempts')
      .values({
        id: attemptId,
        booking_id: bookingId as string,
        account_id: payment.accountId,
        mode: payment.mode,
        amount_minor: payment.amountMinor,
        currency: payment.currency,
        idempotency_key: 'fixture_checkout_key',
        started_at: sql`clock_timestamp()`,
        session_id: 'cs_refund_fixture',
      })
      .execute()
  })

  afterEach(async () => {
    await db?.deleteFrom('payment_refund_obligations').execute()
  })
  afterAll(async () => {
    await database?.drop()
  })

  const ensure = () => ensurePaymentRefund(db, { attemptId, ...payment })
  const current = () =>
    db
      .selectFrom('payment_refund_obligations')
      .selectAll()
      .where('attempt_id', '=', attemptId)
      .executeTakeFirstOrThrow()
  const makeDue = () =>
    db
      .updateTable('payment_refund_obligations')
      .set({ next_attempt_at: sql`clock_timestamp()` })
      .where('attempt_id', '=', attemptId)
      .execute()

  type RefundInput = Parameters<PaymentRefundProvider['createRefund']>[0]
  // Stripe Refund result, reduced to the fields consumed by the worker.
  // https://docs.stripe.com/api/refunds/object
  const success = (input: RefundInput) => ({
    ...payment,
    id: 're_refund_fixture',
    obligationId: input.obligationId,
    state: 'succeeded' as const,
  })

  it('claims one obligation across competing workers and never sends it again on replay', async () => {
    await Promise.all([ensure(), ensure()])
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const createRefund = vi.fn(async (input: RefundInput) => {
      entered.resolve()
      await finish.promise
      return success(input)
    })
    const provider = { ...payment, createRefund }
    const first = runPaymentRefunds(db, provider)
    try {
      await entered.promise
      expect(await runPaymentRefunds(db, provider)).toEqual({ attempted: 0, failed: 0 })
    } finally {
      finish.resolve()
      await first
    }
    await ensure()
    expect(await runPaymentRefunds(db, provider)).toEqual({ attempted: 0, failed: 0 })
    expect(createRefund).toHaveBeenCalledTimes(1)
    expect(await current()).toMatchObject({ state: 'succeeded', attempts: 1 })
  })

  it('reuses the same Stripe request identity after an ambiguous response and an expired lease', async () => {
    await ensure()
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const identities = new Set<string>()
    const dispatchChecks: boolean[] = []
    const createRefund = vi.fn(async (input: RefundInput) => {
      identities.add(input.idempotencyKey)
      if (createRefund.mock.calls.length === 1) {
        dispatchChecks.push(await input.canDispatch())
        entered.resolve()
        await finish.promise
        dispatchChecks.push(await input.canDispatch())
        throw new PaymentRefundProviderError(true)
      }
      dispatchChecks.push(await input.canDispatch())
      return success(input)
    })
    const provider = { ...payment, createRefund }
    const original = runPaymentRefunds(db, provider)
    try {
      await entered.promise
      await db
        .updateTable('payment_refund_obligations')
        .set({ lease_expires_at: sql`clock_timestamp()` })
        .where('attempt_id', '=', attemptId)
        .execute()
      expect(await runPaymentRefunds(db, provider)).toEqual({ attempted: 1, failed: 0 })
    } finally {
      finish.resolve()
      await original
    }
    expect(createRefund).toHaveBeenCalledTimes(2)
    expect(identities.size).toBe(1)
    expect(dispatchChecks).toEqual([true, true, false])
    expect(await current()).toMatchObject({
      state: 'succeeded',
      stripe_refund_id: 're_refund_fixture',
      attempts: 2,
      lease_token: null,
      last_error: null,
    })
  })

  it('backs off on transient failures and stops after six attempts', async () => {
    await ensure()
    const createRefund = vi.fn(async () => {
      throw new PaymentRefundProviderError(true)
    })
    const provider = { ...payment, createRefund }
    expect(await runPaymentRefunds(db, provider)).toEqual({ attempted: 1, failed: 0 })
    expect(await current()).toMatchObject({
      state: 'requested',
      last_error: 'provider_unavailable',
    })
    expect(await runPaymentRefunds(db, provider)).toEqual({ attempted: 0, failed: 0 })
    for (let attempt = 2; attempt <= 6; attempt++) {
      await makeDue()
      expect(await runPaymentRefunds(db, provider)).toEqual({
        attempted: 1,
        failed: attempt === 6 ? 1 : 0,
      })
    }
    expect(await current()).toMatchObject({
      attempts: 6,
      state: 'failed',
      last_error: 'retry_exhausted',
    })
    expect(await runPaymentRefunds(db, provider)).toEqual({ attempted: 0, failed: 0 })
    expect(createRefund).toHaveBeenCalledTimes(6)
  })

  it('ends a permanent rejection without retry and only claims its own Stripe account and mode', async () => {
    await ensure()
    const createRefund = vi.fn(async () => {
      throw new PaymentRefundProviderError(false)
    })
    expect(
      await runPaymentRefunds(db, { ...payment, accountId: 'acct_other', createRefund }),
    ).toEqual({ attempted: 0, failed: 0 })
    expect(await runPaymentRefunds(db, { ...payment, mode: 'live', createRefund })).toEqual({
      attempted: 0,
      failed: 0,
    })
    expect(await runPaymentRefunds(db, { ...payment, createRefund })).toEqual({
      attempted: 1,
      failed: 1,
    })
    expect(await current()).toMatchObject({
      attempts: 1,
      state: 'failed',
      last_error: 'provider_rejected',
    })
    expect(createRefund).toHaveBeenCalledTimes(1)
  })

  it('never sends a retry after the Stripe key could have expired during an outage', async () => {
    await ensure()
    await db
      .updateTable('payment_refund_obligations')
      .set({ attempts: 1, first_attempted_at: sql`clock_timestamp() - interval '25 hours'` })
      .where('attempt_id', '=', attemptId)
      .execute()
    const createRefund = vi.fn(async (input: RefundInput) => success(input))
    expect(await runPaymentRefunds(db, { ...payment, createRefund })).toEqual({
      attempted: 0,
      failed: 1,
    })
    expect(createRefund).not.toHaveBeenCalled()
    expect(await current()).toMatchObject({
      attempts: 1,
      state: 'failed',
      last_error: 'retry_window_elapsed',
    })
  })
})
