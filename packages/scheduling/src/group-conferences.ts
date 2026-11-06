import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import {
  automaticConference,
  automaticZoom,
  conferenceOrganizerAvailable,
  evaluateGoogleWriteDestination,
  requireMeetDestination,
  requireZoomConnection,
} from './conferences.ts'
import type { PublicContext } from './context.ts'
import { DomainError } from './errors.ts'
import { cleanText } from './text.ts'

/** Caller owns the slot lock. Resource ownership never follows an attendee chain. */
export async function prepareGroupSlotConference(ctx: PublicContext, trx: Db, slotId: string) {
  const slot = await trx
    .selectFrom('group_slots')
    .selectAll()
    .where('id', '=', slotId)
    .executeTakeFirstOrThrow()
  if (!automaticConference(slot.location)) return
  const existing = await trx
    .selectFrom('group_slot_conferences')
    .selectAll()
    .where('group_slot_id', '=', slotId)
    .executeTakeFirst()
  if (existing) {
    if (!(await conferenceOrganizerAvailable(trx, existing)))
      throw new DomainError('conflict', 'slot_unavailable', 'This time is not available')
    if (existing.provider === 'zoom') {
      await requireZoomConnection(
        trx,
        existing.organizer_user_id,
        existing.zoom_connection_id,
        ctx.automaticZoom,
        true,
      )
    } else {
      const pinned = await trx
        .selectFrom('calendars as c')
        .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
        .select([
          'c.id as calendar_id',
          'cc.id as connection_id',
          'cc.provider',
          'cc.status',
          'c.access_role',
          'c.supports_google_meet',
          'cc.scopes',
        ])
        .where('c.id', '=', existing.calendar_id ?? '')
        .where('cc.id', '=', existing.connection_id ?? '')
        .where('cc.user_id', '=', existing.organizer_user_id)
        .executeTakeFirst()
      if (
        !ctx.automaticMeet ||
        !evaluateGoogleWriteDestination(
          pinned ? { ...pinned, destination: existing.calendar_id } : undefined,
          true,
        ).eligible
      )
        throw new DomainError('conflict', 'slot_unavailable', 'This time is not available')
    }

    if (existing.state === 'ready' || existing.state === 'failed')
      await releaseGroupSeatInvitations(trx, slotId, existing.state === 'failed')
    return
  }
  const zoom = automaticZoom(slot.location)
  const target = zoom
    ? await requireZoomConnection(
        trx,
        slot.host_user_id,
        slot.zoom_connection_id,
        ctx.automaticZoom,
        true,
      )
    : await requireMeetDestination(
        trx,
        slot.host_user_id,
        slot.event_type_id ?? undefined,
        ctx.automaticMeet,
      )
  const host = await trx
    .selectFrom('auth.user')
    .select(['name', 'email'])
    .where('id', '=', slot.host_user_id)
    .where('emailVerified', '=', true)
    .executeTakeFirst()
  if (!host) throw new DomainError('conflict', 'booking_hosts_unavailable')
  await trx
    .insertInto('group_slot_conferences')
    .values({
      group_slot_id: slotId,
      organization_id: slot.organization_id,
      organizer_user_id: slot.host_user_id,
      provider: zoom ? 'zoom' : 'google_meet',
      invitation_organizer_name: cleanText(host.name, { max: 200 }) ?? 'Host',
      invitation_organizer_email: host.email,
      revision: Number(slot.logistics_revision),
      next_attempt_at: ctx.now().toString(),
      ...target,
    })
    .execute()
}

/** Count-only exits never change logistics readiness or survivors' invitation receipts. */
export async function cancelGroupSlotConference(trx: Db, slotId: string, now: Temporal.Instant) {
  const slot = await trx
    .selectFrom('group_slots')
    .select(['state', 'logistics_revision'])
    .where('id', '=', slotId)
    .executeTakeFirstOrThrow()
  if (slot.state === 'open') return
  await trx
    .updateTable('group_slot_conferences')
    .set({
      revision: Number(slot.logistics_revision),
      state: 'pending',
      error_code: null,
      attempts: 0,
      join_url: null,
      next_attempt_at: now.toString(),
      updated_at: now.toString(),
    })
    .where('group_slot_id', '=', slotId)
    .where('revision', '<', Number(slot.logistics_revision))
    .execute()
}

/** Release only active seat versions; one unique outbox per seat/kind survives retries. */
export async function releaseGroupSeatInvitations(trx: Db, slotId: string, failed = false) {
  await sql`INSERT INTO booking_conference_notifications(booking_id,kind,due_at)
    SELECT b.id, CASE WHEN ${failed} THEN 'conference_failed'
      WHEN b.rescheduled_from_id IS NULL THEN 'confirmed' ELSE 'rescheduled' END, clock_timestamp()
    FROM bookings b JOIN group_slots s ON s.id=b.group_slot_id
    WHERE s.id=${slotId}::uuid AND s.state='open' AND b.status='confirmed'
    ON CONFLICT DO NOTHING`.execute(trx)
  if (!failed) {
    await sql`INSERT INTO booking_conference_notifications(booking_id,kind,due_at)
      SELECT b.id,'reminder',b.start_at-interval '24 hours'
      FROM bookings b JOIN group_slots s ON s.id=b.group_slot_id
      WHERE s.id=${slotId}::uuid AND s.state='open' AND b.status='confirmed'
        AND coalesce(b.notification_snapshot->>'executionMode','legacy_default')='legacy_default'
        AND b.start_at-interval '24 hours' > clock_timestamp()+interval '60 minutes'
      ON CONFLICT DO NOTHING`.execute(trx)
    await sql`UPDATE booking_scheduled_messages m SET next_attempt_at=LEAST(m.next_attempt_at,clock_timestamp())
      FROM bookings b WHERE b.id=m.booking_id AND b.group_slot_id=${slotId}::uuid
        AND b.status='confirmed' AND m.kind='reminder' AND m.state='pending'
        AND m.attempts<13 AND m.due_at<=clock_timestamp() AND m.expires_at>clock_timestamp()`.execute(
      trx,
    )
  }
}
