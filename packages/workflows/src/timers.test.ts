// Workflow timer calculations: due instants for every anchor and direction, the capture-time
// skips at exact equality, the late bound at exact equality, DST transitions in zones with hour
// and non-hour shifts, and properties over generated instants. Every check also runs with the
// host in other time zones, because the rules are elapsed UTC arithmetic only.
import { readFileSync } from 'node:fs'
import { REMINDER_MIN_GAP } from '@hourmere/scheduling'
import { describe, expect, it } from 'vitest'
import type { WorkflowTrigger } from './definition.ts'
import {
  WORKFLOW_MAX_LATE_MINUTES,
  WORKFLOW_MAX_OFFSET_MINUTES,
  WORKFLOW_MIN_TIMER_OFFSET_MINUTES,
} from './limits.ts'
import {
  type WorkflowBookingInstants,
  workflowDispatchWindow,
  workflowRunTiming,
  workflowTimerDueAt,
} from './timers.ts'

const at = (value: string) => Temporal.Instant.from(value)
const zoned = (value: string) => Temporal.ZonedDateTime.from(value)
const nanosecond = { nanoseconds: 1 } as const
const MINUTE_NS = 60_000_000_000n

/** Zones whose rules differ from UTC: hour and non-hour DST shifts and fixed non-hour offsets. */
const HOST_ZONES = [
  'UTC',
  'America/New_York',
  'Europe/Berlin',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
  'Asia/Kathmandu',
  'America/St_Johns',
] as const

