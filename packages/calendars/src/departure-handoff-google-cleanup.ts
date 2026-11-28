import { sql } from 'kysely'
import { GoogleCalendarError } from './google.ts'
import type { CalendarDeps } from './index.ts'
import { useGoogleConnection } from './sync.ts'

/** Reconcile only the fixed Google copies of a cancelled handoff source. */
export async function reconcileHandoffGoogleCopies(
  deps: CalendarDeps,
  root: string,
  source: { id: string; depth: number },
  chainIds: string[],
  signal: AbortSignal,
) {
  const targets = await deps.db
    .selectFrom('departure_handoff_calendar_cleanup')
    .select(['calendar_id', 'connection_id', 'status'])
    .where('source_booking_id', '=', source.id)
    .where('provider', '=', 'google')
    .orderBy('calendar_id')
    .execute()
  const google = deps.google
  if (!targets.length || !google) return targets.length > 0

  const failures: unknown[] = []
  for (const target of targets) {
    if (target.status === 'complete') continue
    signal.throwIfAborted()
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    const status = (db: CalendarDeps['db'], value: 'complete' | 'unresolved') =>
      db
        .updateTable('departure_handoff_calendar_cleanup')
        .set({ status: value })
        .where('source_booking_id', '=', source.id)
        .where('calendar_id', '=', target.calendar_id)
        .where('status', '!=', 'complete')
        .execute()

    try {
      const verified = await useGoogleConnection(
        deps,
        target.connection_id,
        deadline,
        async (trx, token, userId) => {
          const calendar = await trx
            .selectFrom('calendars')
            .select(['external_id', 'access_role'])
            .where('id', '=', target.calendar_id)
            .where('connection_id', '=', target.connection_id)
            .executeTakeFirst()
          const booking = await trx
            .selectFrom('bookings')
            .select(['title', 'start_at', 'end_at'])
            .where('id', '=', source.id)
            .where('status', '=', 'cancelled')
            .where(sql<boolean>`required_host_user_ids = ARRAY[${userId}::uuid]`)
            .executeTakeFirst()
          if (!booking || calendar?.access_role !== 'owner') return false
          const saved = await trx
            .selectFrom('booking_calendar_events')
            .select('external_event_id')
            .where('calendar_id', '=', target.calendar_id)
            .where('booking_id', 'in', chainIds)
            .distinct()
            .execute()
          const client = google.client
          const uid = `${root}@hourmere`
          const found = await client.findConferenceEvent(token, calendar.external_id, uid, deadline)
          // An old import may have reached Google without committing a local
          // mapping. An empty listing does not prove the copy was never created.
          if (!found) throw new GoogleCalendarError('provider_unavailable')
          if (saved.length && (saved.length !== 1 || found.id !== saved[0]?.external_event_id))
            return false
          if (found.status !== 'cancelled') {
            if (!found.etag) return false
            const result = await client.updateEvent(
              token,
              calendar.external_id,
              found.id,
              found.etag,
              {
                iCalUID: uid,
                summary: booking.title,
                start: { dateTime: booking.start_at.toISOString() },
                end: { dateTime: booking.end_at.toISOString() },
                sequence: source.depth + 1,
                status: 'cancelled',
                transparency: 'opaque',
              },
              deadline,
            )
            if (result.id !== found.id || result.iCalUID !== uid || result.status !== 'cancelled')
              return false
          }
          await trx
            .deleteFrom('calendar_busy')
            .where('calendar_id', '=', target.calendar_id)
            .where('external_event_id', '=', found.id)
            .execute()
          await status(trx, 'complete')
          return true
        },
      )
      if (!verified) await status(deps.db, 'unresolved')
    } catch (error) {
      await status(deps.db, 'unresolved')
      if (
        !(error instanceof GoogleCalendarError) ||
        (error.code !== 'needs_reauth' && error.code !== 'permissions_missing')
      )
        failures.push(error)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Calendar cleanup unavailable')
  return true
}
