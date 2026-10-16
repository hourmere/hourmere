import { describe, expect, it } from 'vitest'
import { addMonths, firstDayOfWeek, monthGrid, sameDayIn } from './calendar.ts'
import { dateKeyIn, formatDuration, formatTime, instantOf, offsetLabel, wallTime } from './time.ts'

const at = (iso: string) => Date.parse(iso)
/** Intl puts narrow no-break spaces in some times ("9:00 AM"); compare with plain spaces. */
const plain = (text: string) => text.replace(/[\u2009\u202f\u00a0]/g, ' ')

describe('wall-clock time in a zone', () => {
  it('follows a daylight saving change in both directions', () => {
    // New York falls back at 02:00 EDT on 2026-11-01: 01:30 happens twice.
    expect(wallTime(at('2026-11-01T05:30:00Z'), 'America/New_York')).toMatchObject({
      day: 1,
      hour: 1,
      minute: 30,
    })
    expect(wallTime(at('2026-11-01T06:30:00Z'), 'America/New_York')).toMatchObject({
      day: 1,
      hour: 1,
      minute: 30,
    })
    expect(offsetLabel('America/New_York', at('2026-11-01T05:30:00Z'))).toBe('GMT-04:00')
    expect(offsetLabel('America/New_York', at('2026-11-01T06:30:00Z'))).toBe('GMT-05:00')
    // Berlin springs forward at 02:00 CET on 2026-03-29: 02:30 never happens.
    expect(wallTime(at('2026-03-29T00:59:00Z'), 'Europe/Berlin').hour).toBe(1)
    expect(wallTime(at('2026-03-29T01:00:00Z'), 'Europe/Berlin').hour).toBe(3)
  })

  it('puts instants on the right day far from UTC', () => {
    const instant = at('2026-11-02T10:30:00Z')
    expect(dateKeyIn(instant, 'UTC')).toBe('2026-11-02')
    expect(dateKeyIn(instant, 'Pacific/Kiritimati')).toBe('2026-11-03') // +14:00
    expect(dateKeyIn(at('2026-11-02T10:30:00Z'), 'Pacific/Pago_Pago')).toBe('2026-11-01') // -11:00
    expect(dateKeyIn(at('2026-11-02T18:14:00Z'), 'Asia/Kathmandu')).toBe('2026-11-02') // 23:59
    expect(dateKeyIn(at('2026-11-02T18:15:00Z'), 'Asia/Kathmandu')).toBe('2026-11-03') // 00:00
    expect(offsetLabel('Pacific/Kiritimati', instant)).toBe('GMT+14:00')
    expect(offsetLabel('Pacific/Pago_Pago', instant)).toBe('GMT-11:00')
    expect(offsetLabel('Asia/Kathmandu', instant)).toBe('GMT+05:45')
    expect(offsetLabel('UTC', instant)).toBe('GMT+00:00')
  })

  it('finds the instant of a wall-clock time, also across and inside DST changes', () => {
    const day = (iso: string) => {
      const [year, month, d] = iso.split('-').map(Number) as [number, number, number]
      return { year, month, day: d }
    }
    // Berlin's 25-hour day: midnight to midnight across the change back to CET.
    const start = instantOf(day('2026-10-25'), 0, 0, 'Europe/Berlin')
    const next = instantOf(day('2026-10-26'), 0, 0, 'Europe/Berlin')
    expect(new Date(start).toISOString()).toBe('2026-10-24T22:00:00.000Z')
    expect(new Date(next).toISOString()).toBe('2026-10-25T23:00:00.000Z')
    expect((next - start) / 3_600_000).toBe(25)
    // A time in the spring gap gives the instant after it (03:30 CEST).
    expect(new Date(instantOf(day('2026-03-29'), 2, 30, 'Europe/Berlin')).toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    )
    // A time that happens twice gives the earlier one (01:30 EDT).
    expect(new Date(instantOf(day('2026-11-01'), 1, 30, 'America/New_York')).toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    )
    expect(new Date(instantOf(day('2026-11-03'), 0, 0, 'Pacific/Kiritimati')).toISOString()).toBe(
      '2026-11-02T10:00:00.000Z',
    )
  })
})

describe('formatting', () => {
  it('writes times with 12 or 24 hours as the locale does', () => {
    const instant = at('2026-11-02T14:05:00Z')
    expect(plain(formatTime(instant, 'UTC', 'en-US'))).toBe('2:05 PM')
    expect(formatTime(instant, 'UTC', 'en-GB')).toBe('14:05')
    expect(formatTime(instant, 'UTC', 'de-DE')).toBe('14:05')
    expect(plain(formatTime(instant, 'America/New_York', 'en-US', { withZone: true }))).toBe(
      '9:05 AM EST',
    )
  })

  it('writes durations', () => {
    expect(formatDuration(15)).toBe('15 min')
    expect(formatDuration(60)).toBe('1 h')
    expect(formatDuration(90)).toBe('1 h 30 min')
  })
})

describe('the month grid', () => {
  it('lays a month out in six weeks from the locale’s first weekday', () => {
    // 2026-11-01 is a Sunday.
    const monday = monthGrid({ year: 2026, month: 11 }, 1)
    expect(monday).toHaveLength(6)
    expect(monday[0]).toEqual([null, null, null, null, null, null, '2026-11-01'])
    expect(monday[5]?.filter(Boolean)).toEqual(['2026-11-30'])
    const sunday = monthGrid({ year: 2026, month: 11 }, 0)
    expect(sunday[0]?.[0]).toBe('2026-11-01')
    expect(sunday.flat().filter(Boolean)).toHaveLength(30)
  })

  it('knows where weeks start and moves between months', () => {
    expect(firstDayOfWeek('en-US')).toBe(0)
    expect(firstDayOfWeek('en-GB')).toBe(1)
    expect(firstDayOfWeek('de-DE')).toBe(1)
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 })
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 })
    expect(sameDayIn('2026-01-31', { year: 2026, month: 2 })).toBe('2026-02-28')
  })
})
