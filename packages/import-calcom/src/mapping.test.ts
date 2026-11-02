import { getAvailableSlots } from '@hourmere/core'
import { describe, expect, it } from 'vitest'
import { plainDescription } from './events.ts'
import { parseBookingLocation, parseEventLocation, safeMeetingUrl } from './locations.ts'
import { baseEvent, parseEvent, snapshot, users } from './mapping-fixtures.ts'
import { parseQuestions, stableQuestionId } from './questions.ts'
import { parseSchedules } from './schedules.ts'
import type { PlanProblem, SourceSnapshot } from './types.ts'

const has = (problems: PlanProblem[], code: string) => problems.some((p) => p.code === code)

describe('personal event drafts', () => {
  it('keeps duration order, source defaults, hidden visibility, inactive drafts and empty side effects', () => {
    const { events } = parseEvent({ multipleDuration: [60, 30, 15], hidden: true })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      durationMinutes: 30,
      allowedDurationsMinutes: [60, 30, 15],
      minimumNoticeMinutes: 120,
      isHidden: true,
      isActive: false,
      scheduleSourceId: 10,
      slotStepMinutes: null,
      notifications: { reminders: [], followUps: [] },
      successRedirect: null,
    })
    expect(events[0]?.description).toBe(baseEvent.description)
    expect(parseEvent({ hidden: false }).events[0]).toMatchObject({
      isHidden: false,
      isActive: false,
    })
  })
  it('proposes the default only when the duration selector is hidden and reports loss', () => {
    const { events, problems } = parseEvent({
      multipleDuration: [60, 30],
      hideDurationSelectorInBookingPage: true,
    })
    expect(events[0]?.allowedDurationsMinutes).toEqual([30])
    expect(has(problems, 'event_hidden_durations')).toBe(true)
  })
  it.each([
    { length: 0 },
    { length: 1441 },
    { length: 30.1 },
    { multipleDuration: [30, 30] },
    { multipleDuration: [15, 60] },
    { multipleDuration: Array.from({ length: 13 }, (_, i) => i + 30) },
    { slotInterval: 0 },
    { beforeEventBuffer: -1 },
    { afterEventBuffer: 1441 },
    { minimumBookingNotice: 525601 },
  ])('refuses invalid duration rules without repairing them: %j', (change) => {
    const { events, problems } = parseEvent(change)
    expect(events).toEqual([])
    expect(has(problems, 'event_duration_rules')).toBe(true)
  })
  it.each([
    { title: 'x'.repeat(201) },
    { slug: 'UpperCase' },
    { slug: 'x'.repeat(65) },
    { description: 'x'.repeat(5001) },
    { title: 'bad\u0000text' },
    { position: 2147483648 },
  ])('refuses text limits: %j', (change) => {
    expect(parseEvent(change).events).toEqual([])
  })
  it('converts HTML without loading resources and reports formatting loss', () => {
    const { events, problems } = parseEvent({
      description:
        '<p>Hello &amp; welcome</p><img src="https://example.invalid/secret"><script>leak()</script><div>Second line</div>',
    })
    expect(events[0]?.description).toBe('Hello & welcome\nSecond line')
    expect(has(problems, 'event_html_loss')).toBe(true)
    expect(plainDescription('Ordinary < angle').converted).toBe(false)
  })
  it.each([
    { teamId: 2 },
    { profileId: 2 },
    { parentId: 2 },
    { schedulingType: 'roundRobin' },
    { schedulingType: 'collective' },
    { schedulingType: 'managed' },
    { assignAllTeamMembers: true },
  ])('excludes non-personal scope: %j', (change) => {
    const { events, problems } = parseEvent(change)
    expect(events).toEqual([])
    expect(has(problems, 'event_scope')).toBe(true)
  })
  it.each([
    { Host: [{ eventTypeId: 20, userId: 2 }] },
    {
      _user_eventtype: [
        { A: 20, B: 1 },
        { A: 20, B: 2 },
      ],
    },
    { Host: [], _user_eventtype: [] },
    { HostGroup: [{ id: 5, eventTypeId: 20 }] },
    { Host: [{ eventTypeId: 20, userId: 1, groupId: 3 }] },
  ] as SourceSnapshot['tables'][])('requires actual single-host relationships: %j', (tables) => {
    const { events, problems } = parseEvent({}, tables)
    expect(events).toEqual([])
    expect(has(problems, 'event_host_shape')).toBe(true)
  })
  it.each([
    { price: 1 },
    { paymentConfigured: true },
    { unknownPaymentShape: true },
    { isInstantEvent: true },
  ])('blocks paid or instant events: %j', (change) => {
    const { events, problems } = parseEvent(change)
    expect(events).toEqual([])
    expect(has(problems, 'event_paid_or_instant')).toBe(true)
  })
  it('blocks both events with duplicate source slugs without renaming either', () => {
    const { events, problems } = parseEvent(
      {},
      {
        EventType: [baseEvent, { ...baseEvent, id: 21 }],
        Host: [
          { eventTypeId: 20, userId: 1 },
          { eventTypeId: 21, userId: 1 },
        ],
        _user_eventtype: [],
      },
    )
    expect(events).toEqual([])
    expect(
      problems.filter((p) => p.code === 'event_slug_conflict').map((p) => p.source.id),
    ).toEqual([21, 20])
  })
  it.each([
    { offsetStart: 5 },
    { periodType: 'rolling', periodDays: 14 },
    { periodType: 'rolling_window', periodDays: 7 },
    {
      periodType: 'range',
      periodStartDate: '2026-12-01T00:00:00.000Z',
      periodEndDate: '2027-01-03T00:00:00.000Z',
    },
    { bookingLimits: { PER_DAY: 3, PER_WEEK: 8 } },
    { durationLimits: { PER_MONTH: 200 } },
    { maxActiveBookingsPerBooker: 1 },
    { requiresConfirmation: true },
    { requiresBookerEmailVerification: true },
    { bookingRequiresAuthentication: true },
    { recurringEvent: { freq: 2 } },
    { seatsPerTimeSlot: 5 },
    { disableCancelling: true },
    { disableRescheduling: true },
    { minimumRescheduleNotice: 3 },
    { useBookerTimezone: true },
    { restrictionScheduleId: 5 },
  ])('retains disabled drafts and reports unmappable restrictions: %j', (change) => {
    const { events, problems } = parseEvent(change)
    expect(events).toHaveLength(1)
    expect(events[0]?.isActive).toBe(false)
    expect(problems.some((p) => p.severity === 'activation_blocker')).toBe(true)
  })
  it('refuses arbitrary or invalid limit payloads rather than copying them into the plan', () => {
    for (const bookingLimits of [{ unknown: 7 }, { PER_DAY: 'private-marker' }, { PER_WEEK: -1 }]) {
      const { events, problems } = parseEvent({ bookingLimits })
      expect(events).toEqual([])
      expect(has(problems, 'event_limits_shape')).toBe(true)
      expect(JSON.stringify(problems)).not.toContain('private-marker')
    }
  })
  it('proposes PER_DAY only with its semantic activation blocker', () => {
    const { events, problems } = parseEvent({ bookingLimits: { PER_DAY: 3 } })
    expect(events[0]?.maxBookingsPerDay).toBe(3)
    expect(has(problems, 'event_limits')).toBe(true)
  })
  it('resolves event then host then explicit user default schedules without guessing', () => {
    const source = snapshot({
      Schedule: [10, 11, 12].map((id) => ({
        id,
        userId: 1,
        name: `Schedule ${id}`,
        timeZone: 'UTC',
      })),
      Host: [{ eventTypeId: 20, userId: 1, scheduleId: 11 }],
    })
    expect(parseEvent({ scheduleId: 12 }, source.tables).events[0]?.scheduleSourceId).toBe(12)
    expect(parseEvent({}, source.tables).events[0]?.scheduleSourceId).toBe(11)
    expect(parseEvent().events[0]?.scheduleSourceId).toBe(10)
    const unresolved = parseEvent({}, { users: [{ id: 1, defaultScheduleId: null }] })
    expect(unresolved.events[0]?.scheduleSourceId).toBeNull()
    expect(has(unresolved.problems, 'event_schedule_unresolved')).toBe(true)
    expect(parseEvent({ scheduleId: 99 }).events).toEqual([])
  })
  it('flags timezone fallback plus effective travel, OOO, holiday and host locations', () => {
    const { events, problems } = parseEvent(
      { timeZone: 'Europe/Berlin' },
      {
        Schedule: [{ id: 10, userId: 1, name: 'Fallback', timeZone: null }],
        TravelSchedule: [{ userId: 1 }],
        OutOfOfficeEntry: [{ userId: 1 }],
        UserHolidaySettings: [{ userId: 1 }],
        HostLocation: [{ userId: 1, eventTypeId: 20 }],
      },
    )
    expect(events[0]?.proposedScheduleTimezone).toBe('Europe/Berlin')
    expect(has(problems, 'event_unavailable_rules')).toBe(true)
    expect(has(problems, 'event_extra_restriction')).toBe(true)
    expect(has(problems, 'event_schedule_timezone')).toBe(true)
  })
})

