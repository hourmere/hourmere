import { describe, expect, it } from 'vitest'
import { parseBookings } from './bookings.ts'
import { caldiyDefaultBookingFields } from './caldiy-booking-fields-fixtures.ts'
import { baseEvent, parseEvent, snapshot, users } from './mapping-fixtures.ts'
import { checkSourceMutation, required } from './mutation-testing.ts'
import { parseQuestions } from './questions.ts'
import type { PlanProblem, SourceRow } from './types.ts'

const defaultField = (name: string): SourceRow =>
  structuredClone(required(caldiyDefaultBookingFields.find((f) => f.name === name)))

function questions(fields = structuredClone(caldiyDefaultBookingFields), parse = parseQuestions) {
  const problems: PlanProblem[] = []
  const result = parse({ id: 20, bookingFields: fields }, [], problems)
  return { ...result, problems }
}

function bookingWithDefaults(
  responses: Record<string, unknown>,
  parse = parseBookings,
  fields = structuredClone(caldiyDefaultBookingFields),
) {
  const event = required(parseEvent({ bookingFields: fields }).events[0])
  // Same persisted shape as scripts/seed.ts's 30min accepted booking and
  // seed-utils.ts's single-attendee create, with fixed instants and safe IDs.
  // responses uses the real bookingResponses object keys from zod-utils.ts.
  const source = snapshot({
    EventType: [{ ...baseEvent, bookingFields: fields }],
    Booking: [
      {
        id: 30,
        userId: 1,
        eventTypeId: 20,
        title: '30min',
        startTime: '2026-11-01T00:00:00.000Z',
        endTime: '2026-11-01T00:30:00.000Z',
        status: 'accepted',
        location: null,
        responses: { email: 'pro@example.com', name: 'Pro Example', ...responses },
      },
    ],
    Attendee: [
      {
        id: 40,
        bookingId: 30,
        email: 'pro@example.com',
        name: 'Pro Example',
        timeZone: 'Europe/London',
      },
    ],
  })
  const problems: PlanProblem[] = []
  const bookings = parse(
    source,
    users,
    [event],
    {
      target: { users: [], occupiedHandles: [], occupiedSlugs: [], busy: [] },
      bookingDecisions: [
        {
          sourceBookingId: 30,
          sourceUserId: 1,
          singleHostAndAttendeeRolesConfirmed: true,
          acceptMissingLocation: true,
        },
      ],
    },
    problems,
  )
  return { bookings, problems }
}

describe('real persisted Cal.diy booking fields', () => {
  it('keeps the default system shape as an inactive event draft without translated-label blockers', () => {
    const result = questions()
    expect(result.questions).toEqual([])
    expect(result.crosswalk).toEqual([])
    expect(result.problems.some((p) => p.code === 'question_label')).toBe(false)
    expect(result.problems.some((p) => p.severity === 'import_blocker')).toBe(false)
    expect(result.problems.filter((p) => p.code === 'question_system_excluded')).toHaveLength(3)
    expect(result.problems.some((p) => p.code === 'question_notes')).toBe(true)
    const parsed = parseEvent({ bookingFields: structuredClone(caldiyDefaultBookingFields) })
    expect(parsed.events).toHaveLength(1)
    expect(parsed.events[0]?.isActive).toBe(false)
    expect(parsed.problems.some((p) => p.severity === 'activation_blocker')).toBe(true)
  })

  it.each(['rescheduleReason', 'email', 'notes'])(
    'reports conditional views on the system field %s before skipping it',
    (name) => {
      const field = defaultField(name)
      field.views = [{ id: 'reschedule', label: 'Reschedule View' }]
      field.label = 'Edited label'
      const result = questions([field])
      expect(result.questions).toEqual([])
      expect(result.problems).toContainEqual(
        expect.objectContaining({ code: 'question_unsupported', severity: 'activation_blocker' }),
      )
      expect(result.problems.some((p) => p.code === 'question_label')).toBe(false)
    },
  )

  it('does not turn a reschedule-only custom field into an always-visible question', () => {
    const result = questions([
      {
        ...defaultField('rescheduleReason'),
        name: 'customReason',
        editable: 'user',
        label: 'Why reschedule?',
      },
    ])
    expect(result.questions).toEqual([])
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: 'question_unsupported', severity: 'activation_blocker' }),
    )
  })

  it('keeps translation-only custom labels blocked rather than guessing a translation', () => {
    const result = questions([{ ...defaultField('notes'), name: 'customNotes', editable: 'user' }])
    expect(result.questions).toEqual([])
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: 'question_label', severity: 'import_blocker' }),
    )
  })

  it.each([false, true])(
    'synthesizes Notes for a saved system field with custom label %s',
    (custom) => {
      const fields = structuredClone(caldiyDefaultBookingFields)
      if (custom) required(fields.find((f) => f.name === 'notes')).label = 'Host custom label'
      const result = bookingWithDefaults({ notes: 'Preserve this note' }, parseBookings, fields)
      expect(result.bookings).toHaveLength(1)
      expect(result.bookings[0]?.questions).toEqual([
        expect.objectContaining({ label: 'Notes', type: 'long_text', required: false }),
      ])
      expect(Object.values(result.bookings[0]?.responses ?? {})).toEqual(['Preserve this note'])
    },
  )

  it.each(['title', 'rescheduleReason', 'attendeePhoneNumber'])(
    'reports the known system answer %s as excluded without blocking the booking',
    (name) => {
      const result = bookingWithDefaults({ [name]: 'private-answer-marker' })
      expect(result.bookings).toHaveLength(1)
      expect(result.problems).toContainEqual({
        code: 'booking_system_answer_excluded',
        severity: 'excluded',
        source: { table: 'Booking', id: 30 },
        message: 'An optional source system answer has no equivalent and is excluded.',
      })
      expect(JSON.stringify(result.problems)).not.toContain('private-answer-marker')
      expect(result.bookings[0]?.responses).toEqual({})
    },
  )

  it('keeps an unknown answer blocked with real system fields alongside it', () => {
    const result = bookingWithDefaults({ deletedCustomField: 'private-answer-marker' })
    expect(result.bookings).toEqual([])
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: 'booking_answer_unmapped', severity: 'import_blocker' }),
    )
    expect(JSON.stringify(result.problems)).not.toContain('private-answer-marker')
  })
})

