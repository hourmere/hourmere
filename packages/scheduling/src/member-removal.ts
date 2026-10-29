import { checkTeamManagementAccess, TeamManagementError } from '@hourmere/auth'
import { sql } from 'kysely'
import { z } from 'zod'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { isUuid } from './internal.ts'
import { MemberDepartureBookingSchema } from './member-departure-impact.ts'
import { readTeamBookingPage } from './team-bookings.ts'

/** Exact internal whitelist; the route publishes open response objects. */
export const MemberRemovalHandlingSchema = z.strictObject({
  id: z.uuid(),
  memberUserId: z.uuid(),
  removedAt: z.iso.datetime(),
  evaluatedAt: z.iso.datetime(),
  reason: z.literal('member_removed'),
  bookings: z.strictObject({
    data: z.array(MemberDepartureBookingSchema),
    nextCursor: z.string().nullable(),
    totalCount: z.number().int().nonnegative(),
  }),
})

export type MemberRemovalHandling = z.infer<typeof MemberRemovalHandlingSchema>
export interface MemberRemovalHandlingInput {
  teamId: string
  operationId: string
  limit?: number | undefined
  cursor?: string | undefined
}
export interface LatestMemberRemovalHandlingInput
  extends Omit<MemberRemovalHandlingInput, 'operationId'> {
  memberUserId: string
}

const denied = () => new DomainError('forbidden', 'team_management_access_denied')

async function readHandling(
  ctx: ServiceContext,
  input: MemberRemovalHandlingInput | LatestMemberRemovalHandlingInput,
): Promise<MemberRemovalHandling> {
  try {
    await checkTeamManagementAccess(ctx.db, ctx.principal, input.teamId, false, {
      expectedOrganizationId: input.teamId,
      allowPersonal: false,
    })
  } catch (error) {
    if (!(error instanceof TeamManagementError)) throw error
    throw denied()
  }
  let query = ctx.db
    .selectFrom('organization_operations')
    .select(['id', 'target_user_id', 'occurred_at'])
    .where('organization_id', '=', input.teamId)
    .where('operation', '=', 'member_removed')
    // Ordinary departure records belong to the separate leave workflow.
    .whereRef('actor_user_id', '!=', 'target_user_id')
  if ('operationId' in input) {
    if (!isUuid(input.operationId)) throw denied()
    query = query.where('id', '=', input.operationId)
  } else {
    if (!isUuid(input.memberUserId)) throw denied()
    query = query.where('target_user_id', '=', input.memberUserId)
  }
  const removal = await query
    .orderBy('occurred_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst()
  if (!removal?.target_user_id) throw denied()

  const now = ctx.now()
  const count = await ctx.db
    .selectFrom('bookings as booking')
    .innerJoin('booking_hosts as host', 'host.booking_id', 'booking.id')
    .leftJoin('event_types as event', 'event.id', 'booking.event_type_id')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('booking.organization_id', '=', input.teamId)
    .where('event.owner_user_id', 'is', null)
    .where('host.user_id', '=', removal.target_user_id)
    .where('booking.status', '=', 'confirmed')
    .where('booking.end_at', '>', sql<Date>`${now.toString()}::timestamptz`)
    .executeTakeFirstOrThrow()
  const { data, nextCursor, startInstants } = await readTeamBookingPage(
    ctx,
    input.teamId,
    { limit: input.limit, cursor: input.cursor, status: 'confirmed', endAfter: now },
    removal.target_user_id,
    true,
  )
  return {
    id: removal.id,
    memberUserId: removal.target_user_id,
    removedAt: removal.occurred_at.toISOString(),
    evaluatedAt: now.toString(),
    reason: 'member_removed',
    bookings: {
      data: data.map((booking) => {
        const start = startInstants.get(booking.id)
        const inProgress = start !== undefined && Temporal.Instant.compare(start, now) <= 0
        return {
          ...booking,
          inProgress,
          handling: inProgress ? 'wait_until_end_or_coordinate_offline' : 'coordinate_cancellation',
        }
      }),
      nextCursor,
      totalCount: Number(count.count),
    },
  }
}

/**
 * The durable operation identifies the removed team member after membership is gone.
 * Reuse the impact read's current unfinished-booking projection and precise bounded
 * keyset pages. No management token, answer, conference link or credential is exposed.
 */
export async function getTeamMemberRemovalHandling(
  ctx: ServiceContext,
  input: MemberRemovalHandlingInput,
): Promise<MemberRemovalHandling> {
  return handlingSnapshot(ctx, input)
}

/** Discover a native removal's handling record using the known removed user identity. */
export async function getLatestTeamMemberRemovalHandling(
  ctx: ServiceContext,
  input: LatestMemberRemovalHandlingInput,
): Promise<MemberRemovalHandling> {
  return handlingSnapshot(ctx, input)
}

async function handlingSnapshot(
  ctx: ServiceContext,
  input: MemberRemovalHandlingInput | LatestMemberRemovalHandlingInput,
): Promise<MemberRemovalHandling> {
  if (ctx.db.isTransaction) return readHandling(ctx, input)
  return ctx.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute((db) => readHandling({ ...ctx, db }, input))
}
