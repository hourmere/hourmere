import { describe, expect, it } from 'vitest'
import { parseBookings } from './bookings.ts'
import type { EventPlan } from './events.ts'
import { checkSourceMutation, required } from './mutation-testing.ts'
import { parseQuestions } from './questions.ts'
import type { MatchedUser, ParseOptions, PlanProblem, SourceRow, SourceSnapshot } from './types.ts'

const uid = '019a4321-1234-7000-8000-000000000001',
  org = '019a4321-1234-7000-8000-000000000002'
const user: MatchedUser = {
  sourceId: 1,
  targetUserId: uid,
  organizationId: org,
  sourceTimezone: 'America/Los_Angeles',
  profileAction: 'preserve',
  profile: { handle: 'alice', timeZone: 'UTC', locale: 'en' },
}
const event: EventPlan = {
  sourceId: 10,
  sourceUserId: 1,
  targetUserId: uid,
  organizationId: org,
  title: 'Session',
  slug: 'session',
  description: null,
  position: 0,
  durationMinutes: 30,
  allowedDurationsMinutes: [30],
  slotStepMinutes: null,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minimumNoticeMinutes: 120,
  bookingWindowDays: null,
  maxBookingsPerDay: null,
  isHidden: false,
  isActive: false,
  allowGuests: false,
  schedulingType: 'individual',
  scheduleSourceId: 20,
  proposedScheduleTimezone: null,
  location: null,
  questions: [],
  questionCrosswalk: [],
  notifications: { reminders: [], followUps: [] },
  successRedirect: null,
  sourceConstraints: {
    periodType: 'unlimited',
    periodDays: null,
    periodCountCalendarDays: null,
    periodStartDate: null,
    periodEndDate: null,
    bookingLimits: null,
    durationLimits: null,
    maxActiveBookingsPerBooker: null,
  },
}
const booking = (change: SourceRow = {}): SourceRow => ({
  id: 30,
  userId: 1,
  eventTypeId: 10,
  title: 'Old system session',
  startTime: '2026-11-02T08:30:00.123Z',
  endTime: '2026-11-02T09:17:00.456Z',
  status: 'accepted',
  paid: false,
  hasPayment: false,
  hasSeats: false,
  hasSuccessor: false,
  rescheduled: false,
  recurringEventId: null,
  dynamicEventSlugRef: null,
  dynamicGroupSlugRef: null,
  location: 'https://meet.example.com/join?pwd=private-passcode',
  responses: { email: 'invitee@example.com' },
  customInputs: null,
  ...change,
})
const attendee = (id = 40): SourceRow => ({
  id,
  bookingId: 30,
  name: `Guest ${id}`,
  email: id === 40 ? 'invitee@example.com' : `guest${id}@example.com`,
  timeZone: 'America/Los_Angeles',
  locale: 'en',
})
function parse(
  rows = [booking()],
  attendees = [attendee()],
  optionsChange: Partial<ParseOptions> = {},
  events = [event],
  parser = parseBookings,
) {
  const snapshot: SourceSnapshot = {
    sourceVersion: 'cal.diy-a5ee96f77edd',
    schemaFingerprint: 'a'.repeat(64),
    cutoff: '2026-11-01T00:00:00.000Z',
    extractedAt: '2026-11-01T00:00:00.000Z',
    selectedUserIds: [1],
    tables: { Booking: rows, Attendee: attendees },
  }
  const options: ParseOptions = {
    target: { users: [], occupiedHandles: [], occupiedSlugs: [], busy: [] },
    bookingDecisions: rows.map((r) => ({
      sourceBookingId: r.id as number,
      sourceUserId: 1,
      singleHostAndAttendeeRolesConfirmed: true,
    })),
    ...optionsChange,
  }
  const problems: PlanProblem[] = []
  const bookings = parser(snapshot, new Map([[1, user]]), events, options, problems)
  return { bookings, problems, codes: problems.map((p) => p.code) }
}
describe('future local-only booking parsing', () => {
  it('preserves UTC milliseconds and actual duration, with inert local-only policy', () => {
    const { bookings, problems } = parse()
    expect(bookings).toHaveLength(1)
    expect(bookings[0]).toMatchObject({
      start: '2026-11-02T08:30:00.123Z',
      end: '2026-11-02T09:17:00.456Z',
      status: 'confirmed',
      policy: 'local_only_read_only',
      managedIn: 'source_system',
      manageTokenHash: null,
      rescheduledFromId: null,
      hostsUseDefaultSchedule: false,
      externalActions: [],
      notificationSnapshot: {
        version: 1,
        executionMode: 'configurable',
        notifications: { reminders: [], followUps: [] },
      },
    })
    expect(bookings[0]?.location).toEqual({
      kind: 'link',
      url: 'https://meet.example.com/join?pwd=private-passcode',
    })
    expect(problems).toEqual([])
  })
  it('excludes cutoff equality and preserves the first future millisecond across the year', () => {
    expect(parse([booking({ startTime: '2026-11-01T00:00:00.000Z' })]).codes).toContain(
      'booking_not_future',
    )
    expect(parse([booking({ startTime: '2026-11-01T00:00:00.001Z' })]).bookings).toHaveLength(1)
    expect(
      parse([
        booking({ startTime: '2027-01-01T00:00:00.000Z', endTime: '2027-01-01T00:01:00.000Z' }),
      ]).bookings,
    ).toHaveLength(1)
  })
  it.each(['cancelled', 'rejected', 'pending', 'awaiting_host', 'ACCEPTED', 'unknown'])(
    'never confirms status %s',
    (status) => {
      const parsed = parse([booking({ status })])
      expect(parsed.bookings).toHaveLength(0)
      expect(parsed.problems.length).toBeGreaterThan(0)
    },
  )
  it.each([
    { paid: true },
    { hasPayment: true },
    { hasSeats: true },
    { dynamicEventSlugRef: 'dynamic' },
    { dynamicGroupSlugRef: 'group' },
    { rescheduled: true },
    { recurringEventId: 'series' },
    { eventTypeId: null },
    { userId: 2 },
    { endTime: '2026-11-02T08:30:00.123Z' },
    { startTime: '2026-11-02 08:30:00.123' },
  ])('blocks unsafe association or boundary %j', (change) => {
    const parsed = parse([booking(change)])
    expect(parsed.bookings).toHaveLength(0)
    expect(parsed.problems.some((p) => p.severity === 'import_blocker')).toBe(true)
  })
  it('excludes superseded rows and requires owner confirmation of historical roles', () => {
    expect(parse([booking({ hasSuccessor: true })]).codes).toContain('booking_lineage_unresolved')
    expect(parse(undefined, undefined, { bookingDecisions: [] }).codes).toContain(
      'booking_history_confirmation_required',
    )
    expect(
      parse(undefined, undefined, {
        bookingDecisions: [
          { sourceBookingId: 30, sourceUserId: 2, singleHostAndAttendeeRolesConfirmed: true },
        ],
      }).bookings,
    ).toHaveLength(0)
  })
  it('permits exactly one booker plus ten guests and blocks an eleventh guest', () => {
    expect(
      parse(
        [booking()],
        Array.from({ length: 11 }, (_, i) => attendee(40 + i)),
      ).bookings[0]?.attendees,
    ).toHaveLength(11)
    expect(
      parse(
        [booking()],
        Array.from({ length: 12 }, (_, i) => attendee(40 + i)),
      ).codes,
    ).toContain('booking_attendee_count')
  })
  it('refuses duplicate email, absent booker, invalid attendee and arbitrary first-row selection', () => {
    expect(
      parse(undefined, [attendee(), { ...attendee(41), email: ' INVITEE@example.com ' }]).codes,
    ).toContain('attendee_email_duplicate')
    expect(parse([booking({ responses: {} })]).codes).toContain('booking_booker_unresolved')
    expect(
      parse(undefined, [{ ...attendee(), timeZone: 'Not/AZone', name: 'bad\nname' }]).codes,
    ).toContain('attendee_invalid')
    expect(
      parse([booking({ responses: null })], undefined, {
        bookingDecisions: [
          {
            sourceBookingId: 30,
            sourceUserId: 1,
            singleHostAndAttendeeRolesConfirmed: true,
            bookerAttendeeId: 40,
          },
        ],
      }).bookings,
    ).toHaveLength(1)
  })
  it('reports both sides of batch overlap and existing target overlap while allowing adjacency', () => {
    const second = booking({
      id: 31,
      startTime: '2026-11-02T09:00:00.000Z',
      endTime: '2026-11-02T10:00:00.000Z',
    })
    const batch = parse(
      [booking(), second],
      [attendee(), { ...attendee(42), bookingId: 31, email: 'invitee@example.com' }],
    )
    expect(
      batch.problems.filter((p) => p.code === 'booking_batch_overlap').map((p) => p.source.id),
    ).toEqual([30, 31])
    const blocked = parse(
      [booking(), { ...second, responses: { email: 'invitee@example.com', removed: 'bad' } }],
      [attendee(), { ...attendee(42), bookingId: 31, email: 'invitee@example.com' }],
    )
    expect(blocked.bookings).toHaveLength(1)
    expect(
      blocked.problems.filter((p) => p.code === 'booking_batch_overlap').map((p) => p.source.id),
    ).toEqual([30, 31])
    const existing = {
      users: [],
      occupiedHandles: [],
      occupiedSlugs: [],
      busy: [
        { targetUserId: uid, start: '2026-11-02T09:00:00.000Z', end: '2026-11-02T10:00:00.000Z' },
      ],
    }
    expect(parse(undefined, undefined, { target: existing }).codes).toContain(
      'booking_target_overlap',
    )
    required(existing.busy[0]).start = '2026-11-02T09:17:00.456Z'
    expect(parse(undefined, undefined, { target: existing }).codes).not.toContain(
      'booking_target_overlap',
    )
  })
  it('maps modern option values and preserves historical missing required questions', () => {
    const mapped = parseQuestions(
      {
        id: 10,
        bookingFields: [
          {
            name: 'choice',
            label: 'Choice',
            type: 'select',
            required: true,
            options: [{ value: 'internal', label: 'Shown' }],
          },
          { name: 'later', label: 'Added later', type: 'text', required: true },
        ],
      },
      [],
      [],
    )
    const parsed = parse(
      [
        booking({
          responses: { email: 'invitee@example.com', choice: 'internal', notes: 'Private notes' },
        }),
      ],
      undefined,
      {},
      [{ ...event, questions: mapped.questions, questionCrosswalk: mapped.crosswalk }],
    )
    expect(parsed.bookings).toHaveLength(1)
    expect(Object.values(parsed.bookings[0]?.responses ?? {})).toEqual(['Shown', 'Private notes'])
    expect(parsed.bookings[0]?.questions.find((q) => q.label === 'Notes')?.type).toBe('long_text')
  })
  it('maps legacy labels uniquely, uses description notes only for null modern responses, and blocks unmapped answers', () => {
    const mapped = parseQuestions(
      { id: 10, bookingFields: [] },
      [
        {
          id: 11,
          eventTypeId: 10,
          label: ' Choice ',
          type: 'radio',
          options: [{ label: ' One ', type: 'text' }],
          required: true,
        },
      ],
      [],
    )
    const decisions: ParseOptions['bookingDecisions'] = [
      {
        sourceBookingId: 30,
        sourceUserId: 1,
        singleHostAndAttendeeRolesConfirmed: true,
        bookerAttendeeId: 40,
      },
    ]
    const parsed = parse(
      [
        booking({
          responses: null,
          customInputs: { ' Choice ': ' One ' },
          description: 'Legacy notes',
        }),
      ],
      undefined,
      { bookingDecisions: decisions },
      [{ ...event, questions: mapped.questions, questionCrosswalk: mapped.crosswalk }],
    )
    expect(parsed.bookings).toHaveLength(1)
    expect(Object.values(parsed.bookings[0]?.responses ?? {})).toEqual(['One', 'Legacy notes'])
    expect(
      parse([booking({ responses: { email: 'invitee@example.com', removed: 'sensitive-answer' } })])
        .codes,
    ).toContain('booking_answer_unmapped')
    expect(
      parse([
        booking({ responses: { email: 'invitee@example.com' }, description: 'Do not duplicate' }),
      ]).bookings[0]?.questions,
    ).toEqual([])
  })
  it('never leaks attendee emails, answers, location passcodes or rejected titles into problems', () => {
    const parsed = parse(
      [
        booking({
          title: 'private-secret\n',
          responses: { email: 'invitee@example.com', removed: 'private-secret' },
        }),
      ],
      [{ ...attendee(), name: 'private-secret\n' }],
    )
    expect(parsed.problems.length).toBeGreaterThan(0)
    expect(JSON.stringify(parsed.problems)).not.toMatch(
      /private-secret|invitee@example|private-passcode/,
    )
  })
})

