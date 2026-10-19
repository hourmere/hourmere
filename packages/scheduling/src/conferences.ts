import type { Db, Json } from '@hourmere/db'
import { sql } from 'kysely'
import type { PublicContext } from './context.ts'
import { DomainError } from './errors.ts'
import { cleanText } from './text.ts'

export const automaticMeet = (location: unknown): boolean =>
  typeof location === 'object' &&
  location !== null &&
  'kind' in location &&
  location.kind === 'google_meet' &&
  'autoCreate' in location &&
  location.autoCreate === true

export const automaticZoom = (location: unknown): boolean =>
  typeof location === 'object' &&
  location !== null &&
  'kind' in location &&
  location.kind === 'zoom' &&
  'autoCreate' in location &&
  location.autoCreate === true
export const automaticConference = (location: unknown): boolean =>
  automaticMeet(location) || automaticZoom(location)
export interface ConferenceWork {
  rootBookingId: string
  organizerUserId: string
  connectionId: string | null
  externalUserId: string | null
  meetingId: string | null
  create: boolean
  createStarted: boolean
  booking: { title: string; start_at: Date; end_at: Date; status: string }
}
export interface ConferenceResult {
  meetingId?: string
  url?: string
  pending?: boolean
  cancelled?: boolean
  error?: string
  knownNoCreate?: boolean
}
/** Cache-only check, never a provider lock/network under booking or host locks. */
export async function requireZoomConnection(
  db: Db,
  user: string,
  id: string | null | undefined,
  enabled = false,
  allowRefreshing = false,
) {
  if (!enabled)
    throw new DomainError(
      'conflict',
      'automatic_zoom_disabled',
      'Automatic Zoom meetings are disabled on this instance.',
    )
  const row = id
    ? await db
        .selectFrom('conference_connections')
        .select(['id', 'external_user_id', 'mode', 'scopes', 'status'])
        .where('id', '=', id)
        .where('user_id', '=', user)
        .where('provider', '=', 'zoom')
        .executeTakeFirst()
    : undefined
  const scopes = [
    'user:read:user',
    'meeting:write:meeting',
    'meeting:read:meeting',
    'meeting:update:meeting',
    'meeting:delete:meeting',
  ]
  if (
    (row?.status !== 'active' && !(allowRefreshing && row?.status === 'refreshing')) ||
    row.mode !== 'meetings' ||
    !row.external_user_id ||
    row.scopes.length !== scopes.length ||
    scopes.some((s, i) => row.scopes[i] !== s)
  )
    throw new DomainError(
      'conflict',
      'automatic_zoom_unavailable',
      'Choose your own connected Zoom account with meeting permissions.',
    )
  return { zoom_connection_id: row.id, zoom_user_id: row.external_user_id }
}
export interface ConferenceStatus {
  provider: 'google_meet' | 'zoom'
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

export type WriteDestination =
  | { eligible: true; calendar_id: string; connection_id: string }
  | {
      eligible: false
      reason:
        | 'not_configured'
        | 'unsupported_provider'
        | 'calendar_unavailable'
        | 'needs_reauth'
        | 'permissions_missing'
        | 'meet_unsupported'
    }

/** Tagged cache-only eligibility; unknown SQL/parse failures are deliberately not caught. */
export async function googleWriteDestination(
  db: Db,
  userId: string,
  eventTypeId?: string,
  meet = false,
): Promise<WriteDestination> {
  const result = await sql<{
    destination: string | null
    calendar_id: string | null
    connection_id: string | null
    provider: string | null
    status: string | null
    access_role: string | null
    supports_google_meet: boolean | null
    scopes: string[] | null
  }>`SELECT coalesce(h.destination_calendar_id,p.destination_calendar_id) AS destination,
      c.id AS calendar_id,cc.id AS connection_id,cc.provider,cc.status,c.access_role,c.supports_google_meet,cc.scopes
    FROM profiles p LEFT JOIN event_type_hosts h ON h.user_id=p.user_id AND h.event_type_id=${eventTypeId ?? null}::uuid
    LEFT JOIN calendars c ON c.id=coalesce(h.destination_calendar_id,p.destination_calendar_id)
    LEFT JOIN calendar_connections cc ON cc.id=c.connection_id AND cc.user_id=p.user_id
    WHERE p.user_id=${userId}::uuid`.execute(db)
  const r = result.rows[0]
  if (!r?.destination) return { eligible: false, reason: 'not_configured' }
  if (!r.calendar_id || !r.connection_id) return { eligible: false, reason: 'calendar_unavailable' }
  if (r.provider !== 'google') return { eligible: false, reason: 'unsupported_provider' }
  if (r.status !== 'active') return { eligible: false, reason: 'needs_reauth' }
  if (r.access_role !== 'owner') return { eligible: false, reason: 'permissions_missing' }
  if (
    !r.scopes ||
    ![
      'https://www.googleapis.com/auth/calendar.events.owned',
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ].every((s) => r.scopes?.includes(s))
  )
    return { eligible: false, reason: 'permissions_missing' }
  if (meet && !r.supports_google_meet) return { eligible: false, reason: 'meet_unsupported' }
  return { eligible: true, calendar_id: r.calendar_id, connection_id: r.connection_id }
}
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
  const value = await googleWriteDestination(db, userId, eventTypeId, true)
  if (!value.eligible)
    throw new DomainError(
      'conflict',
      'automatic_meet_unavailable',
      'Choose an owned Meet-capable Google calendar and enable calendar synchronization first.',
    )
  return { calendar_id: value.calendar_id, connection_id: value.connection_id }
}
export async function eligibleMeetHosts(
  db: Db,
  ids: readonly string[],
  eventTypeId: string | undefined,
  enabled = false,
) {
  if (!enabled)
    throw new DomainError(
      'conflict',
      'automatic_meet_disabled',
      'Automatic Google Meet is disabled on this instance.',
    )
  const eligible: string[] = []
  for (const id of ids)
    if ((await googleWriteDestination(db, id, eventTypeId, true)).eligible) eligible.push(id)
  if (!eligible.length)
    throw new DomainError(
      'conflict',
      'automatic_meet_unavailable',
      'No available host has a Meet-capable owned Google calendar.',
    )
  return eligible
}
export function meetOrganizer(
  mode: string,
  hosts: readonly string[],
  selected: string | null,
): string | undefined {
  if (mode === 'round_robin') {
    if (selected !== null)
      throw new DomainError(
        'invalid',
        'invalid_conference_organizer',
        'Round robin uses the assigned host as organizer.',
      )
    return undefined
  }
  if (mode === 'individual') {
    if (selected !== null)
      throw new DomainError(
        'invalid',
        'invalid_conference_organizer',
        'Individual meetings use their host as organizer.',
      )
    return hosts[0]
  }
  if (!selected || !hosts.includes(selected))
    throw new DomainError(
      'invalid',
      'invalid_conference_organizer',
      'Choose an organizer from the selected required hosts.',
    )
  return selected
}

