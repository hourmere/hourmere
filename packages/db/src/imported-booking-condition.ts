import { type Expression, sql } from 'kysely'

/** Exclude the complete import-connected set before a bounded worker scan's LIMIT. */
export function importedBookingCondition(bookingId: Expression<unknown>) {
  return sql<boolean>`${bookingId} IN (
    WITH RECURSIVE imported(id,rescheduled_from_id) AS (
      SELECT id,rescheduled_from_id FROM bookings WHERE source = 'import'
      UNION
      SELECT adjacent.id,adjacent.rescheduled_from_id FROM imported current
        JOIN LATERAL (
          SELECT id,rescheduled_from_id FROM bookings WHERE id = current.rescheduled_from_id
          UNION
          SELECT id,rescheduled_from_id FROM bookings WHERE rescheduled_from_id = current.id
        ) adjacent ON true
    )
    SELECT id FROM imported
  )`
}
