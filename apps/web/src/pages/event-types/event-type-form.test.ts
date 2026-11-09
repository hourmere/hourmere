import '../../i18n/admin.ts'
import { describe, expect, it, vi } from 'vitest'
import { RequestError } from '../../api/errors.ts'
import { translateMessage } from '../../i18n/translate.ts'
import { eventType } from '../../test/fixtures.ts'
import {
  allowedDurationsProblem,
  comparable,
  draftFromEventType,
  durationToAddProblem,
  emptyDraft,
  newOption,
  newQuestion,
  optionField,
  questionField,
  serverErrors,
  slugify,
  suggestedBookingSlug,
  toInput,
  toPatchInput,
  validateDraft,
} from './event-type-form.ts'

const renderedDraftErrors = (...args: Parameters<typeof validateDraft>) =>
  Object.fromEntries(
    Object.entries(validateDraft(...args)).map(([key, value]) => [
      key,
      translateMessage('en', value),
    ]),
  )

describe.each([
  { mode: 'collective', min: 2, max: 8 },
  { mode: 'round_robin', min: 1, max: 8 },
] as const)('$mode host count boundaries', ({ mode, min, max }) => {
  it.each([min - 1, min, max, max + 1])('validates %i selected hosts', (count) => {
    const draft = {
      ...emptyDraft(),
      schedulingType: mode,
      hostUserIds: Array.from(
        { length: count },
        (_, index) => `00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`,
      ),
    }
    expect(validateDraft(draft).hosts !== undefined).toBe(count < min || count > max)
  })
})
describe('slugify', () => {
  it.each([
    ['Intro call', 'intro-call'],
    ['  Café & Crème brûlée! ', 'cafe-creme-brulee'],
    ['30 min — Q&A', '30-min-q-a'],
    ['日本語', ''],
    [`${'a'.repeat(63)} b`, 'a'.repeat(63)],
  ])('%j → %j', (title, slug) => {
    expect(slugify(title)).toBe(slug)
  })
})

describe('suggestedBookingSlug', () => {
  it.each([
    ['30分钟咨询', '30', '30-min'],
    ['30分钟面谈', '45', '45-min'],
    ['初次沟通', '60', '60-min'],
    ['123', '30', '30-min'],
    ['30 min — Q&A', '30', '30-min-q-a'],
    ['Intro call', '30', 'intro-call'],
    ['  ', '30', ''],
  ])('suggests %j at %s minutes as %j', (title, duration, expected) => {
    expect(suggestedBookingSlug(title, duration)).toBe(expected)
  })
})