describe('questions and stable answer crosswalks', () => {
  it('prefers modern fields, skips systems, preserves order and maps option values distinctly from labels', () => {
    const problems: PlanProblem[] = []
    const result = parseQuestions(
      {
        id: 20,
        bookingFields: [
          { name: 'name', type: 'name' },
          { name: 'email', type: 'email' },
          {
            name: 'choice',
            label: 'Choose',
            type: 'select',
            required: true,
            options: [
              { value: 'alpha', label: 'Alpha' },
              { value: 'beta', label: 'Beta' },
            ],
          },
          { name: 'terms', label: 'Terms', type: 'boolean', required: false },
        ],
      },
      [{ id: 9, label: 'Legacy', type: 'text' }],
      problems,
    )
    expect(result.questions.map((q) => q.type)).toEqual(['select', 'checkbox'])
    expect(result.crosswalk[0]?.optionValues).toEqual({ alpha: 'Alpha', beta: 'Beta' })
    expect(result.questions[0]?.options).toEqual(['Alpha', 'Beta'])
    expect(result.questions[0]?.id).toBe(stableQuestionId(20, 'choice'))
    expect(result.questions[0]?.id).not.toBe(stableQuestionId(21, 'choice'))
    expect(result.questions[0]?.id.length).toBeLessThanOrEqual(64)
    expect(problems.filter((p) => p.code === 'question_system')).toHaveLength(2)
  })
  it('falls back to legacy IDs and exact labels only when modern fields are empty', () => {
    const problems: PlanProblem[] = []
    const result = parseQuestions(
      { id: 20, bookingFields: [] },
      [
        {
          id: 7,
          label: 'Legacy choice',
          type: 'radio',
          options: [
            { label: '  Choice A ', type: 'text' },
            { label: 'Choice B', type: 'text' },
          ],
          required: true,
        },
        { id: 8, label: 'Consent', type: 'bool', required: false },
      ],
      problems,
    )
    expect(result.questions.map((q) => q.type)).toEqual(['select', 'checkbox'])
    expect(result.crosswalk[0]).toMatchObject({
      sourceKey: 'legacy:7',
      legacyLabel: 'Legacy choice',
      optionValues: { '  Choice A ': 'Choice A', 'Choice B': 'Choice B' },
    })
    expect(has(problems, 'question_normalized')).toBe(true)
  })
  it.each(['text', 'textarea', 'phone', 'select', 'radio', 'multiselect', 'boolean'])(
    'supports the audited modern type %s',
    (type) => {
      const problems: PlanProblem[] = []
      const options = ['select', 'radio', 'multiselect'].includes(type)
        ? [{ label: 'A', value: 'a' }]
        : undefined
      const result = parseQuestions(
        {
          id: 20,
          bookingFields: [{ name: 'q', label: 'Question', type, ...(options ? { options } : {}) }],
        },
        [],
        problems,
      )
      expect(result.questions).toHaveLength(1)
      expect(problems).toEqual([])
    },
  )
  it.each(['number', 'email', 'url', 'address', 'name', 'multiemail', 'radioInput', 'checkbox'])(
    'does not guess unsupported modern type %s',
    (type) => {
      const problems: PlanProblem[] = []
      expect(
        parseQuestions(
          { id: 20, bookingFields: [{ name: 'custom', label: 'Custom', type }] },
          [],
          problems,
        ).questions,
      ).toEqual([])
      expect(has(problems, 'question_unsupported')).toBe(true)
    },
  )
  it.each([
    { minLength: 3 },
    { maxLength: 10 },
    { hidden: true },
    { disableOnPrefill: true },
    { readOnly: true },
    { getOptionsAt: 'dynamic' },
    { conditions: {} },
    { variantsConfig: {} },
  ])('reports advanced question semantics: %j', (advanced) => {
    const problems: PlanProblem[] = []
    expect(
      parseQuestions(
        { id: 20, bookingFields: [{ name: 'q', label: 'Question', type: 'text', ...advanced }] },
        [],
        problems,
      ).questions,
    ).toEqual([])
    expect(has(problems, 'question_unsupported')).toBe(true)
  })
  it.each(
    [
      [
        { label: 'A', value: 'a' },
        { label: 'A', value: 'b' },
      ],
      [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'a' },
      ],
      [{ label: 'A' }],
      [{ label: '', value: 'a' }],
      [{ label: 'x'.repeat(201), value: 'a' }],
      Array.from({ length: 51 }, (_, i) => ({ label: String(i), value: String(i) })),
    ].map((options) => ({ options })),
  )('rejects ambiguous or excessive choice mappings', ({ options }) => {
    const problems: PlanProblem[] = []
    parseQuestions(
      { id: 20, bookingFields: [{ name: 'q', label: 'Question', type: 'select', options }] },
      [],
      problems,
    )
    expect(has(problems, 'question_options')).toBe(true)
  })
  it('requires the audited modern object options and legacy object option shape', () => {
    const problems: PlanProblem[] = []
    expect(
      parseQuestions(
        { id: 20, bookingFields: [{ name: 'q', label: 'Choice', type: 'select', options: ['A'] }] },
        [],
        problems,
      ).questions,
    ).toEqual([])
    expect(has(problems, 'question_options')).toBe(true)
    for (const options of [['A'], [{ label: 'A' }], '[{"label":"A","type":"text"}]']) {
      const legacyProblems: PlanProblem[] = []
      expect(
        parseQuestions(
          { id: 20, bookingFields: [] },
          [{ id: 7, label: 'Choice', type: 'radio', options }],
          legacyProblems,
        ).questions,
      ).toEqual([])
      expect(has(legacyProblems, 'question_options')).toBe(true)
    }
  })
  it('rejects paid questions/options, invalid labels, duplicate identities and more than twenty questions', () => {
    const priced = parseEvent({
      bookingFields: [{ name: 'q', label: 'Question', type: 'boolean', price: 100 }],
    })
    expect(priced.events).toEqual([])
    expect(has(priced.problems, 'question_priced')).toBe(true)
    expect(
      parseEvent({
        bookingFields: [
          {
            name: 'q',
            label: 'Q',
            type: 'select',
            options: [{ value: 'a', label: 'A', price: 1 }],
          },
        ],
      }).events,
    ).toEqual([])
    expect(parseEvent({ bookingFields: [{ name: 'q', label: '', type: 'text' }] }).events).toEqual(
      [],
    )
    expect(
      parseEvent({
        bookingFields: [
          { name: 'q', label: 'Q', type: 'text' },
          { name: 'q', label: 'Q2', type: 'text' },
        ],
      }).events,
    ).toEqual([])
    const excessive = parseEvent({
      bookingFields: Array.from({ length: 21 }, (_, i) => ({
        name: `q${i}`,
        label: 'Q',
        type: 'text',
      })),
    })
    expect(excessive.events).toEqual([])
    expect(has(excessive.problems, 'question_limit')).toBe(true)
  })
  it('reports placeholders and legacy duplicate labels', () => {
    const problems: PlanProblem[] = []
    parseQuestions(
      { id: 20 },
      [
        { id: 1, label: 'Same', type: 'text', placeholder: 'Hint' },
        { id: 2, label: 'Same', type: 'text' },
      ],
      problems,
    )
    expect(has(problems, 'question_placeholder')).toBe(true)
    expect(has(problems, 'question_key')).toBe(true)
  })
})