it('kills source-copy booking boundary, policy, role and overlap mutations', async () => {
  const source = new URL('./bookings.ts', import.meta.url)
  const select = (module: Record<string, unknown>) => module.parseBookings as typeof parseBookings
  await checkSourceMutation(
    source,
    'Temporal.Instant.compare(start,cutoff)<=0',
    'Temporal.Instant.compare(start,cutoff)<0',
    select,
    (run) =>
      expect(
        parse([booking({ startTime: '2026-11-01T00:00:00.000Z' })], undefined, {}, undefined, run)
          .bookings,
      ).toEqual([]),
  )
  await checkSourceMutation(source, "status !== 'accepted'", 'false', select, (run) =>
    expect(parse([booking({ status: 'pending' })], undefined, {}, undefined, run).bookings).toEqual(
      [],
    ),
  )
  await checkSourceMutation(
    source,
    'attendees.length > 11',
    'attendees.length > 12',
    select,
    (run) =>
      expect(
        parse(
          undefined,
          Array.from({ length: 12 }, (_, i) => attendee(40 + i)),
          {},
          undefined,
          run,
        ).bookings,
      ).toEqual([]),
  )
  await checkSourceMutation(
    source,
    'decision.singleHostAndAttendeeRolesConfirmed !== true',
    'false',
    select,
    (run) => {
      const decision = {
        sourceBookingId: 30,
        sourceUserId: 1,
        singleHostAndAttendeeRolesConfirmed: false,
      } as never
      expect(
        parse(undefined, undefined, { bookingDecisions: [decision] }, undefined, run).bookings,
      ).toEqual([])
    },
  )
  await checkSourceMutation(source, 'row.paid === true', 'false', select, (run) =>
    expect(parse([booking({ paid: true })], undefined, {}, undefined, run).bookings).toEqual([]),
  )
  await checkSourceMutation(source, 'seenEmails.has(normalized)', 'false', select, (run) =>
    expect(
      parse(
        undefined,
        [attendee(), { ...attendee(41), email: 'invitee@example.com' }],
        {},
        undefined,
        run,
      ).codes,
    ).toContain('attendee_email_duplicate'),
  )
  await checkSourceMutation(
    source,
    "policy:'local_only_read_only',",
    "policy:'writable',",
    select,
    (run) =>
      expect(parse(undefined, undefined, {}, undefined, run).bookings[0]?.policy).toBe(
        'local_only_read_only',
      ),
  )
  await checkSourceMutation(
    source,
    'Temporal.Instant.compare(start,booking.end)<0',
    'false',
    select,
    (run) => {
      const target = {
        users: [],
        occupiedHandles: [],
        occupiedSlugs: [],
        busy: [
          { targetUserId: uid, start: '2026-11-02T09:00:00.000Z', end: '2026-11-02T10:00:00.000Z' },
        ],
      }
      expect(parse(undefined, undefined, { target }, undefined, run).codes).toContain(
        'booking_target_overlap',
      )
    },
  )
  await checkSourceMutation(source, 'matches.length !== 1', 'false', select, (run) => {
    // Use a duplicate crosswalk: the mutated parser chooses one, attaching an ambiguous answer.
    const mapped = parseQuestions(
      { id: 10, bookingFields: [{ name: 'x', label: 'X', type: 'text' }] },
      [],
      [],
    )
    const e = {
      ...event,
      questions: mapped.questions,
      questionCrosswalk: [...mapped.crosswalk, ...mapped.crosswalk],
    }
    expect(
      parse(
        [booking({ responses: { email: 'invitee@example.com', x: 'value' } })],
        undefined,
        {},
        [e],
        run,
      ).bookings,
    ).toEqual([])
  })
})