describe('question identity', () => {
  it('allocates distinct valid identities for same-label and replacement questions', () => {
    const first = { ...newQuestion(), label: 'Company' }
    const second = { ...newQuestion(), label: 'Company' }
    const replacement = { ...newQuestion(), label: 'Company' }
    expect(new Set([first.id, second.id, replacement.id]).size).toBe(3)
    for (const q of [first, second, replacement]) {
      expect(q.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
      expect(q.id).not.toBe('company')
    }
  })

  it('does not reuse identities when the editor is loaded in a new page', async () => {
    vi.resetModules()
    const firstPage = await import('./event-type-form.ts')
    const old = firstPage.newQuestion().id
    vi.resetModules()
    const nextPage = await import('./event-type-form.ts')
    expect(nextPage.newQuestion().id).not.toBe(old)
  })

  it('keeps ids through renames, reordering, repeated serialization and server round trips', () => {
    const saved = { ...newQuestion(), id: 'company', label: 'Company' }
    const added = { ...newQuestion(), label: 'Company' }
    const draft = { ...emptyDraft(), questions: [saved, added] }
    expect(toInput(draft).questions?.map((q) => q.id)).toEqual(['company', added.id])
    expect(toInput(draft)).toEqual(toInput(draft))
    const changed = { ...draft, questions: [{ ...added, label: 'New question' }, saved] }
    expect(toInput(changed).questions?.map((q) => q.id)).toEqual([added.id, 'company'])
    const reloaded = draftFromEventType(eventType(toInput(changed)))
    expect(toInput(reloaded).questions).toEqual(toInput(changed).questions)
    expect(comparable(reloaded)).toBe(comparable(draftFromEventType(eventType(toInput(changed)))))
  })

  it('preserves a saved id without allocating a new one on load', () => {
    const persisted = eventType({
      questions: [{ id: 'legacy-question', label: 'Renamed', type: 'short_text', required: false }],
    })
    expect(toInput(draftFromEventType(persisted)).questions).toEqual(persisted.questions)
  })
})

describe('validateDraft', () => {
  it('round-trips invitee-phone compatibility without requiring a host number on metadata saves', () => {
    const draft = draftFromEventType(eventType({ location: { kind: 'phone', askInvitee: true } }))
    expect(draft.locationKind).toBe('phone')
    expect(draft.phone).toBe('')
    expect(draft.phoneAskInvitee).toBe(true)
    expect(toInput(draft).locations).toEqual([
      { id: draft.primaryLocationId, kind: 'phone', askInvitee: true },
    ])
    const renamed = { ...draft, title: 'Renamed' }
    expect(renderedDraftErrors(renamed, draft)).toEqual({})
    expect(toPatchInput(renamed, draft)).not.toHaveProperty('location')
    expect(
      draftFromEventType(eventType({ location: { kind: 'phone', number: '+14155550123' } })).phone,
    ).toBe('+14155550123')
  })

  it('validates a deliberate switch from invitee phone to a host number', () => {
    const draft = draftFromEventType(eventType({ location: { kind: 'phone', askInvitee: true } }))
    expect(renderedDraftErrors({ ...draft, phone: '0301234567' }, draft)).toHaveProperty(
      'location-phone',
    )
    const hostPhone = { ...draft, phone: ' +14155550123 ' }
    expect(renderedDraftErrors(hostPhone, draft)).toEqual({})
    expect(toPatchInput(hostPhone, draft).location).toEqual({
      kind: 'phone',
      number: '+14155550123',
    })
    expect(
      renderedDraftErrors({
        ...emptyDraft(),
        title: 'Intro',
        slug: 'intro',
        locationKind: 'phone',
      }),
    ).toHaveProperty('location-phone')
  })

  it('keeps provider labels inert until explicit automatic opt-in, and preserves that opt-in through a round trip', () => {
    const legacy = draftFromEventType(eventType({ location: { kind: 'google_meet' } }))
    expect(legacy.autoCreateMeet).toBe(false)
    expect(toInput(legacy).location).toEqual({ kind: 'google_meet' })
    const enabled = draftFromEventType(
      eventType({ location: { kind: 'google_meet', autoCreate: true } }),
    )
    expect(enabled.autoCreateMeet).toBe(true)
    expect(toInput({ ...enabled, title: 'Renamed' }).location).toEqual({
      kind: 'google_meet',
      autoCreate: true,
    })
    expect(toInput({ ...enabled, locationKind: 'zoom' }).location).toEqual({ kind: 'zoom' })
    expect(renderedDraftErrors({ ...enabled, schedulingType: 'collective' })).toHaveProperty(
      'conferenceOrganizer',
      'Choose the meeting organizer from the required hosts.',
    )
  })
  it('preserves an explicit non-first collective organizer and rejects missing or removed choices', () => {
    const ids = ['00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002']
    const value = {
      ...emptyDraft(),
      title: 'Panel',
      slug: 'panel',
      schedulingType: 'collective' as const,
      hostUserIds: ids,
      locationKind: 'google_meet' as const,
      autoCreateMeet: true,
      conferenceOrganizerUserId: ids[1] as string,
    }
    expect(renderedDraftErrors(value)).toEqual({})
    expect(toInput(value).conferenceOrganizer).toEqual({ userId: ids[1] })
    const restored = draftFromEventType(
      eventType({ ...toInput(value), conferenceOrganizer: { userId: ids[1] as string } }),
    )
    expect(restored.conferenceOrganizerUserId).toBe(ids[1])
    expect(renderedDraftErrors({ ...value, conferenceOrganizerUserId: '' })).toHaveProperty(
      'conferenceOrganizer',
    )
    expect(
      renderedDraftErrors({
        ...value,
        hostUserIds: [ids[0] as string, '00000000-0000-7000-8000-000000000003'],
      }),
    ).toHaveProperty('conferenceOrganizer')
    expect(toInput({ ...value, schedulingType: 'round_robin' }).conferenceOrganizer).toBeNull()
  })
  it('accepts the defaults with a title and slug', () => {
    expect(renderedDraftErrors({ ...emptyDraft(), title: 'Intro', slug: 'intro' })).toEqual({})
  })

  it('refuses control characters and overlong text the way the server does', () => {
    const errors = renderedDraftErrors({
      ...emptyDraft(),
      title: 'Intro\u0007',
      slug: 'a'.repeat(65),
      description: `${'x'.repeat(5001)}`,
      locationKind: 'link',
      url: 'ftp://example.com/',
    })
    expect(errors).toEqual({
      title: 'Use one line of text without special control characters.',
      slug: 'Use at most 64 characters.',
      description: 'Use at most 5000 characters (now 5001).',
      'location-url': 'Enter a link starting with https:// or http://.',
    })
  })

  it('allows line breaks in the description but not other controls', () => {
    const base = { ...emptyDraft(), title: 'Intro', slug: 'intro' }
    expect(renderedDraftErrors({ ...base, description: 'a\n\tb' })).toEqual({})
    expect(renderedDraftErrors({ ...base, description: 'a b' })).toHaveProperty('description')
  })

  it('needs options for choice questions, at most 50', () => {
    const q = {
      ...newQuestion(),
      label: 'Pick',
      type: 'select' as const,
      options: Array.from({ length: 51 }, (_, i) => newOption(`o${i}`)),
    }
    expect(renderedDraftErrors({ ...emptyDraft(), title: 'T', slug: 't', questions: [q] })).toEqual(
      {
        [questionField(q, 'options')]: 'Offer at most 50 options.',
      },
    )
  })
})

describe('location compatibility metadata saves', () => {
  it.each([
    null,
    { kind: 'phone', number: '+14155550123' },
    { kind: 'in_person', address: 'HQ' },
    { kind: 'link', url: 'https://example.com/room' },
    { kind: 'google_meet' },
    { kind: 'zoom' },
  ] as const)(
    'omits unchanged compat value %j so the saved option list is preserved',
    (location) => {
      const baseline = draftFromEventType(eventType({ location }))
      const draft = { ...baseline, title: 'Renamed' }
      expect(renderedDraftErrors(draft, baseline)).toEqual({})
      expect(toPatchInput(draft, baseline)).not.toHaveProperty('location')
    },
  )

  it('preserves a future location kind on metadata saves without sending an incomplete value', () => {
    const baseline = draftFromEventType(
      eventType({ location: { kind: 'future_location', setting: 'opaque' } as never }),
    )
    const draft = { ...baseline, title: 'Renamed' }
    expect(renderedDraftErrors(draft, baseline)).toEqual({})
    expect(toPatchInput(draft, baseline)).not.toHaveProperty('location')
  })

  it('sends explicit location edits, clearing, and changes after a metadata save', () => {
    const baseline = draftFromEventType(
      eventType({ location: { kind: 'phone', number: '+14155550123' } }),
    )
    expect(toPatchInput({ ...baseline, phone: '+442071838750' }, baseline).location).toEqual({
      kind: 'phone',
      number: '+442071838750',
    })
    expect(
      toPatchInput({ ...baseline, locationKind: 'in_person', address: 'HQ' }, baseline).location,
    ).toEqual({ kind: 'in_person', address: 'HQ' })
    expect(toPatchInput({ ...baseline, locationKind: '' }, baseline).location).toBeNull()
    expect(toPatchInput({ ...baseline, title: 'Renamed' }, baseline)).not.toHaveProperty('location')
  })
})

describe('serverErrors', () => {
  const q = { ...newQuestion(), label: 'Plan', type: 'select' as const, options: [newOption('A')] }
  const draft = { ...emptyDraft(), questions: [q] }
  const refused = (code: string, message: string) => new RequestError(400, code, message)

  it.each([
    ['questions.0.options.0: options must be distinct', optionField(q, q.options[0] as never)],
    ['questions.0.options: select needs options', questionField(q, 'options')],
    ['questions.0.type: Invalid option', questionField(q, 'type')],
    ['questions.0.id: id must be 1 to 64 letters', questionField(q, 'label')],
    ['questions.7.label: Too big', 'questions'],
    ['Too big: expected array to have <=20 items', 'questions'],
  ])('puts %j on its field', (message, field) => {
    expect(Object.keys(serverErrors(refused('invalid_questions', message), draft).fields)).toEqual([
      field,
    ])
  })

  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'keeps an unknown server field named %s as literal form text',
    (name) => {
      const detail = `${name} must be checked by the server.`
      const mapped = serverErrors(refused('invalid_event_type', detail), draft)
      expect(mapped).toEqual({ fields: {}, message: { literal: detail } })
      expect(translateMessage('zh-CN', mapped.message)).toBe(detail)
    },
  )

  it('puts a known host refusal on its field without translating arbitrary server detail', () => {
    expect(serverErrors(refused('invalid_hosts', 'Server policy detail'), draft)).toEqual({
      fields: {
        hosts:
          'Choose one individual host, two to eight collective hosts, or one to eight round-robin pool members. Changes affect new bookings; existing meetings retain their original hosts.',
      },
      message: null,
    })
  })

  it('keeps unknown codes for the whole form', () => {
    expect(serverErrors(refused('something_new', 'Something new.'), draft)).toEqual({
      fields: {},
      message: { literal: 'Something new.' },
    })
    expect(serverErrors(new TypeError('Failed to fetch'), draft)).toEqual({
      fields: {},
      message: null,
    })
  })
})

