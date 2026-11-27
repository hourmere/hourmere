import { formatPaymentAmount } from '@hourmere/core/payment'
import type { Schemas } from '../api/client.ts'
import { useI18n } from '../i18n/runtime.tsx'

type Payment = NonNullable<Schemas['ManagedBooking']['payment']>

export function useBookingPaymentItems(payment: Payment | undefined): [string, string][] {
  const { t, formatLocale } = useI18n()
  if (!payment) return []
  const refund = payment.refundStatus
  return [
    [
      'bookingPayment.label',
      payment.status === 'paid'
        ? t('bookingPayment.paid', { amount: formatPaymentAmount(payment, formatLocale) })
        : t('bookingPayment.unknown'),
    ],
    [
      'bookingPayment.refund',
      refund === 'requested' ||
      refund === 'pending' ||
      refund === 'succeeded' ||
      refund === 'failed'
        ? t(`bookingPayment.${refund}`)
        : t(refund === null ? 'bookingPayment.none' : 'bookingPayment.unknown'),
    ],
  ]
}

/** A successful cancellation and its full-refund request commit together. */
export function cancelledBookingPayment<T extends Payment>(payment: T): T {
  return payment.status === 'paid' && payment.refundStatus === null
    ? { ...payment, refundStatus: 'requested' }
    : payment
}
