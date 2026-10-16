import { describe, expect, it } from 'vitest'
import {
  type AvailabilityInput,
  AvailabilityInputError,
  type DateOverride,
  type EventTypeRules,
  getAvailableSlots,
  type WeeklyHours,
} from './index.ts'

// Calendar used below (America/New_York is on EDT, -04:00, until 2026-11-01):
// Mon 2026-10-19 … Sun 2026-10-25, Mon 2026-10-26, Tue 2026-10-27.
// DST in New York: 2026-03-08 02:00 EST -> 03:00 EDT; 2026-11-01 02:00 EDT -> 01:00 EST.
const NEW_YORK = 'America/New_York'

interface Scenario {
  timeZone?: string
  weeklyHours: WeeklyHours
  dateOverrides?: DateOverride[]
  /** Defaults to a 60-minute event with no other rules. */
  eventType?: Partial<EventTypeRules>
  busy?: [string, string][]
  bookings?: [string, string][]
  range: [string, string]
  now: string
}

function toInput(s: Scenario): AvailabilityInput {
  const instant = (iso: string) => Temporal.Instant.from(iso)
  const intervals = (list: [string, string][] = []) =>
    list.map(([start, end]) => ({ start: instant(start), end: instant(end) }))
  return {
    schedule: {
      timeZone: s.timeZone ?? NEW_YORK,
      weeklyHours: s.weeklyHours,
      dateOverrides: s.dateOverrides,
    },
    eventType: { durationMinutes: 60, ...s.eventType },
    busy: intervals(s.busy),
    bookings: intervals(s.bookings),
    rangeStart: instant(s.range[0]),
    rangeEnd: instant(s.range[1]),
    now: instant(s.now),
  }
}

/**
 * Runs the engine, checks the invariants every result must hold, and renders each
 * slot as an ISO 8601 interval in the host's zone:
 * "2026-10-19T09:00-04:00/2026-10-19T10:00-04:00".
 */
function slots(s: Scenario): string[] {
  const input = toInput(s)
  const result = getAvailableSlots(input)
  result.forEach((slot, i) => {
    expect(slot.end.since(slot.start).total('minutes')).toBe(input.eventType.durationMinutes)
    const previous = result[i - 1]
    if (previous) expect(Temporal.Instant.compare(previous.start, slot.start)).toBe(-1)
  })
  const local = (instant: Temporal.Instant) =>
    instant
      .toZonedDateTimeISO(input.schedule.timeZone)
      .toString({ timeZoneName: 'never', smallestUnit: 'minute' })
  return result.map((slot) => `${local(slot.start)}/${local(slot.end)}`)
}

/** Same-day interval on EDT (-04:00), for scenarios that stay away from DST changes. */
const edt = (date: string, from: string, to: string) => `${date}T${from}-04:00/${date}T${to}-04:00`

const hours = (start: string, end: string) => ({ start, end })
const weekdays = (...intervals: { start: string; end: string }[]): WeeklyHours => ({
  monday: intervals,
  tuesday: intervals,
  wednesday: intervals,
  thursday: intervals,
  friday: intervals,
})

const MONDAY: [string, string] = ['2026-10-19T00:00-04:00', '2026-10-20T00:00-04:00']
const LAST_SUNDAY = '2026-10-18T12:00-04:00'

