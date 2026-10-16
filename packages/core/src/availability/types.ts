/**
 * Local wall-clock time of day as `"HH:MM"` (24-hour, `"00:00"`–`"23:59"`).
 * `"24:00"` is also accepted, but only as the end of an interval, and means the
 * start of the next local day.
 */
export type WallClockTime = string

/**
 * Half-open span of local wall-clock time within one day: [start, end). `end`
 * must be after `start`; overnight hours are written as two intervals, one
 * ending at "24:00" and one starting at "00:00" on the next day.
 */
export interface WallClockInterval {
  readonly start: WallClockTime
  readonly end: WallClockTime
}

export type Weekday =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday'

/**
 * Recurring working hours per weekday. A missing or empty weekday means no
 * availability on that day. Intervals of one day must not overlap. Touching
 * intervals are joined: 09:00–10:30 plus 10:30–12:00 behaves exactly like
 * 09:00–12:00. Days are never joined across midnight.
 */
export type WeeklyHours = Readonly<Partial<Record<Weekday, readonly WallClockInterval[]>>>

/**
 * Replaces the weekly hours for one local date. An empty `intervals` list marks
 * the whole day unavailable. Intervals follow the same rules as `WeeklyHours`.
 */
export interface DateOverride {
  /** Local calendar date in the host's time zone, `"YYYY-MM-DD"`. */
  readonly date: string
  readonly intervals: readonly WallClockInterval[]
}

export interface HostSchedule {
  /** IANA time zone name, e.g. `"Europe/Berlin"`. All wall-clock times are read in this zone. */
  readonly timeZone: string
  readonly weeklyHours: WeeklyHours
  /** At most one override per date. */
  readonly dateOverrides?: readonly DateOverride[]
}

/** Booking rules of an event type. All values are whole numbers within the stated bounds. */
export interface EventTypeRules {
  /** Length of a meeting in elapsed minutes, 1–1440. */
  readonly durationMinutes: number
  /**
   * Distance between candidate start times, counted in wall-clock minutes from
   * the start of each working interval, 1–1440. Defaults to `durationMinutes`.
   */
  readonly slotStepMinutes?: number
  /** Time that must be free before a meeting, 0–1440. Defaults to 0. */
  readonly bufferBeforeMinutes?: number
  /** Time that must be free after a meeting, 0–1440. Defaults to 0. */
  readonly bufferAfterMinutes?: number
  /** A slot must start at least this long after `now`, 0–525600 (365 days). Defaults to 0. */
  readonly minimumNoticeMinutes?: number
  /**
   * A host-local day that already has this many bookings (counted on the local
   * date of each booking's start) offers no slots, 1–1000. Unlimited if omitted.
   */
  readonly maxBookingsPerDay?: number
  /**
   * A slot may start at most this many calendar days after `now`, counted in the
   * host's time zone (same wall-clock time N days later), 1–3650. Unlimited if omitted.
   */
  readonly bookingWindowDays?: number
}

/** Half-open span of absolute time: [start, end). `end` must be after `start`. */
export interface InstantInterval {
  readonly start: Temporal.Instant
  readonly end: Temporal.Instant
}

/** A bookable time. `end - start` always equals `durationMinutes` of elapsed time. */
export type Slot = InstantInterval

export interface AvailabilityInput {
  readonly schedule: HostSchedule
  readonly eventType: EventTypeRules
  /** Busy times from connected calendars. They block slots but do not count toward the daily limit. */
  readonly busy?: readonly InstantInterval[]
  /**
   * Existing bookings. They block slots and count toward `maxBookingsPerDay`;
   * pass bookings that should not count in `busy` instead.
   *
   * The engine applies only `eventType`'s buffers, around each candidate slot. It
   * knows nothing about the buffers of existing bookings: the caller must pass
   * each booking already widened by its own event type's buffers (start moved
   * earlier by its bufferBefore, end moved later by its bufferAfter). The daily
   * limit counts each booking on the local date of the start it is given, so a
   * booking widened across local midnight counts toward the earlier day.
   */
  readonly bookings?: readonly InstantInterval[]
  /**
   * Only slots that lie fully inside [rangeStart, rangeEnd] are returned. The
   * range may span at most 400 days, and `rangeStart`, `rangeEnd` and `now` must
   * fall in the years 0001–9999.
   */
  readonly rangeStart: Temporal.Instant
  readonly rangeEnd: Temporal.Instant
  /** Current time. The engine never reads the clock itself. */
  readonly now: Temporal.Instant
}
