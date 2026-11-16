import type { AvailabilityReason, AvailabilityReasonCode } from '@hourmere/core'
import { explainEventAvailability } from './availability.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { validTimeZone } from './internal.ts'

/** One local calendar day of an event type, explained for its managers. */
export interface TroubleshootAvailabilityInput {
  eventTypeId: string
  /** Local calendar date, `YYYY-MM-DD`, read in `timeZone`. */
  date: string
  /** IANA zone for the day's bounds; defaults to the caller's profile time zone, else UTC. */
  timeZone?: string | undefined
  durationMinutes?: number | undefined
}

export interface TroubleshootReason {
  code: AvailabilityReasonCode
  /** The part of the time this reason affects, clipped to it; UTC RFC 3339. */
  start: string
  end: string
  /** Team event types only: the host this reason belongs to. */
  hostUserId?: string
}

export interface TroubleshootSlot {
  start: string
  end: string
  status: 'available' | 'unavailable'
  reasons: TroubleshootReason[]
}

export interface TroubleshootAvailabilityResult {
  eventTypeId: string
  date: string
  timeZone: string
  /** Null for the event's default length. */
  durationMinutes: number | null
  rangeStart: string
  rangeEnd: string
  /** Team event types: assigned hosts with display names. Empty for personal event types. */
  hosts: { userId: string; name: string }[]
  slots: TroubleshootSlot[]
}

/** Reasons that reveal when a team host is busy, rather than how the event is configured. */
const PRIVATE_TIMING_CODES: ReadonlySet<AvailabilityReasonCode> = new Set([
  'calendar_busy',
  'buffer_before',
  'buffer_after',
  'host_conflict',
])

/**
 * A team manager learns that a time is outside a host's working hours, but not what that host
 * does then: for such a host and time, busy, buffer and booking-conflict reasons (and their
 * minute-precise intervals) are dropped. Personal event types carry no hostUserId; their
 * only caller is the host themself.
 */
function withoutPrivateOffHours(reasons: readonly AvailabilityReason[]): AvailabilityReason[] {
  const offHours = new Set(
    reasons
      .filter(
        (reason) => reason.code === 'outside_working_hours' && reason.hostUserId !== undefined,
      )
      .map((reason) => reason.hostUserId),
  )
  return reasons.filter(
    (reason) =>
      reason.hostUserId === undefined ||
      !offHours.has(reason.hostUserId) ||
      !PRIVATE_TIMING_CODES.has(reason.code),
  )
}

const DATE = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/
const iso = (instant: Temporal.Instant) => instant.toString()

/**
 * The single entry point behind REST, MCP and CLI. Authorization is the explanation service's
 * manager-only boundary: callers that may not manage the event type (other hosts, other
 * organizations, ordinary team members, keys without `full`) get the same `event_type_not_found`
 * as a missing id. Output is an explicit allowlist: codes, clipped UTC intervals and, for team
 * managers, host ids and names. Never calendar or booking details.
 */
export async function troubleshootEventAvailability(
  ctx: ServiceContext,
  input: TroubleshootAvailabilityInput,
): Promise<TroubleshootAvailabilityResult> {
  if (typeof input.date !== 'string' || !DATE.test(input.date))
    throw new DomainError('invalid', 'invalid_date', 'date must be a YYYY-MM-DD calendar date')
  let date: Temporal.PlainDate
  try {
    date = Temporal.PlainDate.from(input.date, { overflow: 'reject' })
  } catch {
    throw new DomainError('invalid', 'invalid_date', 'date must be a YYYY-MM-DD calendar date')
  }
  let timeZone: string
  if (input.timeZone !== undefined) timeZone = validTimeZone(input.timeZone)
  else {
    const profile = await ctx.db
      .selectFrom('profiles')
      .select('time_zone')
      .where('user_id', '=', ctx.principal.user.id)
      .executeTakeFirst()
    timeZone = profile?.time_zone ?? 'UTC'
  }
  let rangeStart: Temporal.Instant
  let rangeEnd: Temporal.Instant
  try {
    // startOfDay handles zones whose midnight is skipped on a DST change.
    rangeStart = date.toZonedDateTime({ timeZone }).startOfDay().toInstant()
    rangeEnd = date.add({ days: 1 }).toZonedDateTime({ timeZone }).startOfDay().toInstant()
  } catch {
    throw new DomainError('invalid', 'invalid_date', 'date is outside the supported range')
  }
  const slots = await explainEventAvailability(ctx, {
    eventTypeId: input.eventTypeId,
    rangeStart,
    rangeEnd,
    ...(input.durationMinutes !== undefined && { durationMinutes: input.durationMinutes }),
  })
  // Only managers get here; a personal event type has no host directory to disclose.
  const team = await ctx.db
    .selectFrom('event_types')
    .select('owner_user_id')
    .where('id', '=', input.eventTypeId)
    .executeTakeFirst()
  const hosts =
    team && team.owner_user_id === null
      ? await ctx.db
          .selectFrom('event_type_hosts as h')
          .innerJoin('auth.user as u', 'u.id', 'h.user_id')
          .select(['u.id as userId', 'u.name as name'])
          .where('h.event_type_id', '=', input.eventTypeId)
          .orderBy('u.name')
          .orderBy('u.id')
          .execute()
      : []
  return {
    eventTypeId: input.eventTypeId,
    date: date.toString(),
    timeZone,
    durationMinutes: input.durationMinutes ?? null,
    rangeStart: iso(rangeStart),
    rangeEnd: iso(rangeEnd),
    hosts: hosts.map((host) => ({ userId: host.userId, name: host.name })),
    slots: slots.map((slot) => ({
      start: iso(slot.start),
      end: iso(slot.end),
      status: slot.status,
      reasons: withoutPrivateOffHours(slot.reasons).map((reason) => ({
        code: reason.code,
        start: iso(reason.interval.start),
        end: iso(reason.interval.end),
        ...(reason.hostUserId !== undefined && { hostUserId: reason.hostUserId }),
      })),
    })),
  }
}
