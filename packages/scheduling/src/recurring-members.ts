import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { meetingPollChainLinked } from './meeting-poll-outcomes.ts'

/**
 * Reads a booking's series link before the caller takes any lock. The link never changes
 * after insert, so ordinary bookings need no further query while locks are held.
 */
export async function bookingSeriesOccurrence(
  db: Db,
  bookingId: string,
  organizationId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('bookings')
    .select('series_occurrence_id')
    .where('id', '=', bookingId)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()
  return row?.series_occurrence_id ?? null
}

/**
 * bookingSeriesOccurrence and bookingMeetingPollLinked as one unlocked statement, for
 * cancel and reschedule entry points that need both before their first lock. A booking
 * this statement cannot see yet reports a possible poll link (rechecked under the lock)
 * and no series, like bookingSeriesOccurrence: series links are fixed at insert.
 */
export async function bookingPreLockLinks(
  db: Db,
  bookingId: string,
  organizationId: string,
): Promise<{ seriesOccurrenceId: string | null; meetingPollLinked: boolean }> {
  const row = await db
    .selectFrom('bookings')
    .select(['series_occurrence_id', meetingPollChainLinked(bookingId).as('linked')])
    .where('id', '=', bookingId)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()
  return row
    ? { seriesOccurrenceId: row.series_occurrence_id, meetingPollLinked: row.linked }
    : { seriesOccurrenceId: null, meetingPollLinked: true }
}

/**
 * The organization is already locked. Ordinary bookings (no occurrence) return at once,
 * without a query. Only an authorized member can lock its series; membership is checked
 * again here, under the organization lock.
 */
export async function lockBookingSeries(
  db: Db,
  occurrenceId: string | null,
  bookingId: string,
  organizationId: string,
  hostId?: string,
) {
  if (!occurrenceId) return undefined
  let member = db
    .selectFrom('bookings as b')
    .select('b.series_occurrence_id')
    .where('b.id', '=', bookingId)
    .where('b.organization_id', '=', organizationId)
    .where('b.series_occurrence_id', '=', occurrenceId)
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
