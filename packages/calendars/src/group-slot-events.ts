import { sql } from 'kysely'
import { GoogleCalendarError } from './google.ts'
import type { GoogleEventWrite } from './google-events.ts'
import type { CalendarDeps } from './index.ts'
import { useGoogleConnection } from './sync.ts'

/** A slot owns its identity independently of every seat chain. */
export const groupSlotCalendarUid = (slotId: string) => `group-${slotId}@hourmere`

/** Reconcile current truth under the provider connection lock, never a slot/host lock. */
export async function writeGroupSlotCalendar(
  deps: CalendarDeps,
  slotId: string,
  signal = AbortSignal.timeout(120_000),
) {
  if (!deps.google) return
  const target = await deps.db
    .selectFrom('group_slots as s')
    .leftJoin('group_slot_conferences as conference', 'conference.group_slot_id', 's.id')
    .innerJoin('calendars as c', (join) =>
      join.on(
        sql<boolean>`c.id=CASE WHEN conference.provider='google_meet' THEN conference.calendar_id ELSE s.destination_calendar_id END`,
      ),
    )
    .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
    .select(['c.id', 'c.connection_id'])
    .where('s.id', '=', slotId)
    .where('cc.provider', '=', 'google')
    .whereRef('cc.user_id', '=', 's.host_user_id')
    .executeTakeFirst()
  if (!target) return
  const client = deps.google.client
  await useGoogleConnection(deps, target.connection_id, signal, async (trx, token, userId) => {
    const slot = await trx
      .selectFrom('group_slots as s')
      .leftJoin('group_slot_conferences as conference', 'conference.group_slot_id', 's.id')
      .innerJoin('calendars as c', (join) =>
        join.on(
          sql<boolean>`c.id=CASE WHEN conference.provider='google_meet' THEN conference.calendar_id ELSE s.destination_calendar_id END`,
        ),
      )
      .select([
        's.id',
        's.title',
        's.start_at',
        's.end_at',
        's.state',
        's.active_seats',
        's.count_revision',
        's.host_user_id',
        's.location',
        'c.external_id',
        'c.access_role',
        'conference.provider',
        'conference.state as conference_state',
        'conference.revision as conference_revision',
        'conference.applied_revision',
        'conference.external_event_id',
      ])
      .where('s.id', '=', slotId)
      .where('c.id', '=', target.id)
      .executeTakeFirst()
    if (!slot || slot.host_user_id !== userId || slot.access_role !== 'owner') return
    const active =
      slot.state === 'open' &&
      slot.active_seats > 0 &&
      Boolean(
        await trx
          .selectFrom('booking_hosts')
          .select('id')
          .where('group_slot_id', '=', slotId)
          .where('user_id', '=', userId)
          .executeTakeFirst(),
      )
    const uid = groupSlotCalendarUid(slotId)
    if (
      slot.location &&
      typeof slot.location === 'object' &&
      !Array.isArray(slot.location) &&
      slot.location.autoCreate === true &&
      !slot.provider
    )
      return
    const isMeet = slot.provider === 'google_meet'
    // Count-only writes never become a second conference-create/cleanup authority.
    if (
      slot.provider &&
      active &&
      (slot.conference_state !== 'ready' || slot.applied_revision !== slot.conference_revision)
    )
      return
    if (isMeet && (!active || !slot.external_event_id)) return
    const mapping = isMeet
      ? await trx
          .selectFrom('group_slot_calendar_events')
          .select(['external_event_id', 'calendar_id'])
          .where('group_slot_id', '=', slotId)
          .executeTakeFirst()
      : undefined
    if (
      isMeet &&
      (mapping?.external_event_id !== slot.external_event_id || mapping?.calendar_id !== target.id)
    )
      return
    const found =
      isMeet && slot.external_event_id
        ? await client.getConferenceEvent(token, slot.external_id, slot.external_event_id, signal)
        : await client.findEvent(token, slot.external_id, uid, signal)
    if (isMeet && (found?.iCalUID !== uid || found.status === 'cancelled'))
      throw new GoogleCalendarError('provider_unavailable')
    if (!found && (!active || isMeet)) return
    // The title and count are the entire provider projection: no roster, answers,
    // mailboxes, capabilities, per-seat IDs or seat-owned calendar UIDs.
    const value: GoogleEventWrite = {
      iCalUID: uid,
      summary: slot.title,
      description: String(slot.active_seats),
      start: { dateTime: slot.start_at.toISOString() },
      end: { dateTime: slot.end_at.toISOString() },
      sequence: Number(slot.count_revision),
      status: active ? 'confirmed' : 'cancelled',
      transparency: 'opaque',
      visibility: 'private',
    }
    const result = found
      ? await client.updateEvent(token, slot.external_id, found.id, found.etag, value, signal)
      : await client.importEvent(token, slot.external_id, value, signal)
    if (
      (!found && result.iCalUID !== uid) ||
      (found &&
        (result.id !== found.id || (result.iCalUID !== undefined && result.iCalUID !== uid)))
    )
      throw new GoogleCalendarError('provider_unavailable')
    await sql`INSERT INTO group_slot_calendar_events
      (group_slot_id,calendar_id,external_event_id,etag,count_revision)
      VALUES (${slotId},${target.id},${result.id},${result.etag ?? null},${slot.count_revision})
      ON CONFLICT(group_slot_id) DO UPDATE SET external_event_id=excluded.external_event_id,
        etag=excluded.etag,count_revision=excluded.count_revision`.execute(trx)
    if (active)
      await trx
        .insertInto('calendar_busy')
        .values({
          calendar_id: target.id,
          external_event_id: result.id,
          period: sql<string>`tstzrange(${slot.start_at}::timestamptz,${slot.end_at}::timestamptz,'[)')`,
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
        .where('calendar_id', '=', target.id)
        .where('external_event_id', '=', result.id)
        .execute()
  })
}
