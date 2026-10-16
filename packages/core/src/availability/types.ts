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
 * availability on that day. Intervals of one day must not overlap (touching is
 * fine, but each interval is used on its own: a slot never spans two intervals).
 */
export type WeeklyHours = Readonly<Partial<Record<Weekday, readonly WallClockInterval[]>>>

/**
 * Replaces the weekly hours for one local date. An empty `intervals` list marks
 * the whole day unavailable.
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

/** Booking rules of an event type. All values are whole numbers. */
export interface EventTypeRules {
  /** Length of a meeting in elapsed minutes. Must be positive. */
  readonly durationMinutes: number
  /**
   * Distance between candidate start times, counted in wall-clock minutes from
   * each working interval's start. Defaults to `durationMinutes`.
   */
  readonly slotStepMinutes?: number
  /** Time that must be free before a meeting. Defaults to 0. */
  readonly bufferBeforeMinutes?: number
  /** Time that must be free after a meeting. Defaults to 0. */
  readonly bufferAfterMinutes?: number
  /** A slot must start at least this long after `now`. Defaults to 0. */
  readonly minimumNoticeMinutes?: number
  /**
   * A host-local day that already has this many bookings (counted on the local
   * date of each booking's start) offers no slots. Unlimited if omitted.
   */
  readonly maxBookingsPerDay?: number
  /**
   * A slot may start at most this many calendar days after `now`, counted in the
   * host's time zone (same wall-clock time N days later). Unlimited if omitted.
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
   * Existing bookings, as the time they occupy (widen them by their own buffers
   * first if those must stay free too). They block slots and count toward
   * `maxBookingsPerDay`; pass bookings that should not count in `busy` instead.
   */
  readonly bookings?: readonly InstantInterval[]
  /** Only slots that lie fully inside [rangeStart, rangeEnd] are returned. */
  readonly rangeStart: Temporal.Instant
  readonly rangeEnd: Temporal.Instant
  /** Current time. The engine never reads the clock itself. */
  readonly now: Temporal.Instant
}
