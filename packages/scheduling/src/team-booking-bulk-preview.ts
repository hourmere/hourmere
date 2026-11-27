import { type Database, type Db, importedBookingIds } from '@hourmere/db'
import { sql, type Transaction } from 'kysely'
import { bookingPaymentBindings, cancelTeamBookingInTransaction } from './bookings.ts'
import type { BookingNotifier } from './context.ts'

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
export async function teamBookingBulkPreview(
  db: Db,
  organizationId: string,
  bookingIds: string[],
  checkedAt = sql<Date>`clock_timestamp()`,
) {
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
      sql<boolean>`booking.start_at <= ${checkedAt}`.as('started'),
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

type BulkSkip = Exclude<BulkBookingPreviewCode, 'eligible'>

/** The worker already holds team authority and the item fence. Use the ordinary cancellation
 * transaction's series, seat and booking locks before reusing preview's eligibility rules. */
export async function cancelTeamBookingBulkItem(
  trx: Transaction<Database>,
  actor: { userId: string; organizationId: string },
  bookingId: string,
  options: {
    batchId: string
    sessionId: string
    notify: BookingNotifier
    deadline: Date
  },
): Promise<BulkSkip | 'cancelled' | 'processing_failed'> {
  let outcome: BulkSkip | 'cancelled' | 'processing_failed' = 'booking_unavailable'
  await cancelTeamBookingInTransaction(trx, actor, bookingId, Temporal.Now.instant, {
    sessionId: options.sessionId,
    notify: options.notify,
    bulk: {
      batchId: options.batchId,
      async eligibleAt() {
        const { now } = await trx
          .selectNoFrom(sql<Date>`clock_timestamp()`.as('now'))
          .executeTakeFirstOrThrow()
        if (now >= options.deadline) {
          outcome = 'processing_failed'
          return
        }
        const [item] = await teamBookingBulkPreview(
          trx,
          actor.organizationId,
          [bookingId],
          sql`${now}::timestamptz`,
        )
        outcome = item?.code === 'eligible' ? 'cancelled' : (item?.code ?? 'booking_unavailable')
        if (outcome === 'cancelled') return Temporal.Instant.fromEpochMilliseconds(now.getTime())
      },
    },
  })
  return outcome
}