describe('explicit Zoom configuration', () => {
  const pin = '00000000-0000-7000-8000-000000000099'
  it('keeps passive labels inert, requires a deliberate account and preserves an automatic round trip', () => {
    const value = draftFromEventType(
      eventType({ location: { kind: 'zoom' }, zoomConnectionId: null }),
    )
    expect(value.autoCreateZoom).toBe(false)
    expect(value.zoomConnectionId).toBe('')
    expect(toInput(value)).not.toHaveProperty('zoomConnectionId')
    expect(toInput(value).location).toEqual({ kind: 'zoom' })
    expect(renderedDraftErrors({ ...value, autoCreateZoom: true })).toHaveProperty(
      'zoomConnectionId',
    )
    const enabled = { ...value, autoCreateZoom: true, zoomConnectionId: pin }
    expect(renderedDraftErrors(enabled)).toEqual({})
    expect(toInput(enabled)).toMatchObject({
      location: { kind: 'zoom', autoCreate: true },
      zoomConnectionId: pin,
    })
    expect(draftFromEventType(eventType(toInput(enabled)))).toMatchObject({
      autoCreateZoom: true,
      zoomConnectionId: pin,
    })
    expect(renderedDraftErrors({ ...enabled, schedulingType: 'round_robin' })).toHaveProperty(
      'location-kind',
    )
  })
  it('omits unchanged authorization on metadata saves and disable, but sends an explicitly changed account', () => {
    const original = draftFromEventType(
      eventType({ location: { kind: 'zoom', autoCreate: true }, zoomConnectionId: pin }),
    )
    const metadata = toPatchInput({ ...original, title: 'literal unsaved title' }, original)
    for (const key of ['location', 'hosts', 'schedulingType', 'zoomConnectionId', 'scheduleId'])
      expect(metadata).not.toHaveProperty(key)
    const disabled = toPatchInput({ ...original, autoCreateZoom: false }, original)
    expect(disabled.location).toEqual({ kind: 'zoom' })
    expect(disabled).not.toHaveProperty('zoomConnectionId')
    expect(
      toPatchInput(
        { ...original, zoomConnectionId: '00000000-0000-7000-8000-000000000100' },
        original,
      ),
    ).toHaveProperty('zoomConnectionId', '00000000-0000-7000-8000-000000000100')
  })
  it.each([
    'automatic_zoom_disabled',
    'automatic_zoom_unavailable',
    'automatic_zoom_host_policy',
    'zoom_host_session_required',
    'invalid_zoom_connection',
  ])('maps %s to a bounded local message', (code) => {
    const result = serverErrors(new RequestError(403, code, 'unsafe provider detail'), emptyDraft())
    expect(JSON.stringify(result)).not.toContain('unsafe provider detail')
    expect(Object.keys(result.fields)).toHaveLength(1)
  })
})

