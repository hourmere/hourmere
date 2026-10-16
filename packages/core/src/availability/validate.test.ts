import { describe, expect, it } from 'vitest'
import {
  AvailabilityInputError,
  EVENT_TYPE_RULE_BOUNDS,
  getAvailableSlots,
  validateDate,
  validateDayIntervals,
  validateEventTypeRules,
  validateTimeZone,
  validateWeeklyHours,
} from './index.ts'

// The exported validators check stored data (schedules, overrides, event types) by the
// engine's own rules; the engine's behavior on the same input is covered in
// get-available-slots.test.ts.

const throws = (fn: () => unknown, message: RegExp) => {
  expect(fn).toThrow(AvailabilityInputError)
  expect(fn).toThrow(message)
}

describe('validateTimeZone', () => {
  it('returns the normalized IANA id', () => {
    expect(validateTimeZone('Europe/Berlin')).toBe('Europe/Berlin')
    expect(validateTimeZone('europe/berlin')).toBe('Europe/Berlin')
    expect(validateTimeZone('UTC')).toBe('UTC')
  })

  it('rejects unknown zones, offsets and non-strings under the given path', () => {
    throws(() => validateTimeZone('Mars/Olympus'), /^timeZone is not a known IANA time zone/)
    throws(() => validateTimeZone('+08:00', 'profile.timeZone'), /^profile\.timeZone .*UTC offset/)
    throws(() => validateTimeZone(''), /non-empty string/)
    throws(() => validateTimeZone(42), /non-empty string/)
  })
})

describe('validateWeeklyHours', () => {
  it('accepts valid hours, empty days and "24:00" ends', () => {
    expect(() =>
      validateWeeklyHours({
        monday: [
          { start: '09:00', end: '12:00' },
          { start: '12:00', end: '17:00' },
        ],
        saturday: [],
        sunday: [{ start: '20:00', end: '24:00' }],
      }),
    ).not.toThrow()
    expect(() => validateWeeklyHours({})).not.toThrow()
  })

  it.each<[string, unknown, RegExp]>([
    ['an array', [], /^weeklyHours must be a plain object keyed by weekday/],
    ['an unknown weekday', { mon: [] }, /unknown weekday "mon"/],
    ['a non-array day', { monday: {} }, /weeklyHours\.monday must be an array/],
    [
      'an end before the start',
      { tuesday: [{ start: '12:00', end: '09:00' }] },
      /weeklyHours\.tuesday\[0\]\.end \(09:00\) must be after start \(12:00\)/,
    ],
    [
      'a malformed time',
      { monday: [{ start: '9:00', end: '12:00' }] },
      /weeklyHours\.monday\[0\]\.start must be a time "HH:MM"/,
    ],
    [
      'overlapping intervals',
      {
        friday: [
          { start: '09:00', end: '12:00' },
          { start: '11:00', end: '13:00' },
        ],
      },
      /weeklyHours\.friday has overlapping intervals/,
    ],
  ])('rejects %s', (_, value, message) => {
    throws(() => validateWeeklyHours(value), message)
  })

  it('names the given path', () => {
    throws(() => validateWeeklyHours({ mon: [] }, 'body.hours'), /^body\.hours has unknown weekday/)
  })
})

describe('validateDayIntervals', () => {
  it('accepts an empty day and valid intervals', () => {
    expect(() => validateDayIntervals([])).not.toThrow()
    expect(() => validateDayIntervals([{ start: '00:00', end: '24:00' }])).not.toThrow()
  })

  it('rejects what a weekday would reject', () => {
    throws(() => validateDayIntervals({}), /^intervals must be an array/)
    throws(() => validateDayIntervals([null]), /intervals\[0\] must be an object/)
    throws(
      () => validateDayIntervals([{ start: '24:00', end: '24:00' }], 'override'),
      /^override\[0\]\.start must be a time/,
    )
  })
})

describe('validateDate', () => {
  it('returns the date', () => {
    expect(validateDate('2026-02-28')).toBe('2026-02-28')
    expect(validateDate('2028-02-29')).toBe('2028-02-29')
  })

  it('rejects impossible and malformed dates', () => {
    throws(() => validateDate('2026-02-29'), /^date is not a valid calendar date/)
    throws(() => validateDate('2026-2-1', 'from'), /^from must be a date like/)
    throws(() => validateDate('2026-03-08T10:00'), /must be a date like/)
    throws(() => validateDate(20260308), /must be a date like/)
  })
})

describe('validateEventTypeRules', () => {
  it('accepts the bounds themselves and omitted optional rules', () => {
    const min = Object.fromEntries(
      Object.entries(EVENT_TYPE_RULE_BOUNDS).map(([rule, { min }]) => [rule, min]),
    )
    const max = Object.fromEntries(
      Object.entries(EVENT_TYPE_RULE_BOUNDS).map(([rule, { max }]) => [rule, max]),
    )
    expect(() => validateEventTypeRules(min)).not.toThrow()
    expect(() => validateEventTypeRules(max)).not.toThrow()
    expect(() => validateEventTypeRules({ durationMinutes: 30 })).not.toThrow()
  })

  it.each(Object.entries(EVENT_TYPE_RULE_BOUNDS))(
    'rejects %s outside its bounds or not whole',
    (rule, { min, max }) => {
      const rules = (value: unknown) => ({ durationMinutes: 30, [rule]: value })
      const message = new RegExp(
        `^eventType\\.${rule} must be a whole number from ${min} to ${max}`,
      )
      throws(() => validateEventTypeRules(rules(min - 1)), message)
      throws(() => validateEventTypeRules(rules(max + 1)), message)
      throws(() => validateEventTypeRules(rules(1.5)), message)
      throws(() => validateEventTypeRules(rules('30')), message)
    },
  )

  it('names rules alone when the path is empty', () => {
    throws(
      () => validateEventTypeRules({ durationMinutes: 0 }, ''),
      /^durationMinutes must be a whole number from 1 to 1440, got 0$/,
    )
  })

  it('requires a duration and a plain object', () => {
    throws(() => validateEventTypeRules({}), /eventType\.durationMinutes must be a whole number/)
    throws(() => validateEventTypeRules(null, 'rules'), /^rules must be a plain object/)
  })

  it('agrees with the engine: rules it accepts never make the engine throw', () => {
    const max = Object.fromEntries(
      Object.entries(EVENT_TYPE_RULE_BOUNDS).map(([rule, { max }]) => [rule, max]),
    ) as { durationMinutes: number }
    validateEventTypeRules(max)
    const now = Temporal.Instant.from('2026-10-19T00:00:00Z')
    expect(() =>
      getAvailableSlots({
        schedule: { timeZone: 'UTC', weeklyHours: { monday: [{ start: '00:00', end: '24:00' }] } },
        eventType: max,
        rangeStart: now,
        rangeEnd: now.add({ hours: 400 * 24 }),
        now,
      }),
    ).not.toThrow()
  })
})