/** Called after booking insertion, before its notifier, while booking/host locks are held. */
export async function prepareBookingConference(ctx: PublicContext, trx: Db, bookingId: string) {
  const booking = await trx
    .selectFrom('bookings')
    .select(['location', 'event_type_id', 'organization_id', 'rescheduled_from_id'])
    .where('id', '=', bookingId)
    .executeTakeFirstOrThrow()
  if (!automaticConference(booking.location)) return
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
    await trx
      .updateTable('booking_conference_mirrors')
      .set({
        revision: sql`revision+1`,
        state: 'pending',
        error_code: null,
        attempts: 0,
        next_attempt_at: ctx.now().toString(),
      })
      .where('root_booking_id', '=', root)
      .where('calendar_id', 'is not', null)
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
      .select(['scheduling_type', 'conference_organizer_user_id', 'zoom_connection_id'])
      .where('id', '=', booking.event_type_id ?? '')
      .executeTakeFirst()
    const ids = hosts.map((h) => h.user_id)
    const organizer =
      et?.scheduling_type === 'round_robin'
        ? ids[0]
        : meetOrganizer(et?.scheduling_type ?? '', ids, et?.conference_organizer_user_id ?? null)
    if (!organizer || !ids.includes(organizer))
      throw new DomainError('conflict', 'automatic_meet_unavailable')
    const zoom = automaticZoom(booking.location)
    if (zoom && (et?.scheduling_type !== 'individual' || ids.length !== 1))
      throw new DomainError(
        'conflict',
        'automatic_zoom_host_policy',
        'Automatic Zoom requires one explicitly authorized host.',
      )
    const target = zoom
      ? await requireZoomConnection(trx, organizer, et?.zoom_connection_id, ctx.automaticZoom, true)
      : await requireMeetDestination(
          trx,
          organizer,
          booking.event_type_id ?? undefined,
          ctx.automaticMeet,
        )
    const identity = await trx
      .selectFrom('auth.user')
      .select(['name', 'email'])
      .where('id', '=', organizer)
      .where('emailVerified', '=', true)
      .executeTakeFirst()
    if (!identity) throw new DomainError('conflict', 'automatic_meet_unavailable')
    await trx
      .insertInto('booking_conferences')
      .values({
        root_booking_id: root,
        booking_id: bookingId,
        organization_id: booking.organization_id,
        organizer_user_id: organizer,
        provider: zoom ? 'zoom' : 'google_meet',
        invitation_organizer_name: cleanText(identity.name, { max: 200 }) ?? 'Host',
        invitation_organizer_email: identity.email,
        ...target,
        next_attempt_at: ctx.now().toString(),
      })
      .execute()
    for (const userId of ids.filter((id) => zoom || id !== organizer)) {
      const mirror = await googleWriteDestination(trx, userId, booking.event_type_id ?? undefined)
      await trx
        .insertInto('booking_conference_mirrors')
        .values({
          root_booking_id: root,
          user_id: userId,
          calendar_id: mirror.eligible ? mirror.calendar_id : null,
          connection_id: mirror.eligible ? mirror.connection_id : null,
          state: mirror.eligible
            ? 'pending'
            : mirror.reason === 'not_configured'
              ? 'not_configured'
              : 'failed',
          error_code: mirror.eligible
            ? null
            : mirror.reason === 'meet_unsupported'
              ? 'calendar_unavailable'
              : mirror.reason,
          next_attempt_at: ctx.now().toString(),
        })
        .execute()
    }
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
  const root = await conferenceRoot(trx, bookingId)
  if (root)
    await trx
      .updateTable('booking_conference_mirrors')
      .set({
        revision: sql`revision+1`,
        state: 'pending',
        error_code: null,
        attempts: 0,
        next_attempt_at: now.toString(),
      })
      .where('root_booking_id', '=', root)
      .where('calendar_id', 'is not', null)
      .execute()
}