describe('multiple duration draft validation', () => {
  const draft = { ...emptyDraft(), title: 'Intro', slug: 'intro' }
  it.each([30, 45])(
    'keeps a single-duration create payload unchanged for %i minutes',
    (minutes) => {
      const value = {
        ...draft,
        durationMinutes: String(minutes),
        allowedDurationsMinutes: [minutes],
      }
      expect(toInput(value)).toHaveProperty('durationMinutes', minutes)
      expect(toInput(value)).not.toHaveProperty('allowedDurationsMinutes')
    },
  )

  it.each([{ durations: [30] }, { durations: [15, 30, 60] }])(
    'omits an unchanged offered list from a patch (baseline $durations)',
    ({ durations }) => {
      const original = { ...draft, allowedDurationsMinutes: durations }
      expect(toPatchInput({ ...original, title: 'Renamed' }, original)).not.toHaveProperty(
        'allowedDurationsMinutes',
      )
    },
  )

  it('sends an explicitly reduced single-duration list, but omits it after reverting the edit', () => {
    const original = { ...draft, allowedDurationsMinutes: [15, 30, 60] }
    const reduced = { ...draft, allowedDurationsMinutes: [30] }
    expect(toPatchInput(reduced, original).allowedDurationsMinutes).toEqual([30])
    expect(
      toPatchInput({ ...reduced, allowedDurationsMinutes: [15, 30, 60] }, original),
    ).not.toHaveProperty('allowedDurationsMinutes')
    // A default-only change leaves the remotely configured offered list alone.
    expect(toPatchInput({ ...original, durationMinutes: '60' }, original)).not.toHaveProperty(
      'allowedDurationsMinutes',
    )
  })

  it.each([
    [[], 'Offer from 1 to 12 durations.'],
    [Array.from({ length: 13 }, (_, index) => index + 1), 'Offer from 1 to 12 durations.'],
    [[30, 30], 'Offer each duration only once.'],
    [[15, 60], 'Include the default duration in the allowed durations.'],
    [[0, 30], 'Enter a number from 1 to 1,440.'],
    [[30, 1441], 'Enter a number from 1 to 1,440.'],
    [[1.5, 30], 'Enter a number from 1 to 1,440.'],
  ])('rejects malformed offered lengths %j with the server rule', (values, problem) => {
    expect(renderedDraftErrors({ ...draft, allowedDurationsMinutes: values })).toHaveProperty(
      'allowedDurationsMinutes',
      problem,
    )
  })

  it('accepts twelve distinct lengths including both bounds and retains them through both writes', () => {
    const values = [1, 15, 30, 45, 60, 90, 120, 180, 240, 360, 720, 1440]
    const value = { ...draft, allowedDurationsMinutes: values, durationMinutes: '90' }
    expect(validateDraft(value)).toEqual({})
    expect(toInput(value)).toMatchObject({ allowedDurationsMinutes: values, durationMinutes: 90 })
    expect(toPatchInput(value, draft)).toMatchObject({
      allowedDurationsMinutes: values,
      durationMinutes: 90,
    })
    const saved = draftFromEventType(eventType(toInput(value)))
    expect(saved.allowedDurationsMinutes).toEqual(values)
    expect(saved.durationMinutes).toBe('90')
    expect(comparable(saved)).not.toBe(comparable({ ...saved, allowedDurationsMinutes: [90] }))
  })

  it.each([
    [
      'allowedDurationsMinutes must contain from 1 to 12 durations',
      'Offer from 1 to 12 durations.',
    ],
    ['allowedDurationsMinutes must contain distinct durations', 'Offer each duration only once.'],
    [
      'allowedDurationsMinutes must include durationMinutes',
      'Include the default duration in the allowed durations.',
    ],
  ])('maps the server refusal %s to the list', (detail, message) => {
    const mapped = serverErrors(new RequestError(400, 'invalid_event_type', detail), draft)
    expect(mapped).toEqual({ fields: { allowedDurationsMinutes: message }, message: null })
  })

  it('uses the same limits for custom additions and stored lists', () => {
    expect(durationToAddProblem('30', [30])).toBe('This duration is already in the list.')
    expect(durationToAddProblem('1440', [30])).toBeNull()
    expect(allowedDurationsProblem([30, 1440], '1440')).toBeNull()
  })
})

