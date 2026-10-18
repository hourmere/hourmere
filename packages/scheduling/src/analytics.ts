// First-party activity reconstructed from retained bookings; no attendee or answer reads.
import { sql } from 'kysely'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { validTimeZone } from './internal.ts'

export const MAX_ANALYTICS_DAYS = 90
export interface ActivityCounts {
  created: number
  rescheduled: number
  cancelled: number
}
export interface BookingActivity {
  startDate: string
  endDate: string
  timeZone: string
  totals: ActivityCounts
  data: (ActivityCounts & { date: string })[]
}

export function activityRange(input: { startDate: unknown; endDate: unknown; timeZone: unknown }) {
  const timeZone = validTimeZone(input.timeZone)
  const invalid = () =>
    new DomainError(
      'invalid',
      'invalid_analytics_range',
      'Choose at most 90 calendar days, with the end on or after the start',
    )
  let start: Temporal.PlainDate
  let end: Temporal.PlainDate
  try {
    if (
      typeof input.startDate !== 'string' ||
      typeof input.endDate !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)
    )
      throw invalid()
    start = Temporal.PlainDate.from(input.startDate)
    end = Temporal.PlainDate.from(input.endDate)
    if (Temporal.PlainDate.compare(start, end) > 0 || start.until(end).days >= MAX_ANALYTICS_DAYS)
      throw invalid()
  } catch {
    throw invalid()
  }
  const bins = []
  for (let day = start; Temporal.PlainDate.compare(day, end) <= 0; day = day.add({ days: 1 })) {
    // Starting each calendar date independently handles DST and wholly skipped local dates.
    const from = day.toZonedDateTime(timeZone).toInstant()
    const to = day.add({ days: 1 }).toZonedDateTime(timeZone).toInstant()
    bins.push({
      date: day.toString(),
      from: new Date(from.epochMilliseconds),
      to: new Date(to.epochMilliseconds),
    })
  }
  return { startDate: start.toString(), endDate: end.toString(), timeZone, bins }
}

function count(value: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error('Activity count outside JSON integer range')
  return number
}

/** The authorization guard and both activity branches share one PostgreSQL snapshot. */
export async function getBookingActivity(
  ctx: ServiceContext,
  input: { startDate: unknown; endDate: unknown; timeZone: unknown },
): Promise<BookingActivity> {
  const range = activityRange(input)
  const first = range.bins[0]
  const last = range.bins.at(-1)
  if (!first || !last) throw new Error('Empty validated activity range')
  const organizationId = ctx.principal.organization.id
  const userId = ctx.principal.user.id
  const bins = sql.join(
    range.bins.map(
      (bin) => sql`(${bin.date}::text, ${bin.from}::timestamptz, ${bin.to}::timestamptz)`,
    ),
  )
  const result = await sql<{
    allowed: boolean
    date: string
    created: string
    rescheduled: string
    cancelled: string
  }>`
    WITH access AS (
      SELECT 1 FROM auth.member m
      LEFT JOIN personal_organizations p ON p.organization_id = m."organizationId"
      WHERE m."organizationId" = ${organizationId} AND m."userId" = ${userId}
        AND (p.user_id = ${userId} OR (p.organization_id IS NULL AND EXISTS (
          SELECT 1 FROM unnest(string_to_array(m.role, ',')) role
          WHERE btrim(role) IN ('owner', 'admin')
        )))
    ), bins(date, starts, ends) AS (VALUES ${bins}), activity AS (
      SELECT b.created_at AS at,
        (b.rescheduled_from_id IS NULL)::integer AS created,
        (b.rescheduled_from_id IS NOT NULL)::integer AS rescheduled, 0 AS cancelled
      FROM bookings b WHERE b.organization_id = ${organizationId}
        AND b.created_at >= ${first.from} AND b.created_at < ${last.to}
        AND EXISTS (SELECT 1 FROM access)
      UNION ALL
      SELECT b.cancelled_at AS at, 0, 0, 1
      FROM bookings b WHERE b.organization_id = ${organizationId} AND b.status = 'cancelled'
        AND b.cancelled_at >= ${first.from} AND b.cancelled_at < ${last.to}
        AND EXISTS (SELECT 1 FROM access)
        AND NOT EXISTS (
          SELECT 1 FROM bookings successor WHERE successor.rescheduled_from_id = b.id
            AND successor.organization_id = ${organizationId}
        )
    )
    SELECT EXISTS (SELECT 1 FROM access) AS allowed, bins.date,
      COALESCE(sum(activity.created), 0)::text AS created,
      COALESCE(sum(activity.rescheduled), 0)::text AS rescheduled,
      COALESCE(sum(activity.cancelled), 0)::text AS cancelled
    FROM bins LEFT JOIN activity ON activity.at >= bins.starts AND activity.at < bins.ends
    GROUP BY bins.date ORDER BY bins.date
  `.execute(ctx.db)
  if (!result.rows[0]?.allowed)
    throw new DomainError(
      'forbidden',
      'insufficient_role',
      'Only personal account owners and team owners or admins can view booking activity',
    )
  const data = result.rows.map((row) => ({
    date: row.date,
    created: count(row.created),
    rescheduled: count(row.rescheduled),
    cancelled: count(row.cancelled),
  }))
  const totals = data.reduce(
    (sum, day) => ({
      created: sum.created + day.created,
      rescheduled: sum.rescheduled + day.rescheduled,
      cancelled: sum.cancelled + day.cancelled,
    }),
    { created: 0, rescheduled: 0, cancelled: 0 },
  )
  for (const value of Object.values(totals)) count(String(value))
  return {
    startDate: range.startDate,
    endDate: range.endDate,
    timeZone: range.timeZone,
    totals,
    data,
  }
}
