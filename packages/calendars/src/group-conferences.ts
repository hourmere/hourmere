import { randomUUID } from 'node:crypto'
import { conferenceJoinUrl } from '@hourmere/scheduling/conference-url'
import {
  conferenceOrganizerAvailable,
  releaseGroupSeatInvitations,
} from '@hourmere/scheduling/conferences'
import { sql } from 'kysely'
import { runConferenceProviderWork } from './conferences.ts'
import { groupSlotCalendarUid, writeGroupSlotCalendar } from './group-slot-events.ts'
import type { CalendarDeps } from './index.ts'

const clock = (deps: CalendarDeps) => new Date((deps.now ?? Date.now)())

/** Short lease claims commit before provider work. The slot is always the resource owner. */
export async function writeGroupSlotConference(
  deps: CalendarDeps,
  slotId: string,
  signal = AbortSignal.timeout(60_000),
) {
  const claim = await deps.db.transaction().execute(async (trx) => {
    const slot = await trx
      .selectFrom('group_slots')
      .selectAll()
      .where('id', '=', slotId)
      .executeTakeFirst()
    if (!slot) return
    const c = await trx
      .selectFrom('group_slot_conferences')
      .selectAll()
      .where('group_slot_id', '=', slotId)
      .forUpdate()
      .executeTakeFirst()
    const now = clock(deps)
    if (c?.state !== 'pending' || c.next_attempt_at > now || (c.lease_until && c.lease_until > now))
      return
    if (c.attempts >= 12) {
      await trx
        .updateTable('group_slot_conferences')
        .set({
          state: 'failed',
          error_code: 'provider_unavailable',
          lease_id: null,
          lease_until: null,
        })
        .where('group_slot_id', '=', slotId)
        .execute()
      if (slot.state === 'open') await releaseGroupSeatInvitations(trx, slotId, true)
      return
    }
    const lease = randomUUID()
    const create =
      slot.state === 'open' && !c.create_started && !c.external_event_id && !c.zoom_meeting_id
    await trx
      .updateTable('group_slot_conferences')
      .set({
        lease_id: lease,
        lease_until: new Date(now.getTime() + 120_000),
        attempts: c.attempts + 1,
        create_started: c.create_started || create,
      })
      .where('group_slot_id', '=', slotId)
      .execute()
    return {
      ...c,
      lease,
      create,
      create_started: c.create_started || create,
      attempts: c.attempts + 1,
      slot,
    }
  })
  if (!claim) return
  const c = claim
  let outcome =
    c.slot.state === 'open' && c.slot.start_at <= clock(deps)
      ? { error: 'meeting_started', knownNoCreate: c.create }
      : await runConferenceProviderWork(
          deps,
          {
            ...c,
            resourceId: slotId,
            calendarUid: groupSlotCalendarUid(slotId),
            seatCount: c.slot.active_seats,
            booking: {
              title: c.slot.title,
              start_at: c.slot.start_at,
              end_at: c.slot.end_at,
              status: c.slot.state === 'open' ? 'confirmed' : 'cancelled',
            },
          },
          signal,
        )
  if (
    outcome.url &&
    !conferenceJoinUrl(c.provider, outcome.url, outcome.meetingId ?? c.zoom_meeting_id)
  )
    outcome = { ...outcome, url: undefined, error: 'invalid_response' }
  await deps.db.transaction().execute(async (trx) => {
    // Match service order, but never retain slot/intent locks over provider I/O.
    const slot = await trx
      .selectFrom('group_slots')
      .selectAll()
      .where('id', '=', slotId)
      .forUpdate()
      .executeTakeFirst()
    const current = await trx
      .selectFrom('group_slot_conferences')
      .selectAll()
      .where('group_slot_id', '=', slotId)
      .forUpdate()
      .executeTakeFirst()
    if (!slot || !current) return
    // Remember late creation identity only on its original generation so cleanup can
    // find it. This never publishes its URL, changes a new generation or resets attempts.
    const identity = {
      ...(!current.external_event_id && outcome.event
        ? { external_event_id: outcome.event.id }
        : {}),
      ...(!current.zoom_meeting_id && outcome.meetingId
        ? { zoom_meeting_id: outcome.meetingId }
        : {}),
    }
    if (Object.keys(identity).length)
      await trx
        .updateTable('group_slot_conferences')
        .set({
          ...identity,
          ...(slot.state !== 'open' &&
          current.state !== 'pending' &&
          current.attempts < 12 &&
          (!current.lease_until || current.lease_until <= clock(deps))
            ? { state: 'pending', error_code: null, next_attempt_at: clock(deps) }
            : {}),
        })
        .where('group_slot_id', '=', slotId)
        .execute()
    if (current.lease_id !== c.lease || !current.lease_until || current.lease_until <= clock(deps))
      return
    if (
      current.revision !== c.revision ||
      Number(slot.logistics_revision) !== c.revision ||
      current.request_id !== c.request_id ||
      slot.state !== c.slot.state
    ) {
      await trx
        .updateTable('group_slot_conferences')
        .set({ lease_id: null, lease_until: null, next_attempt_at: clock(deps) })
        .where('group_slot_id', '=', slotId)
        .execute()
      return
    }
    if (
      outcome.error === 'ambiguous_create' &&
      !(c.external_event_id || c.zoom_meeting_id) &&
      (current.external_event_id || current.zoom_meeting_id)
    ) {
      await trx
        .updateTable('group_slot_conferences')
        .set({
          state: 'pending',
          error_code: null,
          lease_id: null,
          lease_until: null,
          next_attempt_at: clock(deps),
        })
        .where('group_slot_id', '=', slotId)
        .execute()
      return
    }
    const now = clock(deps)
    const available = slot.state !== 'open' || (await conferenceOrganizerAvailable(trx, current))
    const expired = slot.state === 'open' && slot.start_at <= now
    const error = !available
      ? 'organizer_unavailable'
      : expired
        ? 'meeting_started'
        : (outcome.error ??
          (outcome.pending && c.attempts >= 12 ? 'conference_pending_timeout' : undefined))
    const ready =
      available &&
      !expired &&
      !outcome.error &&
      (Boolean(outcome.url) || outcome.cancelled === true)
    const retryable =
      available &&
      !expired &&
      (outcome.pending || error === 'provider_unavailable') &&
      c.attempts < 12
    const state = ready ? 'ready' : retryable ? 'pending' : 'failed'
    await trx
      .updateTable('group_slot_conferences')
      .set({
        state,
        applied_revision: ready ? c.revision : null,
        join_url: ready && slot.state === 'open' ? (outcome.url ?? null) : null,
        error_code: ready || retryable ? null : (error ?? 'provider_unavailable'),
        lease_id: null,
        lease_until: null,
        ...(outcome.conferencePatchRequestId === c.request_id
          ? { conference_patch_request_id: c.request_id }
          : {}),
        ...(outcome.knownNoCreate ? { create_started: false } : {}),
        next_attempt_at: new Date(
          now.getTime() + Math.min(60_000, 5_000 * 2 ** Math.min(c.attempts, 4)),
        ),
        updated_at: now,
      })
      .where('group_slot_id', '=', slotId)
      .execute()
    if (outcome.event && c.calendar_id) {
      const calendar = await trx
        .selectFrom('calendars')
        .select('id')
        .where('id', '=', c.calendar_id)
        .forKeyShare()
        .executeTakeFirst()
      if (calendar) {
        await sql`INSERT INTO group_slot_calendar_events(group_slot_id,calendar_id,external_event_id,etag,count_revision)
          VALUES (${slotId},${calendar.id},${outcome.event.id},${outcome.event.etag ?? null},${c.slot.count_revision})
          ON CONFLICT(group_slot_id) DO UPDATE SET external_event_id=excluded.external_event_id,etag=excluded.etag`.execute(
          trx,
        )
        if (slot.state === 'open')
          await trx
            .insertInto('calendar_busy')
            .values({
              calendar_id: calendar.id,
              external_event_id: outcome.event.id,
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
            .where('calendar_id', '=', calendar.id)
            .where('external_event_id', '=', outcome.event.id)
            .execute()
      }
    }
    if (outcome.cancelled && c.calendar_id && c.external_event_id)
      await trx
        .deleteFrom('calendar_busy')
        .where('calendar_id', '=', c.calendar_id)
        .where('external_event_id', '=', c.external_event_id)
        .execute()
    if (slot.state === 'open' && (ready || state === 'failed'))
      await releaseGroupSeatInvitations(trx, slotId, state === 'failed')
  })
  // A join may have committed while creation was in flight. Count reconciliation reads
  // current truth and never changes logistics readiness or seat release receipts.
  await writeGroupSlotCalendar(deps, slotId, signal)
}
