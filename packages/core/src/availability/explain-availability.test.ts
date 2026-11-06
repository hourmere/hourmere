import { describe, expect, it } from 'vitest'
import {
  AVAILABILITY_REASON_CODES,
  AvailabilityInputError,
  type AvailabilityReasonCode,
  type ExplainAvailabilityInput,
  explainAvailability,
  getAvailableSlots,
  type Slot,
} from './index.ts'
import type { EventTypeRules } from './types.ts'

const instant = Temporal.Instant.from
const interval = (start: string, end: string) => ({ start: instant(start), end: instant(end) })
const base: ExplainAvailabilityInput = {
  schedule: { timeZone: 'UTC', weeklyHours: { monday: [{ start: '09:00', end: '12:00' }] } },
  eventType: { durationMinutes: 30 },
  rangeStart: instant('2026-11-02T09:00Z'),
  rangeEnd: instant('2026-11-02T12:00Z'),
  now: instant('2026-11-01T00:00Z'),
}

function at(input: ExplainAvailabilityInput, start = '2026-11-02T10:00Z') {
  const slot = explainAvailability(input).find((slot) => slot.start.equals(instant(start)))
  expect(slot, `candidate ${start}`).toBeDefined()
  if (!slot) throw new Error('Missing candidate')
  return slot
}

function codes(input: ExplainAvailabilityInput, start?: string) {
  return [...new Set(at(input, start).reasons.map((reason) => reason.code))]
}

const keys = (slots: readonly Slot[]) => slots.map((slot) => `${slot.start}/${slot.end}`)

