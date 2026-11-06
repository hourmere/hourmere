import { intervalIndex } from './interval-index.ts'
import {
  AVAILABILITY_REASON_CODES,
  type AvailabilityReason,
  type AvailabilityReasonCode,
  type EventTypeRules,
  type ExplainAvailabilityInput,
  type ExplainedSlot,
  type InstantInterval,
  type Slot,
} from './types.ts'
import {
  AvailabilityInputError,
  type NormalizedInput,
  normalizeInput,
  resolveDurationMinutes,
} from './validate.ts'

const NS_PER_MINUTE = 60_000_000_000n
const MINUTES_PER_DAY = 1440
const COMPATIBLE = { disambiguation: 'compatible' } as const

/** Adding an engine rule requires an explicit explanation implementation and parity coverage. */
const EXPLAINED_RULES = {
  durationMinutes: true,
  allowedDurationsMinutes: true,
  slotStepMinutes: true,
  bufferBeforeMinutes: true,
  bufferAfterMinutes: true,
  minimumNoticeMinutes: true,
  maxBookingsPerDay: true,
  maxBookingsPerWeek: true,
  maxBookingsPerMonth: true,
  bookingWindowDays: true,
} satisfies Record<keyof EventTypeRules, true>
// Keep this compile-time checklist local to diagnostics, with no normal-path allocation.
void EXPLAINED_RULES

interface NsInterval {
  readonly start: bigint
  readonly end: bigint
}

/**
 * Opt-in diagnostics; the normal engine does not call or allocate this machinery.
 * Candidates are the union of the local-midnight step grid and the working
 * interval grids, plus explicitly supplied starts, fully inside the request.
 * Nonexistent DST wall times are skipped; repeated times use the earlier instant.
 * A midnight-grid start inside working hours but off their anchored grid receives
 * off_slot_grid. This preserves exact parity with getAvailableSlots even for
 * intervals beginning at e.g. 09:15 with a thirty-minute step.
 *
 * A well-formed but unoffered duration produces reasons. Invalid inputs still
 * throw AvailabilityInputError. Counts include every supplied booking in the
 * host-local day, Monday–Sunday week and calendar month, including outside the range.
 */
