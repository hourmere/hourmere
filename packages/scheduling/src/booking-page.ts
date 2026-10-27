import type { Db } from '@hourmere/db'
import type { ExpressionBuilder } from 'kysely'
import type { BookingStatus } from './bookings.ts'
import { DomainError } from './errors.ts'
import { isUuid } from './internal.ts'

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 100

export interface ListBookingsInput {
  /** Chronological direction for start and id; default asc. Keep it unchanged between pages. */
  order?: 'asc' | 'desc' | undefined
  /** Only bookings that start at or after this instant. */
  from?: Temporal.Instant | undefined
  /** Only bookings that start before this instant. */
  to?: Temporal.Instant | undefined
  /** Only bookings that end strictly after this instant (includes meetings in progress). */
  endAfter?: Temporal.Instant | undefined
  /** Only bookings that end at or before this instant. */
  endTo?: Temporal.Instant | undefined
  status?: BookingStatus | undefined
  /** 1–MAX_PAGE_SIZE, default DEFAULT_PAGE_SIZE. */
  limit?: number | undefined
  /** `nextCursor` of the previous page. */
  cursor?: string | undefined
}

// Postgres reads ISO 8601 instants in years 0001–9999 (no year 0000).
const EARLIEST_SQL = Temporal.Instant.from('0001-01-01T00:00:00Z')
const LATEST_SQL = Temporal.Instant.from('9999-12-31T23:59:59.999999Z')

/**
 * An instant as a bound timestamptz value with its full precision (Postgres keeps
 * microseconds and rounds beyond); a Date would cut it to milliseconds. Clamped to the years
 * Postgres reads, which changes nothing for filters: no booking lies outside them.
 */
function timestamptz<DB, TB extends keyof DB>(
  eb: ExpressionBuilder<DB, TB>,
  instant: Temporal.Instant,
) {
  const clamped =
    Temporal.Instant.compare(instant, EARLIEST_SQL) < 0
      ? EARLIEST_SQL
      : Temporal.Instant.compare(instant, LATEST_SQL) > 0
        ? LATEST_SQL
        : instant
  return eb.cast<Date>(eb.val(clamped.toString()), 'timestamptz')
}

/** `start` keeps the microseconds of start_at (see bookingPageQuery), so pages never overlap. */
export function encodeBookingCursor(row: { cursor_start: string; id: string }): string {
  return Buffer.from(JSON.stringify([row.cursor_start, row.id])).toString('base64url')
}

function decodeCursor(cursor: string): { start: Temporal.Instant; id: string } {
  const invalid = () => new DomainError('invalid', 'invalid_cursor', 'cursor is not valid')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw invalid()
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw invalid()
  const [start, id] = parsed
  if (typeof start !== 'string' || typeof id !== 'string' || !isUuid(id)) throw invalid()
  let instant: Temporal.Instant
  try {
    instant = Temporal.Instant.from(start)
  } catch {
    throw invalid()
  }
  // Cursors are made from stored bookings; outside these years one can only be forged.
  if (
    Temporal.Instant.compare(instant, EARLIEST_SQL) < 0 ||
    Temporal.Instant.compare(instant, LATEST_SQL) > 0
  ) {
    throw invalid()
  }
  return { start: instant, id }
}

/** Shared filters, ordering and exact-precision keyset cursor for booking lists. */
export function bookingPageQuery(db: Db, input: ListBookingsInput) {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new DomainError('invalid', 'invalid_limit', `limit must be from 1 to ${MAX_PAGE_SIZE}`)
  }
  const order = input.order ?? 'asc'
  if (order !== 'asc' && order !== 'desc')
    throw new DomainError('invalid', 'invalid_order', 'order must be asc or desc')
  const comparison = order === 'desc' ? '<' : '>'
  const { from, to, endAfter, endTo, status } = input
  if (from && to && Temporal.Instant.compare(to, from) <= 0) {
    throw new DomainError('invalid', 'invalid_range', 'to must be after from')
  }
  if (endAfter && endTo && Temporal.Instant.compare(endTo, endAfter) <= 0) {
    throw new DomainError('invalid', 'invalid_range', 'endTo must be after endAfter')
  }
  const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor)

  const query = db
    .selectFrom('bookings as b')
    // start_at with its microseconds, for the cursor (node-postgres Dates have milliseconds).
    .select((eb) =>
      eb
        .fn<string>('to_char', [
          eb.fn('timezone', [eb.val('UTC'), 'b.start_at']),
          eb.val('YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        ])
        .as('cursor_start'),
    )
    .$if(from !== undefined, (q) =>
      q.where((eb) => eb('b.start_at', '>=', timestamptz(eb, from as Temporal.Instant))),
    )
    .$if(to !== undefined, (q) =>
      q.where((eb) => eb('b.start_at', '<', timestamptz(eb, to as Temporal.Instant))),
    )
    .$if(endAfter !== undefined, (q) =>
      q.where((eb) => eb('b.end_at', '>', timestamptz(eb, endAfter as Temporal.Instant))),
    )
    .$if(endTo !== undefined, (q) =>
      q.where((eb) => eb('b.end_at', '<=', timestamptz(eb, endTo as Temporal.Instant))),
    )
    .$if(status !== undefined, (q) => q.where('b.status', '=', status as string))
    .$if(after !== undefined, (q) =>
      q.where((eb) => {
        const start = timestamptz(eb, (after as { start: Temporal.Instant }).start)
        return eb.or([
          eb('b.start_at', comparison, start),
          eb.and([
            eb('b.start_at', '=', start),
            eb('b.id', comparison, (after as { id: string }).id),
          ]),
        ])
      }),
    )
    .orderBy('b.start_at', order)
    .orderBy('b.id', order)
    .limit(limit + 1)

  return { query, limit }
}