describe('explainAvailability', () => {
  it('offers the exact normal slots with typed empty reasons', () => {
    const explained = explainAvailability(base)
    expect(explained.map((slot) => slot.status)).toEqual(Array(6).fill('available'))
    expect(explained.every((slot) => slot.reasons.length === 0)).toBe(true)
    expect(keys(explained)).toEqual(keys(getAvailableSlots(base)))
  })

  it.each<[AvailabilityReasonCode, ExplainAvailabilityInput]>([
    ['past', { ...base, now: instant('2026-11-02T10:15Z') }],
    ['duration_not_offered', { ...base, durationMinutes: 20 }],
    ['outside_working_hours', { ...base, schedule: { ...base.schedule, weeklyHours: {} } }],
    [
      'off_slot_grid',
      {
        ...base,
        schedule: {
          ...base.schedule,
          weeklyHours: { monday: [{ start: '09:15', end: '12:00' }] },
        },
      },
    ],
    [
      'minimum_notice',
      {
        ...base,
        now: instant('2026-11-02T09:00Z'),
        eventType: { ...base.eventType, minimumNoticeMinutes: 90 },
      },
    ],
    [
      'booking_window',
      {
        ...base,
        now: instant('2026-11-01T09:00Z'),
        eventType: { ...base.eventType, bookingWindowDays: 1 },
      },
    ],
    ['calendar_busy', { ...base, busy: [interval('2026-11-02T10:05Z', '2026-11-02T10:25Z')] }],
    [
      'buffer_before',
      {
        ...base,
        busy: [interval('2026-11-02T09:45Z', '2026-11-02T09:55Z')],
        eventType: { ...base.eventType, bufferBeforeMinutes: 10 },
      },
    ],
    [
      'buffer_after',
      {
        ...base,
        busy: [interval('2026-11-02T10:35Z', '2026-11-02T10:45Z')],
        eventType: { ...base.eventType, bufferAfterMinutes: 10 },
      },
    ],
    [
      'daily_limit',
      {
        ...base,
        bookings: [interval('2026-11-02T06:00Z', '2026-11-02T07:00Z')],
        eventType: { ...base.eventType, maxBookingsPerDay: 1 },
      },
    ],
    [
      'host_conflict',
      { ...base, blockingBookings: [interval('2026-11-02T10:10Z', '2026-11-02T10:20Z')] },
    ],
  ])('reports %s in isolation', (code, input) => {
    expect(codes(input)).toEqual([code])
    expect(at(input).status).toBe('unavailable')
  })

  it('keeps every cause in stable order and clips all intervals to the slot', () => {
    const input: ExplainAvailabilityInput = {
      ...base,
      durationMinutes: 20,
      now: instant('2026-11-02T11:00Z'),
      schedule: { ...base.schedule, weeklyHours: {} },
      eventType: {
        durationMinutes: 30,
        bufferBeforeMinutes: 20,
        bufferAfterMinutes: 20,
        minimumNoticeMinutes: 30,
        bookingWindowDays: 1,
        maxBookingsPerDay: 1,
      },
      busy: [interval('2026-11-02T09:00Z', '2026-11-02T12:00Z')],
      bookings: [interval('2026-11-02T09:00Z', '2026-11-02T12:00Z')],
    }
    expect(codes(input)).toEqual([
      'past',
      'duration_not_offered',
      'outside_working_hours',
      'minimum_notice',
      'calendar_busy',
      'buffer_before',
      'buffer_after',
      'daily_limit',
      'host_conflict',
    ])
    for (const reason of at(input).reasons) {
      expect(Object.keys(reason).sort()).toEqual(['code', 'interval'])
      expect(reason.interval.start.equals(instant('2026-11-02T10:00Z'))).toBe(true)
      expect(reason.interval.end.equals(instant('2026-11-02T10:20Z'))).toBe(true)
    }
    expect(at({ ...input, busy: [...(input.busy ?? [])].reverse() })).toEqual(at(input))
  })

  it('projects buffer-only blockers onto the affected portion of the candidate', () => {
    const before = at({
      ...base,
      busy: [interval('2026-11-02T09:45Z', '2026-11-02T09:55Z')],
      eventType: { durationMinutes: 30, bufferBeforeMinutes: 10 },
    }).reasons
    expect(before).toEqual([
      { code: 'buffer_before', interval: interval('2026-11-02T10:00Z', '2026-11-02T10:05Z') },
    ])
    const after = at({
      ...base,
      busy: [interval('2026-11-02T10:35Z', '2026-11-02T10:45Z')],
      eventType: { durationMinutes: 30, bufferAfterMinutes: 10 },
    }).reasons
    expect(after).toEqual([
      { code: 'buffer_after', interval: interval('2026-11-02T10:25Z', '2026-11-02T10:30Z') },
    ])
  })

  it('includes both existing booking buffers and additive candidate buffers', () => {
    const booking = {
      ...interval('2026-11-02T10:40Z', '2026-11-02T11:00Z'),
      bufferBeforeMinutes: 5,
    }
    expect(
      codes({
        ...base,
        blockingBookings: [booking],
        eventType: { durationMinutes: 30, bufferAfterMinutes: 10 },
      }),
    ).toEqual(['buffer_before', 'buffer_after'])
    const earlier = {
      ...interval('2026-11-02T09:00Z', '2026-11-02T09:50Z'),
      bufferAfterMinutes: 5,
    }
    expect(
      codes({
        ...base,
        blockingBookings: [earlier],
        eventType: { durationMinutes: 30, bufferBeforeMinutes: 10 },
      }),
    ).toEqual(['buffer_before', 'buffer_after'])
    expect(codes({ ...base, blockingBookings: [booking, earlier] })).toEqual([])
  })

  it('does not count calendars or other-event bookings toward this event daily limit', () => {
    const remote = interval('2026-11-02T06:00Z', '2026-11-02T07:00Z')
    expect(
      codes({
        ...base,
        busy: [remote],
        blockingBookings: [remote],
        eventType: { durationMinutes: 30, maxBookingsPerDay: 1 },
      }),
    ).toEqual([])
  })

  it('treats touching endpoints and exact notice/window bounds as available', () => {
    expect(
      codes({
        ...base,
        now: instant('2026-11-01T10:00Z'),
        eventType: { durationMinutes: 30, minimumNoticeMinutes: 1440, bookingWindowDays: 1 },
        busy: [
          interval('2026-11-02T09:00Z', '2026-11-02T10:00Z'),
          interval('2026-11-02T10:30Z', '2026-11-02T11:00Z'),
        ],
      }),
    ).toEqual([])
  })

  it('replaces weekly hours with date overrides, including closed and adjacent dates', () => {
    const input: ExplainAvailabilityInput = {
      ...base,
      schedule: {
        ...base.schedule,
        dateOverrides: [
          { date: '2026-11-01', intervals: [{ start: '10:00', end: '11:00' }] },
          { date: '2026-11-02', intervals: [] },
        ],
      },
    }
    expect(codes(input)).toEqual(['outside_working_hours'])
    const partial = {
      ...input,
      schedule: {
        ...input.schedule,
        dateOverrides: [{ date: '2026-11-02', intervals: [{ start: '10:15', end: '11:00' }] }],
      },
    }
    expect(at(partial).reasons).toEqual([
      {
        code: 'outside_working_hours',
        interval: interval('2026-11-02T10:00Z', '2026-11-02T10:15Z'),
      },
    ])
    expect(keys(explainAvailability(partial).filter((s) => s.status === 'available'))).toEqual(
      keys(getAvailableSlots(partial)),
    )
  })

  it('retains interval-anchored starts and evaluates additional team starts safely', () => {
    const input: ExplainAvailabilityInput = {
      ...base,
      schedule: {
        ...base.schedule,
        weeklyHours: { monday: [{ start: '09:15', end: '12:00' }] },
      },
      candidateStarts: [instant('2026-11-02T10:07Z'), instant('2026-10-01T10:00Z')],
    }
    expect(codes(input, '2026-11-02T10:07Z')).toEqual(['off_slot_grid'])
    expect(at(input, '2026-11-02T10:15Z').status).toBe('available')
    expect(keys(explainAvailability(input).filter((s) => s.status === 'available'))).toEqual(
      keys(getAvailableSlots(input)),
    )
  })

  it.each([
    ['spring gap', '2026-03-08', '01:00', '02:30'],
    ['fall repeated hour', '2026-11-01', '00:00', '04:00'],
  ])('matches the normal DST %s semantics', (_label, date, start, end) => {
    const local = Temporal.PlainDate.from(date)
    const input: ExplainAvailabilityInput = {
      ...base,
      schedule: {
        timeZone: 'America/New_York',
        weeklyHours: { sunday: [{ start, end }] },
      },
      eventType: { durationMinutes: 30, slotStepMinutes: 30 },
      rangeStart: local.toZonedDateTime('America/New_York').toInstant(),
      rangeEnd: local.add({ days: 1 }).toZonedDateTime('America/New_York').toInstant(),
      now: instant('2026-01-01T00:00Z'),
    }
    const result = explainAvailability(input)
    expect(keys(result.filter((s) => s.status === 'available'))).toEqual(
      keys(getAvailableSlots(input)),
    )
    expect(new Set(result.map((s) => s.start.toString())).size).toBe(result.length)
    expect(
      result.some((s) => {
        const zoned = s.start.toZonedDateTimeISO('America/New_York')
        return date === '2026-03-08'
          ? zoned.hour === 2
          : zoned.hour === 1 && zoned.offset === '-05:00'
      }),
    ).toBe(false)
    if (date === '2026-03-08') {
      expect(at(input, '2026-03-08T07:00Z').status).toBe('available')
    }
  })

  it('skips gap starts rather than moving them onto an unoffered forty-five-minute grid', () => {
    const input: ExplainAvailabilityInput = {
      ...base,
      schedule: {
        timeZone: 'America/New_York',
        weeklyHours: { sunday: [{ start: '01:00', end: '04:00' }] },
      },
      eventType: { durationMinutes: 15, slotStepMinutes: 45 },
      rangeStart: instant('2026-03-08T00:00-05:00'),
      rangeEnd: instant('2026-03-09T00:00-04:00'),
      now: instant('2026-03-07T00:00Z'),
    }
    const result = explainAvailability(input)
    expect(result.some((slot) => slot.start.equals(instant('2026-03-08T07:30Z')))).toBe(false)
    expect(keys(result.filter((slot) => slot.status === 'available'))).toEqual(
      keys(getAvailableSlots(input)),
    )
  })

  it('never copies descriptive metadata or ids from untrusted interval objects', () => {
    const privateBusy = {
      ...interval('2026-11-02T09:00Z', '2026-11-02T12:00Z'),
      title: 'private-title-marker',
      attendees: ['private-attendee-marker'],
      location: 'private-location-marker',
      id: 'private-id-marker',
      hostUserId: 'private-host-marker',
    }
    const result = at({ ...base, busy: [privateBusy], blockingBookings: [privateBusy] })
    expect(result.reasons.map((r) => r.code)).toEqual(['calendar_busy', 'host_conflict'])
    const encoded = JSON.stringify(result)
    expect(encoded).not.toContain('private-')
    expect(Object.keys(result).sort()).toEqual(['end', 'reasons', 'start', 'status'])
    for (const reason of result.reasons) {
      expect(Object.keys(reason).sort()).toEqual(['code', 'interval'])
      expect(reason.interval).toEqual(interval('2026-11-02T10:00Z', '2026-11-02T10:30Z'))
    }
  })

  it.each([0, 1441, 15.5, Number.NaN])('rejects malformed duration %s', (durationMinutes) => {
    expect(() => explainAvailability({ ...base, durationMinutes })).toThrow(AvailabilityInputError)
  })

  it('validates extra starts and conflict bookings before returning explanations', () => {
    expect(() =>
      explainAvailability({ ...base, candidateStarts: ['2026-11-02T10:00Z' as never] }),
    ).toThrow(AvailabilityInputError)
    expect(() =>
      explainAvailability({
        ...base,
        blockingBookings: [interval('2026-11-02T11:00Z', '2026-11-02T10:00Z')],
      }),
    ).toThrow(AvailabilityInputError)
  })

  it('enforces a distinct-candidate budget before evaluating reasons, including interval restarts', () => {
    const intervals = Array.from({ length: 30 }, (_, i) => ({
      start: `10:${String(i * 2).padStart(2, '0')}`,
      end: `10:${String(i * 2 + 1).padStart(2, '0')}`,
    }))
    const input: ExplainAvailabilityInput = {
      ...base,
      schedule: { timeZone: 'UTC', weeklyHours: { monday: intervals } },
      eventType: { durationMinutes: 1, slotStepMinutes: 1440 },
      maximumCandidates: 20,
    }
    expect(() => explainAvailability(input)).toThrow('explain candidate limit exceeded')
    expect(explainAvailability({ ...base, maximumCandidates: 6 })).toHaveLength(6)
    expect(() => explainAvailability({ ...base, maximumCandidates: 5 })).toThrow(
      'explain candidate limit exceeded',
    )
    expect(() => explainAvailability({ ...base, maximumCandidates: 0 })).toThrow(
      AvailabilityInputError,
    )
  })

  it.each([
    ['Pacific/Apia', '2011-12-29T00:00-10:00', '2011-12-31T23:59+14:00'],
    ['America/St_Johns', '2006-10-29T00:00-02:30', '2006-10-29T00:00-03:30'],
    ['America/Santiago', '2026-09-05T00:00-04:00', '2026-09-07T00:00-03:00'],
  ])('retains parity across midnight transitions in %s', (timeZone, from, until) => {
    const allDay = [{ start: '00:00', end: '24:00' }]
    const input: ExplainAvailabilityInput = {
      ...base,
      schedule: {
        timeZone,
        weeklyHours: {
          monday: allDay,
          tuesday: allDay,
          wednesday: allDay,
          thursday: allDay,
          friday: allDay,
          saturday: allDay,
          sunday: allDay,
        },
      },
      rangeStart: instant(from),
      rangeEnd: instant(until),
      now: instant(from).subtract({ hours: 1 }),
    }
    expect(keys(explainAvailability(input).filter((s) => s.status === 'available'))).toEqual(
      keys(getAvailableSlots(input)),
    )
  })

  it('has exact normal-path parity over seeded schedules, rules, overrides and DST transitions', () => {
    let seed = 0x5eed1234
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    const clock = (minute: number) =>
      `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
    const dates = ['2026-03-07', '2026-03-08', '2026-10-31', '2026-11-01', '2026-11-02']
    const zones = ['UTC', 'America/New_York', 'Europe/Berlin', 'Australia/Lord_Howe']
    for (let trial = 0; trial < 100; trial++) {
      const zone = zones[random(zones.length)] ?? 'UTC'
      const date = Temporal.PlainDate.from(dates[random(dates.length)] ?? '2026-11-02')
      const rangeStart = date.toZonedDateTime(zone).toInstant()
      const rangeEnd = date.add({ days: 2 }).toZonedDateTime(zone).toInstant()
      const begin = random(20) * 15
      const finish = begin + (random(8) + 2) * 30
      const working =
        random(2) === 0
          ? [{ start: clock(begin), end: clock(finish) }]
          : [
              { start: clock(begin), end: clock(finish) },
              { start: clock(finish + random(3) * 15), end: clock(finish + 120) },
            ]
      const overridden = random(3) === 0 ? [] : working
      const durationMinutes = [15, 30, 45, 60][random(4)] ?? 30
      const bookings = Array.from({ length: random(4) }, () => {
        const start = rangeStart.add({ minutes: random(48 * 60) })
        return {
          start,
          end: start.add({ minutes: random(90) + 1 }),
          bufferBeforeMinutes: random(4) * 5,
          bufferAfterMinutes: random(4) * 5,
        }
      })
      const input: ExplainAvailabilityInput = {
        schedule: {
          timeZone: zone,
          weeklyHours: {
            monday: working,
            tuesday: working,
            wednesday: working,
            thursday: working,
            friday: working,
            saturday: working,
            sunday: working,
          },
          dateOverrides: [{ date: date.toString(), intervals: overridden }],
        },
        eventType: {
          durationMinutes,
          allowedDurationsMinutes: [15, 30, 45, 60],
          slotStepMinutes: [15, 20, 30, 45][random(4)] ?? 30,
          bufferBeforeMinutes: random(4) * 5,
          bufferAfterMinutes: random(4) * 5,
          minimumNoticeMinutes: random(24 * 60),
          bookingWindowDays: random(2) + 1,
          maxBookingsPerDay: random(3) + 1,
        } satisfies Required<EventTypeRules>,
        rangeStart,
        rangeEnd,
        durationMinutes: random(2) === 0 ? ([15, 30, 45, 60][random(4)] ?? 30) : undefined,
        now: rangeStart.subtract({ minutes: random(24 * 60) }),
        busy: bookings.slice(0, 1),
        bookings,
      }
      const result = explainAvailability(input)
      expect(keys(result.filter((slot) => slot.status === 'available')), `trial ${trial}`).toEqual(
        keys(getAvailableSlots(input)),
      )
      for (const slot of result) {
        const indexes = slot.reasons.map((reason) => AVAILABILITY_REASON_CODES.indexOf(reason.code))
        expect(indexes).toEqual([...indexes].sort((a, b) => a - b))
        for (const reason of slot.reasons) {
          expect(
            Temporal.Instant.compare(reason.interval.start, slot.start),
          ).toBeGreaterThanOrEqual(0)
          expect(Temporal.Instant.compare(reason.interval.end, slot.end)).toBeLessThanOrEqual(0)
          expect(Temporal.Instant.compare(reason.interval.start, reason.interval.end)).toBeLessThan(
            0,
          )
        }
      }
    }
  })
})
