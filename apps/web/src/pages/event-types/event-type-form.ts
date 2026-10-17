// The event type form's state, its checks (the API's documented limits) and the mapping of
// the server's error codes back to fields. Inputs hold text; toInput turns a checked draft
// into the API's body.
import type { Schemas } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import type { EventType } from '../../api/resources.ts'
import { type FieldErrors, parseWhole, wholeNumberProblem } from '../../components/forms.tsx'
import { EVENT_TYPE, QUESTIONS, RULES } from '../../limits.ts'
import { isMultiLineText, isSingleLineText, singleLineProblem } from '../../text.ts'

export type QuestionType = Schemas['Question']['type']
export type LocationKind = NonNullable<EventType['location']>['kind']
export type EventTypeBody = Schemas['EventTypeInput']

export const QUESTION_TYPES: { value: QuestionType; label: string }[] = [
  { value: 'short_text', label: 'Short text' },
  { value: 'long_text', label: 'Long text' },
  { value: 'phone', label: 'Phone number' },
  { value: 'select', label: 'Pick one (dropdown)' },
  { value: 'multi_select', label: 'Pick several' },
  { value: 'checkbox', label: 'Checkbox' },
]

export const LOCATION_KINDS: { value: LocationKind | ''; label: string }[] = [
  { value: '', label: 'Not set' },
  { value: 'google_meet', label: 'Google Meet (link created per booking)' },
  { value: 'zoom', label: 'Zoom (link created per booking)' },
  { value: 'phone', label: 'Phone call' },
  { value: 'in_person', label: 'In person' },
  { value: 'link', label: 'Other video or meeting link' },
]

export const isChoice = (type: QuestionType) => type === 'select' || type === 'multi_select'

export interface OptionDraft {
  /** Stable while editing, for React and for field ids. */
  key: string
  text: string
}

export interface QuestionDraft {
  key: string
  /** Stable answer identity, allocated when added; existing saved ids are preserved. */
  id: string
  label: string
  type: QuestionType
  required: boolean
  /** Kept while the type is not a choice, so switching back restores them. */
  options: OptionDraft[]
}

export interface EventTypeDraft {
  title: string
  slug: string
  description: string
  durationMinutes: string
  slotStepMinutes: string
  locationKind: LocationKind | ''
  phone: string
  address: string
  url: string
  questions: QuestionDraft[]
  /** '' = the default schedule. */
  scheduleId: string
  bufferBeforeMinutes: string
  bufferAfterMinutes: string
  minimumNoticeMinutes: string
  maxBookingsPerDay: string
  bookingWindowDays: string
  position: string
  isActive: boolean
  isHidden: boolean
  allowGuests: boolean
}

let nextKey = 0
export const newKey = (prefix: string) => `${prefix}${++nextKey}`

export function newQuestion(): QuestionDraft {
  // A label or list counter can reuse a deleted question's id and attach its old answers.
  // getRandomValues also works on plain HTTP self-hosted instances.
  const id = `q_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')}`
  return { key: newKey('q'), id, label: '', type: 'short_text', required: false, options: [] }
}

export const newOption = (text = ''): OptionDraft => ({ key: newKey('o'), text })

/** A new event type: the API's defaults, 30 minutes long. */
export function emptyDraft(): EventTypeDraft {
  return {
    title: '',
    slug: '',
    description: '',
    durationMinutes: '30',
    slotStepMinutes: '',
    locationKind: '',
    phone: '',
    address: '',
    url: '',
    questions: [],
    scheduleId: '',
    bufferBeforeMinutes: '0',
    bufferAfterMinutes: '0',
    minimumNoticeMinutes: '0',
    maxBookingsPerDay: '',
    bookingWindowDays: '',
    position: '0',
    isActive: true,
    isHidden: false,
    allowGuests: false,
  }
}

const text = (n: number | null) => (n === null ? '' : String(n))

