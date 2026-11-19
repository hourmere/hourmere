import { describe, expect, it } from 'vitest'
import type { DomainError } from './errors.ts'
import { expandRecurringRule, normalizeRecurringRule } from './recurring-rules.ts'

const weekly = { pattern: 'weekly', count: 2 }
const monthly = { pattern: 'monthly_weekday', count: 2, ordinal: 2, weekday: 1 }
const defaultInput = {
  rule: weekly,
  timeZone: 'America/New_York',
  firstLocalStart: '2027-01-04T09:00:00-05:00',
  now: Temporal.Instant.from('2027-01-01T12:00:00Z'),
  durationMinutes: 30,
}

function expand(input: Partial<Parameters<typeof expandRecurringRule>[0]>) {
  return expandRecurringRule({ ...defaultInput, ...input })
}

function expectInvalid(action: () => unknown) {
  expect(action).toThrow(
    expect.objectContaining<Partial<DomainError>>({ kind: 'invalid', code: 'invalid_recurrence' }),
  )
}

describe('normalizeRecurringRule', () => {
  it.each([
    weekly,
    { pattern: 'fortnightly', count: 12 },
    monthly,
    { pattern: 'monthly_weekday', count: 2, ordinal: 'last', weekday: 7 },
  ])('accepts a supported rule %j', (rule) => {
    expect(normalizeRecurringRule(rule)).toEqual(rule)
  })

  it.each<[string, unknown]>([
    ['a null rule', null],
    ['an open-ended rule', { pattern: 'weekly' }],
    ['a single occurrence', { ...weekly, count: 1 }],
    ['an over-limit count', { ...weekly, count: 13 }],
    ['a fractional count', { ...weekly, count: 2.5 }],
    ['a numeric string count', { ...weekly, count: '2' }],
    ['a daily pattern', { ...weekly, pattern: 'daily' }],
    ['a numbered-date monthly pattern', { ...weekly, pattern: 'monthly' }],
    ['a yearly pattern', { ...weekly, pattern: 'yearly' }],
    ['an arbitrary RRULE', { ...weekly, rrule: 'FREQ=WEEKLY;COUNT=2' }],
    ['an end date', { ...weekly, until: '2027-03-07' }],
    ['an added date', { ...weekly, rdate: ['2027-03-07'] }],
    ['a custom interval', { ...weekly, interval: 3 }],
    ['an array of caller-expanded instants', ['2027-01-04T14:00:00Z', '2027-01-11T14:00:00Z']],
    ['a weekly ordinal', { ...weekly, ordinal: 1 }],
    ['a fortnightly weekday', { ...weekly, pattern: 'fortnightly', weekday: 1 }],
    ['an omitted monthly ordinal', { ...monthly, ordinal: undefined }],
    ['an omitted monthly weekday', { ...monthly, weekday: undefined }],
    ['a fifth weekday', { ...monthly, ordinal: 5 }],
    ['a Sunday numbered zero', { ...monthly, weekday: 0 }],
    ['a weekday above seven', { ...monthly, weekday: 8 }],
    ['multiple weekdays', { ...monthly, weekday: [1, 5] }],
  ])('rejects %s', (_label, rule) => {
    expectInvalid(() => normalizeRecurringRule(rule))
  })
})

