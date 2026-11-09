import type { Db } from '@hourmere/db'
import { assertBookingLocallyManaged } from './bookings.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { lockOrganization, resolvedBookingHosts } from './hosts.ts'
import { isUuid } from './internal.ts'

export interface AttendeeNoShow {
  attendeeId: string
  noShowMarkedAt: string | null
  noShowMarkedBy: string | null
}

/** Attendance metadata only: never notify invitees or alter scheduled messages. */
export async function setAttendeeNoShow(
  ctx: ServiceContext,
  bookingId: string,
  attendeeId: string,
  noShow: boolean,
): Promise<AttendeeNoShow> {
  const missing = () => new DomainError('not_found', 'booking_not_found')
  if (!isUuid(bookingId) || !isUuid(attendeeId)) throw missing()
  return ctx.db.transaction().execute(async (trx) => {
    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, bookingId)
    const booking = await authorizeBookingNoShow(trx, ctx, bookingId)
    // Confirmed paid bookings: paid_booking_management_unavailable, as for other host actions.
    await assertBookingLocallyManaged(trx, bookingId)
    // Only confirmed and cancelled rows are visible; anything else stays booking_not_found.
    if (booking.status !== 'confirmed')
      throw booking.status === 'cancelled'
        ? new DomainError('conflict', 'booking_cancelled', 'This booking is cancelled')
        : missing()
    const now = ctx.now()
    if (Temporal.Instant.compare(now, Temporal.Instant.from(booking.start_at.toISOString())) <= 0)
      throw new DomainError(
        'conflict',
        'booking_not_started',
        'The booking must have started before attendance can be marked',
      )
    const attendee = await trx
      .selectFrom('booking_attendees')
      .select(['id', 'no_show_marked_at', 'no_show_marked_by'])
      .where('booking_id', '=', bookingId)
      .where('id', '=', attendeeId)
      .forUpdate()
      .executeTakeFirst()
    if (!attendee) throw missing()
    const current: AttendeeNoShow = {
      attendeeId: attendee.id,
      noShowMarkedAt: attendee.no_show_marked_at?.toISOString() ?? null,
      noShowMarkedBy: attendee.no_show_marked_by,
    }
    if ((current.noShowMarkedAt !== null) === noShow) return current
    const result: AttendeeNoShow = {
      attendeeId: attendee.id,
      noShowMarkedAt: noShow ? new Date(now.epochMilliseconds).toISOString() : null,
      noShowMarkedBy: noShow ? ctx.principal.user.id : null,
    }
    await trx
      .updateTable('booking_attendees')
      .set({ no_show_marked_at: result.noShowMarkedAt, no_show_marked_by: result.noShowMarkedBy })
      .where('id', '=', attendeeId)
      .execute()
    await ctx.notifyAttendeeNoShow?.(trx, { bookingId, ...result }, now)
    return result
  })
}

export async function authorizeBookingNoShow(
  trx: Db,
  ctx: ServiceContext,
  bookingId: string,
  lock = true,
) {
  const missing = () => new DomainError('not_found', 'booking_not_found')
  // User deletion takes the user row before cascading through organizations.
  const actor = await trx
    .selectFrom('auth.user')
    .select('emailVerified')
    .where('id', '=', ctx.principal.user.id)
    .$if(lock, (query) => query.forShare())
    .executeTakeFirst()
  if (!actor?.emailVerified) throw missing()
  if (lock) await lockOrganization(trx, ctx.principal.organization.id)
  const member = await trx
    .selectFrom('auth.member as member')
    .select(['member.role'])
    .where('member.organizationId', '=', ctx.principal.organization.id)
    .where('member.userId', '=', ctx.principal.user.id)
    .$if(lock, (query) => query.forShare('member'))
    .executeTakeFirst()
  if (!member) throw missing()
  // Same visibility as host booking reads: pending, expired and unpaid-cancelled payment
  // holds do not exist for their hosts (booking_not_found).
  const booking = await trx
    .selectFrom('bookings')
    .select(['id', 'status', 'start_at'])
    .where('id', '=', bookingId)
    .where('organization_id', '=', ctx.principal.organization.id)
    .where('status', 'in', ['confirmed', 'cancelled'])
    .where((eb) =>
      eb.or([
        eb('payment_hold_expires_at', 'is', null),
        eb('payment_confirmed_at', 'is not', null),
      ]),
    )
    .$if(lock, (query) => query.forUpdate())
    .executeTakeFirst()
  if (!booking) throw missing()
  const host = resolvedBookingHosts(trx).as('host')
  const isHost = await trx
    .selectFrom(host)
    .select('user_id')
    .where('booking_id', '=', bookingId)
    .where('user_id', '=', ctx.principal.user.id)
    .executeTakeFirst()
  const manager =
    ctx.principal.kind === 'session' &&
    !ctx.principal.organization.personal &&
    member.role.split(',').some((role) => ['owner', 'admin'].includes(role.trim()))
  if (!isHost && !manager) throw missing()
  return booking
}

export async function listBookingAttendeeNoShows(ctx: ServiceContext, bookingId: string) {
  if (!isUuid(bookingId)) throw new DomainError('not_found', 'booking_not_found')
  return ctx.db.transaction().execute(async (trx) => {
    await authorizeBookingNoShow(trx, ctx, bookingId, false)
    const rows = await trx
      .selectFrom('booking_attendees')
      .select(['id', 'name', 'email', 'is_booker', 'no_show_marked_at', 'no_show_marked_by'])
      .where('booking_id', '=', bookingId)
      .orderBy('is_booker', 'desc')
      .orderBy('id')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      isBooker: row.is_booker,
      noShowMarkedAt: row.no_show_marked_at?.toISOString() ?? null,
      noShowMarkedBy: row.no_show_marked_by,
    }))
  })
}
