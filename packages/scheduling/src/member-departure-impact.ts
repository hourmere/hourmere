import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { z } from 'zod'
import { checkedCatalogPage } from './catalog-page.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { isUuid } from './internal.ts'
import { TeamAdminBookingSchema } from './team-admin-booking.ts'
import { readTeamBookingPage } from './team-bookings.ts'

/** Exact internal projections for leak tests; published response schemas remain open. */
export const MemberDepartureEventTypeSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  slug: z.string(),
  schedulingType: z.enum(['individual', 'round_robin', 'collective']),
  isActive: z.boolean(),
  reason: z.enum(['sole_host', 'round_robin_pool_member', 'collective_required_host']),
  remainingHostCount: z.number().int().nonnegative(),
})

export const MemberDepartureBookingSchema = TeamAdminBookingSchema.extend({
  inProgress: z.boolean(),
  handling: z.enum(['coordinate_cancellation', 'wait_until_end_or_coordinate_offline']),
})

export const MemberDepartureImpactSchema = z.strictObject({
  evaluatedAt: z.iso.datetime(),
  eventTypes: z.strictObject({
    data: z.array(MemberDepartureEventTypeSchema),
    nextCursor: z.string().nullable(),
    totalCount: z.number().int().nonnegative(),
  }),
  bookings: z.strictObject({
    data: z.array(MemberDepartureBookingSchema),
    nextCursor: z.string().nullable(),
    totalCount: z.number().int().nonnegative(),
  }),
})

export type MemberDepartureImpact = z.infer<typeof MemberDepartureImpactSchema>

export interface MemberDepartureImpactInput {
  teamId: string
  memberUserId: string
  eventTypesLimit?: number | undefined
  /** Exclusive event-type UUID from the previous page. */
  eventTypesCursor?: string | undefined
  bookingsLimit?: number | undefined
  /** Exact start/id cursor from the previous booking page. */
  bookingsCursor?: string | undefined
}

const denied = () => new DomainError('forbidden', 'team_management_access_denied')
const currentRoles = (role: string) => role.split(',').map((value) => value.trim())
const knownMember = (roles: string[]) =>
  roles.includes('owner') || roles.includes('admin') || roles.includes('member')

/** Current browser identity and team context, independent of stale principal metadata. */
async function authorize(ctx: ServiceContext, input: MemberDepartureImpactInput): Promise<void> {
  const { db, principal } = ctx
  if (
    principal.kind !== 'session' ||
    !isUuid(principal.user.id) ||
    !isUuid(principal.sessionId) ||
    !isUuid(principal.organization.id) ||
    !isUuid(input.teamId) ||
    !isUuid(input.memberUserId) ||
    principal.organization.id.toLowerCase() !== input.teamId.toLowerCase()
  )
    throw denied()

  const actor = await db
    .selectFrom('auth.session as session')
    .innerJoin('auth.user as user', 'user.id', 'session.userId')
    .innerJoin('auth.member as member', 'member.userId', 'user.id')
    .innerJoin('auth.organization as organization', 'organization.id', 'member.organizationId')
    .select('member.role')
    .where('session.id', '=', principal.sessionId)
    .where('session.userId', '=', principal.user.id)
    .where('session.expiresAt', '>', sql<Date>`clock_timestamp()`)
    .where('session.activeOrganizationId', '=', input.teamId)
    .where('user.emailVerified', '=', true)
    .where('organization.id', '=', input.teamId)
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
  const roles = actor ? currentRoles(actor.role) : []
  if (!actor || !knownMember(roles)) throw denied()
  if (
    principal.user.id.toLowerCase() !== input.memberUserId.toLowerCase() &&
    !roles.includes('owner') &&
    !roles.includes('admin')
  )
    throw denied()

  const target = await db
    .selectFrom('auth.member')
    .select('role')
    .where('organizationId', '=', input.teamId)
    .where('userId', '=', input.memberUserId)
    .executeTakeFirst()
  if (!target || !knownMember(currentRoles(target.role))) throw denied()
}

/** Both count and page start from the same current host relation and explicit team scope. */
function affectedEventTypes(db: Db, input: MemberDepartureImpactInput) {
  return db
    .selectFrom('event_types as event')
    .innerJoin('event_type_hosts as host', 'host.event_type_id', 'event.id')
    .where('event.organization_id', '=', input.teamId)
    .where('event.owner_user_id', 'is', null)
    .where('event.deleted_at', 'is', null)
    .where('host.user_id', '=', input.memberUserId)
}