export function explainAvailability(input: ExplainAvailabilityInput): ExplainedSlot[] {
  // Validate the real offered rules before admitting an unoffered selected length.
  const validated = normalizeInput({ ...input, durationMinutes: undefined })
  const durationMinutes =
    input.durationMinutes === undefined
      ? validated.durationMinutes
      : resolveDurationMinutes({ durationMinutes: input.durationMinutes })
  const durationOffered = (
    input.eventType.allowedDurationsMinutes ?? [input.eventType.durationMinutes]
  ).includes(durationMinutes)
  const q: NormalizedInput = {
    ...validated,
    durationMinutes,
    slotStepMinutes: input.eventType.slotStepMinutes ?? durationMinutes,
  }
  const otherBookings = normalizeInput({
    ...input,
    durationMinutes: undefined,
    bookings: input.blockingBookings,
  }).bookings
  const { candidates, scheduled, workingIntervals } = candidateSlots(
    q,
    input.candidateStarts,
    input.maximumCandidates,
  )
  const bookingsPerDay = new Map<string, number>()
  const bookingsPerWeek = new Map<string, number>()
  const bookingsPerMonth = new Map<string, number>()
  for (const booking of q.bookings) {
    const date = booking.start.toZonedDateTimeISO(q.timeZone).toPlainDate()
    for (const [counts, key] of [
      [bookingsPerDay, date.toString()],
      [bookingsPerWeek, weekKey(date)],
      [bookingsPerMonth, monthKey(date)],
    ] as const) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  const notice = q.now.add({ minutes: q.minimumNoticeMinutes }).epochNanoseconds
  const windowEnd =
    q.bookingWindowDays === undefined
      ? undefined
      : q.now.toZonedDateTimeISO(q.timeZone).add({ days: q.bookingWindowDays }).toInstant()
          .epochNanoseconds

  const before = BigInt(q.bufferBeforeMinutes) * NS_PER_MINUTE
  const after = BigInt(q.bufferAfterMinutes) * NS_PER_MINUTE
  const busyOverlapping = intervalIndex(q.busy.map(ns))
  const bookingsOverlapping = intervalIndex(
    [...q.bookings, ...otherBookings].map((booking) => {
      const interval = ns(booking)
      const bookingBefore = BigInt(booking.bufferBeforeMinutes) * NS_PER_MINUTE
      const bookingAfter = BigInt(booking.bufferAfterMinutes) * NS_PER_MINUTE
      return {
        start: interval.start - bookingBefore,
        end: interval.end + bookingAfter,
        interval,
        bookingBefore,
        bookingAfter,
      }
    }),
  )
  const workingOverlapping = intervalIndex(workingIntervals)

  return candidates.map((slot): ExplainedSlot => {
    const start = slot.start.epochNanoseconds
    const end = slot.end.epochNanoseconds
    const reasons: AvailabilityReason[] = []
    const add = (code: AvailabilityReasonCode, interval: NsInterval = { start, end }) => {
      const clippedStart = max(start, interval.start)
      const clippedEnd = min(end, interval.end)
      if (clippedStart >= clippedEnd) return
      reasons.push({
        code,
        interval: {
          start: Temporal.Instant.fromEpochNanoseconds(clippedStart),
          end: Temporal.Instant.fromEpochNanoseconds(clippedEnd),
        },
      })
    }

    if (start < q.now.epochNanoseconds) add('past', { start, end: q.now.epochNanoseconds })
    if (!durationOffered) add('duration_not_offered')
    const working = workingOverlapping(start, end)
    const insideHours = working.some((i) => i.start <= start && end <= i.end)
    if (!insideHours) {
      const uncovered = uncoveredParts({ start, end }, working)
      // Separate local-day intervals cannot authorize a meeting across midnight,
      // even if their union happens to cover its elapsed time completely.
      for (const interval of uncovered.length ? uncovered : [{ start, end }]) {
        add('outside_working_hours', interval)
      }
    } else if (!scheduled.has(start)) add('off_slot_grid')
    if (q.minimumNoticeMinutes > 0 && start < notice) {
      add('minimum_notice', { start, end: notice })
    }
    if (windowEnd !== undefined && start > windowEnd) add('booking_window')

    const paddedSlot = { start: start - before, end: end + after }
    for (const interval of busyOverlapping(paddedSlot.start, paddedSlot.end)) {
      if (overlaps({ start, end }, interval)) add('calendar_busy', interval)
      candidateBuffers(interval, start, end, before, after, add)
    }
    for (const paddedBooking of bookingsOverlapping(paddedSlot.start, paddedSlot.end)) {
      const { interval, bookingBefore, bookingAfter } = paddedBooking
      if (overlaps({ start, end }, interval)) add('host_conflict', interval)
      candidateBuffers(paddedBooking, start, end, before, after, add)
      const beforeInterval = { start: paddedBooking.start, end: interval.start }
      if (bookingBefore > 0n && overlaps(paddedSlot, beforeInterval)) {
        add('buffer_before', {
          start: beforeInterval.start - after,
          end: beforeInterval.end + before,
        })
      }
      const afterInterval = { start: interval.end, end: paddedBooking.end }
      if (bookingAfter > 0n && overlaps(paddedSlot, afterInterval)) {
        add('buffer_after', {
          start: afterInterval.start - after,
          end: afterInterval.end + before,
        })
      }
    }
    const date = slot.start.toZonedDateTimeISO(q.timeZone).toPlainDate()
    if (
      q.maxBookingsPerDay !== undefined &&
      (bookingsPerDay.get(date.toString()) ?? 0) >= q.maxBookingsPerDay
    ) {
      add('daily_limit')
    }
    if (
      q.maxBookingsPerWeek !== undefined &&
      (bookingsPerWeek.get(weekKey(date)) ?? 0) >= q.maxBookingsPerWeek
    ) {
      add('weekly_limit')
    }
    if (
      q.maxBookingsPerMonth !== undefined &&
      (bookingsPerMonth.get(monthKey(date)) ?? 0) >= q.maxBookingsPerMonth
    ) {
      add('monthly_limit')
    }

    const ordered = sortReasons(reasons)
    return { ...slot, status: ordered.length === 0 ? 'available' : 'unavailable', reasons: ordered }
  })
}

/** Each buffer source is checked separately; direct overlaps do not hide buffers. */
function candidateBuffers(
  blocked: NsInterval,
  start: bigint,
  end: bigint,
  before: bigint,
  after: bigint,
  add: (code: AvailabilityReasonCode, interval: NsInterval) => void,
) {
  if (before > 0n && overlaps({ start: start - before, end: start }, blocked)) {
    add('buffer_before', { start: blocked.start, end: blocked.end + before })
  }
  if (after > 0n && overlaps({ start: end, end: end + after }, blocked)) {
    add('buffer_after', { start: blocked.start - after, end: blocked.end })
  }
}

function candidateSlots(
  q: NormalizedInput,
  extra: readonly Temporal.Instant[] | undefined,
  maximum: number | undefined,
) {
  if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 1)) {
    throw new AvailabilityInputError('maximumCandidates must be a positive safe integer')
  }
  const candidates = new Map<bigint, Slot>()
  const scheduled = new Set<bigint>()
  const workingIntervals: NsInterval[] = []
  const add = (start: Temporal.Instant, onSchedule = false) => {
    const end = start.add({ minutes: q.durationMinutes })
    if (Temporal.Instant.compare(start, q.rangeStart) < 0) return
    if (Temporal.Instant.compare(end, q.rangeEnd) > 0) return
    if (
      maximum !== undefined &&
      !candidates.has(start.epochNanoseconds) &&
      candidates.size >= maximum
    ) {
      throw new AvailabilityInputError('explain candidate limit exceeded')
    }
    candidates.set(start.epochNanoseconds, { start, end })
    if (onSchedule) scheduled.add(start.epochNanoseconds)
  }
  const lastDate = q.rangeEnd.toZonedDateTimeISO(q.timeZone).toPlainDate().add({ days: 1 })
  let date = q.rangeStart.toZonedDateTimeISO(q.timeZone).toPlainDate().subtract({ days: 1 })
  for (; Temporal.PlainDate.compare(date, lastDate) <= 0; date = date.add({ days: 1 })) {
    for (let minute = 0; minute < MINUTES_PER_DAY; minute += q.slotStepMinutes) {
      const start = existingWallClockInstant(date, minute, q.timeZone)
      if (start) add(start)
    }
    const intervals =
      q.dateOverrides.get(date.toString()) ?? q.weeklyHours.get(date.dayOfWeek) ?? []
    for (const interval of intervals) {
      const intervalStart = boundaryInstant(date, interval.start, q.timeZone)
      const intervalEnd = boundaryInstant(date, interval.end, q.timeZone)
      workingIntervals.push(ns({ start: intervalStart, end: intervalEnd }))
      for (let minute = interval.start; minute < MINUTES_PER_DAY; minute += q.slotStepMinutes) {
        const start = existingWallClockInstant(date, minute, q.timeZone)
        if (!start || Temporal.Instant.compare(start, intervalStart) < 0) continue
        if (Temporal.Instant.compare(start.add({ minutes: q.durationMinutes }), intervalEnd) > 0) {
          break
        }
        add(start, true)
      }
    }
  }
  if (extra !== undefined) {
    if (!Array.isArray(extra)) throw new AvailabilityInputError('candidateStarts must be an array')
    for (const start of extra) {
      if (!(start instanceof Temporal.Instant)) {
        throw new AvailabilityInputError('candidateStarts must contain Temporal.Instant values')
      }
      // Ignore other hosts' out-of-range starts before performing Temporal arithmetic.
      if (
        Temporal.Instant.compare(start, q.rangeStart) >= 0 &&
        Temporal.Instant.compare(start, q.rangeEnd) < 0
      ) {
        add(start)
      }
    }
  }
  return {
    candidates: [...candidates.values()].sort((a, b) => Temporal.Instant.compare(a.start, b.start)),
    scheduled,
    workingIntervals,
  }
}

