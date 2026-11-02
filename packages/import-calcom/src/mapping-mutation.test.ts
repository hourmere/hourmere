import { expect, it } from 'vitest'
import type { parseEvents } from './events.ts'
import type * as Locations from './locations.ts'
import { baseEvent, snapshot, users } from './mapping-fixtures.ts'
import { checkSourceMutation } from './mutation-testing.ts'
import type { parseQuestions } from './questions.ts'
import { parseSchedules } from './schedules.ts'
import type { PlanProblem, SourceRow, SourceSnapshot } from './types.ts'

const has = (problems: PlanProblem[], code: string) => problems.some((p) => p.code === code)
function eventsMutation(
  name: string,
  before: string,
  after: string,
  change: SourceRow,
  tables: SourceSnapshot['tables'],
  assertion: (result: { events: ReturnType<typeof parseEvents>; problems: PlanProblem[] }) => void,
) {
  it(`source-copy mutation: ${name}`, async () => {
    await checkSourceMutation(
      new URL('./events.ts', import.meta.url),
      before,
      after,
      (module) => module.parseEvents as typeof parseEvents,
      (parse) => {
        const source = snapshot({ EventType: [{ ...baseEvent, ...change }], ...tables })
        const problems: PlanProblem[] = []
        const schedules = parseSchedules(source, users, problems)
        assertion({ events: parse(source, users, schedules, problems), problems })
      },
    )
  })
}
const noEvent = (result: { events: ReturnType<typeof parseEvents> }) =>
  expect(result.events).toEqual([])
eventsMutation('personal scope', 'event.teamId != null ||', 'false ||', { teamId: 7 }, {}, noEvent)
eventsMutation(
  'actual host relationships',
  'actualUsers.size !== 1 ||',
  'false ||',
  {},
  {
    Host: [
      { eventTypeId: 20, userId: 1 },
      { eventTypeId: 20, userId: 2 },
    ],
  },
  noEvent,
)
eventsMutation(
  'paid event refusal',
  'event.price != null && event.price !== 0',
  'false',
  { price: 100 },
  {},
  noEvent,
)
eventsMutation('inactive drafts', 'isActive: false,', 'isActive: true,', {}, {}, ({ events }) =>
  expect(events[0]?.isActive).toBe(false),
)
eventsMutation(
  'duration order',
  'allowedDurationsMinutes: allowed as number[],',
  'allowedDurationsMinutes: (allowed as number[]).toSorted((a,b) => a-b),',
  { multipleDuration: [60, 30, 15] },
  {},
  ({ events }) => expect(events[0]?.allowedDurationsMinutes).toEqual([60, 30, 15]),
)
eventsMutation(
  'duration bounds',
  'validateEventTypeRules({',
  '(() => {})({',
  { length: 0 },
  {},
  noEvent,
)
eventsMutation(
  'schedule precedence',
  'event.scheduleId ?? hostScheduleIds[0] ?? sourceUser?.defaultScheduleId',
  'sourceUser?.defaultScheduleId ?? hostScheduleIds[0] ?? event.scheduleId',
  { scheduleId: 11 },
  {
    Schedule: [
      { id: 10, userId: 1, name: 'Default', timeZone: 'UTC' },
      { id: 11, userId: 1, name: 'Event hours', timeZone: 'UTC' },
    ],
  },
  ({ events }) => expect(events[0]?.scheduleSourceId).toBe(11),
)

eventsMutation('title validation', '!title ||', 'false ||', { title: 'x'.repeat(201) }, {}, noEvent)
eventsMutation('slug validation', '!slug ||', 'false ||', { slug: 'Invalid-Slug' }, {}, noEvent)
eventsMutation(
  'known limit keys only',
  "!['PER_DAY', 'PER_WEEK', 'PER_MONTH', 'PER_YEAR'].includes(key)",
  'false',
  { bookingLimits: { unknown: 7 } },
  {},
  noEvent,
)

