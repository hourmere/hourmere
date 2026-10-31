import { describe, expect, it } from 'vitest'
import {
  type AvailabilityInput,
  AvailabilityInputError,
  getAvailableSlots,
  resolveDurationMinutes,
  validateEventTypeRules,
} from './index.ts'

const instant = Temporal.Instant.from
const base: AvailabilityInput = {
  schedule: { timeZone: 'UTC', weeklyHours: { monday: [{ start: '09:00', end: '12:00' }] } },
  eventType: { durationMinutes: 30, allowedDurationsMinutes: [15, 30, 60] },
  rangeStart: instant('2026-11-02T00:00Z'),
  rangeEnd: instant('2026-11-03T00:00Z'),
  now: instant('2026-11-01T00:00Z'),
}

describe('multiple availability durations', () => {
  it('preserves the omitted default and single-duration slot intervals exactly', () => {
    const legacy = { ...base, eventType: { durationMinutes: 30 } }
    expect(getAvailableSlots(base)).toEqual(getAvailableSlots(legacy))
    expect(getAvailableSlots({ ...legacy, durationMinutes: 30 })).toEqual(getAvailableSlots(legacy))
  })

  it.each([15, 30, 60])(
    'uses %i elapsed minutes for length and the default start grid',
    (durationMinutes) => {
      const result = getAvailableSlots({ ...base, durationMinutes })
      expect(result).toHaveLength(180 / durationMinutes)
      for (const [index, slot] of result.entries()) {
        expect(
          slot.start.equals(instant('2026-11-02T09:00Z').add({ minutes: index * durationMinutes })),
        ).toBe(true)
        expect(slot.end.since(slot.start).total('minutes')).toBe(durationMinutes)
      }
    },
  )

  it.each([0, 45, 1441, 15.5, Number.NaN])(
    'rejects an invalid selected duration %s',
    (durationMinutes) => {
      expect(() => getAvailableSlots({ ...base, durationMinutes })).toThrow(AvailabilityInputError)
    },
  )

  it.each([
    null,
    [],
    [30, 30],
    [15, 60],
    [0, 30],
    [30, 1441],
    [30, 15.5],
    [30, '15'],
    Array.from({ length: 13 }, (_, index) => index + 20),
    [30, ...new Array(1)],
  ])('rejects malformed allowed durations %j', (allowedDurationsMinutes) => {
    expect(() => validateEventTypeRules({ durationMinutes: 30, allowedDurationsMinutes })).toThrow(
      AvailabilityInputError,
    )
  })

  it('accepts both duration bounds and the maximum distinct list length', () => {
    const allowedDurationsMinutes = [1, 15, 30, 45, 60, 90, 120, 180, 240, 360, 720, 1440]
    expect(() =>
      validateEventTypeRules({ durationMinutes: 30, allowedDurationsMinutes }),
    ).not.toThrow()
    expect(resolveDurationMinutes({ durationMinutes: 30, allowedDurationsMinutes }, 1)).toBe(1)
    expect(resolveDurationMinutes({ durationMinutes: 30, allowedDurationsMinutes }, 1440)).toBe(
      1440,
    )
  })
})
