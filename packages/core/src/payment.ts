export const PAYMENT_CURRENCIES = ['usd', 'eur', 'gbp', 'cad', 'aud', 'jpy'] as const
export { formatPaymentAmount } from './payment-amount.ts'
export type PaymentCurrency = (typeof PAYMENT_CURRENCIES)[number]

// Card charge floors when the Stripe settlement and price currencies match.
export const PAYMENT_CURRENCY_MINIMUM_MINOR: Record<PaymentCurrency, number> = {
  usd: 50,
  eur: 50,
  gbp: 30,
  cad: 50,
  aud: 50,
  jpy: 50,
}
export const PAYMENT_MAX_MINOR = 99_999_999

export interface EventPayment {
  currency: PaymentCurrency
  prices: { durationMinutes: number; amountMinor: number }[]
}

export const PAYMENT_PROVIDER_AVAILABILITIES = [
  'available',
  'disabled',
  'stripe_not_configured',
  'stripe_unverified',
  'live_mode_unavailable',
] as const
export type PaymentProviderAvailability = (typeof PAYMENT_PROVIDER_AVAILABILITIES)[number]
export type EventPaymentAvailability = PaymentProviderAvailability | 'unsupported_event'

export function isPaidEventSupported(event: {
  personal: boolean
  schedulingType: string
  bookingMode: string
  hostCount: number
  allowGuests: boolean
  waitlistEnabled: boolean
  recurringEnabled?: boolean
  locationKinds: readonly string[]
}): boolean {
  return (
    event.personal &&
    event.schedulingType === 'individual' &&
    event.bookingMode === 'individual' &&
    event.hostCount === 1 &&
    !event.allowGuests &&
    !event.waitlistEnabled &&
    !event.recurringEnabled &&
    event.locationKinds.every((kind) => kind === 'in_person' || kind === 'link')
  )
}