export function draftFromEventType(e: EventType): EventTypeDraft {
  const location = e.location
  return {
    title: e.title,
    slug: e.slug,
    description: e.description ?? '',
    durationMinutes: String(e.durationMinutes),
    slotStepMinutes: text(e.slotStepMinutes),
    locationKind: location?.kind ?? '',
    phone: location?.kind === 'phone' ? location.number : '',
    address: location?.kind === 'in_person' ? location.address : '',
    url: location?.kind === 'link' ? location.url : '',
    questions: e.questions.map((q) => ({
      key: newKey('q'),
      id: q.id,
      label: q.label,
      type: q.type,
      required: q.required,
      options: (q.options ?? []).map((o) => newOption(o)),
    })),
    scheduleId: e.scheduleId ?? '',
    bufferBeforeMinutes: String(e.bufferBeforeMinutes),
    bufferAfterMinutes: String(e.bufferAfterMinutes),
    minimumNoticeMinutes: String(e.minimumNoticeMinutes),
    maxBookingsPerDay: text(e.maxBookingsPerDay),
    bookingWindowDays: text(e.bookingWindowDays),
    position: String(e.position),
    isActive: e.isActive,
    isHidden: e.isHidden,
    allowGuests: e.allowGuests,
  }
}

/** What decides whether there are unsaved changes (not editing aids such as React keys). */
export function comparable(draft: EventTypeDraft): string {
  return JSON.stringify({
    ...draft,
    questions: draft.questions.map(({ key: _key, options, ...q }) => ({
      ...q,
      options: isChoice(q.type) ? options.map((o) => o.text) : [],
    })),
  })
}

/** "Intro call!" → "intro-call": a slug suggestion from a title. */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, EVENT_TYPE.slugMaxLength)
    .replace(/-+$/g, '')
}

// Field ids, which are also the keys of FieldErrors.
export const questionField = (q: QuestionDraft, part: 'label' | 'type' | 'options') =>
  `question-${q.key}-${part}`
export const optionField = (q: QuestionDraft, o: OptionDraft) => `question-${q.key}-option-${o.key}`

const NUMBER_FIELDS = [
  ['durationMinutes', true],
  ['slotStepMinutes', false],
  ['bufferBeforeMinutes', true],
  ['bufferAfterMinutes', true],
  ['minimumNoticeMinutes', true],
  ['maxBookingsPerDay', false],
  ['bookingWindowDays', false],
] as const satisfies readonly (readonly [keyof typeof RULES, boolean])[]

/** The problems with a draft, by field id; empty when it can be sent. */
export function validateDraft(draft: EventTypeDraft): FieldErrors {
  const errors: FieldErrors = {}
  const add = (field: string, problem: string | null) => {
    if (problem) errors[field] = problem
  }

  add('title', singleLineProblem(draft.title, 'a title', EVENT_TYPE.titleMaxLength))
  const slug = draft.slug.trim()
  if (slug === '') add('slug', 'Enter the last part of the booking link.')
  else if (slug.length > EVENT_TYPE.slugMaxLength) {
    add('slug', `Use at most ${EVENT_TYPE.slugMaxLength} characters.`)
  } else if (!EVENT_TYPE.slugPattern.test(slug)) {
    add(
      'slug',
      'Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.',
    )
  }
  const description = draft.description.trim()
  if (description.length > EVENT_TYPE.descriptionMaxLength) {
    add(
      'description',
      `Use at most ${EVENT_TYPE.descriptionMaxLength} characters (now ${description.length}).`,
    )
  } else if (!isMultiLineText(description)) {
    add('description', 'Remove special control characters (tabs and line breaks are fine).')
  }

  for (const [name, required] of NUMBER_FIELDS) {
    add(name, wholeNumberProblem(draft[name], RULES[name], required))
  }
  add(
    'position',
    wholeNumberProblem(
      draft.position,
      { min: EVENT_TYPE.positionMin, max: EVENT_TYPE.positionMax },
      true,
    ),
  )

  switch (draft.locationKind) {
    case 'phone':
      if (!EVENT_TYPE.phonePattern.test(draft.phone.trim())) {
        add('location-phone', 'Enter the number in international format, e.g. +14155550123.')
      }
      break
    case 'in_person':
      add(
        'location-address',
        singleLineProblem(draft.address, 'an address', EVENT_TYPE.addressMaxLength),
      )
      break
    case 'link':
      add('location-url', urlProblem(draft.url))
      break
  }

  if (draft.questions.length > QUESTIONS.maxQuestions) {
    add('questions', `Ask at most ${QUESTIONS.maxQuestions} questions.`)
  }
  for (const q of draft.questions) {
    add(
      questionField(q, 'label'),
      singleLineProblem(q.label, 'a question', QUESTIONS.labelMaxLength),
    )
    if (!isChoice(q.type)) continue
    if (q.options.length === 0) add(questionField(q, 'options'), 'Add at least one option.')
    if (q.options.length > QUESTIONS.maxOptions) {
      add(questionField(q, 'options'), `Offer at most ${QUESTIONS.maxOptions} options.`)
    }
    const seen = new Set<string>()
    for (const o of q.options) {
      const option = o.text.trim()
      if (seen.has(option) && option !== '') {
        add(optionField(q, o), 'This option is already in the list.')
      } else {
        add(optionField(q, o), singleLineProblem(o.text, 'an option', QUESTIONS.optionMaxLength))
      }
      seen.add(option)
    }
  }
  return errors
}

