import type { Db } from '@hourmere/db'
import { sql } from 'kysely'

export interface BookingPaymentSummary {
  status: 'paid'
  amountMinor: number
  currency: string
  refundStatus: 'requested' | 'pending' | 'succeeded' | 'failed' | null
}

export interface HostBookingPayment extends BookingPaymentSummary {
  stripeDashboardUrl?: string
}

/** Call after the booking has passed the host or invitee read boundary. */
export async function readBookingPayment(db: Db, bookingId: string, organizationId: string) {
  const {
    rows: [row],
  } = await sql<{
    amount_minor: number
    currency: string
    account_id: string
    mode: string
    payment_reference: string
    refund_state: string | null
  }>`
    WITH RECURSIVE chain (id, rescheduled_from_id) AS (
      SELECT id, rescheduled_from_id FROM bookings
        WHERE id = ${bookingId} AND organization_id = ${organizationId}
      UNION ALL
      SELECT b.id, b.rescheduled_from_id FROM bookings b
        JOIN chain c ON b.id = c.rescheduled_from_id
        WHERE b.organization_id = ${organizationId}
    ) CYCLE id SET is_cycle USING path
    SELECT a.amount_minor, a.currency, a.account_id, a.mode, b.payment_reference, r.state AS refund_state
      FROM chain c
      JOIN bookings b ON b.id = c.id
      JOIN payment_checkout_attempts a ON a.booking_id = b.id
      LEFT JOIN payment_refund_obligations r ON r.attempt_id = a.id
      WHERE NOT c.is_cycle AND c.rescheduled_from_id IS NULL
        AND b.payment_confirmed_at IS NOT NULL AND b.payment_reference IS NOT NULL
  `.execute(db)
  if (!row) return undefined

  const refund = row.refund_state
  const summary: BookingPaymentSummary = {
    status: 'paid',
    amountMinor: row.amount_minor,
    currency: row.currency,
    refundStatus:
      refund === 'requested' ||
      refund === 'pending' ||
      refund === 'succeeded' ||
      refund === 'failed'
        ? refund
        : null,
  }
  const stripeDashboardUrl =
    /^acct_[a-zA-Z0-9]+$/.test(row.account_id) && /^pi_[a-zA-Z0-9]+$/.test(row.payment_reference)
      ? `https://dashboard.stripe.com/${row.account_id}/${row.mode === 'test' ? 'test/' : ''}payments/${row.payment_reference}`
      : undefined
  return { summary, stripeDashboardUrl }
}