it('requires a same-owner accepted future leaf rather than any reschedule successor', () => {
  const predecessor = booking({ hasSuccessor: true, rescheduled: true, successorIds: [31] })
  const leaf = booking({
    id: 31,
    startTime: '2026-11-03T00:00:00.000Z',
    endTime: '2026-11-03T01:00:00.000Z',
    hasSuccessor: false,
    successorIds: [],
  })
  const people = [attendee(), { ...attendee(41), bookingId: 31, email: 'invitee@example.com' }]
  expect(parse([predecessor, leaf], people).codes).toContain('booking_nonleaf_excluded')
  expect(parse([predecessor, { ...leaf, status: 'rejected' }], people).codes).toContain(
    'booking_lineage_unresolved',
  )
  expect(parse([predecessor, { ...leaf, userId: 2 }], people).codes).toContain(
    'booking_lineage_unresolved',
  )
  expect(
    parse(
      [predecessor, { ...leaf, hasSuccessor: true, rescheduled: true, successorIds: [30] }],
      people,
    ).codes,
  ).toContain('booking_lineage_unresolved')
})

it('reuses an explicit modern notes field at the twenty-question boundary', () => {
  const fields = [
    { name: 'notes', label: 'Additional notes', type: 'textarea' },
    ...Array.from({ length: 19 }, (_, i) => ({
      name: `field${i}`,
      label: `Field ${i}`,
      type: 'text',
    })),
  ]
  const mapped = parseQuestions({ id: 10, bookingFields: fields }, [], [])
  const e = { ...event, questions: mapped.questions, questionCrosswalk: mapped.crosswalk }
  const parsed = parse(
    [booking({ responses: { email: 'invitee@example.com', notes: 'Existing note' } })],
    undefined,
    {},
    [e],
  )
  expect(parsed.bookings).toHaveLength(1)
  expect(parsed.bookings[0]?.questions).toHaveLength(20)
  expect(Object.values(parsed.bookings[0]?.responses ?? {})).toEqual(['Existing note'])
  expect(parsed.bookings[0]?.questions.filter((q) => q.label === 'Notes')).toEqual([])
})

