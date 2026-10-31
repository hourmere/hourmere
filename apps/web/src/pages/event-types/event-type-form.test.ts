import { describe, expect, it, vi } from 'vitest'
import { RequestError } from '../../api/errors.ts'
import { translateMessage } from '../../i18n/translate.ts'
import { eventType } from '../../test/fixtures.ts'
import {
  comparable,
  draftFromEventType,
  emptyDraft,
  newOption,
  newQuestion,
  optionField,
  questionField,
  serverErrors,
  slugify,
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