describe('real booking-field source-copy mutations', () => {
  it.each(['rescheduleReason', 'customReason'])(
    'kills dropped conditional view handling for %s',
    async (name) => {
      await checkSourceMutation(
        new URL('./questions.ts', import.meta.url),
        "'conditional', 'views',",
        "'conditional',",
        (module) => module.parseQuestions as typeof parseQuestions,
        (parse) => {
          const field = { ...defaultField('rescheduleReason'), name, label: 'Reschedule reason' }
          expect(questions([field], parse).problems).toContainEqual(
            expect.objectContaining({
              code: 'question_unsupported',
              severity: 'activation_blocker',
            }),
          )
        },
      )
    },
  )

  it.each(['title', 'rescheduleReason', 'attendeePhoneNumber'])(
    'kills dropped system field recognition for %s',
    async (name) => {
      await checkSourceMutation(
        new URL('./questions.ts', import.meta.url),
        `'${name}',`,
        '',
        (module) => module.parseQuestions as typeof parseQuestions,
        (parse) =>
          expect(questions([defaultField(name)], parse).problems).toContainEqual(
            expect.objectContaining({ code: 'question_system_excluded', severity: 'warning' }),
          ),
      )
    },
  )

  it('kills dropped source-system Notes routing', async () => {
    await checkSourceMutation(
      new URL('./questions.ts', import.meta.url),
      "key === 'notes' &&",
      'false &&',
      (module) => module.parseQuestions as typeof parseQuestions,
      (parse) =>
        expect(questions([defaultField('notes')], parse).problems).toContainEqual(
          expect.objectContaining({ code: 'question_notes', severity: 'warning' }),
        ),
    )
  })

  it.each(['title', 'rescheduleReason', 'attendeePhoneNumber'])(
    'kills dropped system-answer recognition for %s',
    async (name) => {
      await checkSourceMutation(
        new URL('./bookings.ts', import.meta.url),
        'modern && excludedSystemAnswers.has(key)',
        'false',
        (module) => module.parseBookings as typeof parseBookings,
        (parse) =>
          expect(
            bookingWithDefaults({ [name]: 'private-answer-marker' }, parse).bookings,
          ).toHaveLength(1),
      )
    },
  )

  it('kills unreported system-answer loss', async () => {
    await checkSourceMutation(
      new URL('./bookings.ts', import.meta.url),
      "code: 'booking_system_answer_excluded',",
      "code: 'wrong_code',",
      (module) => module.parseBookings as typeof parseBookings,
      (parse) =>
        expect(
          bookingWithDefaults({ rescheduleReason: 'private-answer-marker' }, parse).problems,
        ).toContainEqual(
          expect.objectContaining({ code: 'booking_system_answer_excluded', severity: 'excluded' }),
        ),
    )
  })
})