/** Runs `check` with the host time zone set to `zone`, then restores the previous zone. */
function inHostZone<T>(zone: string, check: () => T): T {
  const previous = process.env.TZ
  process.env.TZ = zone
  try {
    // The host may report an alias of the zone (Asia/Katmandu), so compare the zones themselves.
    const probe = at('2027-01-01T00:00:00Z')
    expect(
      probe.toZonedDateTimeISO(Temporal.Now.timeZoneId()).equals(probe.toZonedDateTimeISO(zone)),
      zone,
    ).toBe(true)
    return check()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

/** Runs `check` in every host zone and requires the same result as with the host in UTC. */
function sameInEveryHostZone<T>(check: () => T): T {
  const baseline = inHostZone('UTC', check)
  for (const zone of HOST_ZONES) expect(inHostZone(zone, check), zone).toEqual(baseline)
  return baseline
}

const booking: WorkflowBookingInstants = {
  start: at('2027-06-01T10:00:00Z'),
  end: at('2027-06-01T12:00:00Z'),
}
const beforeStart = (offsetMinutes: number): WorkflowTrigger => ({
  type: 'before_start',
  offsetMinutes,
})
const afterEnd = (offsetMinutes: number): WorkflowTrigger => ({ type: 'after_end', offsetMinutes })
const LIFECYCLE = ['booking.created', 'booking.cancelled', 'booking.rescheduled'] as const
const lifecycle = (type: (typeof LIFECYCLE)[number], delayMinutes: number): WorkflowTrigger => ({
  type,
  delayMinutes,
})
const ANCHORS = [
  ['start', 'before'],
  ['start', 'after'],
  ['end', 'before'],
  ['end', 'after'],
] as const
/** The refusal of an offset or delay outside the step-1 limits, whole minutes only. */
const OFFSET_REFUSED = new RangeError(
  `A workflow timer offset must be a whole number of minutes from ${WORKFLOW_MIN_TIMER_OFFSET_MINUTES} to ${WORKFLOW_MAX_OFFSET_MINUTES}`,
)
const DELAY_REFUSED = new RangeError(
  `A workflow lifecycle delay must be a whole number of minutes from 0 to ${WORKFLOW_MAX_OFFSET_MINUTES}`,
)
/** Elapsed nanoseconds from `from` to `to`, computed without Temporal arithmetic. */
const elapsed = (from: Temporal.Instant, to: Temporal.Instant) =>
  to.epochNanoseconds - from.epochNanoseconds

describe('workflow timer due instants', () => {
  it.each([
    ['start', 'before', '2027-06-01T09:30:00Z'],
    ['start', 'after', '2027-06-01T10:30:00Z'],
    ['end', 'before', '2027-06-01T11:30:00Z'],
    ['end', 'after', '2027-06-01T12:30:00Z'],
  ] as const)('moves the %s %s it by the offset', (anchor, direction, due) => {
    const dueAt = sameInEveryHostZone(() =>
      workflowTimerDueAt({ anchor, direction, offsetMinutes: 30 }, booking).toString(),
    )
    expect(dueAt).toBe(due)
  })

  it('moves each anchor by exactly the offset in elapsed minutes', () => {
    for (const [anchor, direction] of ANCHORS)
      for (const offsetMinutes of [
        WORKFLOW_MIN_TIMER_OFFSET_MINUTES,
        59,
        60,
        61,
        1440,
        WORKFLOW_MAX_OFFSET_MINUTES,
      ]) {
        const dueAt = workflowTimerDueAt({ anchor, direction, offsetMinutes }, booking)
        const sign = direction === 'before' ? -1n : 1n
        expect(elapsed(booking[anchor], dueAt), `${anchor} ${direction} ${offsetMinutes}`).toBe(
          sign * BigInt(offsetMinutes) * MINUTE_NS,
        )
      }
  })

  it('keeps the anchor precision below a minute', () => {
    const precise = {
      start: at('2027-06-01T10:00:00.123456789Z'),
      end: at('2027-06-01T12:00:59.999999999Z'),
    }
    expect(
      workflowTimerDueAt({ anchor: 'start', direction: 'before', offsetMinutes: 5 }, precise),
    ).toEqual(at('2027-06-01T09:55:00.123456789Z'))
    expect(
      workflowTimerDueAt({ anchor: 'end', direction: 'after', offsetMinutes: 5 }, precise),
    ).toEqual(at('2027-06-01T12:05:59.999999999Z'))
  })

  it('anchors before-start triggers to the start and after-end triggers to the end', () => {
    const capturedAt = at('2027-05-01T00:00:00Z')
    expect(workflowRunTiming(beforeStart(30), booking, capturedAt).dueAt).toEqual(
      at('2027-06-01T09:30:00Z'),
    )
    expect(workflowRunTiming(afterEnd(30), booking, capturedAt).dueAt).toEqual(
      at('2027-06-01T12:30:00Z'),
    )
  })

  it('accepts whole-minute offsets from the minimum to the maximum and nothing else', () => {
    for (const [anchor, direction] of ANCHORS) {
      const due = (offsetMinutes: number) =>
        workflowTimerDueAt({ anchor, direction, offsetMinutes }, booking)
      expect(() => due(WORKFLOW_MIN_TIMER_OFFSET_MINUTES)).not.toThrow()
      expect(() => due(WORKFLOW_MAX_OFFSET_MINUTES)).not.toThrow()
      for (const offset of [
        WORKFLOW_MIN_TIMER_OFFSET_MINUTES - 1,
        WORKFLOW_MAX_OFFSET_MINUTES + 1,
        0,
        -WORKFLOW_MIN_TIMER_OFFSET_MINUTES,
        5.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ])
        expect(() => due(offset), `${anchor} ${direction} ${offset}`).toThrow(OFFSET_REFUSED)
    }
    const capturedAt = at('2027-05-01T00:00:00Z')
    for (const trigger of [beforeStart, afterEnd]) {
      expect(() => workflowRunTiming(trigger(4), booking, capturedAt)).toThrow(OFFSET_REFUSED)
      expect(() => workflowRunTiming(trigger(43_201), booking, capturedAt)).toThrow(OFFSET_REFUSED)
    }
  })

  it('runs a lifecycle trigger its whole-minute delay after capture, whatever the anchors', () => {
    const capturedAt = at('2027-06-01T15:00:00Z')
    for (const type of LIFECYCLE) {
      expect(workflowRunTiming(lifecycle(type, 0), booking, capturedAt).dueAt).toEqual(capturedAt)
      expect(workflowRunTiming(lifecycle(type, 90), booking, capturedAt).dueAt).toEqual(
        at('2027-06-01T16:30:00Z'),
      )
      expect(
        elapsed(
          capturedAt,
          workflowRunTiming(lifecycle(type, WORKFLOW_MAX_OFFSET_MINUTES), booking, capturedAt)
            .dueAt,
        ),
      ).toBe(BigInt(WORKFLOW_MAX_OFFSET_MINUTES) * MINUTE_NS)
      for (const delay of [-1, WORKFLOW_MAX_OFFSET_MINUTES + 1, 1.5, Number.NaN])
        expect(
          () => workflowRunTiming(lifecycle(type, delay), booking, capturedAt),
          `${type} ${delay}`,
        ).toThrow(DELAY_REFUSED)
    }
  })
})

describe('workflow capture-time decision', () => {
  const offset = 120
  const due = at('2027-06-01T08:00:00Z')

  it.each([
    [
      'more than the gap before the due instant',
      'pending',
      due.subtract(REMINDER_MIN_GAP).subtract(nanosecond),
    ],
    ['exactly the gap before the due instant', 'minimum_gap', due.subtract(REMINDER_MIN_GAP)],
    ['a minute inside the gap', 'minimum_gap', due.subtract(REMINDER_MIN_GAP).add({ minutes: 1 })],
    ['just before the due instant', 'minimum_gap', due.subtract(nanosecond)],
    ['exactly at the due instant', 'offset_not_future', due],
    ['just after the due instant', 'offset_not_future', due.add(nanosecond)],
    ['after the booking started', 'offset_not_future', booking.start.add({ hours: 1 })],
  ] as const)('records a before-start run captured %s as %s', (_, outcome, capturedAt) => {
    const timing = sameInEveryHostZone(() =>
      workflowRunTiming(beforeStart(offset), booking, capturedAt),
    )
    expect(timing.dueAt).toEqual(due)
    expect(timing.skipReason ?? 'pending').toBe(outcome)
  })

  it('uses the strict one-hour reminder gap', () => {
    expect(REMINDER_MIN_GAP).toEqual({ hours: 1 })
    expect(
      workflowRunTiming(beforeStart(offset), booking, at('2027-06-01T07:00:00Z')).skipReason,
    ).toBe('minimum_gap')
    expect(
      workflowRunTiming(beforeStart(offset), booking, at('2027-06-01T06:59:59.999999999Z'))
        .skipReason,
    ).toBeUndefined()
  })

  it.each([
    ['exactly the gap before the due instant', 'pending', at('2027-06-01T11:30:00Z')],
    ['just before the due instant', 'pending', at('2027-06-01T12:29:59.999999999Z')],
    ['exactly at the due instant', 'offset_not_future', at('2027-06-01T12:30:00Z')],
    ['after the due instant', 'offset_not_future', at('2027-06-01T13:00:00Z')],
  ] as const)(
    'records an after-end run captured %s as %s, with no gap rule',
    (_, outcome, capturedAt) => {
      expect(
        sameInEveryHostZone(
          () => workflowRunTiming(afterEnd(30), booking, capturedAt).skipReason ?? 'pending',
        ),
      ).toBe(outcome)
    },
  )

  it('never skips a lifecycle run at capture, even with no delay or after the booking ended', () => {
    for (const type of LIFECYCLE)
      for (const capturedAt of [
        booking.start.subtract({ hours: 24 }),
        booking.end.add({ hours: 24 }),
      ])
        for (const delay of [0, 1, 59, 60])
          expect(
            workflowRunTiming(lifecycle(type, delay), booking, capturedAt).skipReason,
            `${type} ${delay}`,
          ).toBeUndefined()
  })

  it('measures the gap from the capture of a reschedule, not from an earlier capture', () => {
    // The successor of a reschedule starts at the same instant, but its runs are captured when
    // it is rescheduled: the gap and capture-time rules use that instant.
    const created = at('2027-05-20T09:00:00Z')
    const rescheduled = at('2027-06-01T07:30:00Z')
    expect(workflowRunTiming(beforeStart(90), booking, created).skipReason).toBeUndefined()
    expect(workflowRunTiming(beforeStart(90), booking, rescheduled).skipReason).toBe('minimum_gap')
    expect(workflowRunTiming(beforeStart(90), booking, rescheduled).dueAt).toEqual(
      workflowRunTiming(beforeStart(90), booking, created).dueAt,
    )
  })
})

describe('workflow late bound and dispatch window', () => {
  const window = (
    timing: { dueAt: Temporal.Instant; expiresAt: Temporal.Instant },
    now: Temporal.Instant,
  ) => sameInEveryHostZone(() => workflowDispatchWindow(timing, now))
  /** The window just before, at and just after the due instant and the late bound. */
  const edges = (timing: { dueAt: Temporal.Instant; expiresAt: Temporal.Instant }) => [
    window(timing, timing.dueAt.subtract(nanosecond)),
    window(timing, timing.dueAt),
    window(timing, timing.expiresAt.subtract(nanosecond)),
    window(timing, timing.expiresAt),
    window(timing, timing.expiresAt.add(nanosecond)),
    window(timing, timing.expiresAt.add({ hours: 24 })),
  ]
  const EDGES = ['not_due', 'open', 'open', 'expired', 'expired', 'expired']

  it('expires an after-end run exactly at due plus the late bound', () => {
    const timing = workflowRunTiming(afterEnd(30), booking, at('2027-06-01T09:00:00Z'))
    expect(timing.dueAt).toEqual(at('2027-06-01T12:30:00Z'))
    expect(timing.expiresAt).toEqual(at('2027-06-01T13:30:00Z'))
    expect(elapsed(timing.dueAt, timing.expiresAt)).toBe(
      BigInt(WORKFLOW_MAX_LATE_MINUTES) * MINUTE_NS,
    )
    expect(edges(timing)).toEqual(EDGES)
  })

  it.each([
    [1440, '2027-05-31T10:00:00Z', '2027-05-31T11:00:00Z'],
    [61, '2027-06-01T08:59:00Z', '2027-06-01T09:59:00Z'],
    [60, '2027-06-01T09:00:00Z', '2027-06-01T10:00:00Z'],
    [59, '2027-06-01T09:01:00Z', '2027-06-01T10:00:00Z'],
    [WORKFLOW_MIN_TIMER_OFFSET_MINUTES, '2027-06-01T09:55:00Z', '2027-06-01T10:00:00Z'],
  ] as const)(
    'expires a before-start run with a %i-minute offset at the earlier of due plus the late bound and the start',
    (offset, due, expires) => {
      const timing = workflowRunTiming(beforeStart(offset), booking, at('2027-05-01T00:00:00Z'))
      expect(timing.dueAt).toEqual(at(due))
      expect(timing.expiresAt).toEqual(at(expires))
      expect(edges(timing)).toEqual(EDGES)
      // Never at or after the start, and never at or after due plus the late bound.
      expect(window(timing, booking.start)).toBe('expired')
      expect(window(timing, timing.dueAt.add({ minutes: WORKFLOW_MAX_LATE_MINUTES }))).toBe(
        'expired',
      )
    },
  )

  it('measures expiry from the due instant, not from capture', () => {
    const capturedAt = at('2027-06-01T08:00:00Z')
    const delayed = workflowRunTiming(lifecycle('booking.created', 90), booking, capturedAt)
    expect(delayed.dueAt).toEqual(at('2027-06-01T09:30:00Z'))
    expect(delayed.expiresAt).toEqual(at('2027-06-01T10:30:00Z'))
    expect(window(delayed, capturedAt.add({ minutes: WORKFLOW_MAX_LATE_MINUTES }))).toBe('not_due')
    expect(edges(delayed)).toEqual(EDGES)

    const immediate = workflowRunTiming(lifecycle('booking.cancelled', 0), booking, capturedAt)
    expect(immediate.expiresAt).toEqual(at('2027-06-01T09:00:00Z'))
    expect(window(immediate, capturedAt)).toBe('open')
    expect(edges(immediate)).toEqual(EDGES)

    // Timers expire from their due instant whenever they were captured.
    for (const trigger of [beforeStart(1440), afterEnd(30)]) {
      const early = workflowRunTiming(trigger, booking, at('2027-05-01T00:00:00Z'))
      const late = workflowRunTiming(trigger, booking, at('2027-05-30T00:00:00Z'))
      expect(late).toEqual(early)
    }
  })
})

describe('workflow timers across DST transitions and non-hour offsets', () => {
  it.each([
    ['America/New_York', '2027-03-01', '2027-03-14T03:00:00-04:00', '-05:00'],
    ['America/New_York', '2027-10-01', '2027-11-07T01:00:00-05:00', '-04:00'],
    ['Europe/Berlin', '2027-03-01', '2027-03-28T03:00:00+02:00', '+01:00'],
    ['Europe/Berlin', '2027-10-01', '2027-10-31T02:00:00+01:00', '+02:00'],
    ['Australia/Lord_Howe', '2027-03-01', '2027-04-04T01:30:00+10:30', '+11:00'],
    ['Australia/Lord_Howe', '2027-09-01', '2027-10-03T02:30:00+11:00', '+10:30'],
    ['Pacific/Chatham', '2027-03-01', '2027-04-04T02:45:00+12:45', '+13:45'],
    ['Pacific/Chatham', '2027-09-01', '2027-09-26T03:45:00+13:45', '+12:45'],
  ])('uses the real %s transition after %s', (zone, from, after, before) => {
    const transition = zoned(`${from}T00:00[${zone}]`).getTimeZoneTransition('next')
    expect(transition?.toString()).toBe(`${after}[${zone}]`)
    expect(transition?.subtract(nanosecond).offset).toBe(before)
  })

  it('uses a fixed non-hour offset for Asia/Kathmandu', () => {
    const start = zoned('2027-01-01T00:00[Asia/Kathmandu]')
    expect(start.offset).toBe('+05:45')
    expect(start.getTimeZoneTransition('next')).toBeNull()
  })

  // Each anchor and expected due instant is local time in its zone; a day is 1440 elapsed
  // minutes, so across a transition the local wall clock of the due instant moves.
  it.each([
    [
      'New York spring, a day before',
      beforeStart(1440),
      '2027-03-14T09:00:00-04:00[America/New_York]',
      '2027-03-13T08:00:00-05:00[America/New_York]',
    ],
    [
      'New York spring, out of the skipped hour',
      beforeStart(60),
      '2027-03-14T03:30:00-04:00[America/New_York]',
      '2027-03-14T01:30:00-05:00[America/New_York]',
    ],
    [
      'New York spring, a day after',
      afterEnd(1440),
      '2027-03-13T22:00:00-05:00[America/New_York]',
      '2027-03-14T23:00:00-04:00[America/New_York]',
    ],
    [
      'New York spring, the maximum offset',
      beforeStart(WORKFLOW_MAX_OFFSET_MINUTES),
      '2027-04-10T09:00:00-04:00[America/New_York]',
      '2027-03-11T08:00:00-05:00[America/New_York]',
    ],
    [
      'New York fall, a day before',
      beforeStart(1440),
      '2027-11-07T09:00:00-05:00[America/New_York]',
      '2027-11-06T10:00:00-04:00[America/New_York]',
    ],
    [
      'New York fall, into the first of the repeated hour',
      beforeStart(60),
      '2027-11-07T01:30:00-05:00[America/New_York]',
      '2027-11-07T01:30:00-04:00[America/New_York]',
    ],
    [
      'New York fall, into the second of the repeated hour',
      afterEnd(30),
      '2027-11-07T01:45:00-04:00[America/New_York]',
      '2027-11-07T01:15:00-05:00[America/New_York]',
    ],
    [
      'Berlin spring, a day before',
      beforeStart(1440),
      '2027-03-28T10:00:00+02:00[Europe/Berlin]',
      '2027-03-27T09:00:00+01:00[Europe/Berlin]',
    ],
    [
      'Berlin spring, over the skipped hour',
      afterEnd(120),
      '2027-03-28T01:30:00+01:00[Europe/Berlin]',
      '2027-03-28T04:30:00+02:00[Europe/Berlin]',
    ],
    [
      'Berlin fall, into the first of the repeated hour',
      beforeStart(60),
      '2027-10-31T02:30:00+01:00[Europe/Berlin]',
      '2027-10-31T02:30:00+02:00[Europe/Berlin]',
    ],
    [
      'Berlin fall, a day after',
      afterEnd(1440),
      '2027-10-30T18:00:00+02:00[Europe/Berlin]',
      '2027-10-31T17:00:00+01:00[Europe/Berlin]',
    ],
    [
      'Lord Howe fall (30 minutes), a day before',
      beforeStart(1440),
      '2027-04-04T09:00:00+10:30[Australia/Lord_Howe]',
      '2027-04-03T09:30:00+11:00[Australia/Lord_Howe]',
    ],
    [
      'Lord Howe fall (30 minutes), into the repeated half hour',
      beforeStart(30),
      '2027-04-04T01:45:00+10:30[Australia/Lord_Howe]',
      '2027-04-04T01:45:00+11:00[Australia/Lord_Howe]',
    ],
    [
      'Lord Howe spring (30 minutes), out of the skipped half hour',
      beforeStart(30),
      '2027-10-03T02:30:00+11:00[Australia/Lord_Howe]',
      '2027-10-03T01:30:00+10:30[Australia/Lord_Howe]',
    ],
    [
      'Lord Howe spring (30 minutes), a day before',
      beforeStart(1440),
      '2027-10-03T09:00:00+11:00[Australia/Lord_Howe]',
      '2027-10-02T08:30:00+10:30[Australia/Lord_Howe]',
    ],
    [
      'Lord Howe spring (30 minutes), a day after',
      afterEnd(1440),
      '2027-10-02T12:00:00+10:30[Australia/Lord_Howe]',
      '2027-10-03T12:30:00+11:00[Australia/Lord_Howe]',
    ],
    [
      'Chatham spring (+12:45 to +13:45), a day before',
      beforeStart(1440),
      '2027-09-26T09:00:00+13:45[Pacific/Chatham]',
      '2027-09-25T08:00:00+12:45[Pacific/Chatham]',
    ],
    [
      'Kathmandu (fixed +05:45), a day before',
      beforeStart(1440),
      '2027-03-14T09:00:00+05:45[Asia/Kathmandu]',
      '2027-03-13T09:00:00+05:45[Asia/Kathmandu]',
    ],
    [
      'Kathmandu (fixed +05:45), after the end',
      afterEnd(45),
      '2027-03-14T09:15:00+05:45[Asia/Kathmandu]',
      '2027-03-14T10:00:00+05:45[Asia/Kathmandu]',
    ],
  ] as const)('%s', (_, trigger, anchor, due) => {
    const local = zoned(anchor)
    expect(local.toString()).toBe(anchor)
    const instants =
      trigger.type === 'before_start'
        ? { start: local.toInstant(), end: local.toInstant().add({ hours: 1 }) }
        : { start: local.toInstant().subtract({ hours: 1 }), end: local.toInstant() }
    const dueAt = sameInEveryHostZone(() =>
      workflowRunTiming(trigger, instants, at('2026-01-01T00:00:00Z')).dueAt.toString(),
    )
    expect(at(dueAt).toZonedDateTimeISO(local.timeZoneId).toString()).toBe(due)
    const minutes = 'offsetMinutes' in trigger ? trigger.offsetMinutes : 0
    expect(elapsed(local.toInstant(), at(dueAt))).toBe(
      (trigger.type === 'before_start' ? -1n : 1n) * BigInt(minutes) * MINUTE_NS,
    )
  })

  it('measures the gap in elapsed time across the New York spring gap', () => {
    // Due at 03:00 EDT, captured at 01:00 EST: two hours apart on the wall clock, one elapsed.
    const instants = {
      start: zoned('2027-03-14T03:30:00-04:00[America/New_York]').toInstant(),
      end: zoned('2027-03-14T04:30:00-04:00[America/New_York]').toInstant(),
    }
    const capturedAt = zoned('2027-03-14T01:00:00-05:00[America/New_York]').toInstant()
    const timing = sameInEveryHostZone(() =>
      workflowRunTiming(beforeStart(30), instants, capturedAt),
    )
    expect(timing.dueAt.toZonedDateTimeISO('America/New_York').toString()).toBe(
      '2027-03-14T03:00:00-04:00[America/New_York]',
    )
    expect(timing.skipReason).toBe('minimum_gap')
    expect(
      sameInEveryHostZone(
        () =>
          workflowRunTiming(beforeStart(30), instants, capturedAt.subtract(nanosecond)).skipReason,
      ),
    ).toBeUndefined()
  })

  it('compares capture with the due instant in elapsed time across the New York fall fold', () => {
    // Due at the second 01:15; a capture at the first 01:50 reads later but is earlier.
    const instants = {
      start: zoned('2027-11-07T00:45:00-04:00[America/New_York]').toInstant(),
      end: zoned('2027-11-07T01:45:00-04:00[America/New_York]').toInstant(),
    }
    const decide = (capturedAt: string) =>
      sameInEveryHostZone(
        () => workflowRunTiming(afterEnd(30), instants, zoned(capturedAt).toInstant()).skipReason,
      )
    expect(decide('2027-11-07T01:50:00-04:00[America/New_York]')).toBeUndefined()
    expect(decide('2027-11-07T01:15:00-05:00[America/New_York]')).toBe('offset_not_future')
  })

  it('closes the late bound in elapsed time across the New York fall fold', () => {
    // Due at 00:45 EDT, so the late bound is the first 01:45; the second 01:44 is past it.
    const instants = {
      start: zoned('2027-11-06T23:15:00-04:00[America/New_York]').toInstant(),
      end: zoned('2027-11-07T00:15:00-04:00[America/New_York]').toInstant(),
    }
    const timing = workflowRunTiming(afterEnd(30), instants, at('2027-11-01T00:00:00Z'))
    expect(timing.expiresAt.toZonedDateTimeISO('America/New_York').toString()).toBe(
      '2027-11-07T01:45:00-04:00[America/New_York]',
    )
    const window = (now: string) =>
      sameInEveryHostZone(() => workflowDispatchWindow(timing, zoned(now).toInstant()))
    expect(window('2027-11-07T01:44:59.999999999-04:00[America/New_York]')).toBe('open')
    expect(window('2027-11-07T01:45:00-04:00[America/New_York]')).toBe('expired')
    expect(window('2027-11-07T01:44:00-05:00[America/New_York]')).toBe('expired')
  })

  it('closes the late bound in elapsed time across the Lord Howe half-hour spring shift', () => {
    // Due at 01:30 (+10:30); 60 elapsed minutes later the wall clock reads 03:00 (+11:00).
    const instants = {
      start: zoned('2027-10-03T04:00:00+11:00[Australia/Lord_Howe]').toInstant(),
      end: zoned('2027-10-03T05:00:00+11:00[Australia/Lord_Howe]').toInstant(),
    }
    const timing = workflowRunTiming(beforeStart(120), instants, at('2027-10-01T00:00:00Z'))
    expect(timing.dueAt.toZonedDateTimeISO('Australia/Lord_Howe').toString()).toBe(
      '2027-10-03T01:30:00+10:30[Australia/Lord_Howe]',
    )
    expect(timing.expiresAt.toZonedDateTimeISO('Australia/Lord_Howe').toString()).toBe(
      '2027-10-03T03:00:00+11:00[Australia/Lord_Howe]',
    )
    const window = (now: Temporal.Instant) =>
      sameInEveryHostZone(() => workflowDispatchWindow(timing, now))
    expect(window(timing.expiresAt.subtract(nanosecond))).toBe('open')
    expect(window(timing.expiresAt)).toBe('expired')
  })
})

describe('workflow timer properties over generated instants', () => {
  /** A seeded linear congruential generator, so every run checks the same instants. */
  function generator(seed: number) {
    let state = seed >>> 0
    return (maximum: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return Math.floor((state / 2 ** 32) * maximum)
    }
  }
  const BASE = at('2026-01-01T00:00:00Z')
  const YEARS_IN_MINUTES = 3 * 366 * 1440
  const OFFSETS = WORKFLOW_MAX_OFFSET_MINUTES - WORKFLOW_MIN_TIMER_OFFSET_MINUTES + 1
  const samples = (() => {
    const random = generator(0x8a71e5)
    return Array.from({ length: 300 }, () => {
      const start = BASE.add({
        minutes: random(YEARS_IN_MINUTES),
        milliseconds: random(60_000),
      })
      const end = start.add({ minutes: WORKFLOW_MIN_TIMER_OFFSET_MINUTES + random(720) })
      const offsets = [
        WORKFLOW_MIN_TIMER_OFFSET_MINUTES + random(OFFSETS),
        WORKFLOW_MIN_TIMER_OFFSET_MINUTES + random(OFFSETS),
      ].sort((a, b) => a - b) as [number, number]
      const capturedAt = start.subtract({ minutes: random(2 * WORKFLOW_MAX_OFFSET_MINUTES) })
      return { booking: { start, end }, offsets, capturedAt, nudge: random(7200) }
    })
  })()

  it('moves every anchor by exactly the offset and is strictly monotonic in the offset', () => {
    for (const { booking: instants, offsets } of samples)
      for (const [anchor, direction] of ANCHORS) {
        const [small, large] = offsets
        const due = (offsetMinutes: number) =>
          workflowTimerDueAt({ anchor, direction, offsetMinutes }, instants)
        const sign = direction === 'before' ? -1n : 1n
        expect(elapsed(instants[anchor], due(small))).toBe(sign * BigInt(small) * MINUTE_NS)
        expect(elapsed(due(small), due(large))).toBe(sign * BigInt(large - small) * MINUTE_NS)
        if (small < large)
          expect(Temporal.Instant.compare(due(small), due(large))).toBe(-Number(sign))
        if (small < WORKFLOW_MAX_OFFSET_MINUTES)
          expect(elapsed(due(small), due(small + 1))).toBe(sign * MINUTE_NS)
      }
  })

  it('gives the same results whatever the host time zone', () => {
    const results = () =>
      samples.map(({ booking: instants, offsets, capturedAt, nudge }) => {
        const timers = ANCHORS.map(([anchor, direction]) =>
          workflowTimerDueAt({ anchor, direction, offsetMinutes: offsets[0] }, instants).toString(),
        )
        const runs = [
          beforeStart(offsets[0]),
          afterEnd(offsets[1]),
          lifecycle('booking.created', offsets[0]),
        ].map((trigger) => {
          const timing = workflowRunTiming(trigger, instants, capturedAt)
          const now = timing.dueAt.add({ seconds: nudge - 3600 })
          return [
            timing.dueAt.toString(),
            timing.expiresAt.toString(),
            timing.skipReason,
            workflowDispatchWindow(timing, now),
          ]
        })
        return { timers, runs }
      })
    const baseline = sameInEveryHostZone(results)
    expect(baseline).toHaveLength(samples.length)
  })

  it('skips at capture only later in time: pending, then minimum_gap, then offset_not_future', () => {
    const order = [undefined, 'minimum_gap', 'offset_not_future']
    for (const { booking: instants, offsets } of samples) {
      const trigger = beforeStart(offsets[0])
      const dueAt = workflowRunTiming(trigger, instants, instants.start).dueAt
      const captures = [
        dueAt.subtract({ hours: 48 }),
        dueAt.subtract(REMINDER_MIN_GAP).subtract(nanosecond),
        dueAt.subtract(REMINDER_MIN_GAP),
        dueAt.subtract({ minutes: 30 }),
        dueAt.subtract(nanosecond),
        dueAt,
        instants.start,
      ]
      const reasons = captures.map(
        (capturedAt) => workflowRunTiming(trigger, instants, capturedAt).skipReason,
      )
      expect(reasons).toEqual([
        undefined,
        undefined,
        'minimum_gap',
        'minimum_gap',
        'minimum_gap',
        'offset_not_future',
        'offset_not_future',
      ])
      const ranks = reasons.map((reason) => order.indexOf(reason))
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    }
  })

  it('opens at the due instant and closes for good at the late bound', () => {
    const order = ['not_due', 'open', 'expired']
    for (const { booking: instants, offsets, capturedAt } of samples)
      for (const trigger of [beforeStart(offsets[0]), afterEnd(offsets[0])]) {
        const timing = workflowRunTiming(trigger, instants, capturedAt)
        const lateBound = timing.dueAt.add({ minutes: WORKFLOW_MAX_LATE_MINUTES })
        expect(Temporal.Instant.compare(timing.expiresAt, lateBound)).toBeLessThanOrEqual(0)
        if (trigger.type === 'before_start')
          expect(Temporal.Instant.compare(timing.expiresAt, instants.start)).toBeLessThanOrEqual(0)
        else expect(timing.expiresAt).toEqual(lateBound)
        const nows = [
          timing.dueAt.subtract({ hours: 24 }),
          timing.dueAt.subtract(nanosecond),
          timing.dueAt,
          timing.expiresAt.subtract(nanosecond),
          timing.expiresAt,
          lateBound,
          lateBound.add({ hours: 24 }),
        ]
        const windows = nows.map((now) => workflowDispatchWindow(timing, now))
        expect(windows).toEqual([
          'not_due',
          'not_due',
          'open',
          'open',
          'expired',
          'expired',
          'expired',
        ])
        const ranks = windows.map((value) => order.indexOf(value))
        expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
      }
  })
})

describe('workflow timer source', () => {
  const source = readFileSync(new URL('./timers.ts', import.meta.url), 'utf8')

  it('reads no clock, time zone or calendar', () => {
    expect(source).not.toMatch(
      /Temporal\.Now|\bDate\b|Zoned|Plain(?:Date|Time)|timeZone|TimezoneOffset|\bIntl\b|\bsetTimeout\b/,
    )
  })

  it('takes every number from the shared constants instead of copying one', () => {
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    // Zero (comparison results and the smallest lifecycle delay) is the only literal number.
    expect(new Set(code.match(/\b\d[\d_]*(?:\.\d+)?\b/g))).toEqual(new Set(['0']))
    expect(code).toContain("import { REMINDER_MIN_GAP } from '@hourmere/scheduling'")
  })
})
