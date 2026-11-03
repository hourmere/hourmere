import { describe, expect, it } from 'vitest'
import {
  calendarReferenceTypes,
  projectedCalendarReference,
  referenceBaselines,
  referenceFixture,
  videoReferences,
} from './caldiy-reference-fixtures.ts'
import { parseBookingLocation } from './locations.ts'
import { required } from './mutation-testing.ts'
import { parseImportPlan } from './plan.ts'
import type { PlanProblem, SourceRow } from './types.ts'

describe.each(referenceBaselines)('real persisted booking reference shapes: %s', (baseline) => {
  for (const calendar of calendarReferenceTypes) {
    it.each(videoReferences)(
      `keeps the $type participant link beside empty ${calendar}`,
      (video) => {
        const { snapshot, options } = referenceFixture(baseline, video, calendar)
        const plan = parseImportPlan(snapshot, options)
        expect(plan.bookings.map((booking) => booking.location)).toEqual([
          { kind: 'link', url: video.meetingUrl },
        ])
        expect(plan.summary.localBusyBookings).toBe(1)
        expect(plan.problems.filter((problem) => problem.source.table === 'Booking')).toEqual([])
      },
    )

    it.each([false, true])(
      `uses the missing-location decision for calendar-only ${calendar} (accepted=%s)`,
      (acceptMissing) => {
        const { snapshot, options } = referenceFixture(baseline)
        snapshot.tables.BookingReference = [projectedCalendarReference(calendar)]
        required(options.bookingDecisions[0]).acceptMissingLocation = acceptMissing
        const plan = parseImportPlan(snapshot, options)
        expect(plan.bookings).toHaveLength(acceptMissing ? 1 : 0)
        expect(plan.problems.filter((problem) => problem.source.table === 'Booking')).toEqual([
          expect.objectContaining({
            code: 'booking_location_missing',
            severity: acceptMissing ? 'warning' : 'import_blocker',
            source: { table: 'Booking', id: 30 },
          }),
        ])
      },
    )
  }
})

it.each<SourceRow>([
  { type: 'google_calendar', deleted: false, meetingUrl: null },
  { type: 'google_calendar', deleted: undefined, meetingUrl: null },
  { type: 'unknown_calendar', deleted: null, meetingUrl: null },
  { type: 'google_calendar', deleted: null, meetingUrl: undefined },
  { type: 'google_calendar', deleted: null, meetingUrl: null, unsafeMeetingUrl: true },
  { type: 'zoom_video', deleted: null, meetingUrl: null },
  { type: 'daily_video', deleted: null, meetingUrl: null },
  { type: 'office365_video', deleted: null, meetingUrl: null },
  { type: 'google_calendar', deleted: null, meetingUrl: 'https://meet.google.com/abc-defg-hij' },
])('preserves the blocker for reference state %j', (reference) => {
  const { snapshot } = referenceFixture()
  const problems: PlanProblem[] = []
  expect(
    parseBookingLocation(
      required(snapshot.tables.Booking?.[0]),
      [required(snapshot.tables.BookingReference?.[0]), { bookingId: 30, ...reference }],
      problems,
      true,
    ),
  ).toBeNull()
  expect(problems).toEqual([
    expect.objectContaining({ code: 'booking_location_reference', severity: 'import_blocker' }),
  ])
})

it('ignores a known deleted calendar reference while retaining the live video link', () => {
  const { snapshot } = referenceFixture()
  const references = required(snapshot.tables.BookingReference)
  required(references[1]).deleted = true
  const problems: PlanProblem[] = []
  expect(
    parseBookingLocation(required(snapshot.tables.Booking?.[0]), references, problems),
  ).toEqual({ kind: 'link', url: videoReferences[0].meetingUrl })
  expect(problems).toEqual([])
})

it('reports batch overlap rows without including them in busy records or the summary', () => {
  const { snapshot, options } = referenceFixture()
  const booking = required(snapshot.tables.Booking?.[0])
  const attendee = required(snapshot.tables.Attendee?.[0])
  for (const [id, start, end] of [
    [31, '2026-11-02T05:15:00.000Z', '2026-11-02T05:45:00.000Z'],
    [32, '2026-11-02T06:00:00.000Z', '2026-11-02T06:30:00.000Z'],
  ] as const) {
    required(snapshot.tables.Booking).push({
      ...booking,
      id,
      startTime: start,
      endTime: end,
      location: videoReferences[0].meetingUrl,
    })
    required(snapshot.tables.Attendee).push({ ...attendee, id: id + 10, bookingId: id })
    options.bookingDecisions.push({
      sourceBookingId: id,
      sourceUserId: 1,
      singleHostAndAttendeeRolesConfirmed: true,
    })
  }
  const plan = parseImportPlan(snapshot, options)
  expect(plan.bookings.map((row) => row.sourceId)).toEqual([32])
  expect(plan.summary.localBusyBookings).toBe(1)
  expect(plan.userBatches).toEqual([{ sourceUserId: 1, disposition: 'blocked' }])
  expect(plan.problems.filter((problem) => problem.code === 'booking_batch_overlap')).toEqual([
    expect.objectContaining({ severity: 'import_blocker', source: { table: 'Booking', id: 30 } }),
    expect.objectContaining({ severity: 'import_blocker', source: { table: 'Booking', id: 31 } }),
  ])
})

it('reports target overlap without including the blocked row in busy records or the summary', () => {
  const { snapshot, options } = referenceFixture()
  options.target.busy.push({
    targetUserId: required(options.target.users[0]).id,
    start: '2026-11-02T05:15:00.000Z',
    end: '2026-11-02T05:45:00.000Z',
  })
  const plan = parseImportPlan(snapshot, options)
  expect(plan.bookings).toEqual([])
  expect(plan.summary.localBusyBookings).toBe(0)
  expect(plan.userBatches).toEqual([{ sourceUserId: 1, disposition: 'blocked' }])
  expect(plan.problems).toContainEqual(
    expect.objectContaining({
      code: 'booking_target_overlap',
      severity: 'import_blocker',
      source: { table: 'Booking', id: 30 },
    }),
  )
  required(options.target.busy[0]).start = '2026-11-02T05:30:00.000Z'
  const adjacent = parseImportPlan(snapshot, options)
  expect(adjacent.bookings.map((row) => row.sourceId)).toEqual([30])
  expect(adjacent.summary.localBusyBookings).toBe(1)
})