function urlProblem(value: string): string | null {
  const given = value.trim()
  const max = EVENT_TYPE.urlMaxLength
  if (given === '') return 'Enter the link.'
  if (!isSingleLineText(given)) return 'Use a link without spaces or control characters.'
  let url: URL
  try {
    url = new URL(given)
  } catch {
    return 'Enter a full link starting with https:// or http://.'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'Enter a link starting with https:// or http://.'
  }
  if (url.href.length > max) return `Use a link of at most ${max} characters.`
  return null
}

const whole = (value: string) => parseWhole(value)

/** The API body for a draft that passed validateDraft. */
export function toInput(draft: EventTypeDraft): EventTypeBody {
  const location: EventTypeBody['location'] = (() => {
    switch (draft.locationKind) {
      case '':
        return null
      case 'phone':
        return { kind: 'phone', number: draft.phone.trim() }
      case 'in_person':
        return { kind: 'in_person', address: draft.address.trim() }
      case 'link':
        return { kind: 'link', url: draft.url.trim() }
      default:
        return { kind: draft.locationKind }
    }
  })()
  return {
    title: draft.title.trim(),
    slug: draft.slug.trim(),
    description: draft.description.trim() || null,
    durationMinutes: whole(draft.durationMinutes) as number,
    slotStepMinutes: whole(draft.slotStepMinutes),
    bufferBeforeMinutes: whole(draft.bufferBeforeMinutes) as number,
    bufferAfterMinutes: whole(draft.bufferAfterMinutes) as number,
    minimumNoticeMinutes: whole(draft.minimumNoticeMinutes) as number,
    maxBookingsPerDay: whole(draft.maxBookingsPerDay),
    bookingWindowDays: whole(draft.bookingWindowDays),
    location,
    questions: draft.questions.map((q) => ({
      id: q.id,
      label: q.label.trim(),
      type: q.type,
      required: q.required,
      ...(isChoice(q.type) && { options: q.options.map((o) => o.text.trim()) }),
    })),
    scheduleId: draft.scheduleId || null,
    position: whole(draft.position) as number,
    isActive: draft.isActive,
    isHidden: draft.isHidden,
    allowGuests: draft.allowGuests,
  }
}