describe('schedule wall times and date replacement', () => {
  it('unions overlapping/touching intervals, maps Sunday zero, truncates seconds and converts 23:59', () => {
    const source = snapshot({
      Availability: [
        {
          id: 1,
          scheduleId: 10,
          days: [0, 1],
          startTime: '09:00:45.123',
          endTime: '12:00:59',
          date: null,
        },
        {
          id: 2,
          scheduleId: 10,
          days: [1],
          startTime: '11:00:00',
          endTime: '14:00:00',
          date: null,
        },
        {
          id: 3,
          scheduleId: 10,
          days: [1],
          startTime: '14:00:00',
          endTime: '23:59:00',
          date: null,
        },
      ],
    })
    const problems: PlanProblem[] = []
    const result = parseSchedules(source, users, problems)
    expect(result[0]?.weeklyHours.monday).toEqual([{ start: '09:00', end: '24:00' }])
    expect(result[0]?.weeklyHours.sunday).toEqual([{ start: '09:00', end: '12:00' }])
    expect(result[0]?.weeklyHours.tuesday).toEqual([])
    expect(has(problems, 'availability_seconds')).toBe(true)
    expect(has(problems, 'availability_end_of_day')).toBe(true)
    expect(result[0]?.isDefault).toBe(false)
    expect(result[0]?.sourceIsDefault).toBe(true)
  })
  it('preserves old and cross-year DATEs, empty days and same-day replacement unions', () => {
    const source = snapshot({
      Availability: [
        {
          id: 1,
          scheduleId: 10,
          days: [],
          startTime: '00:00:00',
          endTime: '00:00:00',
          date: '2025-12-31',
        },
        {
          id: 2,
          scheduleId: 10,
          days: [],
          startTime: '10:00:00',
          endTime: '12:00:00',
          date: '2027-01-01',
        },
        {
          id: 3,
          scheduleId: 10,
          days: [],
          startTime: '11:00:00',
          endTime: '23:59:00',
          date: '2027-01-01',
        },
      ],
    })
    const problems: PlanProblem[] = []
    expect(parseSchedules(source, users, problems)[0]?.overrides).toEqual([
      { date: '2025-12-31', intervals: [] },
      { date: '2027-01-01', intervals: [{ start: '10:00', end: '24:00' }] },
    ])
  })
  it.each([
    { days: [7] },
    { days: [1, 1] },
    { startTime: '12:00', endTime: '11:00' },
    { startTime: '25:00' },
    { startTime: '12:30', endTime: '12:30' },
    { date: '2027-02-30' },
  ])('marks invalid availability without silently repairing: %j', (change) => {
    const source = snapshot({
      Availability: [
        {
          id: 1,
          scheduleId: 10,
          days: [1],
          startTime: '09:00:00',
          endTime: '17:00:00',
          date: null,
          ...change,
        },
      ],
    })
    const problems: PlanProblem[] = []
    expect(parseSchedules(source, users, problems)[0]?.valid).toBe(false)
    expect(problems.some((p) => p.severity === 'import_blocker' && p.source.id === 1)).toBe(true)
  })
  it('rejects mixed empty and nonempty date overrides', () => {
    const source = snapshot({
      Availability: [
        { id: 1, scheduleId: 10, date: '2027-01-01', startTime: '00:00', endTime: '00:00' },
        { id: 2, scheduleId: 10, date: '2027-01-01', startTime: '09:00', endTime: '10:00' },
      ],
    })
    const problems: PlanProblem[] = []
    expect(parseSchedules(source, users, problems)[0]?.valid).toBe(false)
    expect(has(problems, 'availability_empty_conflict')).toBe(true)
  })
  it('rejects invalid zones and reports inferred zones and ignored legacy availability', () => {
    const problems: PlanProblem[] = []
    expect(
      parseSchedules(
        snapshot({ Schedule: [{ id: 10, userId: 1, name: 'Hours', timeZone: '+01:00' }] }),
        users,
        problems,
      ),
    ).toEqual([])
    expect(has(problems, 'schedule_timezone')).toBe(true)
    const result = parseSchedules(
      snapshot({
        Schedule: [{ id: 10, userId: 1, name: 'Hours', timeZone: null }],
        Availability: [
          {
            id: 55,
            userId: 1,
            eventTypeId: 20,
            scheduleId: null,
            days: [1],
            startTime: '01:00',
            endTime: '02:00',
            date: null,
          },
        ],
      }),
      users,
      problems,
    )
    expect(result[0]?.requiresTimezoneConfirmation).toBe(true)
    expect(result[0]?.weeklyHours.monday).toEqual([])
    expect(has(problems, 'availability_legacy_ignored')).toBe(true)
  })
  it('keeps local times across DST gaps and overlaps for the target Temporal engine', () => {
    const problems: PlanProblem[] = []
    const result = parseSchedules(
      snapshot({
        Availability: [
          { id: 1, scheduleId: 10, date: '2027-03-14', startTime: '01:30', endTime: '03:30' },
          { id: 2, scheduleId: 10, date: '2027-11-07', startTime: '01:00', endTime: '02:00' },
        ],
      }),
      users,
      problems,
    )[0]
    expect(result?.overrides).toEqual([
      { date: '2027-03-14', intervals: [{ start: '01:30', end: '03:30' }] },
      { date: '2027-11-07', intervals: [{ start: '01:00', end: '02:00' }] },
    ])
    if (!result) throw new Error('Expected a mapped schedule')
    const starts = (date: string) =>
      getAvailableSlots({
        schedule: {
          timeZone: result.timeZone,
          weeklyHours: result.weeklyHours,
          dateOverrides: result.overrides,
        },
        eventType: { durationMinutes: 30 },
        now: Temporal.Instant.from('2026-10-31T00:00:00Z'),
        rangeStart: Temporal.Instant.from(`${date}T00:00:00Z`),
        rangeEnd: Temporal.Instant.from(`${date}T23:59:59Z`),
      }).map((slot) => slot.start.toString())
    expect(starts('2027-03-14')).toEqual(['2027-03-14T06:30:00Z', '2027-03-14T07:00:00Z'])
    expect(starts('2027-11-07')).toEqual(['2027-11-07T05:00:00Z', '2027-11-07T05:30:00Z'])
  })
})