async function readImpact(
  ctx: ServiceContext,
  input: MemberDepartureImpactInput,
): Promise<MemberDepartureImpact> {
  await authorize(ctx, input)
  const now = ctx.now()
  const { limit, after } = checkedCatalogPage({
    limit: input.eventTypesLimit ?? 50,
    after: input.eventTypesCursor,
  })
  const eventQuery = affectedEventTypes(ctx.db, input)
  const eventCount = await eventQuery
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow()
  const eventRows = await eventQuery
    .select(['event.id', 'event.title', 'event.slug', 'event.scheduling_type', 'event.is_active'])
    .select((eb) =>
      eb
        .selectFrom('event_type_hosts as remaining_host')
        .innerJoin('auth.member as remaining_member', (join) =>
          join
            .onRef('remaining_member.userId', '=', 'remaining_host.user_id')
            .onRef('remaining_member.organizationId', '=', 'event.organization_id'),
        )
        .innerJoin('auth.user as remaining_user', 'remaining_user.id', 'remaining_host.user_id')
        .select((host) => host.fn.countAll<string>().as('count'))
        .whereRef('remaining_host.event_type_id', '=', 'event.id')
        .where('remaining_host.user_id', '!=', input.memberUserId)
        .where('remaining_user.emailVerified', '=', true)
        .as('remaining_host_count'),
    )
    .$if(after !== undefined, (q) => q.where('event.id', '>', after as string))
    .orderBy('event.id')
    .limit(limit + 1)
    .execute()
  const eventPage = eventRows.slice(0, limit)

  const bookingCount = await ctx.db
    .selectFrom('bookings as booking')
    .innerJoin('booking_hosts as host', 'host.booking_id', 'booking.id')
    .leftJoin('event_types as event', 'event.id', 'booking.event_type_id')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('booking.organization_id', '=', input.teamId)
    .where('event.owner_user_id', 'is', null)
    .where('host.user_id', '=', input.memberUserId)
    .where('booking.status', '=', 'confirmed')
    .where('booking.end_at', '>', sql<Date>`${now.toString()}::timestamptz`)
    .executeTakeFirstOrThrow()
  const { data, nextCursor, startInstants } = await readTeamBookingPage(
    ctx,
    input.teamId,
    {
      limit: input.bookingsLimit,
      cursor: input.bookingsCursor,
      status: 'confirmed',
      endAfter: now,
    },
    input.memberUserId,
    true,
  )

  return {
    evaluatedAt: now.toString(),
    eventTypes: {
      data: eventPage.map((row) => ({
        id: row.id,
        title: row.title,
        slug: row.slug,
        schedulingType: row.scheduling_type as 'individual' | 'round_robin' | 'collective',
        isActive: row.is_active,
        remainingHostCount: Number(row.remaining_host_count),
        reason:
          row.scheduling_type === 'round_robin'
            ? 'round_robin_pool_member'
            : row.scheduling_type === 'collective'
              ? 'collective_required_host'
              : 'sole_host',
      })),
      nextCursor: eventRows.length > limit ? (eventPage.at(-1)?.id ?? null) : null,
      totalCount: Number(eventCount.count),
    },
    bookings: {
      data: data.map((booking) => {
        const start = startInstants.get(booking.id)
        const inProgress = start !== undefined && Temporal.Instant.compare(start, now) <= 0
        return {
          ...booking,
          inProgress,
          // Existing cancellation semantics reject started bookings. This read never
          // cancels, replaces hosts, or broadens cancellation to permit departure.
          handling: inProgress ? 'wait_until_end_or_coordinate_offline' : 'coordinate_cancellation',
        }
      }),
      nextCursor,
      totalCount: Number(bookingCount.count),
    },
  }
}

/**
 * A preview only: ordinary DB calls read current membership, configured hosts and saved
 * booking hosts in one snapshot. An existing transaction retains its caller's isolation;
 * that caller must provide the snapshot or locks needed for its operation. A later
 * leave/removal write must recheck its own authorization and impact.
 * Counts cover every matching item, independently of the two bounded keyset pages.
 */
export async function getTeamMemberDepartureImpact(
  ctx: ServiceContext,
  input: MemberDepartureImpactInput,
): Promise<MemberDepartureImpact> {
  if (ctx.db.isTransaction) return readImpact(ctx, input)
  return ctx.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute((db) => readImpact({ ...ctx, db }, input))
}
