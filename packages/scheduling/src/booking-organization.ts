import { sql } from 'kysely'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { resolvedBookingHosts } from './hosts.ts'
import { isUuid } from './internal.ts'

/** Resolve only browser-visible bookings; this read never changes the session's space. */
export async function resolveBookingOrganization(
  { db, principal }: ServiceContext,
  bookingId: string,
  authorizeSpace?: (scope: { id: string; personal: boolean }) => Promise<void>,
): Promise<{ organizationId: string; access: 'host' | 'team_admin' }> {
  const missing = () => new DomainError('not_found', 'booking_not_found', 'Booking not found')
  if (principal.kind !== 'session' || !isUuid(bookingId)) throw missing()
  const booking = await db
    .selectFrom('bookings as booking')
    .innerJoin('auth.member as member', 'member.organizationId', 'booking.organization_id')
    .innerJoin('auth.user as user', 'user.id', 'member.userId')
    .innerJoin('auth.session as session', 'session.userId', 'user.id')
    .leftJoin(
      'personal_organizations as personal',
      'personal.organization_id',
      'booking.organization_id',
    )
    .select(['booking.organization_id', 'member.role', 'personal.user_id as personal_owner'])
    .select((eb) =>
      eb
        .exists(
          eb
            .selectFrom(resolvedBookingHosts(db).as('host'))
            .select('host.user_id')
            .whereRef('host.booking_id', '=', 'booking.id')
            .whereRef('host.user_id', '=', 'user.id'),
        )
        .as('is_host'),
    )
    .where('booking.id', '=', bookingId)
    .where('user.id', '=', principal.user.id)
    .where('user.emailVerified', '=', true)
    .where('session.id', '=', principal.sessionId)
    .where('session.expiresAt', '>', sql<Date>`clock_timestamp()`)
    .executeTakeFirst()
  if (!booking) throw missing()
  const personal = booking.personal_owner !== null
  const roles = booking.role.split(',').map((role) => role.trim())
  if (!booking.is_host && (personal || !roles.some((role) => role === 'owner' || role === 'admin')))
    throw missing()
  await authorizeSpace?.({ id: booking.organization_id, personal })
  return {
    organizationId: booking.organization_id,
    access: booking.is_host ? 'host' : 'team_admin',
  }
}
