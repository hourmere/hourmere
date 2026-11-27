import { type Db, importedBookingIds } from '@hourmere/db'
import { sql } from 'kysely'
import { bookingPaymentBindings } from './bookings.ts'

export const BULK_BOOKING_PREVIEW_CODES = [
  'eligible',
  'already_cancelled',
  'booking_started',
  'booking_not_supported',
  'booking_unavailable',
  'booking_host_departed',
] as const

type BulkBookingPreviewCode = (typeof BULK_BOOKING_PREVIEW_CODES)[number]

/** Read bounded, already-proven IDs. Execution must repeat eligibility under its booking locks. */
export async function teamBookingBulkPreview(db: Db, organizationId: string, bookingIds: string[]) {
  const rows = await bookingPaymentBindings(db)
    .select(['booking.id', 'booking.status'])
    .select((eb) =>
      eb
        .or([
          eb('attempt.id', 'is not', null),
          eb('booking.payment_hold_expires_at', 'is not', null),
          eb('booking.payment_confirmed_at', 'is not', null),
          eb('booking.payment_reference', 'is not', null),
        ])
        .as('paid'),
    )
    .select([
      sql<boolean>`booking.start_at <= clock_timestamp()`.as('started'),
      sql<boolean>`EXISTS (
        SELECT 1 FROM unnest(booking.required_host_user_ids) AS host(user_id)
        WHERE NOT EXISTS (
          SELECT 1 FROM auth.member AS member
          WHERE member."organizationId" = booking.organization_id
            AND member."userId" = host.user_id
        )
      )`.as('host_departed'),
    ])
    .where('booking.organization_id', '=', organizationId)
    .where('booking.id', 'in', bookingIds)
    .distinct()
    .execute()
  const imported = await importedBookingIds(
    db,
    rows.map((row) => row.id),
    organizationId,
  )
  const byId = new Map(rows.map((row) => [row.id, row]))
  return bookingIds.map((bookingId): { bookingId: string; code: BulkBookingPreviewCode } => {
    const row = byId.get(bookingId)
    if (!row) return { bookingId, code: 'booking_unavailable' }
    if (row.status === 'cancelled') return { bookingId, code: 'already_cancelled' }
    if (row.status !== 'confirmed' || row.paid || imported.has(bookingId))
      return { bookingId, code: 'booking_not_supported' }
    if (row.started) return { bookingId, code: 'booking_started' }
    if (row.host_departed) return { bookingId, code: 'booking_host_departed' }
    return { bookingId, code: 'eligible' }
  })
}
