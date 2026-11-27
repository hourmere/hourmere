import {
  type EventPayment,
  type EventPaymentAvailability,
  isPaidEventSupported,
  PAYMENT_CURRENCIES,
  PAYMENT_CURRENCY_MINIMUM_MINOR,
  PAYMENT_MAX_MINOR,
  type PaymentProviderAvailability,
} from '@hourmere/core/payment'
import { z } from 'zod'
import { DomainError } from './errors.ts'

const paymentShape = z.strictObject({
  currency: z.enum(PAYMENT_CURRENCIES),
  prices: z.array(z.strictObject({ durationMinutes: z.int(), amountMinor: z.int() })),
})

export function validateEventPayment(
  value: unknown,
  durations: readonly number[],
): EventPayment | null {
  if (value === null) return null
  const parsed = paymentShape.safeParse(value)
  if (parsed.success) {
    const { currency } = parsed.data
    const prices = parsed.data.prices.toSorted((a, b) => a.durationMinutes - b.durationMinutes)
    if (
      prices.length === durations.length &&
      prices.every(
        ({ durationMinutes, amountMinor }, i) =>
          durationMinutes === durations[i] &&
          amountMinor >= PAYMENT_CURRENCY_MINIMUM_MINOR[currency] &&
          amountMinor <= PAYMENT_MAX_MINOR,
      )
    )
      return { currency, prices }
  }
  throw new DomainError(
    'invalid',
    'invalid_payment_price',
    'Supply one price in supported currency minor units for every offered duration',
  )
}

export function paymentAvailability(
  event: Parameters<typeof isPaidEventSupported>[0],
  provider: PaymentProviderAvailability | undefined,
): EventPaymentAvailability {
  return isPaidEventSupported(event) ? (provider ?? 'stripe_not_configured') : 'unsupported_event'
}

export function assertPaidEventSupported(
  event: Parameters<typeof isPaidEventSupported>[0],
  provider: PaymentProviderAvailability | undefined,
  paymentChanged: boolean,
): void {
  const availability = paymentAvailability(event, provider)
  if (availability === 'unsupported_event')
    throw new DomainError('invalid', 'payment_flow_unsupported')
  if (paymentChanged && availability !== 'available')
    throw new DomainError('conflict', 'payment_settings_unavailable')
}