describe('location disclosure and protected joins', () => {
  it('maps public static locations and keeps private static locations out of drafts', () => {
    expect(parseEvent().events[0]?.location).toEqual({
      kind: 'in_person',
      address: '1 Example Street',
    })
    for (const privacy of [undefined, false]) {
      const { events, problems } = parseEvent({
        locations: [
          {
            type: 'link',
            link: 'https://meeting.example/join?pwd=private',
            displayLocationPublicly: privacy,
          },
        ],
      })
      expect(events[0]?.location).toBeNull()
      expect(has(problems, 'location_private')).toBe(true)
      expect(JSON.stringify(problems)).not.toContain('https://meeting.example/join?pwd=private')
    }
    expect(
      parseEvent({
        locations: [
          { type: 'userPhone', hostPhoneNumber: '+14155550123', displayLocationPublicly: true },
        ],
      }).events[0]?.location,
    ).toEqual({ kind: 'phone', number: '+14155550123' })
  })
  it('never guesses the first location, exposes guest phone as host phone or enables dynamic providers', () => {
    for (const locations of [
      [
        { type: 'inPerson', address: 'A' },
        { type: 'inPerson', address: 'B' },
      ],
      [{ type: 'phone' }],
      [{ type: 'integrations:zoom', credentialId: 123 }],
      [{ type: 'integrations:google:meet' }],
    ]) {
      const problems: PlanProblem[] = []
      expect(parseEventLocation({ id: 20, locations }, problems)).toBeNull()
      expect(problems[0]?.severity).toBe('activation_blocker')
      expect(JSON.stringify(problems)).not.toContain('123')
    }
  })
  it.each([
    'ftp://example.com/join',
    'https://user:secret@example.com/join',
    'https://meeting.example/login',
    'https://meeting.example/oauth/authorize',
    'https://zoom.us/s/123?zak=secret',
    'https://meeting.example/join?access_token=secret',
    'https://meeting.example/join\nsecret',
  ])('rejects non-meeting and host capabilities without echoing them: %s', (url) => {
    expect(safeMeetingUrl(url)).toBeNull()
    const problems: PlanProblem[] = []
    parseBookingLocation({ id: 50, location: url }, [], problems)
    expect(problems.some((p) => p.severity === 'import_blocker')).toBe(true)
    expect(JSON.stringify(problems)).not.toContain(url)
  })
  it('keeps textual historical private addresses and only known fixed host phones', () => {
    const address = '42 Private Source Street'
    const event = {
      id: 20,
      locations: [{ type: 'inPerson', address, displayLocationPublicly: false }],
    }
    const problems: PlanProblem[] = []
    expect(
      parseBookingLocation(
        {
          id: 50,
          location: address,
          responses: { location: { value: 'inPerson', optionValue: '' } },
        },
        [],
        problems,
      ),
    ).toEqual({ kind: 'in_person', address })
    expect(parseBookingLocation({ id: 51, location: address }, [], problems, false, event)).toEqual(
      { kind: 'in_person', address },
    )
    expect(parseEventLocation(event, problems)).toBeNull()
    const hostPhone = '+14155550123'
    expect(
      parseBookingLocation(
        {
          id: 52,
          location: hostPhone,
          responses: { location: { value: 'userPhone', optionValue: '' } },
        },
        [],
        problems,
      ),
    ).toEqual({ kind: 'phone', number: hostPhone })
    const unresolved: PlanProblem[] = []
    expect(parseBookingLocation({ id: 53, location: hostPhone }, [], unresolved)).toBeNull()
    expect(
      parseBookingLocation(
        {
          id: 54,
          location: hostPhone,
          responses: { location: { value: 'phone', optionValue: hostPhone } },
        },
        [],
        unresolved,
      ),
    ).toBeNull()
    expect(has(unresolved, 'booking_location_booker_phone')).toBe(true)
    expect(JSON.stringify(problems)).not.toContain(address)
    expect(JSON.stringify(unresolved)).not.toContain(hostPhone)
  })
  it('rejects mismatched historical responses and non-text source locations', () => {
    const problems: PlanProblem[] = []
    expect(
      parseBookingLocation(
        {
          id: 50,
          location: 'Actual address',
          responses: { location: { value: 'inPerson', optionValue: 'Different address' } },
        },
        [],
        problems,
      ),
    ).toBeNull()
    expect(has(problems, 'booking_location_response_conflict')).toBe(true)
    expect(
      parseBookingLocation(
        { id: 51, location: { type: 'inPerson', address: 'Synthetic shape' } },
        [],
        problems,
      ),
    ).toBeNull()
    expect(has(problems, 'booking_location_shape')).toBe(true)
  })
  it.each(['pwd', 'passcode', 'pin'])(
    'keeps fragment %s out of public event configuration',
    (parameter) => {
      const url = `https://meeting.example/join#${parameter}=private-join-code`
      expect(safeMeetingUrl(url, true)).toBeNull()
      expect(safeMeetingUrl(url)).toBe(url)
      const problems: PlanProblem[] = []
      expect(
        parseEventLocation(
          { id: 20, locations: [{ type: 'link', link: url, displayLocationPublicly: true }] },
          problems,
        ),
      ).toBeNull()
      expect(has(problems, 'location_invalid')).toBe(true)
      expect(JSON.stringify(problems)).not.toContain('private-join-code')
    },
  )
  it('checks an audited reference provider against its actual participant URL shape', () => {
    const problems: PlanProblem[] = []
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
        problems,
      ),
    ).toBeNull()
    expect(has(problems, 'booking_location_reference')).toBe(true)
    expect(
      parseBookingLocation(
        { id: 51, location: 'integrations:google:meet' },
        [
          {
            bookingId: 51,
            deleted: null,
            type: 'google_calendar',
            meetingUrl: 'https://meet.google.com/abc-defg-hij',
          },
        ],
        [],
      ),
    ).toEqual({ kind: 'link', url: 'https://meet.google.com/abc-defg-hij' })
  })
  it('allows join passcodes only in protected booking locations', () => {
    const url = 'https://zoom.us/j/123456789?pwd=private-passcode'
    const problems: PlanProblem[] = []
    expect(parseBookingLocation({ id: 50, location: url }, [], problems)).toEqual({
      kind: 'link',
      url,
    })
    expect(safeMeetingUrl(url, true)).toBeNull()
    expect(problems).toEqual([])
  })
  it('uses only unique live audited references and refuses deleted=false, unknown or conflicting links', () => {
    const booking = { id: 50, location: 'integrations:zoom' }
    const ref = {
      bookingId: 50,
      type: 'zoom_video',
      deleted: null,
      meetingUrl: 'https://zoom.us/j/123456789?pwd=private-passcode',
    }
    const problems: PlanProblem[] = []
    expect(parseBookingLocation(booking, [ref], problems)).toMatchObject({ kind: 'link' })
    for (const refs of [
      [{ ...ref, deleted: false }],
      [{ ...ref, type: 'unknown' }],
      [ref, { ...ref, meetingUrl: 'https://zoom.us/j/987654321' }],
    ]) {
      const errors: PlanProblem[] = []
      expect(parseBookingLocation(booking, refs, errors)).toBeNull()
      expect(has(errors, 'booking_location_reference')).toBe(true)
      expect(JSON.stringify(errors)).not.toContain('private-passcode')
    }
  })
  it('honors extraction capability suppression even when missing locations are accepted', () => {
    const problems: PlanProblem[] = []
    expect(
      parseBookingLocation({ id: 50, location: null, unsafeLocation: true }, [], problems, true),
    ).toBeNull()
    expect(problems[0]?.severity).toBe('import_blocker')
    const eventProblems: PlanProblem[] = []
    expect(
      parseEventLocation(
        {
          id: 20,
          unsafeLocation: true,
          locations: [
            {
              type: 'inPerson',
              address: 'Unrelated public fallback',
              displayLocationPublicly: true,
            },
          ],
        },
        eventProblems,
      ),
    ).toBeNull()
    expect(has(eventProblems, 'location_unsafe_source')).toBe(true)
  })
  it('requires an explicit missing-location decision', () => {
    const problems: PlanProblem[] = []
    expect(parseBookingLocation({ id: 50, location: null }, [], problems)).toBeNull()
    expect(problems[0]?.severity).toBe('import_blocker')
    const accepted: PlanProblem[] = []
    expect(parseBookingLocation({ id: 50, location: null }, [], accepted, true)).toBeNull()
    expect(accepted[0]?.severity).toBe('warning')
  })
})