describe('booking limit drafts', () => {
  const baseline = draftFromEventType(
    eventType({
      maxBookingsPerDay: 2,
      maxBookingsPerWeek: 5,
      maxBookingsPerMonth: 10,
    }),
  )
  it('loads and round-trips all limits, tracks edits, and clears optional limits', () => {
    expect(baseline).toMatchObject({
      maxBookingsPerDay: '2',
      maxBookingsPerWeek: '5',
      maxBookingsPerMonth: '10',
    })
    expect(toInput(baseline)).toMatchObject({
      maxBookingsPerDay: 2,
      maxBookingsPerWeek: 5,
      maxBookingsPerMonth: 10,
    })
    for (const name of [
      'maxBookingsPerDay',
      'maxBookingsPerWeek',
      'maxBookingsPerMonth',
    ] as const) {
      expect(toPatchInput({ ...baseline, title: 'Metadata' }, baseline)).not.toHaveProperty(name)
      expect(toPatchInput({ ...baseline, [name]: '' }, baseline)).toHaveProperty(name, null)
      expect(comparable({ ...baseline, [name]: '' })).not.toBe(comparable(baseline))
    }
    expect(toPatchInput({ ...baseline, maxBookingsPerWeek: '6' }, baseline)).toHaveProperty(
      'maxBookingsPerWeek',
      6,
    )
    expect(toPatchInput({ ...baseline, maxBookingsPerMonth: '12' }, baseline)).toHaveProperty(
      'maxBookingsPerMonth',
      12,
    )
  })
  it.each(['maxBookingsPerWeek', 'maxBookingsPerMonth'] as const)(
    'validates optional integer bounds for %s',
    (name) => {
      const draft = { ...emptyDraft(), title: 'Intro', slug: 'intro' }
      for (const value of ['', '1', '1000'])
        expect(validateDraft({ ...draft, [name]: value })).toEqual({})
      for (const value of ['0', '1001', '1.5', 'abc', '-1'])
        expect(validateDraft({ ...draft, [name]: value })).toHaveProperty(name)
      const errors = serverErrors(
        new RequestError(400, 'invalid_event_type', `${name} must be an integer from 1 to 1000`),
        draft,
      )
      expect(translateMessage('en', errors.fields[name])).toBe('Enter a number from 1 to 1,000.')
    },
  )
  it.each([
    ['maxBookingsPerDay', 'maxBookingsPerWeek', 'Weekly limit must be at least the daily limit.'],
    [
      'maxBookingsPerWeek',
      'maxBookingsPerMonth',
      'Monthly limit must be at least the weekly limit.',
    ],
    ['maxBookingsPerDay', 'maxBookingsPerMonth', 'Monthly limit must be at least the daily limit.'],
  ] as const)('checks %s ≤ %s and maps the server refusal', (shorter, longer, message) => {
    const draft = { ...emptyDraft(), title: 'Intro', slug: 'intro', [shorter]: '5', [longer]: '4' }
    expect(renderedDraftErrors(draft)).toEqual({ [longer]: message })
    expect(validateDraft({ ...draft, [longer]: '5' })).toEqual({})
    const mapped = serverErrors(
      new RequestError(400, 'invalid_event_type', `${longer} must be at least ${shorter}`),
      draft,
    )
    expect(mapped).toEqual({ fields: { [longer]: message }, message: null })
    expect(translateMessage('zh-CN', mapped.fields[longer])).not.toBe(message)
  })
})