function boundaryInstant(date: Temporal.PlainDate, minute: number, timeZone: string) {
  return minute === MINUTES_PER_DAY
    ? date.add({ days: 1 }).toZonedDateTime(timeZone).toInstant()
    : wallClock(date, minute).toZonedDateTime(timeZone, COMPATIBLE).toInstant()
}

function existingWallClockInstant(date: Temporal.PlainDate, minute: number, timeZone: string) {
  const local = wallClock(date, minute)
  const zoned = local.toZonedDateTime(timeZone, COMPATIBLE)
  return zoned.toPlainDateTime().equals(local) ? zoned.toInstant() : undefined
}

function wallClock(date: Temporal.PlainDate, minute: number) {
  return date.toPlainDateTime({ hour: Math.floor(minute / 60), minute: minute % 60 })
}

function uncoveredParts(slot: NsInterval, working: readonly NsInterval[]): NsInterval[] {
  const parts: NsInterval[] = []
  let cursor = slot.start
  for (const interval of working) {
    if (interval.end <= cursor) continue
    if (interval.start >= slot.end) break
    if (interval.start > cursor) parts.push({ start: cursor, end: min(slot.end, interval.start) })
    cursor = max(cursor, interval.end)
    if (cursor >= slot.end) break
  }
  if (cursor < slot.end) parts.push({ start: cursor, end: slot.end })
  return parts
}

function sortReasons(reasons: AvailabilityReason[]) {
  reasons.sort(
    (a, b) =>
      AVAILABILITY_REASON_CODES.indexOf(a.code) - AVAILABILITY_REASON_CODES.indexOf(b.code) ||
      Temporal.Instant.compare(a.interval.start, b.interval.start) ||
      Temporal.Instant.compare(a.interval.end, b.interval.end),
  )
  return reasons.filter((reason, index) => {
    const previous = reasons[index - 1]
    return (
      !previous ||
      previous.code !== reason.code ||
      !previous.interval.start.equals(reason.interval.start) ||
      !previous.interval.end.equals(reason.interval.end)
    )
  })
}

function ns(interval: InstantInterval): NsInterval {
  return { start: interval.start.epochNanoseconds, end: interval.end.epochNanoseconds }
}

function overlaps(a: NsInterval, b: NsInterval) {
  return a.start < b.end && b.start < a.end
}

function min(a: bigint, b: bigint) {
  return a < b ? a : b
}

function max(a: bigint, b: bigint) {
  return a > b ? a : b
}

function weekKey(date: Temporal.PlainDate): string {
  return `${date.yearOfWeek}-${date.weekOfYear}`
}

function monthKey(date: Temporal.PlainDate): string {
  return `${date.year}-${date.month}`
}
