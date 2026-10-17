import type { Db } from '@hourmere/db'
import type { EnqueueOptions } from '@hourmere/jobs'
import { sql } from 'kysely'
import { GOOGLE_CALENDAR_SYNC_SCOPES, GoogleCalendarError } from './google.ts'
import type { GoogleEventWrite } from './google-events.ts'
import type { CalendarDeps } from './index.ts'
import { useGoogleConnection } from './sync.ts'

export const BOOKING_CALENDAR_JOB = 'booking-calendar'
interface BookingEvent {
  bookingId: string
  type?: 'created' | 'rescheduled' | 'cancelled'
}
interface CalendarBookingQueue {
  enqueue(
    name: typeof BOOKING_CALENDAR_JOB,
    payload: { bookingId: string },
    options?: EnqueueOptions,
  ): Promise<string | null>
}
async function rootOf(db: Db, id: string) {
  const result = await sql<{ id: string }>`WITH RECURSIVE chain(id,rescheduled_from_id,depth) AS (
    SELECT id,rescheduled_from_id,0 FROM bookings WHERE id=${id}::uuid
    UNION ALL SELECT b.id,b.rescheduled_from_id,c.depth+1 FROM bookings b JOIN chain c ON b.id=c.rescheduled_from_id
  ) CYCLE id SET is_cycle USING path SELECT id FROM chain WHERE NOT is_cycle ORDER BY depth DESC LIMIT 1`.execute(
    db,
  )
  return result.rows[0]?.id
}
/** Stately queue keeps one follow-up when another change commits during an in-flight write. */
export function calendarBookingNotifier(queue: CalendarBookingQueue) {
  return async (trx: Db, event: BookingEvent) => {
    if (!trx.isTransaction) throw new Error('Calendar jobs require the booking transaction')
    const root = await rootOf(trx, event.bookingId)
    if (root) {
      const destinations =
        event.type === 'cancelled'
          ? []
          : await trx
              .selectFrom('booking_hosts as bh')
              .innerJoin('bookings as b', 'b.id', 'bh.booking_id')
              .innerJoin('profiles as p', 'p.user_id', 'bh.user_id')
              .leftJoin('event_type_hosts as h', (j) =>
                j
                  .onRef('h.event_type_id', '=', 'b.event_type_id')
                  .onRef('h.user_id', '=', 'bh.user_id'),
              )
              .innerJoin('calendars as c', (j) =>
                j.on(
                  sql<boolean>`c.id=coalesce(h.destination_calendar_id,p.destination_calendar_id)`,
                ),
              )
              .innerJoin('calendar_connections as cc', (j) =>
                j.onRef('cc.id', '=', 'c.connection_id').onRef('cc.user_id', '=', 'bh.user_id'),
              )
              .select(['bh.user_id', 'c.id', 'cc.scopes'])
              .where('bh.booking_id', '=', event.bookingId)
              .where('cc.provider', '=', 'google')
              .where('cc.status', '=', 'active')
              .where('c.access_role', '=', 'owner')
              .forKeyShare('c')
              .execute()
      for (const destination of destinations) {
        if (GOOGLE_CALENDAR_SYNC_SCOPES.every((s) => destination.scopes.includes(s)))
          await trx
            .insertInto('booking_calendar_targets')
            .values({
              root_booking_id: root,
              user_id: destination.user_id,
              calendar_id: destination.id,
            })
            .onConflict((oc) => oc.columns(['root_booking_id', 'user_id']).doNothing())
            .execute()
      }
      await queue.enqueue(
        BOOKING_CALENDAR_JOB,
        { bookingId: root },
        { transaction: trx, singletonKey: root },
      )
    }
  }
}

