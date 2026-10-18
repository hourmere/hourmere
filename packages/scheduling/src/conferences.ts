import type { Db, Json } from '@hourmere/db'
import { sql } from 'kysely'
import type { PublicContext } from './context.ts'
import { DomainError } from './errors.ts'

export const automaticMeet = (location: unknown): boolean =>
  typeof location === 'object' &&
  location !== null &&
  'kind' in location &&
  location.kind === 'google_meet' &&
  'autoCreate' in location &&
  location.autoCreate === true

export interface ConferenceStatus {
  provider: 'google_meet'
  status: 'pending' | 'ready' | 'failed'
  errorCode: string | null
}

export async function conferenceRoot(db: Db, bookingId: string): Promise<string | undefined> {
  const result = await sql<{ id: string }>`WITH RECURSIVE chain(id,rescheduled_from_id,depth) AS (
    SELECT id,rescheduled_from_id,0 FROM bookings WHERE id=${bookingId}::uuid
    UNION ALL SELECT b.id,b.rescheduled_from_id,c.depth+1 FROM bookings b JOIN chain c ON b.id=c.rescheduled_from_id
  ) CYCLE id SET is_cycle USING path SELECT id FROM chain WHERE NOT is_cycle ORDER BY depth DESC LIMIT 1`.execute(
    db,
  )
  return result.rows[0]?.id
}

/** Cache-only eligibility: never wait for provider/credential locks in a booking transaction. */
export async function requireMeetDestination(
  db: Db,
  userId: string,
  eventTypeId?: string,
  enabled = false,
) {
  if (!enabled)
    throw new DomainError(
      'conflict',
      'automatic_meet_disabled',
      'Automatic Google Meet is disabled on this instance.',
    )
  const result = await sql<{ calendar_id: string; connection_id: string }>`
    SELECT c.id AS calendar_id,cc.id AS connection_id FROM profiles p
    LEFT JOIN event_type_hosts h ON h.user_id=p.user_id AND h.event_type_id=${eventTypeId ?? null}::uuid
    JOIN calendars c ON c.id=coalesce(h.destination_calendar_id,p.destination_calendar_id)
    JOIN calendar_connections cc ON cc.id=c.connection_id AND cc.user_id=p.user_id
    WHERE p.user_id=${userId}::uuid AND cc.provider='google' AND cc.status='active'
      AND c.access_role='owner' AND c.supports_google_meet
      AND cc.scopes @> ARRAY['https://www.googleapis.com/auth/calendar.events.owned','https://www.googleapis.com/auth/calendar.events.readonly']::text[]
  `.execute(db)
  const value = result.rows[0]
  if (!value)
    throw new DomainError(
      'conflict',
      'automatic_meet_unavailable',
      'Choose an owned Meet-capable Google calendar and enable calendar synchronization first.',
    )
  return value
}

export function requireSingleMeetHost(schedulingType: string, hosts: readonly string[]) {
  if (schedulingType !== 'individual' || hosts.length !== 1)
    throw new DomainError(
      'invalid',
      'automatic_meet_mode_unsupported',
      'Automatic Google Meet currently supports one individual host only.',
    )
}

/** Called after booking insertion, before its notifier, while booking/host locks are held. */
export async function prepareBookingConference(ctx: PublicContext, trx: Db, bookingId: string) {
  const booking = await trx
    .selectFrom('bookings')
    .select(['location', 'event_type_id', 'organization_id', 'rescheduled_from_id'])
    .where('id', '=', bookingId)
    .executeTakeFirstOrThrow()
  if (!automaticMeet(booking.location)) return
  const root = await conferenceRoot(trx, bookingId)
  if (!root) return
  const existing = await trx
    .selectFrom('booking_conferences')
    .select('root_booking_id')
    .where('root_booking_id', '=', root)
    .executeTakeFirst()
  if (existing) {
    await trx
      .updateTable('booking_conferences')
      .set({
        booking_id: bookingId,
        revision: sql`revision+1`,
        state: 'pending',
        error_code: null,
        attempts: 0,
        next_attempt_at: ctx.now().toString(),
        updated_at: ctx.now().toString(),
      })
      .where('root_booking_id', '=', root)
      .execute()
  } else {
    // No old provider-label booking is ever upgraded through a later reschedule.
    if (booking.rescheduled_from_id) return
    const hosts = await trx
      .selectFrom('booking_hosts')
      .select('user_id')
      .where('booking_id', '=', bookingId)
      .execute()
    const et = await trx
      .selectFrom('event_types')
      .select('scheduling_type')
      .where('id', '=', booking.event_type_id ?? '')
      .executeTakeFirst()
    requireSingleMeetHost(
      et?.scheduling_type ?? '',
      hosts.map((h) => h.user_id),
    )
    const host = hosts[0] as { user_id: string }
    const target = await requireMeetDestination(
      trx,
      host.user_id,
      booking.event_type_id ?? undefined,
      ctx.automaticMeet,
    )
    await trx
      .insertInto('booking_conferences')
      .values({
        root_booking_id: root,
        booking_id: bookingId,
        organization_id: booking.organization_id,
        organizer_user_id: host.user_id,
        ...target,
        next_attempt_at: ctx.now().toString(),
      })
      .execute()
  }
}

/** Lock order is always booking row (already held by caller), then conference intent. */
export async function cancelBookingConference(trx: Db, bookingId: string, now: Temporal.Instant) {
  await trx
    .updateTable('booking_conferences')
    .set({
      revision: sql`revision+1`,
      state: 'pending',
      error_code: null,
      attempts: 0,
      next_attempt_at: now.toString(),
      updated_at: now.toString(),
    })
    .where('booking_id', '=', bookingId)
    .execute()
}

export async function bookingConferenceStates(db: Db, ids: readonly string[]) {
  if (!ids.length) return new Map<string, ConferenceStatus>()
  const rows = await db
    .selectFrom('booking_conferences')
    .select(['booking_id', 'state', 'error_code'])
    .where('booking_id', 'in', ids)
    .execute()
  return new Map(
    rows.map((r) => [
      r.booking_id,
      {
        provider: 'google_meet' as const,
        status: r.state as ConferenceStatus['status'],
        errorCode: r.error_code,
      },
    ]),
  )
}

/** Only resolved data changes asynchronously; it must not affect idempotency fingerprints. */
export function unresolvedLocation(location: Json | null): Json | null {
  return automaticMeet(location) ? { kind: 'google_meet', autoCreate: true } : location
}
