import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { seedCheckoutHolds } from './payment-checkout-attempt-fixtures.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

async function assertEventPaymentProtection(pool: pg.Pool) {
  const [hold] = await seedCheckoutHolds(pool)
  const update = `UPDATE event_types AS event SET payment = $2::jsonb FROM bookings AS booking
    WHERE booking.id = $1 AND event.id = booking.event_type_id`
  const set = (payment: unknown) => pool.query(update, [hold, JSON.stringify(payment)])
  const price = (currency: string, amountMinor: unknown, durationMinutes = 30) => ({
    currency,
    prices: [{ durationMinutes, amountMinor }],
  })
  for (const invalid of [
    null,
    [],
    { currency: 'usd' },
    { currency: 'usd', prices: [{ durationMinutes: 30 }] },
    price('foo', 5000),
    price('usd', 5000, 45),
    price('usd', 49),
    price('jpy', 50.5),
    price('usd', 100_000_000),
    price('usd', [5000]),
    price('usd', '5000'),
  ]) {
    await expect(set(invalid)).rejects.toMatchObject({
      code: '23514',
      constraint: 'event_types_payment_check',
    })
  }
  await expect(set(price('gbp', 30))).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query(
      `UPDATE event_types AS event SET recurrence = $2::jsonb FROM bookings AS booking
       WHERE booking.id = $1 AND event.id = booking.event_type_id`,
      [hold, JSON.stringify({ timeZone: 'UTC', allowedPatterns: ['weekly'], maxOccurrences: 2 })],
    ),
  ).rejects.toMatchObject({ code: '23514', constraint: 'event_types_payment_check' })
  await expect(pool.query(update, [hold, null])).resolves.toMatchObject({ rowCount: 1 })
}

describe.skipIf(!process.env.DATABASE_URL)('event type payment migration protection', () => {
  it('fails an assertion when any 0191 object is dropped', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: process.env.DATABASE_URL as string,
      migration: '0191_event_type_payment.sql',
      assertions: assertEventPaymentProtection,
    })
    expect(report.problems).toEqual([])
  }, 600_000)
})
