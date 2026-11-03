import { expect, it } from 'vitest'
import { parseBookings } from './bookings.ts'
import { referenceFixture, videoReferences } from './caldiy-reference-fixtures.ts'
import { parseBookingLocation } from './locations.ts'
import { checkSourceMutation, required } from './mutation-testing.ts'
import { parseImportPlan } from './plan.ts'
import type { PlanProblem } from './types.ts'

function locationMutation(
  name: string,
  before: string,
  after: string,
  assertion: (parse: typeof parseBookingLocation) => void,
) {
  it(`source-copy mutation: ${name}`, async () => {
    assertion(parseBookingLocation)
    await checkSourceMutation(
      new URL('./locations.ts', import.meta.url),
      before,
      after,
      (module) => module.parseBookingLocation as typeof parseBookingLocation,
      assertion,
    )
  })
}
locationMutation(
  'empty calendar references do not block the video participant link',
  "['google_calendar', 'office365_calendar'].includes(ref.type) && ref.meetingUrl === null",
  'false',
  (parse) => {
    const { snapshot } = referenceFixture()
    const problems: PlanProblem[] = []
    expect(
      parse(
        required(snapshot.tables.Booking?.[0]),
        required(snapshot.tables.BookingReference),
        problems,
      ),
    ).toEqual({ kind: 'link', url: videoReferences[0].meetingUrl })
    expect(problems).toEqual([])
  },
)
locationMutation(
  'only calendar references may omit their participant URL',
  "['google_calendar', 'office365_calendar'].includes(ref.type) && ref.meetingUrl === null",
  'ref.meetingUrl === null',
  (parse) => {
    const { snapshot } = referenceFixture()
    const problems: PlanProblem[] = []
    parse(
      required(snapshot.tables.Booking?.[0]),
      [
        ...required(snapshot.tables.BookingReference),
        { bookingId: 30, type: 'zoom_video', deleted: null, meetingUrl: null },
      ],
      problems,
    )
    expect(problems).toContainEqual(
      expect.objectContaining({ code: 'booking_location_reference', severity: 'import_blocker' }),
    )
  },
)
locationMutation(
  'suppressed unsafe calendar URLs are not treated as empty references',
  'if (ref.unsafeMeetingUrl === true)',
  'if (false)',
  (parse) => {
    const { snapshot } = referenceFixture()
    required(snapshot.tables.BookingReference?.[1]).unsafeMeetingUrl = true
    const problems: PlanProblem[] = []
    expect(
      parse(
        required(snapshot.tables.Booking?.[0]),
        required(snapshot.tables.BookingReference),
        problems,
        true,
      ),
    ).toBeNull()
    expect(problems).toContainEqual(
      expect.objectContaining({ code: 'booking_location_reference', severity: 'import_blocker' }),
    )
  },
)

for (const kind of ['batch', 'target'] as const) {
  it(`source-copy mutation: ${kind} overlap rows are excluded from local busy bookings`, async () => {
    const { snapshot, options } = referenceFixture()
    if (kind === 'target') {
      options.target.busy.push({
        targetUserId: required(options.target.users[0]).id,
        start: '2026-11-02T05:15:00.000Z',
        end: '2026-11-02T05:45:00.000Z',
      })
    } else {
      required(snapshot.tables.Booking).push({
        ...required(snapshot.tables.Booking?.[0]),
        id: 31,
        location: videoReferences[0].meetingUrl,
      })
      required(snapshot.tables.Attendee).push({
        ...required(snapshot.tables.Attendee?.[0]),
        id: 41,
        bookingId: 31,
      })
      options.bookingDecisions.push({
        sourceBookingId: 31,
        sourceUserId: 1,
        singleHostAndAttendeeRolesConfirmed: true,
      })
    }
    const plan = parseImportPlan(snapshot, options)
    const assertion = (parse: typeof parseBookings) => {
      const problems: PlanProblem[] = []
      expect(
        parse(
          snapshot,
          new Map(plan.users.map((user) => [user.sourceId, user])),
          plan.events,
          options,
          problems,
        ),
      ).toEqual([])
      expect(problems.some((problem) => problem.code === `booking_${kind}_overlap`)).toBe(true)
    }
    assertion(parseBookings)
    await checkSourceMutation(
      new URL('./bookings.ts', import.meta.url),
      'return result.filter((booking) => !overlapBlocked.has(booking.sourceId))',
      'return result',
      (module) => module.parseBookings as typeof parseBookings,
      assertion,
    )
  })
}
