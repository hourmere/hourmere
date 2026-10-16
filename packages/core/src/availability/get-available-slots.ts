import type { AvailabilityInput, InstantInterval, Slot } from './types.ts'
import { type NormalizedBooking, normalizeInput } from './validate.ts'

const COMPATIBLE = { disambiguation: 'compatible' } as const
const MINUTES_PER_DAY = 24 * 60

/**
 * Returns the bookable slots for one host and event type, sorted by start, with
 * no two slots sharing a start. Pure: no I/O and no clock reads (`now` is an input).
 * Throws `AvailabilityInputError` on invalid input.
 *
 * A slot is offered when all of these hold:
 * - it lies fully inside one working interval of its host-local day (date
 *   override if present, else weekly hours; touching intervals are joined first),
 *   and its start is a whole number of steps after that interval's start;
 * - [start - bufferBefore, end + bufferAfter] overlaps no busy time and no booking
 *   (touching endpoints is fine; buffers may reach outside working hours; each
 *   booking is first widened by its own buffers, see `AvailabilityInput.bookings`);
 * - now + minimumNotice <= start <= now + bookingWindowDays (calendar days in the
 *   host's zone);
 * - rangeStart <= start and end <= rangeEnd;
 * - its host-local day has fewer than maxBookingsPerDay bookings.
 *
 * Daylight saving time. Wall-clock times are read in the host's zone, separately
 * for each local date:
 * - Interval boundaries are converted with Temporal's 'compatible'
 *   disambiguation, which matches RFC 5545 (iCalendar): an ambiguous time on a
 *   fall-back day means its earlier occurrence, and a time inside a spring-forward
 *   gap moves forward by the gap's length (02:30 becomes 03:30 when 02:00–03:00 is
 *   skipped). "24:00" means the start of the next local day.
 * - Candidate starts step through wall-clock time from the interval's start, so
 *   starts stay on the host's local grid (e.g. :00 and :30) on every day. A
 *   candidate that does not exist on that date (inside a gap) is skipped rather
 *   than moved, so it never duplicates or misaligns a later candidate. An
 *   ambiguous candidate uses its earlier occurrence ('compatible').
 * - A slot's end is its start plus exactly durationMinutes of elapsed time, so
 *   its wall-clock length differs from the duration when it crosses a transition.
 *   The slot must end by the interval's resolved end instant, which for an end
 *   inside a gap is later than the wall clock suggests: 01:00–02:30 on a New York
 *   spring-forward day is [01:00 EST, 03:30 EDT) and offers 03:00 EDT.
 * - Consequences on transition days: the repeated hour of a fall-back day is not
 *   offered as a start a second time (slots that start earlier may still run into
 *   it), and after a gap two consecutive starts can be closer in real time than
 *   the step, so even with step = duration such slots may overlap.
 */
export function getAvailableSlots(input: AvailabilityInput): Slot[] {
  const q = normalizeInput(input)
  const timeZone = q.timeZone
  const duration = { minutes: q.durationMinutes }

  // Bounds on a slot's start.
  const earliest = later(q.rangeStart, q.now.add({ minutes: q.minimumNoticeMinutes }))
  let latest = q.rangeEnd.subtract(duration)
  if (q.bookingWindowDays !== undefined) {
    const windowEnd = q.now.toZonedDateTimeISO(timeZone).add({ days: q.bookingWindowDays })
    latest = earlier(latest, windowEnd.toInstant())
  }
  if (Temporal.Instant.compare(earliest, latest) > 0) return []

  const blocked = blockedIntervals(q.busy, q.bookings)
  const bookingsPerDay = countByLocalDate(q.bookings, timeZone)
  const slots: Slot[] = []

  // A slot starts on the local date whose wall-clock time it was generated from.
  // The local date is not monotonic in time: a fall-back across midnight (e.g.
  // America/St_Johns at 00:01 until 2011) steps it back to the previous day, so
  // `latest` can read an earlier date than `earliest`. No zone steps back more than
  // 24 hours, so visiting one extra day on each side covers every date a slot in
  // [earliest, latest] can start on; the per-candidate checks drop the rest.
  const lastDate = latest.toZonedDateTimeISO(timeZone).toPlainDate().add({ days: 1 })
  let date = earliest.toZonedDateTimeISO(timeZone).toPlainDate().subtract({ days: 1 })
  for (; Temporal.PlainDate.compare(date, lastDate) <= 0; date = date.add({ days: 1 })) {
    const key = date.toString()
    const bookedThatDay = bookingsPerDay.get(key) ?? 0
    if (q.maxBookingsPerDay !== undefined && bookedThatDay >= q.maxBookingsPerDay) continue

    const intervals = q.dateOverrides.get(key) ?? q.weeklyHours.get(date.dayOfWeek) ?? []
    for (const interval of intervals) {
      const intervalStart = boundaryInstant(date, interval.start, timeZone)
      const intervalEnd = boundaryInstant(date, interval.end, timeZone)

      // Not bounded by the interval's wall-clock end: an end inside a gap resolves
      // later (02:30 becomes 03:30), so a candidate after 02:30 on the wall clock
      // (03:00) can still end in time. The resolved end instant stops the loop.
      for (let minute = interval.start; minute < MINUTES_PER_DAY; minute += q.slotStepMinutes) {
        const start = existingWallClockInstant(date, minute, timeZone)
        if (start === undefined) continue
        // Only possible when the interval's start fell into a gap and was moved forward.
        if (Temporal.Instant.compare(start, intervalStart) < 0) continue
        const end = start.add(duration)
        // Existing wall-clock times of one date map to strictly increasing instants,
        // so once a candidate fails one of these two checks, every later one does.
        if (Temporal.Instant.compare(end, intervalEnd) > 0) break
        if (Temporal.Instant.compare(start, latest) > 0) break
        if (Temporal.Instant.compare(start, earliest) < 0) continue

        const windowStart = start.subtract({ minutes: q.bufferBeforeMinutes })
        const windowEnd = end.add({ minutes: q.bufferAfterMinutes })
        if (overlapsAny(blocked, windowStart, windowEnd)) continue
        slots.push({ start, end })
      }
    }
  }

  return sortedByUniqueStart(slots)
}

