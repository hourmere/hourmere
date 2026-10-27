import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { bookingPageQuery, encodeBookingCursor, type ListBookingsInput } from './booking-page.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { isUuid } from './internal.ts'
import {
  type TeamAdminBookingPage,
  type TeamAdminBookingRecord,
  toTeamAdminBooking,
} from './team-admin-booking.ts'

const denied = () => new DomainError('forbidden', 'team_management_access_denied')

/** The web access middleware guards its boundary; direct service calls need current facts too. */
async function teamManager(ctx: ServiceContext): Promise<string> {
  const { db, principal } = ctx
  if (
    principal.kind !== 'session' ||
    !isUuid(principal.user.id) ||
    !isUuid(principal.sessionId) ||
    !isUuid(principal.organization.id)
  )
    throw denied()

  const membership = await db
    .selectFrom('auth.session as session')
    .innerJoin('auth.user as user', 'user.id', 'session.userId')
    .innerJoin('auth.member as member', 'member.userId', 'user.id')
    .innerJoin('auth.organization as organization', 'organization.id', 'member.organizationId')
    .select(['organization.id', 'member.role'])
    .where('session.id', '=', principal.sessionId)
    .where('session.userId', '=', principal.user.id)
    .where('session.expiresAt', '>', sql<Date>`clock_timestamp()`)
    .where('user.emailVerified', '=', true)
    .where('organization.id', '=', principal.organization.id)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('personal_organizations')
            .select('organization_id')
            .whereRef('organization_id', '=', 'organization.id'),
        ),
      ),
    )
    .executeTakeFirst()
  const roles = membership?.role.split(',').map((role) => role.trim()) ?? []
  if (!membership || (!roles.includes('owner') && !roles.includes('admin'))) throw denied()
  return membership.id
}

/** Load only the saved hosts and attendees of this authorized page, including inactive hosts. */
async function pageParticipants(db: Db, teamId: string, bookingIds: string[]) {
  const [hosts, attendees] = await Promise.all([
    db
      .selectFrom('booking_hosts as host')
      .innerJoin('bookings as booking', 'booking.id', 'host.booking_id')
      .innerJoin('auth.user as user', 'user.id', 'host.user_id')
      .select(['host.booking_id', 'host.user_id', 'user.name'])
      .where('booking.organization_id', '=', teamId)
      .where('host.booking_id', 'in', bookingIds)
      .orderBy('host.user_id')
      .execute(),
    db
      .selectFrom('booking_attendees as attendee')
      .innerJoin('bookings as booking', 'booking.id', 'attendee.booking_id')
      .select([
        'attendee.booking_id',
        'attendee.name',
        'attendee.email',
        'attendee.time_zone',
        'attendee.is_booker',
      ])
      .where('booking.organization_id', '=', teamId)
      .where('attendee.booking_id', 'in', bookingIds)
      .orderBy('attendee.is_booker', 'desc')
      .orderBy('attendee.id')
      .execute(),
  ])
  const byHost = new Map<string, TeamAdminBookingRecord['hosts'][number][]>()
  const byAttendee = new Map<string, TeamAdminBookingRecord['attendees'][number][]>()
  for (const host of hosts) {
    const saved = byHost.get(host.booking_id) ?? []
    saved.push(host)
    byHost.set(host.booking_id, saved)
  }
  for (const attendee of attendees) {
    const saved = byAttendee.get(attendee.booking_id) ?? []
    saved.push(attendee)
    byAttendee.set(attendee.booking_id, saved)
  }
  return { byHost, byAttendee }
}

/** A team's bookings for a current verified owner/admin session, through the explicit whitelist. */
export async function listTeamAdminBookings(
  ctx: ServiceContext,
  input: ListBookingsInput = {},
): Promise<TeamAdminBookingPage> {
  const teamId = await teamManager(ctx)
  // Page booking rows before loading their hosts: collective meetings occupy one row.
  const { query, limit } = bookingPageQuery(ctx.db, input)
  const rows = await query
    // The composite event/organization foreign key keeps metadata in this booking's team.
    .leftJoin('event_types as event', 'event.id', 'b.event_type_id')
    .select([
      'b.id',
      'b.status',
      'b.start_at',
      'b.end_at',
      'b.cancelled_at',
      'event.id as event_type_id',
    ])
    .select(
      sql<string | null>`CASE WHEN event.deleted_at IS NULL THEN event.title ELSE NULL END`.as(
        'event_type_title',
      ),
    )
    .where('b.organization_id', '=', teamId)
    .execute()

  const page = rows.slice(0, limit)
  if (!page.length) return { data: [], nextCursor: null }
  const last = page.at(-1)
  const { byHost, byAttendee } = await pageParticipants(
    ctx.db,
    teamId,
    page.map((row) => row.id),
  )
  return {
    data: page.map((row) =>
      toTeamAdminBooking({
        id: row.id,
        status: row.status as TeamAdminBookingRecord['status'],
        start_at: row.start_at,
        end_at: row.end_at,
        cancelled_at: row.cancelled_at,
        event_type_id: row.event_type_id,
        event_type_title: row.event_type_title,
        hosts: byHost.get(row.id) ?? [],
        attendees: byAttendee.get(row.id) ?? [],
      }),
    ),
    nextCursor: rows.length > limit && last ? encodeBookingCursor(last) : null,
  }
}