interface BookingConferenceView {
  conference: ConferenceStatus | undefined
  location: Json | null
  bookingStatus: string
  bookingCancelledAt: Date | null
  bookingCancelReason: string | null
}

export async function bookingConferenceViews(db: Db, ids: readonly string[]) {
  if (!ids.length) return new Map<string, BookingConferenceView>()
  const rows = await db
    .selectFrom('bookings as b')
    .leftJoin('booking_conferences as c', 'c.booking_id', 'b.id')
    // Drive hydration from every booking, including a predecessor whose conference
    // pointer moved to its successor after the initial booking read. No extra query
    // or transaction is needed to keep lifecycle, location and readiness together.
    .select([
      'b.id as booking_id',
      'b.status as booking_status',
      'b.location as booking_location',
      'b.cancelled_at as booking_cancelled_at',
      'b.cancel_reason as booking_cancel_reason',
      'c.root_booking_id',
      'c.provider',
      'c.state',
      'c.error_code',
    ])
    .select((eb) =>
      eb
        .or([
          eb('c.invitation_organizer_email', 'is', null),
          eb.exists(
            eb
              .selectFrom('auth.user as u')
              .innerJoin('auth.member as m', 'm.userId', 'u.id')
              .select('u.id')
              .whereRef('u.id', '=', 'c.organizer_user_id')
              .where('u.emailVerified', '=', true)
              .whereRef('m.organizationId', '=', 'c.organization_id')
              .whereRef('u.email', '=', 'c.invitation_organizer_email'),
          ),
        ])
        .as('organizer_available'),
    )
    .where('b.id', 'in', ids)
    .execute()
  const unavailable = new Set<string>()
  for (const r of rows)
    if (r.booking_status === 'confirmed' && !r.organizer_available) unavailable.add(r.booking_id)
  return new Map(
    rows.map((r) => [
      r.booking_id,
      {
        conference: r.root_booking_id
          ? {
              provider: r.provider as ConferenceStatus['provider'],
              status: unavailable.has(r.booking_id)
                ? 'failed'
                : (r.state as ConferenceStatus['status']),
              errorCode: unavailable.has(r.booking_id) ? 'organizer_unavailable' : r.error_code,
            }
          : undefined,
        location: r.booking_location,
        bookingStatus: r.booking_status,
        bookingCancelledAt: r.booking_cancelled_at,
        bookingCancelReason: r.booking_cancel_reason,
      },
    ]),
  )
}

/** Only resolved data changes asynchronously; it must not affect idempotency fingerprints. */
export function unresolvedLocation(location: Json | null): Json | null {
  return automaticConference(location)
    ? { kind: automaticZoom(location) ? 'zoom' : 'google_meet', autoCreate: true }
    : location
}

/** New roots require the exact verified application identity; old0021 roots keep current-ID compatibility. */
export async function conferenceOrganizerAvailable(
  db: Db,
  c: {
    organizer_user_id: string
    organization_id: string
    invitation_organizer_email: string | null
  },
) {
  let q = db
    .selectFrom('auth.user as u')
    .innerJoin('auth.member as m', 'm.userId', 'u.id')
    .select('u.id')
    .where('u.id', '=', c.organizer_user_id)
    .where('u.emailVerified', '=', true)
    .where('m.organizationId', '=', c.organization_id)
  if (c.invitation_organizer_email !== null)
    q = q.where('u.email', '=', c.invitation_organizer_email)
  return Boolean(await q.executeTakeFirst())
}

export interface CalendarCopyStatus {
  status: 'pending' | 'ready' | 'failed' | 'not_configured'
  errorCode: string | null
  canRetry: boolean
}
export async function ownCalendarCopyStates(db: Db, ids: readonly string[], userId: string) {
  if (!ids.length) return new Map<string, CalendarCopyStatus>()
  const rows = await db
    .selectFrom('booking_conference_mirrors as m')
    .innerJoin('booking_conferences as c', 'c.root_booking_id', 'm.root_booking_id')
    .select(['c.booking_id', 'm.state', 'm.error_code', 'm.calendar_id'])
    .where('c.booking_id', 'in', ids)
    .where('m.user_id', '=', userId)
    .execute()
  return new Map(
    rows.map((r) => [
      r.booking_id,
      {
        status: r.state as CalendarCopyStatus['status'],
        errorCode: r.error_code,
        canRetry: r.state === 'failed' && r.calendar_id !== null,
      },
    ]),
  )
}
