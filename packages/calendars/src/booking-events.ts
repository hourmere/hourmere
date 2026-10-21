import type { Db } from '@hourmere/db'
import type { EnqueueOptions } from '@hourmere/jobs'
import { sql } from 'kysely'
import { writeConferenceMirrors } from './conference-mirrors.ts'
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
/** Explicit operator retry: one normal bounded job, including updates and cancellations. */
export async function redispatchBookingCalendar(
  db: Db,
  queue: CalendarBookingQueue,
  bookingId: string,
) {
  return db.transaction().execute(async (trx) => {
    const root = await rootOf(trx, bookingId)
    if (!root) throw new Error('Booking no longer exists')
    return queue.enqueue(
      BOOKING_CALENDAR_JOB,
      { bookingId: root },
      { transaction: trx, singletonKey: root },
    )
  })
}

/** Save even revoked destinations: consent recovery must retain the original host choice. */
async function recordBookingDestinations(
  trx: Db,
  bookingId: string,
  root: string,
  connectionId?: string,
) {
  const destinations = await trx
    .selectFrom('booking_hosts as bh')
    .innerJoin('bookings as b', 'b.id', 'bh.booking_id')
    .innerJoin('profiles as p', 'p.user_id', 'bh.user_id')
    .leftJoin('event_type_hosts as h', (j) =>
      j.onRef('h.event_type_id', '=', 'b.event_type_id').onRef('h.user_id', '=', 'bh.user_id'),
    )
    .innerJoin('calendars as c', (j) =>
      j.on(sql<boolean>`c.id=coalesce(h.destination_calendar_id,p.destination_calendar_id)`),
    )
    .innerJoin('calendar_connections as cc', (j) =>
      j.onRef('cc.id', '=', 'c.connection_id').onRef('cc.user_id', '=', 'bh.user_id'),
    )
    .select(['bh.user_id', 'c.id', 'cc.scopes'])
    .where('bh.booking_id', '=', bookingId)
    .where('cc.provider', '=', 'google')
    .$if(Boolean(connectionId), (q) => q.where('cc.id', '=', connectionId as string))
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
}

/** One finite recovery page. Existing targets always take precedence over current settings. */
export async function recoverBookingCalendarPage(
  deps: CalendarDeps,
  connectionId: string,
  after: string | undefined,
  enqueue: (bookingId: string, transaction: Db) => Promise<unknown>,
): Promise<string | undefined> {
  return deps.db.transaction().execute(async (trx) => {
    const connection = await trx
      .selectFrom('calendar_connections')
      .select(['user_id', 'scopes'])
      .where('id', '=', connectionId)
      .where('provider', '=', 'google')
      .where('status', '=', 'active')
      .forKeyShare()
      .executeTakeFirst()
    if (!connection || !GOOGLE_CALENDAR_SYNC_SCOPES.every((s) => connection.scopes.includes(s)))
      return
    const bookings = await trx
      .selectFrom('bookings as b')
      .innerJoin('booking_hosts as bh', 'bh.booking_id', 'b.id')
      .select('b.id')
      .where('bh.user_id', '=', connection.user_id)
      .where('b.status', '=', 'confirmed')
      .where('b.start_at', '>', new Date((deps.now ?? Date.now)()))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('bookings as next')
              .select('next.id')
              .whereRef('next.rescheduled_from_id', '=', 'b.id'),
          ),
        ),
      )
      .$if(Boolean(after), (q) => q.where('b.id', '>', after as string))
      .orderBy('b.id')
      .limit(100)
      .execute()
    for (const booking of bookings) {
      const root = await rootOf(trx, booking.id)
      if (!root) continue
      const automatic = await trx
        .selectFrom('booking_conferences')
        .select('root_booking_id')
        .where('root_booking_id', '=', root)
        .executeTakeFirst()
      if (automatic) continue
      await recordBookingDestinations(trx, booking.id, root, connectionId)
      const missing = await trx
        .selectFrom('booking_calendar_targets as t')
        .innerJoin('calendars as c', 'c.id', 't.calendar_id')
        .leftJoin('booking_calendar_events as e', (j) =>
          j.onRef('e.calendar_id', '=', 'c.id').on('e.booking_id', '=', booking.id),
        )
        .select('t.root_booking_id')
        .where('t.root_booking_id', '=', root)
        .where('t.user_id', '=', connection.user_id)
        .where('c.connection_id', '=', connectionId)
        .where('c.access_role', '=', 'owner')
        .where('e.booking_id', 'is', null)
        .executeTakeFirst()
      if (missing) await enqueue(root, trx)
    }
    return bookings.length === 100 ? bookings.at(-1)?.id : undefined
  })
}

/** Stately queue keeps one follow-up when another change commits during an in-flight write. */
export function calendarBookingNotifier(queue: CalendarBookingQueue) {
  return async (trx: Db, event: BookingEvent) => {
    if (!trx.isTransaction) throw new Error('Calendar jobs require the booking transaction')
    const root = await rootOf(trx, event.bookingId)
    if (root) {
      const automatic = await trx
        .selectFrom('booking_conferences')
        .select('root_booking_id')
        .where('root_booking_id', '=', root)
        .executeTakeFirst()
      if (!automatic && event.type !== 'cancelled')
        await recordBookingDestinations(trx, event.bookingId, root)
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
  signal = AbortSignal.timeout(120_000),
) {
  const root = await rootOf(deps.db, bookingId)
  if (!root) return
  // Automatic roots have exactly one provider-create authority, including unknown imports.
  const automatic = await deps.db
    .selectFrom('booking_conferences')
    .select(['root_booking_id', 'invitation_organizer_email'])
    .where('root_booking_id', '=', root)
    .executeTakeFirst()
  if (automatic) {
    if (automatic.invitation_organizer_email !== null)
      await writeConferenceMirrors(deps, root, signal)
    return
  }
  if (!deps.google) return
  const client = deps.google.client
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
  const failures: unknown[] = []
  for (const target of [...targets.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    signal.throwIfAborted()
    const targetSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    try {
      await useGoogleConnection(
        deps,
        target.connection_id,
        targetSignal,
        async (trx, token, userId) => {
          if (
            await trx
              .selectFrom('booking_conferences')
              .select('root_booking_id')
              .where('root_booking_id', '=', root)
              .executeTakeFirst()
          )
            return
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
          const found = await client.findEvent(token, calendar.external_id, uid, targetSignal)
          if (!found && !confirmed) return
          const result = found
            ? await client.updateEvent(
                token,
                calendar.external_id,
                found.id,
                found.etag,
                value,
                targetSignal,
              )
            : await client.importEvent(token, calendar.external_id, value, targetSignal)
          if (
            (!found && result.iCalUID !== uid) ||
            (found &&
              (found.id !== result.id || (result.iCalUID !== undefined && result.iCalUID !== uid)))
          )
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
                oc.columns(['calendar_id', 'external_event_id']).doUpdateSet((eb) => ({
                  period: eb.ref('excluded.period'),
                  all_day_start: null,
                  all_day_end: null,
                })),
              )
              .execute()
          else
            await trx
              .deleteFrom('calendar_busy')
              .where('calendar_id', '=', calendar.id)
              .where('external_event_id', '=', result.id)
              .execute()
        },
      )
    } catch (error) {
      // A revoked host must not prevent the remaining hosts receiving their copies.
      // Reauthorization explicitly queues recovery for terminal destination failures.
      if (
        error instanceof GoogleCalendarError &&
        (error.code === 'needs_reauth' || error.code === 'permissions_missing')
      )
        continue
      failures.push(error)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Calendar destinations unavailable')
}