describe('expandRecurringRule', () => {
  it.each([
    {
      label: 'weekly in a non-DST zone',
      rule: { pattern: 'weekly', count: 3 },
      dates: ['2027-01-04', '2027-01-11', '2027-01-18'],
    },
    {
      label: 'fortnightly across a month boundary',
      rule: { pattern: 'fortnightly', count: 3 },
      dates: ['2027-01-18', '2027-02-01', '2027-02-15'],
    },
    {
      label: 'first Monday',
      rule: { pattern: 'monthly_weekday', ordinal: 1, weekday: 1, count: 2 },
      dates: ['2027-01-04', '2027-02-01'],
    },
    {
      label: 'second Thursday',
      rule: { pattern: 'monthly_weekday', ordinal: 2, weekday: 4, count: 2 },
      dates: ['2027-01-14', '2027-02-11'],
    },
    {
      label: 'third Wednesday',
      rule: { pattern: 'monthly_weekday', ordinal: 3, weekday: 3, count: 2 },
      dates: ['2027-01-20', '2027-02-17'],
    },
    {
      label: 'fourth Monday after a month where it is also last',
      rule: { pattern: 'monthly_weekday', ordinal: 4, weekday: 1, count: 3 },
      dates: ['2027-02-22', '2027-03-22', '2027-04-26'],
    },
    {
      label: 'last Monday after a month where it is also fourth',
      rule: { pattern: 'monthly_weekday', ordinal: 'last', weekday: 1, count: 3 },
      dates: ['2027-02-22', '2027-03-29', '2027-04-26'],
    },
    {
      label: 'last Thursday across a leap day',
      rule: { pattern: 'monthly_weekday', ordinal: 'last', weekday: 4, count: 3 },
      dates: ['2024-01-25', '2024-02-29', '2024-03-28'],
    },
    {
      label: 'last Thursday in a common year',
      rule: { pattern: 'monthly_weekday', ordinal: 'last', weekday: 4, count: 3 },
      dates: ['2025-01-30', '2025-02-27', '2025-03-27'],
    },
    {
      label: 'last Sunday across a year boundary',
      rule: { pattern: 'monthly_weekday', ordinal: 'last', weekday: 7, count: 2 },
      dates: ['2027-12-26', '2028-01-30'],
    },
  ])('preserves local time for $label', ({ rule, dates }) => {
    const occurrences = expand({
      rule,
      firstLocalStart: `${dates[0]}T09:00:00+05:30`,
      timeZone: 'Asia/Kolkata',
      now: Temporal.Instant.from(`${dates[0]}T00:00:00Z`),
    })

    expect(
      occurrences.map(({ start, end, ...occurrence }) => ({
        ...occurrence,
        start: start?.toString(),
        end: end?.toString(),
      })),
    ).toEqual(
      dates.map((date, index) => ({
        ordinal: index + 1,
        localStart: `${date}T09:00:00`,
        start: `${date}T03:30:00Z`,
        end: `${date}T04:00:00Z`,
        offset: '+05:30',
      })),
    )
  })

  it('uses the event zone when host and invitee clocks differ', () => {
    const occurrences = expand({
      firstLocalStart: '2027-03-07T09:00:00-05:00',
      timeZone: 'America/New_York',
    })
    const wallTimes = (zone: string) =>
      occurrences.map(({ start }) => start?.toZonedDateTimeISO(zone).toPlainTime().toString())

    expect(
      occurrences.map(({ localStart, start, offset }) => [localStart, start?.toString(), offset]),
    ).toEqual([
      ['2027-03-07T09:00:00', '2027-03-07T14:00:00Z', '-05:00'],
      ['2027-03-14T09:00:00', '2027-03-14T13:00:00Z', '-04:00'],
    ])
    expect(wallTimes('America/Los_Angeles')).toEqual(['06:00:00', '06:00:00'])
    expect(wallTimes('Europe/London')).toEqual(['14:00:00', '13:00:00'])
    expect(wallTimes('Asia/Tokyo')).toEqual(['23:00:00', '22:00:00'])
  })

  it.each([
    {
      label: 'New York spring gap',
      timeZone: 'America/New_York',
      firstLocalStart: '2027-03-07T02:30:00-05:00',
      gap: '2027-03-14T02:30:00',
      next: '2027-03-21T02:30:00',
      nextStart: '2027-03-21T06:30:00Z',
    },
    {
      label: 'Lord Howe 30-minute spring gap',
      timeZone: 'Australia/Lord_Howe',
      firstLocalStart: '2027-09-26T02:15:00+10:30',
      gap: '2027-10-03T02:15:00',
      next: '2027-10-10T02:15:00',
      nextStart: '2027-10-09T15:15:00Z',
    },
  ])(
    'keeps the requested ordinal across the $label',
    ({ timeZone, firstLocalStart, gap, next, nextStart }) => {
      const occurrences = expand({ rule: { ...weekly, count: 3 }, timeZone, firstLocalStart })

      expect(occurrences).toHaveLength(3)
      expect(occurrences[1]).toEqual({
        ordinal: 2,
        localStart: gap,
        start: null,
        end: null,
        offset: null,
        reason: 'nonexistent_local_time',
      })
      expect(occurrences[2]).toMatchObject({
        ordinal: 3,
        localStart: next,
      })
      expect(occurrences[2]?.start?.toString()).toBe(nextStart)
    },
  )

  it.each([
    {
      label: 'earlier first-slot offset',
      firstLocalStart: '2027-11-07T01:30:00-04:00',
      starts: ['2027-11-07T05:30:00Z', '2027-11-14T06:30:00Z'],
      offsets: ['-04:00', '-05:00'],
    },
    {
      label: 'later first-slot offset',
      firstLocalStart: '2027-11-07T01:30:00-05:00',
      starts: ['2027-11-07T06:30:00Z', '2027-11-14T06:30:00Z'],
      offsets: ['-05:00', '-05:00'],
    },
    {
      label: 'earlier generated offset',
      firstLocalStart: '2027-10-31T01:30:00-04:00',
      starts: ['2027-10-31T05:30:00Z', '2027-11-07T05:30:00Z'],
      offsets: ['-04:00', '-04:00'],
    },
  ])('uses the $label at a New York fold', ({ firstLocalStart, starts, offsets }) => {
    const occurrences = expand({ firstLocalStart })

    expect(occurrences.map(({ start }) => start?.toString())).toEqual(starts)
    expect(occurrences.map(({ offset }) => offset)).toEqual(offsets)
  })

  it('keeps elapsed duration across the Lord Howe 30-minute transition', () => {
    const occurrences = expand({
      rule: { ...weekly, count: 3 },
      timeZone: 'Australia/Lord_Howe',
      firstLocalStart: '2027-09-26T01:45:00+10:30',
    })

    expect(
      occurrences.map(({ localStart, start, end, offset }) => [
        localStart,
        start?.toString(),
        end?.toString(),
        offset,
      ]),
    ).toEqual([
      ['2027-09-26T01:45:00', '2027-09-25T15:15:00Z', '2027-09-25T15:45:00Z', '+10:30'],
      ['2027-10-03T01:45:00', '2027-10-02T15:15:00Z', '2027-10-02T15:45:00Z', '+10:30'],
      ['2027-10-10T01:45:00', '2027-10-09T14:45:00Z', '2027-10-09T15:15:00Z', '+11:00'],
    ])
  })

  it.each<[string, Partial<Parameters<typeof expandRecurringRule>[0]>]>([
    ['a monthly ordinal mismatch', { rule: monthly }],
    ['a monthly weekday mismatch', { rule: { ...monthly, ordinal: 1, weekday: 2 } }],
    [
      'a caller-supplied UTC array in the rule',
      { rule: { ...weekly, starts: ['2027-01-04T14:00:00Z'] } },
    ],
    ['an invalid first fold offset', { firstLocalStart: '2027-11-07T01:30:00-06:00' }],
    ['a first slot inside a spring gap', { firstLocalStart: '2027-03-14T02:30:00-05:00' }],
    ['a missing offset', { firstLocalStart: '2027-01-04T09:00:00' }],
    [
      'a UTC designator instead of a numeric offset',
      { firstLocalStart: '2027-01-04T09:00:00Z', timeZone: 'UTC' },
    ],
    [
      'a caller-supplied timezone annotation',
      { firstLocalStart: '2027-01-04T09:00:00-05:00[America/New_York]' },
    ],
    ['a nonexistent date', { firstLocalStart: '2027-02-29T09:00:00-05:00' }],
    ['a timezone offset instead of an IANA name', { timeZone: '-05:00' }],
    ['an unknown IANA name', { timeZone: 'Mars/Olympus' }],
  ])('rejects %s', (_label, input) => {
    expectInvalid(() => expand(input))
  })

  it('includes the first slot in the maximum count', () => {
    const occurrences = expand({ rule: { ...weekly, count: 12 } })

    expect(occurrences).toHaveLength(12)
    expect(occurrences[0]).toMatchObject({ ordinal: 1, localStart: '2027-01-04T09:00:00' })
    expect(occurrences[11]).toMatchObject({ ordinal: 12, localStart: '2027-03-22T09:00:00' })
  })

  it('allows the last slot on day 366 in the event zone and rejects day 367', () => {
    const input = {
      timeZone: 'Asia/Tokyo',
      now: Temporal.Instant.from('2027-03-01T15:30:00Z'), // March 2 in Tokyo.
    }

    expect(expand({ ...input, firstLocalStart: '2028-02-24T23:59:00+09:00' })[1]).toMatchObject({
      ordinal: 2,
      localStart: '2028-03-02T23:59:00',
    })
    expectInvalid(() => expand({ ...input, firstLocalStart: '2028-02-25T23:59:00+09:00' }))
  })
})
