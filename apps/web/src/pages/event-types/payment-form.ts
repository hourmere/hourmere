import {
  type EventPayment,
  PAYMENT_CURRENCY_MINIMUM_MINOR,
  PAYMENT_MAX_MINOR,
  type PaymentCurrency,
} from '@hourmere/core/payment'
import type { FieldErrors } from '../../components/forms.tsx'
import { type MessageKey, msg, type UiText } from '../../i18n/translate.ts'

export const unsupportedPayment: MessageKey =
  'Paid bookings are available for personal, one-on-one events without additional guests, a waitlist, routing or recurring bookings. Use an in-person location, a saved meeting link or no location.'

export interface PaymentDraft {
  enabled: boolean
  currency: PaymentCurrency
  amounts: Record<number, string>
}

export function paymentFromSettings(payment?: EventPayment | null): PaymentDraft {
  if (!payment) return { enabled: false, currency: 'usd', amounts: {} }
  return {
    enabled: true,
    currency: payment.currency,
    amounts: Object.fromEntries(
      payment.prices.map(({ durationMinutes, amountMinor }) => [
        durationMinutes,
        decimalAmount(amountMinor, payment.currency),
      ]),
    ),
  }
}

function decimalAmount(amountMinor: number, currency: PaymentCurrency): string {
  if (currency === 'jpy') return String(amountMinor)
  const padded = String(amountMinor).padStart(3, '0')
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`
}

function minorAmount(text: string, currency: PaymentCurrency): number {
  const amount = text.trim().normalize('NFKC')
  if (currency === 'jpy') return /^\d+$/.test(amount) ? Number(amount) : NaN
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(amount)
  return match ? Number(`${match[1]}${(match[2] ?? '').padEnd(2, '0')}`) : NaN
}

export function validatePayment(draft: PaymentDraft, durations: number[]): FieldErrors {
  const errors: FieldErrors = {}
  if (!draft.enabled) return errors
  const min = PAYMENT_CURRENCY_MINIMUM_MINOR[draft.currency]
  for (const duration of durations) {
    const value = draft.amounts[duration] ?? ''
    const amount = minorAmount(value, draft.currency)
    let error: UiText | undefined
    if (!value.trim()) error = 'Enter a price for this duration.'
    else if (Number.isNaN(amount))
      error =
        draft.currency === 'jpy'
          ? 'Enter a whole amount.'
          : 'Enter an amount with up to two decimal places.'
    else if (amount < min || amount > PAYMENT_MAX_MINOR)
      error = msg('Enter an amount from {min} to {max} {currency}.', {
        min: decimalAmount(min, draft.currency),
        max: decimalAmount(PAYMENT_MAX_MINOR, draft.currency),
        currency: draft.currency.toUpperCase(),
      })
    if (error) errors[paymentAmountField(duration)] = error
  }
  return errors
}

export function paymentInput(draft: PaymentDraft, durations: number[]): EventPayment | null {
  if (!draft.enabled) return null
  return {
    currency: draft.currency,
    prices: [...durations]
      .sort((a, b) => a - b)
      .map((durationMinutes) => ({
        durationMinutes,
        amountMinor: minorAmount(draft.amounts[durationMinutes] ?? '', draft.currency),
      })),
  }
}

export const paymentAmountField = (duration: number) => `payment-price-${duration}`

export function paymentAmountLabel(duration: number): UiText {
  return msg('Price for {duration}', { duration: msg('{count} min', { count: duration }) })
}
