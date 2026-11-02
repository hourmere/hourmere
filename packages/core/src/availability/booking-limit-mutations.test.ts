// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Source copies intentionally match literal template expressions.
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { getAvailableSlots, WeeklyHours } from './index.ts'
import { normalizeInput, type validateEventTypeRules } from './validate.ts'

type Change = readonly [string, string]
type Engine = typeof getAvailableSlots
type Validate = typeof validateEventTypeRules

/** Compile an isolated source copy; controls never change production source. */
function sourceCopy(filename: string, exported: string, bindings: object, change?: Change) {
  let source = readFileSync(new URL(filename, import.meta.url), 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match source').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source)
    .replace(/^import[\s\S]*?from '[^']+'\n/gm, '')
    .replace(/\bexport /g, '')
  return new Function(...Object.keys(bindings), `${source}; return ${exported}`)(
    ...Object.values(bindings),
  )
}

const engineCopy = (change?: Change): Engine =>
  sourceCopy('./get-available-slots.ts', 'getAvailableSlots', { normalizeInput }, change)
const validationCopy = (change?: Change): Validate =>
  sourceCopy('./validate.ts', 'validateEventTypeRules', {}, change)

function candidate(
  engine: Engine,
  rule: 'maxBookingsPerDay' | 'maxBookingsPerWeek' | 'maxBookingsPerMonth',
  zone = 'UTC',
  booked = '2026-10-19T09:00',
  target = '2026-10-19T12:00',
) {
  const at = (local: string) => Temporal.PlainDateTime.from(local).toZonedDateTime(zone).toInstant()
  const start = at(target)
  const allDays = Object.fromEntries(
    ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => [
      day,
      [{ start: '00:00', end: '24:00' }],
    ]),
  ) as WeeklyHours
  return engine({
    schedule: { timeZone: zone, weeklyHours: allDays },
    eventType: { durationMinutes: 60, [rule]: 1 },
    rangeStart: start,
    rangeEnd: start.add({ hours: 1 }),
    now: start.subtract({ hours: 45 * 24 }),
    bookings: [{ start: at(booked), end: at(booked).add({ minutes: 30 }) }],
  })
}

const engineCases: { name: string; change: Change; verify: (copy: Engine) => void }[] = [
  ...(['Day', 'Week', 'Month'] as const).map((period) => ({
    name: `${period.toLowerCase()} limit removed`,
    change: [
      `q.maxBookingsPer${period} !== undefined &&`,
      `false && q.maxBookingsPer${period} !== undefined &&`,
    ] as const,
    verify: (copy: Engine) => expect(candidate(copy, `maxBookingsPer${period}`)).toEqual([]),
  })),
  {
    name: 'UTC counting replaces the schedule zone',
    change: [
      'const date = start.toZonedDateTimeISO(timeZone).toPlainDate()',
      "const date = start.toZonedDateTimeISO('UTC').toPlainDate()",
    ],
    verify: (copy) => {
      expect(
        candidate(
          copy,
          'maxBookingsPerWeek',
          'America/New_York',
          '2026-03-08T23:30',
          '2026-03-09T12:00',
        ),
      ).toHaveLength(1)
      expect(
        candidate(
          copy,
          'maxBookingsPerMonth',
          'Asia/Tokyo',
          '2026-05-01T00:00',
          '2026-05-01T12:00',
        ),
      ).toEqual([])
    },
  },
  {
    name: 'Sunday replaces Monday as week start',
    change: [
      'return `${date.yearOfWeek}-${date.weekOfYear}`',
      'const shifted = date.add({ days: 1 }); return `${shifted.yearOfWeek}-${shifted.weekOfYear}`',
    ],
    verify: (copy) =>
      expect(
        candidate(
          copy,
          'maxBookingsPerWeek',
          'America/New_York',
          '2026-03-02T09:00',
          '2026-03-08T12:00',
        ),
      ).toEqual([]),
  },
  {
    name: 'calendar year replaces ISO week-year at Dec–Jan',
    change: [
      'return `${date.yearOfWeek}-${date.weekOfYear}`',
      'return `${date.year}-${date.weekOfYear}`',
    ],
    verify: (copy) =>
      expect(
        candidate(copy, 'maxBookingsPerWeek', 'Asia/Tokyo', '2026-12-28T09:00', '2027-01-03T12:00'),
      ).toEqual([]),
  },
  {
    name: 'fixed thirty-day buckets replace leap calendar months',
    change: [
      'return `${date.year}-${date.month}`',
      "return String(Math.floor(date.since(Temporal.PlainDate.from('1970-01-01')).days / 30))",
    ],
    verify: (copy) =>
      expect(
        candidate(
          copy,
          'maxBookingsPerMonth',
          'America/New_York',
          '2028-02-01T09:00',
          '2028-02-29T12:00',
        ),
      ).toEqual([]),
  },
]

function assertMutationFails(verify: () => void) {
  let failure: unknown
  try {
    verify()
  } catch (error) {
    failure = error
  }
  expect(failure, 'mutation must fail a real behavior assertion').toMatchObject({
    name: 'AssertionError',
  })
}

describe('booking limit source-copy mutation controls', () => {
  it('passes every engine assertion against unmodified source', () => {
    const copy = engineCopy()
    for (const control of engineCases) control.verify(copy)
  })

  it.each(engineCases)('detects $name', ({ change, verify }) => {
    const copy = engineCopy(change)
    assertMutationFails(() => verify(copy))
  })

  it.each(['Week', 'Month'] as const)('detects removed %s bounds', (period) => {
    const verify = (copy: Validate) =>
      expect(() => copy({ durationMinutes: 30, [`maxBookingsPer${period}`]: 0 })).toThrowError()
    verify(validationCopy())
    const copy = validationCopy([`rule('maxBookingsPer${period}')`, '(value) => value as number'])
    assertMutationFails(() => verify(copy))
  })

  it.each([
    ['Day', 'Week'],
    ['Week', 'Month'],
    ['Day', 'Month'],
  ] as const)('detects removed %s–%s consistency', (shorter, longer) => {
    const verify = (copy: Validate) =>
      expect(() =>
        copy({
          durationMinutes: 30,
          [`maxBookingsPer${shorter}`]: 3,
          [`maxBookingsPer${longer}`]: 2,
        }),
      ).toThrowError()
    verify(validationCopy())
    const copy = validationCopy([
      `['maxBookingsPer${shorter}', maxBookingsPer${shorter}, 'maxBookingsPer${longer}', maxBookingsPer${longer}],`,
      '',
    ])
    assertMutationFails(() => verify(copy))
  })
})