it.each(['', 'google_meet', 'zoom', 'phone', 'in_person', 'link'] as const)(
  'keeps the legacy essentials request byte-identical for %s',
  (locationKind) => {
    const location =
      locationKind === ''
        ? null
        : locationKind === 'phone'
          ? { kind: locationKind, number: '+14155550123' }
          : locationKind === 'in_person'
            ? { kind: locationKind, address: '42 Main Street' }
            : locationKind === 'link'
              ? { kind: locationKind, url: 'https://example.com/meeting' }
              : { kind: locationKind }
    expect(
      JSON.stringify(
        toInput({
          ...emptyDraft(),
          title: 'Intro',
          slug: 'intro',
          locationKind,
          phone: '+14155550123',
          address: '42 Main Street',
          url: 'https://example.com/meeting',
        }),
      ),
    ).toBe(
      JSON.stringify({
        title: 'Intro',
        slug: 'intro',
        description: null,
        durationMinutes: 30,
        slotStepMinutes: null,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        minimumNoticeMinutes: 0,
        maxBookingsPerDay: null,
        maxBookingsPerWeek: null,
        maxBookingsPerMonth: null,
        bookingWindowDays: null,
        location,
        questions: [],
        scheduleId: null,
        position: 0,
        isActive: true,
        isHidden: false,
        allowGuests: false,
      }),
    )
  },
)
