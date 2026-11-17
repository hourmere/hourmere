import type { Db } from '@hourmere/db'
import { type BookingOrigin, cancelOccurrenceSeatInTransaction, lockHosts } from './bookings.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { lockOrganization } from './hosts.ts'
import { isUuid } from './internal.ts'
import type { Responses } from './questions.ts'

const missing = () => new DomainError('not_found', 'group_occurrence_not_found')

/** Credentials grant host access; only browser sessions grant non-host team management. */
async function authorizeOccurrence(db: Db, ctx: ServiceContext, id: string) {
  if (!isUuid(id)) throw missing()
  const slot = await db
    .selectFrom('group_slots')
    .selectAll()
    .where('id', '=', id)
    .where('organization_id', '=', ctx.principal.organization.id)
    .executeTakeFirst()
  if (!slot) throw missing()
  const member = await db
    .selectFrom('auth.member as m')
    .innerJoin('auth.user as u', 'u.id', 'm.userId')
    .select('m.role')
    .where('m.organizationId', '=', slot.organization_id)
    .where('u.id', '=', ctx.principal.user.id)
    .where('u.emailVerified', '=', true)
    .executeTakeFirst()
  if (!member) throw missing()
  const host = slot.host_user_id === ctx.principal.user.id
  const manager =
    ctx.principal.kind === 'session' &&
    !ctx.principal.organization.personal &&
    member.role.split(',').some((role) => ['owner', 'admin'].includes(role.trim()))
  if (!host && !manager) throw missing()
  return slot
}

export type GroupAttendeesInput = {
  status?: 'active' | 'cancelled' | 'all' | undefined
  limit?: number | undefined
  offset?: number | undefined
}

export async function getGroupOccurrenceAttendees(
  ctx: ServiceContext,
  id: string,
  input: GroupAttendeesInput = {},
) {
  const { status = 'active', limit = 25, offset = 0 } = input
  if (
    !['active', 'cancelled', 'all'].includes(status) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 10000
  )
    throw new DomainError('invalid', 'invalid_request')
  // Authorization, seat count and page share one snapshot without blocking booking writes.
  return ctx.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const slot = await authorizeOccurrence(trx, ctx, id)
      const rows = await trx
        .selectFrom('bookings as b')
        .innerJoin('booking_attendees as a', 'a.booking_id', 'b.id')
        .select([
          'b.id as booking_id',
          'b.responses',
          'b.status',
          'a.id',
          'a.name',
          'a.email',
          'a.no_show_marked_at',
          'a.no_show_marked_by',
        ])
        .where('b.group_slot_id', '=', slot.id)
        .where('b.organization_id', '=', slot.organization_id)
        .where(
          'b.status',
          'in',
          status === 'all'
            ? ['confirmed', 'cancelled']
            : [status === 'active' ? 'confirmed' : 'cancelled'],
        )
        .orderBy('b.created_at')
        .orderBy('b.id')
        .orderBy('a.id')
        .limit(limit + 1)
        .offset(offset)
        .execute()
      return {
        id: slot.id,
        eventTypeId: slot.event_type_id,
        title: slot.title,
        start: slot.start_at.toISOString(),
        end: slot.end_at.toISOString(),
        capacity: slot.capacity,
        activeSeats: slot.active_seats,
        state: slot.state as 'open' | 'retired' | 'host_cancelled',
        pagination: { limit, offset, hasMore: rows.length > limit && offset + limit <= 10000 },
        attendees: rows.slice(0, limit).map((row) => ({
          bookingId: row.booking_id,
          id: row.id,
          name: row.name,
          email: row.email,
          responses: row.responses as Responses,
          status: row.status as 'confirmed' | 'cancelled',
          noShowMarkedAt: row.no_show_marked_at?.toISOString() ?? null,
          noShowMarkedBy: row.no_show_marked_by,
        })),
      }
    })
}

/** Repeated cancellation reauthorizes and returns zero; no further mail or writes occur. */
export async function cancelGroupOccurrence(
  ctx: ServiceContext,
  id: string,
  options: { reason?: string | undefined } = {},
  origin?: BookingOrigin,
) {
  return ctx.db.transaction().execute(async (trx) => {
    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, id)
    await lockOrganization(trx, ctx.principal.organization.id)
    const authorized = await authorizeOccurrence(trx, ctx, id)
    await lockHosts(trx, [authorized.host_user_id])
    const slot = await trx
      .selectFrom('group_slots')
      .selectAll()
      .where('id', '=', authorized.id)
      .forUpdate()
      .executeTakeFirstOrThrow()
    if (slot.state === 'host_cancelled' || slot.state === 'retired')
      return { id: slot.id, cancelledSeatCount: 0 }
    if (
      Temporal.Instant.compare(Temporal.Instant.from(slot.start_at.toISOString()), ctx.now()) <= 0
    )
      throw new DomainError('conflict', 'booking_in_past', 'This occurrence has already started')
    const seats = await trx
      .selectFrom('bookings')
      .select('id')
      .where('group_slot_id', '=', slot.id)
      .where('organization_id', '=', slot.organization_id)
      .where('status', '=', 'confirmed')
      .orderBy('id')
      .execute()
    await trx
      .updateTable('group_slots')
      .set({ state: 'host_cancelled' })
      .where('id', '=', slot.id)
      .execute()
    for (const seat of seats)
      await cancelOccurrenceSeatInTransaction(trx, ctx, seat.id, options, origin)
    return { id: slot.id, cancelledSeatCount: seats.length }
  })
}
