import { createHmac, timingSafeEqual } from 'node:crypto'
import { type Db, isImportedBooking } from '@hourmere/db'
import type { EnqueueOptions } from '@hourmere/jobs'
import { buildIcs, foldIcsLine } from '@hourmere/mail/ics'
import { sql } from 'kysely'
import { type CalDavCredentials, readCalDavCredentials } from './caldav-credentials.ts'
import { removeCalDavSyncedResource } from './caldav-sync.ts'
import { CalDavError } from './caldav-transport.ts'
import type { CalDavWriteClient } from './caldav-write-client.ts'
import { calendarEncryptionKey } from './credentials.ts'

export interface CalDavWritebackDeps {
  db: Db
  client: CalDavWriteClient
  encryptionKey: string
  now?: () => number
}
export type CalDavBookingPayload = { bookingId: string } | { groupSlotId: string }
export const CALDAV_BOOKING_JOB = 'caldav-booking'
interface Queue {
  enqueue(
    name: typeof CALDAV_BOOKING_JOB,
    payload: CalDavBookingPayload,
    options?: EnqueueOptions,
  ): Promise<string | null>
}
async function rootOf(db: Db, id: string) {
  const rows = await sql<{ id: string }>`WITH RECURSIVE chain(id,rescheduled_from_id,depth) AS (
    SELECT id,rescheduled_from_id,0 FROM bookings WHERE id=${id}::uuid
    UNION ALL SELECT b.id,b.rescheduled_from_id,c.depth+1 FROM bookings b JOIN chain c ON b.id=c.rescheduled_from_id
  ) CYCLE id SET is_cycle USING path SELECT id FROM chain WHERE NOT is_cycle ORDER BY depth DESC LIMIT 1`.execute(
    db,
  )
  return rows.rows[0]?.id
}
/** Internal opt-in callback only: application workers do not register CalDAV yet. */
export function calDavBookingNotifier(queue: Queue) {
  return async (
    trx: Db,
    event: { bookingId: string; type?: 'created' | 'rescheduled' | 'cancelled' },
  ) => {
    if (!trx.isTransaction) throw new Error('Calendar jobs require the booking transaction')
    if (await isImportedBooking(trx, event.bookingId)) return
    const booking = await trx
      .selectFrom('bookings')
      .select(['group_slot_id', 'rescheduled_from_id'])
      .where('id', '=', event.bookingId)
      .executeTakeFirst()
    if (booking?.group_slot_id) {
      const slots = new Set([booking.group_slot_id])
      if (booking.rescheduled_from_id) {
        const previous = await trx
          .selectFrom('bookings')
          .select('group_slot_id')
          .where('id', '=', booking.rescheduled_from_id)
          .executeTakeFirst()
        if (previous?.group_slot_id) slots.add(previous.group_slot_id)
      }
      for (const groupSlotId of [...slots].sort())
        await queue.enqueue(
          CALDAV_BOOKING_JOB,
          { groupSlotId },
          { transaction: trx, singletonKey: `group:${groupSlotId}` },
        )
      return
    }
    const root = await rootOf(trx, event.bookingId)
    if (!root) return
    if (event.type !== 'cancelled') {
      const targets = await trx
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
        .select(['c.id', 'bh.user_id'])
        .where('bh.booking_id', '=', event.bookingId)
        .where('cc.provider', '=', 'caldav')
        .where('c.access_role', '=', 'writer')
        .forKeyShare('c')
        .execute()
      for (const target of targets)
        await trx
          .insertInto('booking_calendar_targets')
          .values({ root_booking_id: root, user_id: target.user_id, calendar_id: target.id })
          .onConflict((oc) => oc.columns(['root_booking_id', 'user_id']).doNothing())
          .execute()
    }
    await queue.enqueue(
      CALDAV_BOOKING_JOB,
      { bookingId: root },
      { transaction: trx, singletonKey: root },
    )
  }
}