/** Field labels for the error summary, by field id. */
export function fieldLabels(draft: EventTypeDraft): Record<string, string> {
  const labels: Record<string, string> = {
    title: 'Title',
    slug: 'Booking link',
    description: 'Description',
    durationMinutes: 'Duration',
    slotStepMinutes: 'Start times every',
    'location-kind': 'Location',
    'location-phone': 'Phone number',
    'location-address': 'Address',
    'location-url': 'Meeting link',
    questions: 'Questions',
    scheduleId: 'Schedule',
    bufferBeforeMinutes: 'Buffer before',
    bufferAfterMinutes: 'Buffer after',
    minimumNoticeMinutes: 'Minimum notice',
    maxBookingsPerDay: 'Daily limit',
    bookingWindowDays: 'Booking window',
    position: 'Position',
  }
  draft.questions.forEach((q, i) => {
    const name = `Question ${i + 1}`
    labels[questionField(q, 'label')] = name
    labels[questionField(q, 'type')] = `${name} type`
    labels[questionField(q, 'options')] = `${name} options`
    q.options.forEach((o, j) => {
      labels[optionField(q, o)] = `${name}, option ${j + 1}`
    })
  })
  return labels
}

const RULE_MESSAGES: Record<string, string> = Object.fromEntries(
  Object.entries(RULES).map(([name, { min, max }]) => [
    name,
    `Enter a number from ${min.toLocaleString('en')} to ${max.toLocaleString('en')}.`,
  ]),
)

/**
 * The server's refusal of a draft, as field messages where it names a field (its codes are
 * documented on the event type routes), and otherwise as a message for the whole form.
 */
export function serverErrors(
  err: unknown,
  draft: EventTypeDraft,
): { fields: FieldErrors; message: string | null } {
  if (!(err instanceof RequestError)) return { fields: {}, message: null }
  const field = (id: string, message: string) => ({ fields: { [id]: message }, message: null })
  const detail = err.message
  switch (err.code) {
    case 'invalid_slug':
      return field(
        'slug',
        'Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.',
      )
    case 'slug_taken':
      return field('slug', 'Another of your event types already uses this link. Choose another.')
    case 'invalid_schedule_id':
      return field('scheduleId', 'This schedule no longer exists. Choose another one.')
    case 'invalid_event_type': {
      // The message names the field first: "durationMinutes must be …".
      const name = /^([A-Za-z]+)\b/.exec(detail)?.[1] ?? ''
      if (name in RULE_MESSAGES) return field(name, RULE_MESSAGES[name] as string)
      if (name === 'title') {
        return field('title', 'Use one line of up to 200 characters without control characters.')
      }
      if (name === 'description') {
        return field(
          'description',
          'Use at most 5000 characters, without control characters other than tabs and line breaks.',
        )
      }
      if (name === 'position') return field('position', 'Enter a whole number.')
      return { fields: {}, message: detail }
    }
    case 'invalid_location': {
      if (/location\.number/.test(detail)) {
        return field(
          'location-phone',
          'Enter the number in international format, e.g. +14155550123.',
        )
      }
      if (/location\.address/.test(detail)) {
        return field('location-address', 'Enter an address of up to 500 characters on one line.')
      }
      if (/location\.url/.test(detail)) {
        return field('location-url', 'Enter an http or https link of up to 2000 characters.')
      }
      return field('location-kind', detail)
    }
    case 'invalid_questions': {
      // "questions.2.options.1: …", "questions.0.label: …" or a message about the list.
      const match = /^questions\.(\d+)(?:\.(\w+))?(?:\.(\d+))?: (.*)$/s.exec(detail)
      const q = match ? draft.questions[Number(match[1])] : undefined
      if (!match || !q) return field('questions', detail)
      const [, , part, optionIndex, problem = detail] = match
      if (part === 'options') {
        const o = optionIndex === undefined ? undefined : q.options[Number(optionIndex)]
        return o ? field(optionField(q, o), problem) : field(questionField(q, 'options'), problem)
      }
      if (part === 'type') return field(questionField(q, 'type'), problem)
      return field(questionField(q, 'label'), problem)
    }
    default:
      return { fields: {}, message: detail }
  }
}
