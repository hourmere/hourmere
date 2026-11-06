// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Mutation controls match literal source expressions.
import { describe, expect, it } from 'vitest'
import { explainAvailability } from './explain-availability.ts'
import { explainSourceCopy } from './explain-source-copy.test-helper.ts'
import { getAvailableSlots } from './get-available-slots.ts'
import type { ExplainAvailabilityInput } from './types.ts'

type Explain = typeof explainAvailability
type Change = readonly [string, string]

const cases = [
  {
    period: 'Week',
    zone: 'UTC',
    booked: '2026-11-06T09:00',
    target: '2026-11-02T12:00',
    limited: true,
  },
  {
    period: 'Month',
    zone: 'UTC',
    booked: '2026-11-30T09:00',
    target: '2026-11-02T12:00',
    limited: true,
  },
  {
    period: 'Week',
    zone: 'America/New_York',
    booked: '2026-03-02T09:00',
    target: '2026-03-08T12:00',
    limited: true,
  },
  {
    period: 'Week',
    zone: 'America/New_York',
    booked: '2026-03-08T23:30',
    target: '2026-03-09T12:00',
    limited: false,
  },
  {
    period: 'Week',
    zone: 'Asia/Tokyo',
    booked: '2026-12-28T09:00',
    target: '2027-01-03T12:00',
    limited: true,
  },
  {
    period: 'Month',
    zone: 'Asia/Tokyo',
    booked: '2026-05-01T00:00',
    target: '2026-05-01T12:00',
    limited: true,
  },
  {
    period: 'Month',
    zone: 'America/New_York',
    booked: '2028-02-01T09:00',
    target: '2028-02-29T12:00',
    limited: true,
  },
  {
    period: 'Month',
    zone: 'America/New_York',
    booked: '2026-04-30T23:30',
    target: '2026-05-01T12:00',
    limited: false,
  },
] as const

function verify(copy: Explain, scenario: (typeof cases)[number]) {
  const { period, zone, booked, target, limited } = scenario
  const local = (value: string) =>
    Temporal.PlainDateTime.from(value).toZonedDateTime(zone).toInstant()
  const start = local(target)
  const input: ExplainAvailabilityInput = {
    schedule: {
      timeZone: zone,
      weeklyHours: {},
      dateOverrides: [{ date: target.slice(0, 10), intervals: [{ start: '12:00', end: '13:00' }] }],
    },
    eventType: { durationMinutes: 30, [`maxBookingsPer${period}`]: 1 },
    rangeStart: start,
    rangeEnd: start.add({ hours: 1 }),
    now: start.subtract({ hours: 60 * 24 }),
    bookings: [{ start: local(booked), end: local(booked).add({ minutes: 30 }) }],
  }
  const normal = getAvailableSlots(input)
  const explained = copy(input)
  expect(normal).toHaveLength(limited ? 0 : 2)
  expect(explained).toHaveLength(2)
  expect(explained.filter((slot) => slot.status === 'available')).toHaveLength(normal.length)
  for (const slot of explained) {
    expect(slot.status).toBe(limited ? 'unavailable' : 'available')
    expect(slot.reasons).toEqual(
      limited
        ? [
            {
              code: period === 'Week' ? 'weekly_limit' : 'monthly_limit',
              interval: { start: slot.start, end: slot.end },
            },
          ]
        : [],
    )
  }
}

describe('explain weekly and monthly booking limits', () => {
  it.each(cases)('$period counts full local periods: $booked → $target ($zone)', (scenario) =>
    verify(explainAvailability, scenario),
  )

  it('passes the same assertions against an unmodified source copy', () => {
    for (const scenario of cases) verify(explainSourceCopy(), scenario)
  })

  const mutations: { name: string; change: Change }[] = [
    ...(['Week', 'Month'] as const).map((period) => ({
      name: `${period} reason removed`,
      change: [
        `q.maxBookingsPer${period} !== undefined &&`,
        `false && q.maxBookingsPer${period} !== undefined &&`,
      ] as const,
    })),
    {
      name: 'UTC counts replace host-local counts',
      change: [
        'booking.start.toZonedDateTimeISO(q.timeZone)',
        "booking.start.toZonedDateTimeISO('UTC')",
      ],
    },
    {
      name: 'Sunday replaces Monday as week start',
      change: [
        'return `${date.yearOfWeek}-${date.weekOfYear}`',
        'const shifted = date.add({ days: 1 }); return `${shifted.yearOfWeek}-${shifted.weekOfYear}`',
      ],
    },
    {
      name: 'calendar year replaces ISO week year',
      change: [
        'return `${date.yearOfWeek}-${date.weekOfYear}`',
        'return `${date.year}-${date.weekOfYear}`',
      ],
    },
    {
      name: 'fixed thirty-day periods replace calendar months',
      change: [
        'return `${date.year}-${date.month}`',
        "return String(Math.floor(date.since(Temporal.PlainDate.from('1970-01-01')).days / 30))",
      ],
    },
    {
      name: 'request range clips full-period booking counts',
      change: [
        'for (const booking of q.bookings) {',
        'for (const booking of q.bookings) { if (Temporal.Instant.compare(booking.start, q.rangeStart) < 0 || Temporal.Instant.compare(booking.start, q.rangeEnd) >= 0) continue;',
      ],
    },
  ]
  it.each(mutations)('detects $name using a source copy', ({ change }) => {
    const copy = explainSourceCopy(change)
    let failure: unknown
    try {
      for (const scenario of cases) verify(copy, scenario)
    } catch (error) {
      failure = error
    }
    expect(failure, 'mutation must fail a real behavior assertion').toMatchObject({
      name: 'AssertionError',
    })
  })
})