function questionsMutation(
  name: string,
  before: string,
  after: string,
  fields: SourceRow[],
  legacy: SourceRow[],
  assertion: (result: ReturnType<typeof parseQuestions>, problems: PlanProblem[]) => void,
) {
  it(`source-copy mutation: ${name}`, async () => {
    await checkSourceMutation(
      new URL('./questions.ts', import.meta.url),
      before,
      after,
      (module) => module.parseQuestions as typeof parseQuestions,
      (parse) => {
        const problems: PlanProblem[] = []
        assertion(parse({ id: 20, bookingFields: fields }, legacy, problems), problems)
      },
    )
  })
}
questionsMutation(
  'modern question priority',
  'const modern = Array.isArray(event.bookingFields) && event.bookingFields.length > 0',
  'const modern = false',
  [{ name: 'modern', label: 'Modern', type: 'text' }],
  [{ id: 8, label: 'Legacy', type: 'text' }],
  ({ questions }) => expect(questions[0]?.label).toBe('Modern'),
)
it('source-copy mutation: stable question identity includes its source event', async () => {
  await checkSourceMutation(
    new URL('./questions.ts', import.meta.url),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This is literal source text for mutation.
    'update(`${eventId}:${sourceKey}`)',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This is literal source text for mutation.
    'update(`${sourceKey}`)',
    (module) => module.stableQuestionId as (eventId: number, key: string) => string,
    (stable) => expect(stable(20, 'q')).not.toBe(stable(21, 'q')),
  )
})
questionsMutation(
  'choice option value crosswalk',
  'optionValues[value] = optionLabel',
  'optionValues[optionLabel] = optionLabel',
  [{ name: 'choice', label: 'Choice', type: 'select', options: [{ value: 'a', label: 'Alpha' }] }],
  [],
  ({ crosswalk }) => expect(crosswalk[0]?.optionValues).toEqual({ a: 'Alpha' }),
)
questionsMutation(
  'paid questions',
  'raw.price != null && raw.price !== 0',
  'false',
  [{ name: 'q', label: 'Paid', type: 'boolean', price: 100 }],
  [],
  (_result, problems) => expect(has(problems, 'question_priced')).toBe(true),
)
questionsMutation(
  'hidden question semantics',
  'raw.hidden === true ||',
  'false ||',
  [{ name: 'q', label: 'Hidden', type: 'text', hidden: true }],
  [],
  ({ questions }) => expect(questions).toEqual([]),
)
questionsMutation(
  'question count cap',
  "if (questions.length > 20) add('question_limit', 'import_blocker')",
  "if (questions.length > 200) add('question_limit', 'import_blocker')",
  Array.from({ length: 21 }, (_, i) => ({ name: `q${i}`, label: 'Question', type: 'text' })),
  [],
  (_result, problems) => expect(has(problems, 'question_limit')).toBe(true),
)

questionsMutation(
  'modern options require an explicit value-label object',
  'if (!record(option)) {',
  'if (false) {',
  [{ name: 'q', label: 'Choice', type: 'select', options: ['A'] }],
  [],
  (_result, problems) => expect(has(problems, 'question_options')).toBe(true),
)
questionsMutation(
  'legacy option shape is audited',
  "if (!modern && typeof option.type !== 'string')",
  'if (false)',
  [],
  [{ id: 7, label: 'Choice', type: 'radio', options: [{ label: 'A' }] }],
  (_result, problems) => expect(has(problems, 'question_options')).toBe(true),
)