/** Converts an interval boundary ('compatible' disambiguation; 1440 = start of the next day). */
function boundaryInstant(date: Temporal.PlainDate, minute: number, timeZone: string) {
  if (minute === MINUTES_PER_DAY) return date.add({ days: 1 }).toZonedDateTime(timeZone).toInstant()
  return wallClock(date, minute).toZonedDateTime(timeZone, COMPATIBLE).toInstant()
}

/** Converts a candidate start; `undefined` when that wall-clock time does not exist (DST gap). */
function existingWallClockInstant(date: Temporal.PlainDate, minute: number, timeZone: string) {
  const local = wallClock(date, minute)
  const zoned = local.toZonedDateTime(timeZone, COMPATIBLE)
  // 'compatible' moves a nonexistent time forward, so a changed wall-clock reading means a gap.
  return zoned.toPlainDateTime().equals(local) ? zoned.toInstant() : undefined
}

function wallClock(date: Temporal.PlainDate, minute: number) {
  return date.toPlainDateTime({ hour: Math.floor(minute / 60), minute: minute % 60 })
}

interface NsInterval {
  start: bigint
  end: bigint
}

const NS_PER_MINUTE = 60_000_000_000n

/**
 * Times new slots must keep clear: busy intervals as given, bookings widened by
 * their own buffers. Plain bigint math, so a booking near the edge of Temporal's
 * range cannot overflow it.
 */
function blockedIntervals(
  busy: readonly InstantInterval[],
  bookings: readonly NormalizedBooking[],
): NsInterval[] {
  const fromBusy = busy.map((i) => ({
    start: i.start.epochNanoseconds,
    end: i.end.epochNanoseconds,
  }))
  const fromBookings = bookings.map((b) => ({
    start: b.start.epochNanoseconds - BigInt(b.bufferBeforeMinutes) * NS_PER_MINUTE,
    end: b.end.epochNanoseconds + BigInt(b.bufferAfterMinutes) * NS_PER_MINUTE,
  }))
  return mergeIntervals([...fromBusy, ...fromBookings])
}

/**
 * Sorts intervals and merges overlapping or touching ones. Merging touching ones
 * is lossless: a window that overlaps the merged interval overlaps one of the parts.
 */
function mergeIntervals(intervals: NsInterval[]): NsInterval[] {
  const sorted = intervals.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  const merged: NsInterval[] = []
  for (const interval of sorted) {
    const last = merged.at(-1)
    if (last && interval.start <= last.end) {
      if (interval.end > last.end) last.end = interval.end
    } else {
      merged.push({ ...interval })
    }
  }
  return merged
}

/** Whether the open window (start, end) overlaps any of the sorted, disjoint intervals. */
function overlapsAny(
  blocked: readonly NsInterval[],
  start: Temporal.Instant,
  end: Temporal.Instant,
) {
  const windowStart = start.epochNanoseconds
  const windowEnd = end.epochNanoseconds
  // Binary search for the first interval that ends after the window starts.
  let low = 0
  let high = blocked.length
  while (low < high) {
    const mid = (low + high) >>> 1
    const interval = blocked[mid]
    if (interval && interval.end <= windowStart) low = mid + 1
    else high = mid
  }
  const candidate = blocked[low]
  return candidate !== undefined && candidate.start < windowEnd
}

/** Counts intervals by the host-local date of their (real, unbuffered) start. */
function countByLocalDate(intervals: readonly InstantInterval[], timeZone: string) {
  const counts = new Map<string, number>()
  for (const { start } of intervals) {
    const key = start.toZonedDateTimeISO(timeZone).toPlainDate().toString()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/**
 * Intervals of one day are disjoint on the wall clock but can overlap in real
 * time when an end falls into a gap: 01:00–02:30 resolves to [01:00 EST, 03:30 EDT)
 * and overlaps a following 03:00–04:00, so their candidates can repeat (both yield
 * 03:00 EDT) or interleave (03:15 from the first after 03:00 from the second).
 * So sort, and drop repeated starts.
 */
function sortedByUniqueStart(slots: Slot[]): Slot[] {
  slots.sort((a, b) => Temporal.Instant.compare(a.start, b.start))
  return slots.filter((slot, i) => {
    const previous = slots[i - 1]
    return previous === undefined || !previous.start.equals(slot.start)
  })
}

function later(a: Temporal.Instant, b: Temporal.Instant) {
  return Temporal.Instant.compare(a, b) >= 0 ? a : b
}

function earlier(a: Temporal.Instant, b: Temporal.Instant) {
  return Temporal.Instant.compare(a, b) <= 0 ? a : b
}