it('kills lineage-proof, blocked-overlap and mapped-notes source-copy mutations', async () => {
  const source = new URL('./bookings.ts', import.meta.url)
  const select = (m: Record<string, unknown>) => m.parseBookings as typeof parseBookings
  const predecessor = booking({ hasSuccessor: true, rescheduled: true, successorIds: [31] })
  const rejected = booking({
    id: 31,
    status: 'rejected',
    startTime: '2026-11-03T00:00:00.000Z',
    endTime: '2026-11-03T01:00:00.000Z',
    successorIds: [],
  })
  await checkSourceMutation(source, "next.status === 'accepted'", 'true', select, (run) =>
    expect(parse([predecessor, rejected], undefined, {}, undefined, run).codes).toContain(
      'booking_lineage_unresolved',
    ),
  )
  const foreign = booking({ ...rejected, userId: 2, status: 'accepted' })
  await checkSourceMutation(source, 'next.userId !== row.userId', 'false', select, (run) =>
    expect(parse([predecessor, foreign], undefined, {}, undefined, run).codes).toContain(
      'booking_lineage_unresolved',
    ),
  )
  const invalid = booking({
    id: 31,
    responses: { email: 'invitee@example.com', removed: 'invalid' },
  })
  const people = [attendee(), { ...attendee(41), bookingId: 31, email: 'invitee@example.com' }]
  await checkSourceMutation(
    source,
    'if (user) overlapCandidates.push',
    'if (false) overlapCandidates.push',
    select,
    (run) =>
      expect(parse([booking(), invalid], people, {}, undefined, run).codes).toContain(
        'booking_batch_overlap',
      ),
  )
  const fields = [
    { name: 'notes', label: 'Additional notes', type: 'textarea' },
    ...Array.from({ length: 19 }, (_, i) => ({
      name: `field${i}`,
      label: `Field ${i}`,
      type: 'text',
    })),
  ]
  const mapped = parseQuestions({ id: 10, bookingFields: fields }, [], [])
  const e = { ...event, questions: mapped.questions, questionCrosswalk: mapped.crosswalk }
  await checkSourceMutation(source, 'if (mappedNotes)', 'if (false)', select, (run) =>
    expect(
      parse(
        [booking({ responses: { email: 'invitee@example.com', notes: 'Existing note' } })],
        undefined,
        {},
        [e],
        run,
      ).bookings,
    ).toHaveLength(1),
  )
})
