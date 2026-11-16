import { describe, expect, it } from 'vitest'
import { isCalendarDate, nextCalendarDate, startOfLocalDay } from './audit-log-time.ts'

interface Day {
  toString(): string
  add(duration: { days: number }): Day
  toZonedDateTime(zone: string): { toInstant(): { toString(): string } }
}

describe('local day boundaries of the audit log filter', () => {
  it.each([
    // Spring forward at 02:00 and fall back at 02:00: midnight exists once on both days.
    ['America/Los_Angeles', '2026-03-08', '2026-03-08T08:00:00Z'],
    ['America/Los_Angeles', '2026-03-09', '2026-03-09T07:00:00Z'],
    ['America/Los_Angeles', '2026-11-01', '2026-11-01T07:00:00Z'],
    ['America/Los_Angeles', '2026-11-02', '2026-11-02T08:00:00Z'],
    ['Europe/London', '2026-03-29', '2026-03-29T00:00:00Z'],
    ['Europe/London', '2026-03-30', '2026-03-29T23:00:00Z'],
    ['Europe/London', '2026-10-25', '2026-10-24T23:00:00Z'],
    ['Europe/London', '2026-10-26', '2026-10-26T00:00:00Z'],
    ['Asia/Shanghai', '2026-11-12', '2026-11-11T16:00:00Z'],
    ['UTC', '2026-11-12', '2026-11-12T00:00:00Z'],
    // Midnight is skipped: the day starts at 01:00 local, the first instant that exists.
    ['America/Santiago', '2026-09-06', '2026-09-06T04:00:00Z'],
    ['America/Havana', '2026-03-08', '2026-03-08T05:00:00Z'],
    // Clocks fall back from 24:00 to 23:00: the day begins when 00:00 first appears.
    ['America/Santiago', '2026-04-05', '2026-04-05T04:00:00Z'],
    // Midnight happens twice (01:00 back to 00:00): the first one starts the day.
    ['America/Havana', '2026-11-01', '2026-11-01T04:00:00Z'],
    ['America/Havana', '2026-11-02', '2026-11-02T05:00:00Z'],
  ])('starts %s %s at %s', (zone, date, instant) => {
    expect(startOfLocalDay(date, zone)).toBe(instant)
  })

  it('agrees with Temporal for every day of three years in zones with unusual clock changes', () => {
    // Node ships Temporal; the browser code under test does not rely on it.
    const Temporal = (globalThis as { Temporal?: { PlainDate: { from(date: string): Day } } })
      .Temporal
    expect(Temporal).toBeDefined()
    if (!Temporal) return
    for (const zone of [
      'America/Los_Angeles',
      'America/Santiago',
      'America/Havana',
      'Australia/Lord_Howe',
      'Asia/Tehran',
      'America/Asuncion',
    ]) {
      let day = Temporal.PlainDate.from('2025-01-01')
      for (let index = 0; index < 1096; index++) {
        const date = day.toString()
        expect(startOfLocalDay(date, zone), `${zone} ${date}`).toBe(
          day.toZonedDateTime(zone).toInstant().toString(),
        )
        day = day.add({ days: 1 })
      }
    }
  })

  it('moves to the next calendar date across months, years and leap days', () => {
    expect(nextCalendarDate('2026-03-08')).toBe('2026-03-09')
    expect(nextCalendarDate('2026-12-31')).toBe('2027-01-01')
    expect(nextCalendarDate('2028-02-28')).toBe('2028-02-29')
    expect(nextCalendarDate('2026-02-28')).toBe('2026-03-01')
  })

  it('rejects anything that is not an existing calendar date', () => {
    expect(isCalendarDate('2026-02-29')).toBe(false)
    expect(isCalendarDate('2026-13-01')).toBe(false)
    expect(isCalendarDate('26-1-1')).toBe(false)
    expect(isCalendarDate('2028-02-29')).toBe(true)
    expect(() => startOfLocalDay('2026-02-30', 'UTC')).toThrow(RangeError)
  })
})