describe('getAvailableSlots', () => {
  describe('weekly hours', () => {
    it('offers back-to-back slots inside each working interval', () => {
      // Intervals may be listed in any order.
      const weeklyHours = { monday: [hours('13:00', '15:00'), hours('09:00', '12:00')] }
      expect(slots({ weeklyHours, range: MONDAY, now: LAST_SUNDAY })).toEqual([
        edt('2026-10-19', '09:00', '10:00'),
        edt('2026-10-19', '10:00', '11:00'),
        edt('2026-10-19', '11:00', '12:00'),
        edt('2026-10-19', '13:00', '14:00'),
        edt('2026-10-19', '14:00', '15:00'),
      ])
    })

    it('restarts step alignment at each interval and drops a slot that would overrun it', () => {
      const weeklyHours = { monday: [hours('09:00', '12:00'), hours('13:00', '15:00')] }
      expect(
        slots({ weeklyHours, eventType: { durationMinutes: 45 }, range: MONDAY, now: LAST_SUNDAY }),
      ).toEqual([
        edt('2026-10-19', '09:00', '09:45'),
        edt('2026-10-19', '09:45', '10:30'),
        edt('2026-10-19', '10:30', '11:15'),
        edt('2026-10-19', '11:15', '12:00'),
        // 13:00 is not a multiple of 45 minutes after 09:00; alignment restarts here.
        edt('2026-10-19', '13:00', '13:45'),
        edt('2026-10-19', '13:45', '14:30'),
        // 14:30–15:15 would end after 15:00.
      ])
    })

    it('offers nothing on days without hours', () => {
      const weekend: [string, string] = ['2026-10-24T00:00-04:00', '2026-10-26T00:00-04:00']
      expect(
        slots({ weeklyHours: weekdays(hours('09:00', '17:00')), range: weekend, now: LAST_SUNDAY }),
      ).toEqual([])
    })

    it('treats "24:00" as the end of the day', () => {
      expect(
        slots({
          weeklyHours: { friday: [hours('22:00', '24:00')] },
          range: ['2026-10-23T00:00-04:00', '2026-10-25T00:00-04:00'],
          now: LAST_SUNDAY,
        }),
      ).toEqual([
        '2026-10-23T22:00-04:00/2026-10-23T23:00-04:00',
        '2026-10-23T23:00-04:00/2026-10-24T00:00-04:00',
      ])
    })

    it('joins touching intervals, so a slot can cross the join', () => {
      const joined = { monday: [hours('10:30', '12:00'), hours('09:00', '10:30')] }
      const expected = [
        edt('2026-10-19', '09:00', '10:00'),
        edt('2026-10-19', '10:00', '11:00'), // crosses the 10:30 join
        edt('2026-10-19', '11:00', '12:00'),
      ]
      expect(slots({ weeklyHours: joined, range: MONDAY, now: LAST_SUNDAY })).toEqual(expected)
      // Date overrides follow the same rule.
      expect(
        slots({
          weeklyHours: {},
          dateOverrides: [
            { date: '2026-10-19', intervals: [hours('09:00', '10:30'), hours('10:30', '12:00')] },
          ],
          range: MONDAY,
          now: LAST_SUNDAY,
        }),
      ).toEqual(expected)
    })

    it('aligns steps from the start of the joined interval', () => {
      const pieces = {
        monday: [hours('09:00', '10:00'), hours('10:00', '11:00'), hours('11:00', '12:00')],
      }
      const whole = { monday: [hours('09:00', '12:00')] }
      const eventType = { durationMinutes: 45 }
      const expected = [
        edt('2026-10-19', '09:00', '09:45'),
        edt('2026-10-19', '09:45', '10:30'), // separate pieces would restart at 10:00 instead
        edt('2026-10-19', '10:30', '11:15'),
        edt('2026-10-19', '11:15', '12:00'),
      ]
      expect(slots({ weeklyHours: pieces, eventType, range: MONDAY, now: LAST_SUNDAY })).toEqual(
        expected,
      )
      expect(slots({ weeklyHours: whole, eventType, range: MONDAY, now: LAST_SUNDAY })).toEqual(
        expected,
      )
    })

    it('does not join hours across midnight', () => {
      expect(
        slots({
          weeklyHours: { friday: [hours('22:00', '24:00')], saturday: [hours('00:00', '02:00')] },
          eventType: { durationMinutes: 90, slotStepMinutes: 30 },
          range: ['2026-10-23T00:00-04:00', '2026-10-25T00:00-04:00'],
          now: LAST_SUNDAY,
        }),
      ).toEqual([
        '2026-10-23T22:00-04:00/2026-10-23T23:30-04:00',
        '2026-10-23T22:30-04:00/2026-10-24T00:00-04:00',
        // No slot from 23:00 or 23:30: those would cross midnight into Saturday's hours.
        '2026-10-24T00:00-04:00/2026-10-24T01:30-04:00',
        '2026-10-24T00:30-04:00/2026-10-24T02:00-04:00',
      ])
    })
  })

  it('removes slots that overlap a busy interval, but not ones that only touch it', () => {
    expect(
      slots({
        weeklyHours: { monday: [hours('09:00', '13:00')] },
        busy: [
          ['2026-10-19T08:00-04:00', '2026-10-19T09:00-04:00'], // ends as the 09:00 slot starts
          ['2026-10-19T14:30Z', '2026-10-19T15:15Z'], // 10:30–11:15 in New York
          ['2026-10-19T10:50-04:00', '2026-10-19T11:10-04:00'], // overlaps the previous one
          ['2026-10-19T13:00-04:00', '2026-10-19T14:00-04:00'], // starts as the 12:00 slot ends
        ],
        range: MONDAY,
        now: LAST_SUNDAY,
      }),
    ).toEqual([edt('2026-10-19', '09:00', '10:00'), edt('2026-10-19', '12:00', '13:00')])
  })

  describe('buffers', () => {
    const scenario: Scenario = {
      weeklyHours: { monday: [hours('09:00', '16:00')] },
      busy: [
        ['2026-10-19T10:30-04:00', '2026-10-19T11:50-04:00'],
        ['2026-10-19T15:10-04:00', '2026-10-19T16:00-04:00'],
      ],
      range: MONDAY,
      now: LAST_SUNDAY,
    }

    it('without buffers, only the meeting itself must be free', () => {
      expect(slots(scenario)).toEqual([
        edt('2026-10-19', '09:00', '10:00'),
        edt('2026-10-19', '12:00', '13:00'),
        edt('2026-10-19', '13:00', '14:00'),
        edt('2026-10-19', '14:00', '15:00'),
      ])
    })

    it('keeps the buffer windows before and after each slot free as well', () => {
      const eventType = { bufferBeforeMinutes: 15, bufferAfterMinutes: 30 }
      const expected = [
        // Window 08:45–10:30: may leave working hours and may touch the 10:30 busy start.
        edt('2026-10-19', '09:00', '10:00'),
        // 12:00 is gone: its window starts 11:45, before the busy time ends at 11:50.
        // Window 12:45–14:30.
        edt('2026-10-19', '13:00', '14:00'),
        // 14:00 is gone: its window ends 15:30, after the busy time starts at 15:10.
      ]
      expect(slots({ ...scenario, eventType })).toEqual(expected)
      // Bookings block buffer windows the same way.
      expect(slots({ ...scenario, eventType, busy: [], bookings: scenario.busy })).toEqual(expected)
    })
  })

  describe('minimum notice', () => {
    const weeklyHours = weekdays(hours('09:00', '13:00'))
    const eventType = { minimumNoticeMinutes: 120 }

    it('allows a slot that starts exactly at now + notice', () => {
      expect(
        slots({ weeklyHours, eventType, range: MONDAY, now: '2026-10-19T09:00-04:00' }),
      ).toEqual([edt('2026-10-19', '11:00', '12:00'), edt('2026-10-19', '12:00', '13:00')])
    })

    it('does not move slots off the step grid to meet the notice', () => {
      expect(
        slots({ weeklyHours, eventType, range: MONDAY, now: '2026-10-19T09:01-04:00' }),
      ).toEqual([edt('2026-10-19', '12:00', '13:00')])
    })

    it('trims today only, leaving the next day intact', () => {
      expect(
        slots({
          weeklyHours,
          eventType,
          range: ['2026-10-19T00:00-04:00', '2026-10-21T00:00-04:00'],
          now: '2026-10-19T11:30-04:00',
        }),
      ).toEqual([
        edt('2026-10-20', '09:00', '10:00'),
        edt('2026-10-20', '10:00', '11:00'),
        edt('2026-10-20', '11:00', '12:00'),
        edt('2026-10-20', '12:00', '13:00'),
      ])
    })

    it('counts notice in elapsed time across nights', () => {
      expect(
        slots({
          weeklyHours,
          eventType: { minimumNoticeMinutes: 15 * 60 },
          range: ['2026-10-19T00:00-04:00', '2026-10-21T00:00-04:00'],
          now: '2026-10-19T20:00-04:00', // earliest start: Tuesday 11:00
        }),
      ).toEqual([edt('2026-10-20', '11:00', '12:00'), edt('2026-10-20', '12:00', '13:00')])
    })
  })

  describe('booking window', () => {
    it('allows starts up to and including now + bookingWindowDays', () => {
      expect(
        slots({
          weeklyHours: weekdays(hours('09:00', '12:00')),
          eventType: { bookingWindowDays: 2 },
          range: ['2026-10-19T00:00-04:00', '2026-10-24T00:00-04:00'],
          now: '2026-10-19T10:00-04:00', // window ends Wednesday 10:00
        }),
      ).toEqual([
        edt('2026-10-19', '10:00', '11:00'), // 09:00 is in the past
        edt('2026-10-19', '11:00', '12:00'),
        edt('2026-10-20', '09:00', '10:00'),
        edt('2026-10-20', '10:00', '11:00'),
        edt('2026-10-20', '11:00', '12:00'),
        edt('2026-10-21', '09:00', '10:00'),
        edt('2026-10-21', '10:00', '11:00'),
      ])
    })

    it('counts calendar days in the host zone, keeping the wall-clock end across DST', () => {
      // Friday 10:00 EDT + 3 days = Monday 10:00 EST (73 elapsed hours, not 72).
      expect(
        slots({
          weeklyHours: weekdays(hours('09:00', '12:00')),
          eventType: { bookingWindowDays: 3 },
          range: ['2026-10-30T00:00-04:00', '2026-11-03T00:00-05:00'],
          now: '2026-10-30T10:00-04:00',
        }),
      ).toEqual([
        '2026-10-30T10:00-04:00/2026-10-30T11:00-04:00',
        '2026-10-30T11:00-04:00/2026-10-30T12:00-04:00',
        '2026-11-02T09:00-05:00/2026-11-02T10:00-05:00',
        '2026-11-02T10:00-05:00/2026-11-02T11:00-05:00',
      ])
    })
  })

  describe('daily booking limit', () => {
    const scenario: Scenario = {
      weeklyHours: weekdays(hours('09:00', '13:00')),
      eventType: { maxBookingsPerDay: 2 },
      bookings: [
        ['2026-10-19T09:00-04:00', '2026-10-19T10:00-04:00'],
        // Monday 20:30 in New York, but already Tuesday in UTC.
        ['2026-10-20T00:30Z', '2026-10-20T01:00Z'],
        ['2026-10-20T10:00-04:00', '2026-10-20T11:00-04:00'],
      ],
      // Calendar busy time does not count toward the limit.
      busy: [
        ['2026-10-21T07:00-04:00', '2026-10-21T08:00-04:00'],
        ['2026-10-21T18:00-04:00', '2026-10-21T19:00-04:00'],
      ],
      range: ['2026-10-19T00:00-04:00', '2026-10-22T00:00-04:00'],
      now: LAST_SUNDAY,
    }

    it('closes a host-local day that already has the maximum number of bookings', () => {
      expect(slots(scenario)).toEqual([
        // Monday: 2 bookings (host-local), so no slots.
        // Tuesday: 1 booking, which still blocks its own time.
        edt('2026-10-20', '09:00', '10:00'),
        edt('2026-10-20', '11:00', '12:00'),
        edt('2026-10-20', '12:00', '13:00'),
        // Wednesday: no bookings.
        edt('2026-10-21', '09:00', '10:00'),
        edt('2026-10-21', '10:00', '11:00'),
        edt('2026-10-21', '11:00', '12:00'),
        edt('2026-10-21', '12:00', '13:00'),
      ])
    })

    it('keeps a day open while it is below the limit', () => {
      expect(slots({ ...scenario, eventType: { maxBookingsPerDay: 3 }, range: MONDAY })).toEqual([
        edt('2026-10-19', '10:00', '11:00'),
        edt('2026-10-19', '11:00', '12:00'),
        edt('2026-10-19', '12:00', '13:00'),
      ])
    })
  })

  it('applies date overrides: a day off, custom hours, and hours on a normally free day', () => {
    expect(
      slots({
        weeklyHours: weekdays(hours('09:00', '12:00')),
        dateOverrides: [
          { date: '2026-10-20', intervals: [] },
          { date: '2026-10-21', intervals: [hours('14:00', '16:30')] },
          { date: '2026-10-24', intervals: [hours('10:00', '12:00')] },
        ],
        range: ['2026-10-19T00:00-04:00', '2026-10-25T00:00-04:00'],
        now: LAST_SUNDAY,
      }),
    ).toEqual([
      edt('2026-10-19', '09:00', '10:00'),
      edt('2026-10-19', '10:00', '11:00'),
      edt('2026-10-19', '11:00', '12:00'),
      // Tuesday is off.
      // Wednesday replaces 09:00–12:00 with 14:00–16:30; 16:00–17:00 would overrun.
      edt('2026-10-21', '14:00', '15:00'),
      edt('2026-10-21', '15:00', '16:00'),
      edt('2026-10-22', '09:00', '10:00'),
      edt('2026-10-22', '10:00', '11:00'),
      edt('2026-10-22', '11:00', '12:00'),
      edt('2026-10-23', '09:00', '10:00'),
      edt('2026-10-23', '10:00', '11:00'),
      edt('2026-10-23', '11:00', '12:00'),
      // Saturday has hours only through its override.
      edt('2026-10-24', '10:00', '11:00'),
      edt('2026-10-24', '11:00', '12:00'),
    ])
  })

  describe('slot step', () => {
    const weeklyHours = { monday: [hours('09:00', '10:30')] }

    it('offers overlapping slots when the step is shorter than the duration', () => {
      const eventType = { durationMinutes: 30, slotStepMinutes: 15 }
      expect(slots({ weeklyHours, eventType, range: MONDAY, now: LAST_SUNDAY })).toEqual([
        edt('2026-10-19', '09:00', '09:30'),
        edt('2026-10-19', '09:15', '09:45'),
        edt('2026-10-19', '09:30', '10:00'),
        edt('2026-10-19', '09:45', '10:15'),
        edt('2026-10-19', '10:00', '10:30'),
      ])
      expect(
        slots({
          weeklyHours,
          eventType,
          busy: [['2026-10-19T09:50-04:00', '2026-10-19T10:00-04:00']],
          range: MONDAY,
          now: LAST_SUNDAY,
        }),
      ).toEqual([
        edt('2026-10-19', '09:00', '09:30'),
        edt('2026-10-19', '09:15', '09:45'),
        edt('2026-10-19', '10:00', '10:30'),
      ])
    })

    it('leaves gaps when the step is longer than the duration', () => {
      const eventType = { durationMinutes: 30, slotStepMinutes: 60 }
      expect(slots({ weeklyHours, eventType, range: MONDAY, now: LAST_SUNDAY })).toEqual([
        edt('2026-10-19', '09:00', '09:30'),
        edt('2026-10-19', '10:00', '10:30'),
      ])
    })
  })

  describe('spring forward (America/New_York, 2026-03-08: 02:00 EST jumps to 03:00 EDT)', () => {
    const sunday: [string, string] = ['2026-03-08T00:00-05:00', '2026-03-09T00:00-04:00']
    const now = '2026-03-01T00:00-05:00'
    const sundayHours = { sunday: [hours('01:00', '04:00')] }

    it('skips the missing hour; 01:00–04:00 holds two hours that day', () => {
      const weeklyHours = {
        saturday: [hours('01:00', '04:00')],
        sunday: [hours('01:00', '04:00')],
        monday: [hours('01:00', '04:00')],
      }
      expect(
        slots({ weeklyHours, range: ['2026-03-07T00:00-05:00', '2026-03-10T00:00-04:00'], now }),
      ).toEqual([
        '2026-03-07T01:00-05:00/2026-03-07T02:00-05:00',
        '2026-03-07T02:00-05:00/2026-03-07T03:00-05:00',
        '2026-03-07T03:00-05:00/2026-03-07T04:00-05:00',
        // 01:00 EST + 60 min = 03:00 EDT. The 02:00 candidate does not exist and is skipped.
        '2026-03-08T01:00-05:00/2026-03-08T03:00-04:00',
        '2026-03-08T03:00-04:00/2026-03-08T04:00-04:00',
        '2026-03-09T01:00-04:00/2026-03-09T02:00-04:00',
        '2026-03-09T02:00-04:00/2026-03-09T03:00-04:00',
        '2026-03-09T03:00-04:00/2026-03-09T04:00-04:00',
      ])
    })

    it('skips each missing candidate with a 30-minute step', () => {
      const eventType = { durationMinutes: 30 }
      expect(slots({ weeklyHours: sundayHours, eventType, range: sunday, now })).toEqual([
        '2026-03-08T01:00-05:00/2026-03-08T01:30-05:00',
        '2026-03-08T01:30-05:00/2026-03-08T03:00-04:00',
        // 02:00 and 02:30 do not exist.
        '2026-03-08T03:00-04:00/2026-03-08T03:30-04:00',
        '2026-03-08T03:30-04:00/2026-03-08T04:00-04:00',
      ])
    })

    it('skips a missing candidate off the hour; later starts stay on the wall-clock grid', () => {
      const eventType = { durationMinutes: 45 }
      expect(slots({ weeklyHours: sundayHours, eventType, range: sunday, now })).toEqual([
        '2026-03-08T01:00-05:00/2026-03-08T01:45-05:00',
        '2026-03-08T01:45-05:00/2026-03-08T03:30-04:00',
        // 02:30 does not exist. The next step, 03:15 EDT, starts 15 minutes before the previous
        // slot ends: on this day, steps of the wall clock are not back-to-back in real time.
        '2026-03-08T03:15-04:00/2026-03-08T04:00-04:00',
      ])
    })

    it('keeps the real duration when a slot spans the gap', () => {
      const eventType = { durationMinutes: 90, slotStepMinutes: 30 }
      expect(slots({ weeklyHours: sundayHours, eventType, range: sunday, now })).toEqual([
        '2026-03-08T01:00-05:00/2026-03-08T03:30-04:00',
        '2026-03-08T01:30-05:00/2026-03-08T04:00-04:00',
        // 03:00 EDT + 90 min = 04:30 EDT, past the end of hours.
      ])
    })

    it('moves an interval start inside the gap forward by the gap length (compatible)', () => {
      // 02:30 does not exist and resolves to 03:30 EDT, so the 03:00 candidate is before the
      // interval starts. The 02:30 candidate itself is skipped.
      const eventType = { slotStepMinutes: 30 }
      expect(
        slots({
          weeklyHours: { sunday: [hours('02:30', '05:00')] },
          eventType,
          range: sunday,
          now,
        }),
      ).toEqual([
        '2026-03-08T03:30-04:00/2026-03-08T04:30-04:00',
        '2026-03-08T04:00-04:00/2026-03-08T05:00-04:00',
      ])
    })
  })

  describe('fall back (America/New_York, 2026-11-01: 02:00 EDT falls back to 01:00 EST)', () => {
    const sunday: [string, string] = ['2026-11-01T00:00-04:00', '2026-11-02T00:00-05:00']
    const now = '2026-10-25T00:00-04:00'
    const sundayHours = { sunday: [hours('00:00', '03:00')] }

    it('resolves the repeated 01:00 to its first occurrence (00:00–03:00 is 4 h)', () => {
      const weeklyHours = {
        saturday: [hours('00:00', '03:00')],
        sunday: [hours('00:00', '03:00')],
        monday: [hours('00:00', '03:00')],
      }
      expect(
        slots({ weeklyHours, range: ['2026-10-31T00:00-04:00', '2026-11-03T00:00-05:00'], now }),
      ).toEqual([
        '2026-10-31T00:00-04:00/2026-10-31T01:00-04:00',
        '2026-10-31T01:00-04:00/2026-10-31T02:00-04:00',
        '2026-10-31T02:00-04:00/2026-10-31T03:00-04:00',
        '2026-11-01T00:00-04:00/2026-11-01T01:00-04:00',
        // 01:00 EDT + 60 min = 01:00 EST.
        '2026-11-01T01:00-04:00/2026-11-01T01:00-05:00',
        // The second 01:00 (EST) is not a separate wall-clock step, so the next start is 02:00 EST.
        '2026-11-01T02:00-05:00/2026-11-01T03:00-05:00',
        '2026-11-02T00:00-05:00/2026-11-02T01:00-05:00',
        '2026-11-02T01:00-05:00/2026-11-02T02:00-05:00',
        '2026-11-02T02:00-05:00/2026-11-02T03:00-05:00',
      ])
    })

    it('keeps the real duration when a slot spans the repeated hour', () => {
      const eventType = { durationMinutes: 90, slotStepMinutes: 30 }
      expect(slots({ weeklyHours: sundayHours, eventType, range: sunday, now })).toEqual([
        '2026-11-01T00:00-04:00/2026-11-01T01:30-04:00',
        '2026-11-01T00:30-04:00/2026-11-01T01:00-05:00',
        '2026-11-01T01:00-04:00/2026-11-01T01:30-05:00',
        '2026-11-01T01:30-04:00/2026-11-01T02:00-05:00',
        // 02:00 EST + 90 min = 03:30 EST, past the end of hours.
      ])
    })

    it('compares busy time as instants, even during the repeated hour', () => {
      // Busy during the second 01:00–02:00 (EST) only.
      const eventType = { durationMinutes: 90, slotStepMinutes: 30 }
      const busy: [string, string][] = [['2026-11-01T01:00-05:00', '2026-11-01T02:00-05:00']]
      expect(slots({ weeklyHours: sundayHours, eventType, busy, range: sunday, now })).toEqual([
        '2026-11-01T00:00-04:00/2026-11-01T01:30-04:00',
        '2026-11-01T00:30-04:00/2026-11-01T01:00-05:00', // touches the busy start
      ])
    })

    it('resolves an ambiguous interval end to its first occurrence', () => {
      const eventType = { durationMinutes: 30 }
      expect(
        slots({
          weeklyHours: { sunday: [hours('00:00', '01:30')] },
          eventType,
          range: sunday,
          now,
        }),
      ).toEqual([
        '2026-11-01T00:00-04:00/2026-11-01T00:30-04:00',
        '2026-11-01T00:30-04:00/2026-11-01T01:00-04:00',
        '2026-11-01T01:00-04:00/2026-11-01T01:30-04:00',
      ])
    })
  })

  describe('zones without DST', () => {
    it('handles a half-hour offset (Asia/Kolkata, +05:30)', () => {
      const input: Scenario = {
        timeZone: 'Asia/Kolkata',
        weeklyHours: { monday: [hours('09:00', '12:00')] },
        busy: [['2026-10-19T05:00Z', '2026-10-19T05:30Z']], // 10:30–11:00 in Kolkata
        range: ['2026-10-19T00:00Z', '2026-10-20T00:00Z'],
        now: '2026-10-18T00:00Z',
      }
      expect(slots(input)).toEqual([
        '2026-10-19T09:00+05:30/2026-10-19T10:00+05:30',
        '2026-10-19T11:00+05:30/2026-10-19T12:00+05:30',
      ])
      expect(getAvailableSlots(toInput(input))[0]?.start.toString()).toBe('2026-10-19T03:30:00Z')
    })

    it('uses the host-local weekday when it differs from the UTC one (Asia/Shanghai)', () => {
      // Monday 07:00–08:00 in Shanghai is Sunday 23:00–24:00 UTC: inside a UTC-Sunday range.
      expect(
        slots({
          timeZone: 'Asia/Shanghai',
          weeklyHours: { monday: [hours('07:00', '10:00')] },
          range: ['2026-10-18T00:00Z', '2026-10-19T00:00Z'],
          now: '2026-10-17T00:00Z',
        }),
      ).toEqual(['2026-10-19T07:00+08:00/2026-10-19T08:00+08:00'])
    })

    it('is unaffected by other zones’ DST dates (Asia/Shanghai on 2026-03-08)', () => {
      expect(
        slots({
          timeZone: 'Asia/Shanghai',
          weeklyHours: { sunday: [hours('01:00', '04:00')] },
          range: ['2026-03-08T00:00+08:00', '2026-03-09T00:00+08:00'],
          now: '2026-03-01T00:00+08:00',
        }),
      ).toEqual([
        '2026-03-08T01:00+08:00/2026-03-08T02:00+08:00',
        '2026-03-08T02:00+08:00/2026-03-08T03:00+08:00',
        '2026-03-08T03:00+08:00/2026-03-08T04:00+08:00',
      ])
    })
  })

  describe('query ranges over several days', () => {
    it('crosses a weekend and a week boundary, clipping both partial end days', () => {
      expect(
        slots({
          weeklyHours: weekdays(hours('09:00', '11:00')),
          range: ['2026-10-22T10:00-04:00', '2026-10-27T10:00-04:00'],
          now: LAST_SUNDAY,
        }),
      ).toEqual([
        edt('2026-10-22', '10:00', '11:00'), // Thursday 09:00 starts before the range
        edt('2026-10-23', '09:00', '10:00'),
        edt('2026-10-23', '10:00', '11:00'),
        edt('2026-10-26', '09:00', '10:00'),
        edt('2026-10-26', '10:00', '11:00'),
        edt('2026-10-27', '09:00', '10:00'), // Tuesday 10:00–11:00 ends after the range
      ])
    })

    it('keeps weekly hours at the same local time across a DST change', () => {
      expect(
        slots({
          weeklyHours: { tuesday: [hours('09:00', '10:00')] },
          eventType: { durationMinutes: 30 },
          range: ['2026-10-19T00:00-04:00', '2026-11-09T00:00-05:00'],
          now: LAST_SUNDAY,
        }),
      ).toEqual([
        '2026-10-20T09:00-04:00/2026-10-20T09:30-04:00',
        '2026-10-20T09:30-04:00/2026-10-20T10:00-04:00',
        '2026-10-27T09:00-04:00/2026-10-27T09:30-04:00',
        '2026-10-27T09:30-04:00/2026-10-27T10:00-04:00',
        '2026-11-03T09:00-05:00/2026-11-03T09:30-05:00',
        '2026-11-03T09:30-05:00/2026-11-03T10:00-05:00',
      ])
    })

    it('returns nothing when notice or the booking window leave no room in the range', () => {
      const weeklyHours = weekdays(hours('09:00', '17:00'))
      expect(
        slots({
          weeklyHours,
          eventType: { minimumNoticeMinutes: 7 * 24 * 60 },
          range: MONDAY,
          now: LAST_SUNDAY,
        }),
      ).toEqual([])
      expect(
        slots({
          weeklyHours,
          eventType: { bookingWindowDays: 1 },
          range: ['2026-10-26T00:00-04:00', '2026-10-27T00:00-04:00'],
          now: LAST_SUNDAY,
        }),
      ).toEqual([])
    })
  })

  describe('input validation', () => {
    const valid = (): AvailabilityInput =>
      toInput({
        weeklyHours: { monday: [hours('09:00', '12:00')] },
        range: MONDAY,
        now: LAST_SUNDAY,
      })
    const withSchedule = (schedule: Partial<AvailabilityInput['schedule']>) => ({
      ...valid(),
      schedule: { ...valid().schedule, ...schedule },
    })
    const withEventType = (eventType: Partial<EventTypeRules>) => ({
      ...valid(),
      eventType: { ...valid().eventType, ...eventType },
    })
    const monday = (...intervals: { start: string; end: string }[]) =>
      withSchedule({ weeklyHours: { monday: intervals } })
    const at = (iso: string) => Temporal.Instant.from(iso)

    it.each<[string, () => AvailabilityInput, RegExp]>([
      [
        'unknown time zone',
        () => withSchedule({ timeZone: 'Mars/Olympus' }),
        /schedule\.timeZone is not a known IANA time zone: "Mars\/Olympus"/,
      ],
      ['UTC offset as time zone', () => withSchedule({ timeZone: '+08:00' }), /not a UTC offset/],
      [
        'interval end before start',
        () => monday(hours('12:00', '09:00')),
        /schedule\.weeklyHours\.monday\[0\]\.end \(09:00\) must be after start \(12:00\)/,
      ],
      ['empty interval', () => monday(hours('09:00', '09:00')), /must be after start/],
      [
        'malformed time',
        () => monday(hours('9:00', '12:00')),
        /monday\[0\]\.start must be a time "HH:MM" from "00:00" to "23:59", got "9:00"/,
      ],
      ['"24:00" as a start', () => monday(hours('24:00', '24:00')), /"00:00" to "23:59"/],
      ['time past midnight', () => monday(hours('09:00', '24:30')), /"00:00" to "24:00"/],
      [
        'overlapping intervals',
        () => monday(hours('11:00', '13:00'), hours('09:00', '12:00')),
        /monday has overlapping intervals 09:00–12:00 and 11:00–13:00/,
      ],
      [
        'unknown weekday',
        () =>
          withSchedule({
            weeklyHours: { mon: [hours('09:00', '12:00')] } as unknown as WeeklyHours,
          }),
        /unknown weekday "mon"/,
      ],
      [
        'impossible override date',
        () => withSchedule({ dateOverrides: [{ date: '2026-02-30', intervals: [] }] }),
        /dateOverrides\[0\]\.date is not a valid calendar date: 2026-02-30/,
      ],
      [
        'override date with a time',
        () => withSchedule({ dateOverrides: [{ date: '2026-03-08T10:00', intervals: [] }] }),
        /must be a date like "2026-03-08"/,
      ],
      [
        'duplicate override date',
        () =>
          withSchedule({
            dateOverrides: [
              { date: '2026-10-20', intervals: [] },
              { date: '2026-10-20', intervals: [hours('09:00', '10:00')] },
            ],
          }),
        /dateOverrides\[1\]\.date 2026-10-20 appears more than once/,
      ],
      [
        'overlap next to a join',
        () => monday(hours('09:00', '10:00'), hours('10:00', '11:00'), hours('10:30', '12:00')),
        /monday has overlapping intervals 10:00–11:00 and 10:30–12:00/,
      ],
      [
        'zero duration',
        () => withEventType({ durationMinutes: 0 }),
        /eventType\.durationMinutes must be a whole number from 1 to 1440, got 0/,
      ],
      ['fractional duration', () => withEventType({ durationMinutes: 22.5 }), /durationMinutes/],
      ['negative step', () => withEventType({ slotStepMinutes: -15 }), /slotStepMinutes/],
      [
        'negative buffer',
        () => withEventType({ bufferBeforeMinutes: -5 }),
        /bufferBeforeMinutes must be a whole number from 0 to 1440, got -5/,
      ],
      [
        'negative notice',
        () => withEventType({ minimumNoticeMinutes: -1 }),
        /minimumNoticeMinutes/,
      ],
      ['zero daily limit', () => withEventType({ maxBookingsPerDay: 0 }), /maxBookingsPerDay/],
      ['zero booking window', () => withEventType({ bookingWindowDays: 0 }), /bookingWindowDays/],
      // Upper bounds, one past each maximum.
      [
        'duration over a day',
        () => withEventType({ durationMinutes: 1441 }),
        /durationMinutes must be a whole number from 1 to 1440, got 1441/,
      ],
      [
        'step over a day',
        () => withEventType({ slotStepMinutes: 1441 }),
        /slotStepMinutes must be a whole number from 1 to 1440, got 1441/,
      ],
      [
        'buffer before over a day',
        () => withEventType({ bufferBeforeMinutes: 1441 }),
        /bufferBeforeMinutes must be a whole number from 0 to 1440, got 1441/,
      ],
      [
        'buffer after over a day',
        () => withEventType({ bufferAfterMinutes: 1441 }),
        /bufferAfterMinutes must be a whole number from 0 to 1440, got 1441/,
      ],
      [
        'notice over 365 days',
        () => withEventType({ minimumNoticeMinutes: 525_601 }),
        /minimumNoticeMinutes must be a whole number from 0 to 525600, got 525601/,
      ],
      [
        'booking window over 3650 days',
        () => withEventType({ bookingWindowDays: 3651 }),
        /bookingWindowDays must be a whole number from 1 to 3650, got 3651/,
      ],
      [
        'daily limit over 1000',
        () => withEventType({ maxBookingsPerDay: 1001 }),
        /maxBookingsPerDay must be a whole number from 1 to 1000, got 1001/,
      ],
      [
        'huge duration that Temporal could not add',
        () => withEventType({ durationMinutes: Number.MAX_SAFE_INTEGER }),
        /durationMinutes must be a whole number from 1 to 1440/,
      ],
      [
        'empty range',
        () => ({ ...valid(), rangeEnd: valid().rangeStart }),
        /rangeEnd \(.+\) must be after rangeStart/,
      ],
      [
        'range over 400 days',
        () => ({
          ...valid(),
          rangeEnd: valid().rangeStart.add({ hours: 400 * 24, nanoseconds: 1 }),
        }),
        /rangeEnd \(.+\) must be at most 400 days after rangeStart/,
      ],
      [
        'now past year 9999',
        () => ({ ...valid(), now: at('+010000-01-01T00:00Z') }),
        /now must be in the years 0001 to 9999, got \+010000-01-01T00:00:00Z/,
      ],
      [
        'range start before year 1',
        () => ({ ...valid(), rangeStart: at('0000-12-31T00:00Z') }),
        /rangeStart must be in the years 0001 to 9999/,
      ],
      [
        'busy interval ending before it starts',
        () => ({
          ...valid(),
          busy: [{ start: at('2026-10-19T11:00-04:00'), end: at('2026-10-19T10:00-04:00') }],
        }),
        /busy\[0\]\.end \(2026-10-19T14:00:00Z\) must be after start \(2026-10-19T15:00:00Z\)/,
      ],
      [
        'booking that is not an instant',
        () => ({
          ...valid(),
          bookings: [
            {
              start: '2026-10-19T10:00Z' as unknown as Temporal.Instant,
              end: at('2026-10-19T11:00Z'),
            },
          ],
        }),
        /bookings\[0\]\.start must be a Temporal\.Instant/,
      ],
      [
        'now as a string',
        () => ({ ...valid(), now: '2026-10-18T12:00Z' as unknown as Temporal.Instant }),
        /now must be a Temporal\.Instant/,
      ],
    ])('rejects %s', (_name, build, message) => {
      const input = build()
      expect(() => getAvailableSlots(input)).toThrow(AvailabilityInputError)
      expect(() => getAvailableSlots(input)).toThrow(message)
    })

    it('treats a weekday set to undefined as a day off', () => {
      expect(getAvailableSlots(withSchedule({ weeklyHours: { monday: undefined } }))).toEqual([])
    })

    it('accepts every bound at its maximum, with a 400-day range ending in year 9999', () => {
      const day = hours('00:00', '24:00')
      expect(
        slots({
          weeklyHours: { monday: [day], friday: [day] },
          eventType: {
            durationMinutes: 1440,
            slotStepMinutes: 1440,
            bufferBeforeMinutes: 1440,
            bufferAfterMinutes: 1440,
            minimumNoticeMinutes: 525_600,
            bookingWindowDays: 3650,
            maxBookingsPerDay: 1000,
          },
          // Exactly 400 days. Notice moves the earliest start to 9999-11-01T00:00Z
          // (Sunday 20:00 EDT); the last start must leave a day before the range ends
          // (Sunday 9999-12-05 19:00 EST). New York falls back on Sunday 9999-11-07.
          range: ['9998-11-01T00:00Z', '9999-12-06T00:00Z'],
          now: '9998-11-01T00:00Z',
        }),
      ).toEqual([
        '9999-11-01T00:00-04:00/9999-11-02T00:00-04:00',
        '9999-11-05T00:00-04:00/9999-11-06T00:00-04:00',
        '9999-11-08T00:00-05:00/9999-11-09T00:00-05:00',
        '9999-11-12T00:00-05:00/9999-11-13T00:00-05:00',
        '9999-11-15T00:00-05:00/9999-11-16T00:00-05:00',
        '9999-11-19T00:00-05:00/9999-11-20T00:00-05:00',
        '9999-11-22T00:00-05:00/9999-11-23T00:00-05:00',
        '9999-11-26T00:00-05:00/9999-11-27T00:00-05:00',
        '9999-11-29T00:00-05:00/9999-11-30T00:00-05:00',
        '9999-12-03T00:00-05:00/9999-12-04T00:00-05:00',
      ])
    })
  })
})