type Desired = {
  id: string
  root: string
  uid: string
  sequence: number
  title: string
  description?: string
  start: Date
  end: Date
  active: boolean
  group: boolean
}
function bodyFor(value: Desired, key: string, calendarId: string) {
  // Reuse the invitation generator's escaping/folding and UTC serialization. A stored
  // private copy has no scheduling METHOD, ORGANIZER or ATTENDEE (no provider emails).
  const generated = buildIcs({
    method: 'REQUEST',
    uid: value.uid,
    sequence: value.sequence,
    stamp: Temporal.Instant.from(value.start.toISOString()),
    start: Temporal.Instant.from(value.start.toISOString()),
    end: Temporal.Instant.from(value.end.toISOString()),
    summary: value.title,
    description: value.description,
    organizer: { name: '', email: '' },
    attendees: [],
  })
  const lines = generated
    .replace(/\r\n[ \t]/g, '')
    .split('\r\n')
    .filter((line) => line && !line.startsWith('METHOD:') && !line.startsWith('ORGANIZER;'))
  lines.splice(lines.indexOf('END:VEVENT'), 0, `X-HOURMERE-RESOURCE:${value.root}`, 'CLASS:PRIVATE')
  const unsigned = `${lines.map(foldIcsLine).join('\r\n')}\r\n`
  const signature = signatureFor(unsigned, key, calendarId)
  lines.splice(lines.indexOf('END:VEVENT'), 0, `X-HOURMERE-SIGNATURE:${signature}`)
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`
}
/** Provider folding/order/stamps may change; other VEVENT properties are meaningful edits. */
function comparable(body: string): string | undefined {
  if (Buffer.byteLength(body) > 1_048_576) return
  const lines = body
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter(Boolean)
  if (
    lines.filter((l) => l.toUpperCase() === 'BEGIN:VEVENT').length !== 1 ||
    lines.filter((l) => l.toUpperCase() === 'END:VEVENT').length !== 1
  )
    return
  const start = lines.findIndex((l) => l.toUpperCase() === 'BEGIN:VEVENT'),
    end = lines.findIndex((l) => l.toUpperCase() === 'END:VEVENT')
  if (end <= start) return
  const event = lines.slice(start + 1, end)
  if (event.some((l) => /^(BEGIN|END):/i.test(l))) return
  return JSON.stringify(event.filter((l) => !/^(DTSTAMP|LAST-MODIFIED|CREATED):/i.test(l)).sort())
}
function signatureFor(body: string, key: string, calendarId: string) {
  const unsigned = body
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter((line) => !line.startsWith('X-HOURMERE-SIGNATURE:'))
    .join('\n')
  return createHmac('sha256', calendarEncryptionKey(key))
    .update(JSON.stringify([calendarId, comparable(unsigned)]))
    .digest('hex')
}
function owned(body: string, key: string, calendarId: string, value: Desired) {
  const lines = body
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
  const signatures = lines.filter((line) => line.startsWith('X-HOURMERE-SIGNATURE:'))
  const actual = signatures[0]?.slice('X-HOURMERE-SIGNATURE:'.length)
  const sequences = lines.filter((line) => line.startsWith('SEQUENCE:'))
  const sequence = Number(sequences[0]?.slice('SEQUENCE:'.length))
  if (
    signatures.length !== 1 ||
    !actual ||
    !/^[a-f0-9]{64}$/.test(actual) ||
    sequences.length !== 1 ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    sequence > value.sequence ||
    !lines.includes(`UID:${value.uid}`) ||
    !lines.includes(`X-HOURMERE-RESOURCE:${value.root}`) ||
    comparable(body) === undefined
  )
    return false
  return timingSafeEqual(
    Buffer.from(actual, 'hex'),
    Buffer.from(signatureFor(body, key, calendarId), 'hex'),
  )
}
const same = (a: string, b: string) =>
  comparable(a) !== undefined && comparable(a) === comparable(b)
const sanitized = (error: unknown) =>
  new CalDavError(error instanceof CalDavError ? error.code : 'unavailable')

async function current(
  db: Db,
  payload: CalDavBookingPayload,
  root: string,
  userId: string,
): Promise<Desired | undefined> {
  if ('groupSlotId' in payload) {
    const slot = await db
      .selectFrom('group_slots')
      .selectAll()
      .where('id', '=', payload.groupSlotId)
      .where('host_user_id', '=', userId)
      .executeTakeFirst()
    if (!slot) return
    // Automatic conference resources retain their separate create authority.
    if (
      slot.location &&
      typeof slot.location === 'object' &&
      !Array.isArray(slot.location) &&
      slot.location.autoCreate === true
    )
      return
    const host = await db
      .selectFrom('booking_hosts')
      .select('id')
      .where('group_slot_id', '=', slot.id)
      .where('user_id', '=', userId)
      .executeTakeFirst()
    return {
      id: slot.id,
      root: slot.id,
      uid: `group-${slot.id}@hourmere`,
      sequence: Number(slot.count_revision),
      title: slot.title,
      description: String(slot.active_seats),
      start: slot.start_at,
      end: slot.end_at,
      active: slot.state === 'open' && slot.active_seats > 0 && Boolean(host),
      group: true,
    }
  }
  const result = await sql<{
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
    db,
  )
  const booking = result.rows[0]
  if (!booking || (await isImportedBooking(db, booking.id))) return
  if (
    await db
      .selectFrom('booking_conferences')
      .select('root_booking_id')
      .where('root_booking_id', '=', root)
      .executeTakeFirst()
  )
    return
  const host = await db
    .selectFrom('booking_hosts')
    .select('id')
    .where('booking_id', '=', booking.id)
    .where('user_id', '=', userId)
    .executeTakeFirst()
  return {
    id: booking.id,
    root,
    uid: root,
    sequence: booking.depth,
    title: booking.title,
    start: booking.start_at,
    end: booking.end_at,
    active: booking.status === 'confirmed' && Boolean(host),
    group: false,
  }
}

async function reconcile(
  deps: CalDavWritebackDeps,
  trx: Db,
  credentials: CalDavCredentials,
  calendarId: string,
  calendarUrl: string,
  value: Desired,
  signal: AbortSignal,
) {
  const resourceUrl = `${calendarUrl.replace(/\/$/, '')}/${value.group ? 'group-' : ''}${value.root}.ics`
  const query = { calendarUrl, resourceUrl }
  const mapping = value.group
    ? await trx
        .selectFrom('group_slot_calendar_events')
        .select(['external_event_id', 'etag'])
        .where('group_slot_id', '=', value.root)
        .where('calendar_id', '=', calendarId)
        .executeTakeFirst()
    : await trx
        .selectFrom('booking_calendar_events as e')
        .innerJoin('bookings as b', 'b.id', 'e.booking_id')
        .select(['e.external_event_id', 'e.etag'])
        .where('e.calendar_id', '=', calendarId)
        .where('e.external_event_id', '=', resourceUrl)
        .orderBy('b.created_at', 'desc')
        .executeTakeFirst()
  if (mapping && mapping.external_event_id !== resourceUrl) throw new CalDavError('conflict')
  if (!value.active && mapping?.etag === null) return
  const body = bodyFor(value, deps.encryptionKey, calendarId)
  let etag: string | null = null
  if (value.active) {
    if (mapping?.etag === null) throw new CalDavError('conflict')
    const found = await deps.client.get(credentials, query, signal)
    if (found && same(found.body, body)) etag = found.etag
    else {
      if (mapping && !found) throw new CalDavError('conflict')
      // Creation cannot adopt an unrelated resource. An acknowledged mapping only
      // first uses the stored strong ETag; only signed revisions permit conflict recovery.
      if (found && !mapping && !owned(found.body, deps.encryptionKey, calendarId, value))
        throw new CalDavError('conflict')
      const result = await deps.client.put(
        credentials,
        { ...query, body, etag: mapping?.etag ?? found?.etag ?? null },
        signal,
      )
      if ('missing' in result) throw new CalDavError('conflict')
      if ('conflict' in result || !result.etag) {
        const actual = await deps.client.get(credentials, query, signal)
        if (!actual) throw new CalDavError('conflict')
        if (same(actual.body, body)) etag = actual.etag
        else {
          // A previous revision may have succeeded with its response lost. A signed,
          // unedited revision is safe to advance, using one bounded conditional retry.
          if (!('conflict' in result) || !owned(actual.body, deps.encryptionKey, calendarId, value))
            throw new CalDavError('conflict')
          const retried = await deps.client.put(
            credentials,
            { ...query, body, etag: actual.etag },
            signal,
          )
          if ('missing' in retried) throw new CalDavError('conflict')
          if ('conflict' in retried || !retried.etag) {
            const latest = await deps.client.get(credentials, query, signal)
            if (!latest || !same(latest.body, body)) throw new CalDavError('conflict')
            etag = latest.etag
          } else etag = retried.etag
        }
      } else etag = result.etag
    }
  } else {
    let previousEtag = mapping?.etag
    if (!mapping) {
      const found = await deps.client.get(credentials, query, signal)
      if (!found) return
      if (!owned(found.body, deps.encryptionKey, calendarId, value))
        throw new CalDavError('conflict')
      previousEtag = found.etag
    }
    const result = await deps.client.delete(
      credentials,
      { ...query, etag: previousEtag as string },
      signal,
    )
    if (result === 'conflict') {
      const actual = await deps.client.get(credentials, query, signal)
      if (actual) {
        // A lost successful update can leave a stale local ETag. Only an authenticated,
        // unedited Hourmere revision may be conditionally retired with the new ETag.
        if (!owned(actual.body, deps.encryptionKey, calendarId, value))
          throw new CalDavError('conflict')
        const retried = await deps.client.delete(
          credentials,
          { ...query, etag: actual.etag },
          signal,
        )
        if (retried === 'conflict' && (await deps.client.get(credentials, query, signal)))
          throw new CalDavError('conflict')
      }
    }
  }
  if (value.group)
    await trx
      .insertInto('group_slot_calendar_events')
      .values({
        group_slot_id: value.root,
        calendar_id: calendarId,
        external_event_id: resourceUrl,
        etag,
        count_revision: value.sequence,
      })
      .onConflict((oc) =>
        oc.column('group_slot_id').doUpdateSet({ etag, count_revision: value.sequence }),
      )
      .execute()
  else
    await trx
      .insertInto('booking_calendar_events')
      .values({
        booking_id: value.id,
        calendar_id: calendarId,
        external_event_id: resourceUrl,
        etag,
      })
      .onConflict((oc) =>
        oc
          .columns(['booking_id', 'calendar_id'])
          .doUpdateSet({ etag, external_event_id: resourceUrl }),
      )
      .execute()
  const calendar = await trx
    .selectFrom('calendars')
    .select(['id', 'sync_state'])
    .where('id', '=', calendarId)
    .executeTakeFirstOrThrow()
  await removeCalDavSyncedResource(trx, calendar, resourceUrl)
  if (!value.active) {
    // All successor receipts refer to this one resource; retain deletion tombstones.
    if (!value.group)
      await trx
        .updateTable('booking_calendar_events')
        .set({ etag: null })
        .where('calendar_id', '=', calendarId)
        .where('external_event_id', '=', resourceUrl)
        .execute()
    await trx
      .deleteFrom('calendar_busy')
      .where('calendar_id', '=', calendarId)
      .where('external_event_id', '=', resourceUrl)
      .execute()
  } else
    await trx
      .insertInto('calendar_busy')
      .values({
        calendar_id: calendarId,
        external_event_id: resourceUrl,
        period: sql<string>`tstzrange(${value.start}::timestamptz,${value.end}::timestamptz,'[)')`,
      })
      .onConflict((oc) =>
        oc.columns(['calendar_id', 'external_event_id']).doUpdateSet({
          period: sql<string>`tstzrange(${value.start}::timestamptz,${value.end}::timestamptz,'[)')`,
          all_day_start: null,
          all_day_end: null,
        }),
      )
      .execute()
}

/** Reconcile latest truth with the same connection lock as busy synchronization. */
export async function writeCalDavBooking(
  deps: CalDavWritebackDeps,
  payload: CalDavBookingPayload,
  outerSignal?: AbortSignal,
): Promise<void> {
  const signal = AbortSignal.any([
    ...(outerSignal ? [outerSignal] : []),
    AbortSignal.timeout(60_000),
  ])
  if ('bookingId' in payload) {
    if (await isImportedBooking(deps.db, payload.bookingId)) return
    const seat = await deps.db
      .selectFrom('bookings')
      .select('group_slot_id')
      .where('id', '=', payload.bookingId)
      .executeTakeFirst()
    if (seat?.group_slot_id)
      return writeCalDavBooking(deps, { groupSlotId: seat.group_slot_id }, signal)
  }
  const root =
    'groupSlotId' in payload ? payload.groupSlotId : await rootOf(deps.db, payload.bookingId)
  if (!root) return
  const targets =
    'groupSlotId' in payload
      ? await deps.db
          .selectFrom('group_slots as s')
          .innerJoin('calendars as c', 'c.id', 's.destination_calendar_id')
          .innerJoin('calendar_connections as cc', (j) =>
            j.onRef('cc.id', '=', 'c.connection_id').onRef('cc.user_id', '=', 's.host_user_id'),
          )
          .select(['c.id', 'cc.id as connection_id', 'cc.user_id'])
          .where('s.id', '=', root)
          .where('cc.provider', '=', 'caldav')
          .execute()
      : await deps.db
          .selectFrom('booking_calendar_targets as t')
          .innerJoin('calendars as c', 'c.id', 't.calendar_id')
          .innerJoin('calendar_connections as cc', (j) =>
            j.onRef('cc.id', '=', 'c.connection_id').onRef('cc.user_id', '=', 't.user_id'),
          )
          .select(['c.id', 'cc.id as connection_id', 'cc.user_id'])
          .where('t.root_booking_id', '=', root)
          .where('cc.provider', '=', 'caldav')
          .execute()
  let failed: CalDavError | undefined
  for (const target of targets.sort((a, b) => a.connection_id.localeCompare(b.connection_id))) {
    try {
      const failure = await deps.db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('auth.user')
          .select('id')
          .where('id', '=', target.user_id)
          .forKeyShare()
          .execute()
        const connection = await trx
          .selectFrom('calendar_connections')
          .selectAll()
          .where('id', '=', target.connection_id)
          .where('provider', '=', 'caldav')
          .where('user_id', '=', target.user_id)
          .forUpdate()
          .executeTakeFirst()
        if (!connection) return
        const calendar = await trx
          .selectFrom('calendars')
          .selectAll()
          .where('id', '=', target.id)
          .where('connection_id', '=', connection.id)
          .executeTakeFirst()
        if (!calendar) return
        try {
          if (connection.status !== 'active') throw new CalDavError('unauthorized')
          const metadata = calendar.sync_state as {
            caldavDiscovery?: { available?: boolean }
          } | null
          if (calendar.access_role !== 'writer' || !metadata?.caldavDiscovery?.available)
            throw new CalDavError('forbidden')
          const credentials = readCalDavCredentials(
            calendarEncryptionKey(deps.encryptionKey),
            connection,
          )
          // A booking may change during network I/O. Reconcile it before committing;
          // a later change also has a transactionally enqueued follow-up job.
          for (let pass = 0; pass < 5; pass++) {
            signal.throwIfAborted()
            const value = await current(trx, payload, root, target.user_id)
            if (!value) return
            await reconcile(
              deps,
              trx,
              credentials,
              calendar.id,
              calendar.external_id,
              value,
              signal,
            )
            const next = await current(trx, payload, root, target.user_id)
            if (JSON.stringify(next) === JSON.stringify(value)) break
            if (pass === 4) throw new CalDavError('unavailable')
          }
          await trx
            .updateTable('calendars')
            .set({
              sync_state: sql`jsonb_set(coalesce(sync_state,'{}'::jsonb),'{caldavWriteback}',${JSON.stringify({ result: 'success', root })}::jsonb)`,
            })
            .where('id', '=', calendar.id)
            .execute()
          await trx
            .updateTable('calendar_connections')
            .set({
              last_error: sql`CASE WHEN EXISTS (SELECT FROM calendars WHERE connection_id=${connection.id} AND sync_state->'caldavWriteback'->>'result' <> 'success') THEN 'provider_unavailable' ELSE NULL END`,
            })
            .where('id', '=', connection.id)
            .execute()
        } catch (error) {
          const failure = sanitized(error)
          await trx
            .updateTable('calendars')
            .set({
              sync_state: sql`jsonb_set(coalesce(sync_state,'{}'::jsonb),'{caldavWriteback}',${JSON.stringify({ result: failure.code, root })}::jsonb)`,
            })
            .where('id', '=', calendar.id)
            .execute()
          await trx
            .updateTable('calendar_connections')
            .set({
              last_error:
                failure.code === 'unauthorized'
                  ? 'needs_reauth'
                  : failure.code === 'forbidden'
                    ? 'permissions_missing'
                    : 'provider_unavailable',
              ...(failure.code === 'unauthorized' ? { status: 'needs_reauth' } : {}),
            })
            .where('id', '=', connection.id)
            .execute()
          return failure
        }
      })
      if (failure && (!failed || ['unauthorized', 'forbidden', 'conflict'].includes(failed.code)))
        failed = failure
    } catch (error) {
      failed = sanitized(error)
      await deps.db
        .updateTable('calendar_connections')
        .set({ last_error: 'provider_unavailable' })
        .where('id', '=', target.connection_id)
        .execute()
        .catch(() => {})
    }
  }
  if (failed) throw failed
}