function schedulesMutation(
  name: string,
  before: string,
  after: string,
  availability: SourceRow[],
  assertion: (result: ReturnType<typeof parseSchedules>, problems: PlanProblem[]) => void,
) {
  it(`source-copy mutation: ${name}`, async () => {
    await checkSourceMutation(
      new URL('./schedules.ts', import.meta.url),
      before,
      after,
      (module) => module.parseSchedules as typeof parseSchedules,
      (parse) => {
        const problems: PlanProblem[] = []
        assertion(parse(snapshot({ Availability: availability }), users, problems), problems)
      },
    )
  })
}
schedulesMutation(
  '23:59 end of day',
  'end.minutes === 1439 ? 1440 : end.minutes',
  'end.minutes',
  [{ id: 1, scheduleId: 10, days: [], startTime: '09:00', endTime: '23:59', date: '2027-01-01' }],
  (result) =>
    expect(result[0]?.overrides[0]?.intervals).toEqual([{ start: '09:00', end: '24:00' }]),
)
schedulesMutation(
  'empty day marker',
  'value.empty = true',
  'value.empty = false',
  [
    { id: 1, scheduleId: 10, date: '2027-01-01', startTime: '00:00', endTime: '00:00' },
    { id: 2, scheduleId: 10, date: '2027-01-01', startTime: '09:00', endTime: '10:00' },
  ],
  (result) => expect(result[0]?.valid).toBe(false),
)
schedulesMutation(
  'source seconds truncated without rounding',
  'Number(match[1]) * 60 + Number(match[2])',
  'Number(match[1]) * 60 + Number(match[2]) + (Number(match[3] ?? 0) > 30 ? 1 : 0)',
  [{ id: 1, scheduleId: 10, days: [1], startTime: '09:00:45', endTime: '10:00:00', date: null }],
  (result) => expect(result[0]?.weeklyHours.monday).toEqual([{ start: '09:00', end: '10:00' }]),
)
schedulesMutation(
  'unshifted calendar dates',
  'key = validateDate(date)',
  'key = Temporal.PlainDate.from(validateDate(date)).add({ days: 1 }).toString()',
  [{ id: 1, scheduleId: 10, date: '2026-12-31', startTime: '00:00', endTime: '00:00' }],
  (result) => expect(result[0]?.overrides[0]?.date).toBe('2026-12-31'),
)
schedulesMutation(
  'invalid availability rejection',
  "plan.valid = !problems.slice(startProblems).some((p) => p.severity === 'import_blocker')",
  'plan.valid = true',
  [{ id: 1, scheduleId: 10, days: [1], startTime: '12:00', endTime: '11:00', date: null }],
  (result) => expect(result[0]?.valid).toBe(false),
)