/** Always reconciles the latest booking in a chain; old jobs cannot restore old event times. */
export async function writeBookingCalendar(
  deps: CalendarDeps,
  bookingId: string,
  signal = AbortSignal.timeout(60_000),
) {
  if (!deps.google) return
  const client = deps.google.client
  const root = await rootOf(deps.db, bookingId)
  if (!root) return
  const chain = await sql<{ id: string; depth: number }>`WITH RECURSIVE chain(id,depth) AS (
    SELECT id,0 FROM bookings WHERE id=${root}::uuid
    UNION ALL SELECT b.id,c.depth+1 FROM bookings b JOIN chain c ON b.rescheduled_from_id=c.id
  ) CYCLE id SET is_cycle USING path SELECT id,depth FROM chain WHERE NOT is_cycle ORDER BY depth DESC,id`.execute(
    deps.db,
  )
  const latest = chain.rows[0]
  if (!latest) return
  const mappings = await deps.db
    .selectFrom('booking_calendar_events as bce')
    .innerJoin('calendars as c', 'c.id', 'bce.calendar_id')
    .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
    .select(['c.id', 'c.connection_id', 'cc.user_id'])
    .where(
      'bce.booking_id',
      'in',
      chain.rows.map((r) => r.id),
    )
    .distinct()
    .execute()
  const targets = new Map(mappings.map((m) => [m.id, m]))
  const selected = await deps.db
    .selectFrom('booking_calendar_targets as t')
    .innerJoin('calendars as c', 'c.id', 't.calendar_id')
    .innerJoin('calendar_connections as cc', (j) =>
      j.onRef('cc.id', '=', 'c.connection_id').onRef('cc.user_id', '=', 't.user_id'),
    )
    .select(['c.id', 'c.connection_id', 'cc.user_id'])
    .where('t.root_booking_id', '=', root)
    .where('cc.provider', '=', 'google')
    .execute()
  for (const target of selected) targets.set(target.id, target)
  for (const target of [...targets.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    signal.throwIfAborted()
    await useGoogleConnection(deps, target.connection_id, signal, async (trx, token, userId) => {
      const calendar = await trx
        .selectFrom('calendars')
        .selectAll()
        .where('id', '=', target.id)
        .where('connection_id', '=', target.connection_id)
        .executeTakeFirst()
      if (calendar?.access_role !== 'owner') return
      // Read current truth again after taking the connection lock. A queued follow-up covers
      // a change that commits during this provider call, without locking the booking itself.
      const current = await sql<{
        id: string
        depth: number
        start_at: Date
        end_at: Date
        title: string
        status: string
      }>`WITH RECURSIVE chain(id,depth) AS (
        SELECT id,0 FROM bookings WHERE id=${root}::uuid
        UNION ALL SELECT b.id,c.depth+1 FROM bookings b JOIN chain c ON b.rescheduled_from_id=c.id
      ) CYCLE id SET is_cycle USING path SELECT b.id,c.depth,b.start_at,b.end_at,b.title,b.status FROM chain c JOIN bookings b ON b.id=c.id WHERE NOT c.is_cycle ORDER BY c.depth DESC,b.id LIMIT 1`.execute(
        trx,
      )
      const booking = current.rows[0]
      if (!booking) return
      const host = await trx
        .selectFrom('booking_hosts')
        .select('user_id')
        .where('booking_id', '=', booking.id)
        .where('user_id', '=', userId)
        .executeTakeFirst()
      const confirmed = booking.status === 'confirmed' && Boolean(host)
      const uid = `${root}@hourmere`
      const value: GoogleEventWrite = {
        iCalUID: uid,
        summary: booking.title,
        start: { dateTime: booking.start_at.toISOString() },
        end: { dateTime: booking.end_at.toISOString() },
        sequence: booking.depth + (confirmed ? 0 : 1),
        status: confirmed ? 'confirmed' : 'cancelled',
        transparency: 'opaque',
      }
      const found = await client.findEvent(token, calendar.external_id, uid, signal)
      if (!found && !confirmed) return
      const result = found
        ? await client.updateEvent(token, calendar.external_id, found.id, found.etag, value, signal)
        : await client.importEvent(token, calendar.external_id, value, signal)
      if (result.iCalUID !== uid || (found && found.id !== result.id))
        throw new GoogleCalendarError('provider_unavailable')
      await trx
        .insertInto('booking_calendar_events')
        .values({
          booking_id: booking.id,
          calendar_id: calendar.id,
          external_event_id: result.id,
          etag: result.etag ?? null,
        })
        .onConflict((oc) =>
          oc.columns(['booking_id', 'calendar_id']).doUpdateSet((eb) => ({
            external_event_id: eb.ref('excluded.external_event_id'),
            etag: eb.ref('excluded.etag'),
          })),
        )
        .execute()
      // Update our own mirrored event immediately; rescheduling must not be blocked by the
      // copy of this meeting while the next incremental poll is still pending.
      if (confirmed)
        await trx
          .insertInto('calendar_busy')
          .values({
            calendar_id: calendar.id,
            external_event_id: result.id,
            period: sql<string>`tstzrange(${value.start.dateTime}::timestamptz,${value.end.dateTime}::timestamptz,'[)')`,
          })
          .onConflict((oc) =>
            oc
              .columns(['calendar_id', 'external_event_id'])
              .doUpdateSet((eb) => ({ period: eb.ref('excluded.period') })),
          )
          .execute()
      else
        await trx
          .deleteFrom('calendar_busy')
          .where('calendar_id', '=', calendar.id)
          .where('external_event_id', '=', result.id)
          .execute()
    })
  }
}
