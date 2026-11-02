import { describe, expect, it, vi } from 'vitest'
import { offsetTestClock } from './test-clock.ts'

describe('optional wall-clock offset', () => {
  it.each([7, 30, 90, 400, 1600])('moves Date and every Temporal.Now read by %i days', (days) => {
    const OriginalDate = Date
    const existing = new OriginalDate(0)
    const originalNow = Temporal.Now
    const offset = days * 86_400_000
    const restore = offsetTestClock(String(days))
    try {
      const lower = OriginalDate.now() + offset
      const constructed = new Date()
      const reads = [Date.now(), constructed.getTime(), Date.parse(Date())]
      const upper = OriginalDate.now() + offset
      for (const read of reads) {
        // Date() has second precision.
        expect(read).toBeGreaterThanOrEqual(lower - 999)
        expect(read).toBeLessThanOrEqual(upper)
      }
      const before = originalNow.instant().add({ milliseconds: offset })
      const instant = Temporal.Now.instant()
      const zoned = Temporal.Now.zonedDateTimeISO('UTC')
      const dateTime = Temporal.Now.plainDateTimeISO('UTC').toZonedDateTime('UTC')
      const date = Temporal.Now.plainDateISO('UTC')
      const time = Temporal.Now.plainTimeISO('UTC')
      const after = originalNow.instant().add({ milliseconds: offset })
      for (const read of [instant, zoned.toInstant(), dateTime.toInstant()]) {
        expect(Temporal.Instant.compare(read, before)).toBeGreaterThanOrEqual(0)
        expect(Temporal.Instant.compare(read, after)).toBeLessThanOrEqual(0)
      }
      const first = before.toZonedDateTimeISO('UTC')
      const last = after.toZonedDateTimeISO('UTC')
      expect(Temporal.PlainDate.compare(date, first.toPlainDate())).toBeGreaterThanOrEqual(0)
      expect(Temporal.PlainDate.compare(date, last.toPlainDate())).toBeLessThanOrEqual(0)
      const afterStart = Temporal.PlainTime.compare(time, first.toPlainTime()) >= 0
      const beforeEnd = Temporal.PlainTime.compare(time, last.toPlainTime()) <= 0
      // Plain time wraps at midnight; bound it by both adjacent clock reads.
      expect(
        first.toPlainDate().equals(last.toPlainDate())
          ? afterStart && beforeEnd
          : afterStart || beforeEnd,
      ).toBe(true)
      expect(Temporal.Now.timeZoneId()).toBe(originalNow.timeZoneId())
      expect(new Date('2026-11-01T12:00:00Z').toISOString()).toBe('2026-11-01T12:00:00.000Z')
      expect(new Date(2026, 10, 1).getFullYear()).toBe(2026)
      expect(Date.UTC(2026, 10, 1)).toBe(OriginalDate.UTC(2026, 10, 1))
      expect(new Date()).toBeInstanceOf(OriginalDate)
      expect(existing).toBeInstanceOf(Date)
      expect(Date.prototype).toBe(OriginalDate.prototype)
      class FixtureDate extends Date {}
      expect(new FixtureDate()).toBeInstanceOf(FixtureDate)
    } finally {
      restore()
    }
    expect(Date).toBe(OriginalDate)
    expect(Temporal.Now).toBe(originalNow)
  })

  it('keeps time and ordinary timers moving', async () => {
    const restore = offsetTestClock('400')
    try {
      const start = Date.now()
      const instant = Temporal.Now.instant()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(Date.now()).toBeGreaterThan(start)
      expect(Temporal.Instant.compare(Temporal.Now.instant(), instant)).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })

  it('lets a local Date.now spy take precedence without changing the Date constructor', () => {
    const OriginalDate = Date
    const restore = offsetTestClock('400')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
    try {
      expect(Date.now()).toBe(0)
      const lower = OriginalDate.now() + 400 * 86_400_000
      const constructed = new Date()
      expect(constructed.getTime()).toBeGreaterThanOrEqual(lower)
      expect(constructed.getTime()).toBeLessThanOrEqual(OriginalDate.now() + 400 * 86_400_000)
    } finally {
      clock.mockRestore()
      restore()
    }
  })

  it('leaves the clock alone unless opted in', () => {
    const original = Date
    const originalNow = Temporal.Now
    offsetTestClock(undefined)()
    expect(Date).toBe(original)
    expect(Temporal.Now).toBe(originalNow)
  })

  it.each(['', ' ', 'invalid', 'Infinity', '1e100'])('rejects an invalid offset %j', (value) => {
    expect(() => offsetTestClock(value)).toThrow('HOURMERE_TEST_CLOCK_OFFSET_DAYS')
  })
})
