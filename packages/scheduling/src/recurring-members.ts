import type { Db } from '@hourmere/db'
import { sql } from 'kysely'

/** The organization is already locked. Only an authorized member can lock its series. */
export async function lockBookingSeries(
  db: Db,
  bookingId: string,
  organizationId: string,
  hostId?: string,
) {
  let member = db
    .selectFrom('bookings as b')
    .select('b.series_occurrence_id')
    .where('b.id', '=', bookingId)
    .where('b.organization_id', '=', organizationId)
    .where('b.series_occurrence_id', 'is not', null)
    .$narrowType<{ series_occurrence_id: string }>()
  if (hostId !== undefined)
    member = member.where(({ exists, selectFrom }) =>
      exists(
        selectFrom('booking_hosts as h')
          .select('h.booking_id')
          .whereRef('h.booking_id', '=', 'b.id')
          .where('h.user_id', '=', hostId),
      ),
    )
  const booking = await member.executeTakeFirst()
  if (!booking) return undefined
  return db
    .selectFrom('booking_series_occurrences as o')
    .innerJoin('booking_series as s', (join) =>
      join.onRef('s.id', '=', 'o.series_id').onRef('s.organization_id', '=', 'o.organization_id'),
    )
    .select('s.id')
    .where('o.id', '=', booking.series_occurrence_id)
    .where('o.organization_id', '=', organizationId)
    .forNoKeyUpdate('s')
    .executeTakeFirst()
}

/** Caller already holds the series lock. No work is needed for ordinary bookings. */
export async function advanceBookingSeries(
  db: Db,
  organizationId: string,
  occurrenceId: string | null,
): Promise<void> {
  if (!occurrenceId) return
  await db
    .updateTable('booking_series')
    .set({ revision: sql`revision + 1` })
    .where('organization_id', '=', organizationId)
    .where('id', '=', (eb) =>
      eb
        .selectFrom('booking_series_occurrences')
        .select('series_id')
        .where('id', '=', occurrenceId)
        .where('organization_id', '=', organizationId),
    )
    .execute()
}
