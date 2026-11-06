import { describe, expect, it } from 'vitest'
import { type EventTypeRules, getAvailableSlots, type WeeklyHours } from './index.ts'

const allDay = [{ start: '00:00', end: '24:00' }]
const weeklyHours: WeeklyHours = {
  monday: allDay,
  tuesday: allDay,
  wednesday: allDay,
  thursday: allDay,
  friday: allDay,
  saturday: allDay,
  sunday: allDay,
}

function instant(local: string, zone: string): Temporal.Instant {
  return Temporal.PlainDateTime.from(local).toZonedDateTime(zone).toInstant()
}

function offered(
  zone: string,
  candidate: string,
  booked: readonly string[],
  limits: Partial<EventTypeRules>,
  bufferBeforeMinutes = 0,
) {
  const start = instant(candidate, zone)
  return getAvailableSlots({
    schedule: { timeZone: zone, weeklyHours },
    eventType: { durationMinutes: 60, ...limits },
    rangeStart: start,
    rangeEnd: start.add({ minutes: 60 }),
    now: start.subtract({ hours: 45 * 24 }),
    bookings: booked.map((local) => ({
      start: instant(local, zone),
      end: instant(local, zone).add({ minutes: 30 }),
      bufferBeforeMinutes,
    })),
  }).map((slot) => slot.start.toString())
}

describe('weekly and monthly booking limits', () => {
  it.each(['maxBookingsPerWeek', 'maxBookingsPerMonth'] as const)(
    'hides a non-overlapping slot at %s, retaining it below the limit',
    (limit) => {
      const args = ['UTC', '2026-10-23T12:00', ['2026-10-19T09:00']] as const
      expect(offered(...args, { [limit]: 1 })).toEqual([])
      expect(offered(...args, { [limit]: 2 })).toEqual(['2026-10-23T12:00:00Z'])
      expect(offered(...args, {})).toEqual(['2026-10-23T12:00:00Z'])
    },
  )

  it('enforces every configured period while retaining the daily limit', () => {
    const bookings = ['2026-10-19T09:00', '2026-10-20T09:00']
    expect(
      offered('UTC', '2026-10-20T12:00', bookings, {
        maxBookingsPerDay: 1,
        maxBookingsPerWeek: 3,
        maxBookingsPerMonth: 4,
      }),
    ).toEqual([])
    expect(
      offered('UTC', '2026-10-21T12:00', bookings, {
        maxBookingsPerDay: 1,
        maxBookingsPerWeek: 2,
        maxBookingsPerMonth: 4,
      }),
    ).toEqual([])
    expect(
      offered('UTC', '2026-10-26T12:00', bookings, {
        maxBookingsPerDay: 1,
        maxBookingsPerWeek: 2,
        maxBookingsPerMonth: 2,
      }),
    ).toEqual([])
  })

  it.each([
    ['America/New_York', '2026-03-02T09:00', '2026-03-08T12:00', '2026-03-09T12:00'],
    ['America/New_York', '2026-10-26T09:00', '2026-11-01T12:00', '2026-11-02T12:00'],
    ['Europe/Berlin', '2026-03-23T09:00', '2026-03-29T12:00', '2026-03-30T12:00'],
    ['Europe/Berlin', '2026-10-19T09:00', '2026-10-25T12:00', '2026-10-26T12:00'],
  ])('uses Monday weeks across DST in %s (%s)', (zone, booked, sunday, monday) => {
    expect(offered(zone, sunday, [booked], { maxBookingsPerWeek: 1 })).toEqual([])
    expect(offered(zone, monday, [booked], { maxBookingsPerWeek: 1 })).toEqual([
      instant(monday, zone).toString(),
    ])
  })

  it.each(['America/New_York', 'Asia/Tokyo'])(
    'uses local Monday boundaries rather than UTC in %s',
    (zone) => {
      // Sunday evening and Monday morning fall on different local weeks, even
      // when their UTC date is the same. A start exactly at Monday midnight counts.
      const monday = '2026-03-09T12:00'
      expect(offered(zone, monday, ['2026-03-08T23:30'], { maxBookingsPerWeek: 1 })).toEqual([
        instant(monday, zone).toString(),
      ])
      expect(offered(zone, monday, ['2026-03-09T00:00'], { maxBookingsPerWeek: 1 })).toEqual([])
    },
  )

  it.each(['America/New_York', 'Asia/Tokyo'])(
    'keeps a Dec–Jan ISO week together in %s, then resets on Monday',
    (zone) => {
      expect(
        offered(zone, '2027-01-03T12:00', ['2026-12-28T09:00'], { maxBookingsPerWeek: 1 }),
      ).toEqual([])
      expect(
        offered(zone, '2027-01-04T12:00', ['2027-01-03T23:30'], { maxBookingsPerWeek: 1 }),
      ).toEqual([instant('2027-01-04T12:00', zone).toString()])
    },
  )

  it.each(['America/New_York', 'Asia/Tokyo'])(
    'uses local calendar months through leap day, month ends and Dec–Jan in %s',
    (zone) => {
      expect(
        offered(zone, '2028-02-29T12:00', ['2028-02-01T09:00'], { maxBookingsPerMonth: 1 }),
      ).toEqual([])
      for (const [previousEnd, nextStart] of [
        ['2028-02-29T23:30', '2028-03-01T12:00'],
        ['2026-04-30T23:30', '2026-05-01T12:00'],
        ['2026-12-31T23:30', '2027-01-01T12:00'],
      ] as const) {
        expect(offered(zone, nextStart, [previousEnd], { maxBookingsPerMonth: 1 })).toEqual([
          instant(nextStart, zone).toString(),
        ])
        const midnight = `${nextStart.slice(0, 10)}T00:00`
        expect(offered(zone, nextStart, [midnight], { maxBookingsPerMonth: 1 })).toEqual([])
      }
    },
  )

  it.each(['maxBookingsPerWeek', 'maxBookingsPerMonth'] as const)(
    'counts real starts rather than buffers for %s',
    (limit) => {
      // Monday June 1 starts both a week and a month. Its before-buffer reaches
      // Sunday in May, which must retain capacity far from that buffer.
      expect(offered('UTC', '2026-05-31T12:00', ['2026-06-01T00:10'], { [limit]: 1 }, 30)).toEqual([
        '2026-05-31T12:00:00Z',
      ])
      expect(offered('UTC', '2026-06-01T12:00', ['2026-06-01T00:10'], { [limit]: 1 }, 30)).toEqual(
        [],
      )
    },
  )
})