function locationsMutation(
  name: string,
  before: string,
  after: string,
  assertion: (module: typeof Locations) => void,
) {
  it(`source-copy mutation: ${name}`, async () => {
    await checkSourceMutation(
      new URL('./locations.ts', import.meta.url),
      before,
      after,
      (module) => module as unknown as typeof Locations,
      assertion,
    )
  })
}
locationsMutation(
  'private event location disclosure',
  'if (location.displayLocationPublicly !== true)',
  'if (false)',
  ({ parseEventLocation }) =>
    expect(
      parseEventLocation(
        {
          id: 20,
          locations: [
            { type: 'inPerson', address: 'Private source address', displayLocationPublicly: false },
          ],
        },
        [],
      ),
    ).toBeNull(),
)
locationsMutation(
  'host and authentication URL capabilities',
  'forbiddenParameters.has(normalized)',
  'false',
  ({ safeMeetingUrl }) =>
    expect(safeMeetingUrl('https://meeting.example/join?access_token=synthetic-marker')).toBeNull(),
)
locationsMutation(
  'reference live state',
  'if (ref.deleted !== null)',
  'if (ref.deleted !== null && ref.deleted !== false)',
  ({ parseBookingLocation }) => {
    const problems: PlanProblem[] = []
    expect(
      parseBookingLocation(
        { id: 50, location: 'integrations:zoom' },
        [
          {
            bookingId: 50,
            type: 'zoom_video',
            deleted: false,
            meetingUrl: 'https://zoom.us/j/123456789',
          },
        ],
        problems,
      ),
    ).toBeNull()
  },
)
locationsMutation(
  'reference uniqueness',
  'if (ambiguous || usable.length > 1)',
  'if (ambiguous)',
  ({ parseBookingLocation }) => {
    const problems: PlanProblem[] = []
    parseBookingLocation(
      { id: 50, location: 'integrations:zoom' },
      [
        {
          bookingId: 50,
          type: 'zoom_video',
          deleted: null,
          meetingUrl: 'https://zoom.us/j/123456789',
        },
        {
          bookingId: 50,
          type: 'zoom_video',
          deleted: null,
          meetingUrl: 'https://zoom.us/j/987654321',
        },
      ],
      problems,
    )
    expect(has(problems, 'booking_location_reference')).toBe(true)
  },
)
locationsMutation(
  'missing location owner decision',
  "'booking_location_missing',\n    acceptMissing ? 'warning' : 'import_blocker'",
  "'booking_location_missing',\n    acceptMissing ? 'warning' : 'warning'",
  ({ parseBookingLocation }) => {
    const problems: PlanProblem[] = []
    parseBookingLocation({ id: 50, location: null }, [], problems)
    expect(problems[0]?.severity).toBe('import_blocker')
  },
)
locationsMutation(
  'public join fragment privacy',
  '/(?:^|[?&;])(?:pwd|passcode|pin)=/i.test(fragment)',
  '/never-match-this-fragment/i.test(fragment)',
  ({ safeMeetingUrl }) =>
    expect(safeMeetingUrl('https://meeting.example/join#pwd=synthetic-marker', true)).toBeNull(),
)
locationsMutation(
  'known historical in-person text mapping',
  "['inPerson', 'userPhone', 'phone'].includes",
  "['userPhone', 'phone'].includes",
  ({ parseBookingLocation }) =>
    expect(
      parseBookingLocation(
        {
          id: 50,
          location: 'Historical private address',
          responses: { location: { value: 'inPerson', optionValue: '' } },
        },
        [],
        [],
      ),
    ).toEqual({ kind: 'in_person', address: 'Historical private address' }),
)
locationsMutation(
  'exact source private address fallback',
  'Array.isArray(sourceEvent?.locations) &&',
  'false &&',
  ({ parseBookingLocation }) =>
    expect(
      parseBookingLocation({ id: 50, location: 'Historical private address' }, [], [], false, {
        locations: [
          {
            type: 'inPerson',
            address: 'Historical private address',
            displayLocationPublicly: false,
          },
        ],
      }),
    ).toEqual({ kind: 'in_person', address: 'Historical private address' }),
)
locationsMutation(
  'untyped phone is not assumed to be the host',
  'let direct: StaticLocation | null = null',
  "let direct: StaticLocation | null = typeof raw === 'string' && PHONE.test(raw) ? { kind: 'phone', number: raw } : null",
  ({ parseBookingLocation }) =>
    expect(parseBookingLocation({ id: 50, location: '+14155550123' }, [], [])).toBeNull(),
)
locationsMutation(
  'audited reference participant URL shape',
  'if (!url || !providerJoin)',
  'if (!url)',
  ({ parseBookingLocation }) =>
    expect(
      parseBookingLocation(
        { id: 50, location: 'integrations:zoom' },
        [
          {
            bookingId: 50,
            deleted: null,
            type: 'zoom_video',
            meetingUrl: 'https://zoom.example.invalid/j/123456789',
          },
        ],
        [],
      ),
    ).toBeNull(),
)

locationsMutation(
  'booker phone cannot be reclassified as a host telephone',
  "'booking_location_booker_phone',\n        acceptMissing ? 'warning' : 'import_blocker'",
  "'booking_location_booker_phone',\n        'warning'",
  ({ parseBookingLocation }) => {
    const problems: PlanProblem[] = []
    parseBookingLocation(
      {
        id: 50,
        location: '+14155550123',
        responses: { location: { value: 'phone', optionValue: '+14155550123' } },
      },
      [],
      problems,
      false,
      { locations: [{ type: 'userPhone', hostPhoneNumber: '+14155550123' }] },
    )
    expect(problems[0]?.severity).toBe('import_blocker')
  },
)

locationsMutation(
  'extraction suppression cannot become public event config',
  'if (event.unsafeLocation === true)',
  'if (false)',
  ({ parseEventLocation }) =>
    expect(
      parseEventLocation(
        {
          id: 20,
          unsafeLocation: true,
          locations: [
            { type: 'inPerson', address: 'Unrelated fallback', displayLocationPublicly: true },
          ],
        },
        [],
      ),
    ).toBeNull(),
)
locationsMutation(
  'unsafe source booking capability cannot be accepted as missing',
  'if (booking.unsafeLocation === true)',
  'if (false)',
  ({ parseBookingLocation }) => {
    const problems: PlanProblem[] = []
    parseBookingLocation({ id: 50, location: null, unsafeLocation: true }, [], problems, true)
    expect(problems[0]?.severity).toBe('import_blocker')
  },
)
