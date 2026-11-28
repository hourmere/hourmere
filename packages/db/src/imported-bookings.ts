import { sql } from 'kysely'
import type { Db } from './index.ts'

/**
 * Imported policy covers the entire connected reschedule chain. This also closes
 * stale root jobs and malformed legacy successors, without trusting a caller's ID.
 */
export async function importedBookingIds(db: Db, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const result = await sql<{ id: string }>`
    WITH RECURSIVE connected(seed_id,booking_id) AS (
      SELECT id,id FROM bookings WHERE id = ANY(${ids}::uuid[])
        AND EXISTS (SELECT 1 FROM bookings WHERE source = 'import')
      UNION
      SELECT c.seed_id,n.id FROM connected c
        JOIN bookings b ON b.id = c.booking_id
        JOIN LATERAL (
          SELECT id FROM bookings WHERE id = b.rescheduled_from_id
          UNION
          SELECT id FROM bookings WHERE rescheduled_from_id = b.id
        ) n ON true
    )
    SELECT DISTINCT c.seed_id AS id FROM connected c
      JOIN bookings b ON b.id = c.booking_id WHERE b.source = 'import'
  `.execute(db)
  return new Set(result.rows.map((row) => row.id))
}

export async function isImportedBooking(db: Db, bookingId: string): Promise<boolean> {
  return (await importedBookingIds(db, [bookingId])).has(bookingId)
}
