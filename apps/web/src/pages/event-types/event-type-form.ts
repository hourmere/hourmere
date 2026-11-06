// The event type form's state, its checks (the API's documented limits) and the mapping of
// the server's error codes back to fields. Inputs hold text; toInput turns a checked draft
// into the API's body.
import type { Schemas } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import type { EventType } from '../../api/resources.ts'
import { type FieldErrors, parseWhole, wholeNumberProblem } from '../../components/forms.tsx'
import { literal, msg, type UiText } from '../../i18n/translate.ts'
import { EVENT_TYPE, QUESTIONS, RULES } from '../../limits.ts'
import { isMultiLineText, isSingleLineText, singleLineProblem } from '../../text.ts'
import {
  comparableNotifications,
  defaultNotificationsDraft,
  type NotificationsDraft,
  notificationField,
  notificationServerErrors,
  notificationsFromSettings,
  notificationsInput,
  validateNotificationsDraft,
} from './notifications-form.ts'

export type QuestionType = Schemas['Question']['type']
export type LocationKind = NonNullable<EventType['location']>['kind']
export type EventTypeBody = Schemas['EventTypeInput']
export const SUCCESS_REDIRECT_PARAMETERS = [
  'eventTypeSlug',
  'start',
  'end',
  'timeZone',
  'hostName',
  'inviteeName',
  'inviteeEmail',
] as const
export type SuccessRedirectParameter = (typeof SUCCESS_REDIRECT_PARAMETERS)[number]

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
  { value: 'google_meet', label: 'Google Meet (provider label only)' },
  { value: 'zoom', label: 'Zoom (provider label only)' },
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
  schedulingType: EventType['schedulingType']
  hostUserIds: string[]
  title: string
  slug: string
  description: string
  durationMinutes: string
  allowedDurationsMinutes: number[]
  slotStepMinutes: string
  locationKind: LocationKind | ''
  autoCreateZoom: boolean
  zoomConnectionId: string
  autoCreateMeet: boolean
  conferenceOrganizerUserId: string
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
  waitlistEnabled: boolean
  successRedirectUrl: string
  successRedirectParameters: SuccessRedirectParameter[]
  includeInviteePersonalData: boolean
  allowEmbedParent: boolean
  notifications: NotificationsDraft
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
    schedulingType: 'individual',
    hostUserIds: [],
    title: '',
    slug: '',
    description: '',
    durationMinutes: '30',
    allowedDurationsMinutes: [30],
    slotStepMinutes: '',
    locationKind: '',
    autoCreateZoom: false,
    zoomConnectionId: '',
    autoCreateMeet: false,
    conferenceOrganizerUserId: '',
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
    waitlistEnabled: false,
    successRedirectUrl: '',
    successRedirectParameters: [],
    includeInviteePersonalData: false,
    allowEmbedParent: false,
    notifications: defaultNotificationsDraft(),
  }
}

const text = (n: number | null) => (n === null ? '' : String(n))

export function draftFromEventType(e: EventType): EventTypeDraft {
  const location = e.location
  return {
    schedulingType: e.schedulingType,
    hostUserIds: (e.hosts ?? []).map((h) => h.userId),
    title: e.title,
    slug: e.slug,
    description: e.description ?? '',
    durationMinutes: String(e.durationMinutes),
    allowedDurationsMinutes: [...e.allowedDurationsMinutes],
    slotStepMinutes: text(e.slotStepMinutes),
    locationKind: location?.kind ?? '',
    autoCreateZoom: location?.kind === 'zoom' && location.autoCreate === true,
    zoomConnectionId: e.zoomConnectionId ?? '',
    autoCreateMeet: location?.kind === 'google_meet' && location.autoCreate === true,
    conferenceOrganizerUserId: e.conferenceOrganizer?.userId ?? '',
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
    waitlistEnabled: e.waitlist?.enabled ?? false,
    successRedirectUrl: e.successRedirect?.url ?? '',
    successRedirectParameters: [...(e.successRedirect?.parameters ?? [])],
    includeInviteePersonalData: e.successRedirect?.includeInviteePersonalData ?? false,
    allowEmbedParent: e.successRedirect?.allowEmbedParent ?? false,
    notifications: notificationsFromSettings(e.notifications),
  }
}

/** What decides whether there are unsaved changes (not editing aids such as React keys). */
export function comparable(draft: EventTypeDraft): string {
  return JSON.stringify({
    ...draft,
    notifications: comparableNotifications(draft.notifications),
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

/** Keep titles in any language usable without asking the host to invent a Latin link. */
export function suggestedBookingSlug(title: string, durationMinutes: string): string {
  if (!title.trim()) return ''
  const slug = slugify(title)
  const duration = parseWhole(durationMinutes)
  return /[a-z]/.test(slug) ? slug : `${duration !== null && duration > 0 ? duration : 30}-min`
}

/** The same distinct-count and length bounds as the scheduling service. */
export function durationToAddProblem(value: string, durations: number[]): UiText | null {
  const problem = wholeNumberProblem(value, RULES.durationMinutes, true)
  if (problem) return problem
  if (durations.includes(parseWhole(value) as number))
    return 'This duration is already in the list.'
  if (durations.length >= EVENT_TYPE.maxAllowedDurations) return 'Offer from 1 to 12 durations.'
  return null
}

export function allowedDurationsProblem(
  durations: number[],
  defaultDuration: string,
): UiText | null {
  if (durations.length < 1 || durations.length > EVENT_TYPE.maxAllowedDurations)
    return 'Offer from 1 to 12 durations.'
  if (
    durations.some(
      (value) =>
        !Number.isInteger(value) ||
        value < RULES.durationMinutes.min ||
        value > RULES.durationMinutes.max,
    )
  )
    return msg('Enter a number from {0} to {1}.', { '0': '1', '1': '1,440' })
  if (new Set(durations).size !== durations.length) return 'Offer each duration only once.'
  if (!durations.includes(parseWhole(defaultDuration) as number))
    return 'Include the default duration in the allowed durations.'
  return null
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
export function validateDraft(draft: EventTypeDraft, baseline?: EventTypeDraft): FieldErrors {
  const errors: FieldErrors = {}
  if (
    draft.waitlistEnabled &&
    draft.waitlistEnabled !== baseline?.waitlistEnabled &&
    (draft.schedulingType !== 'individual' || draft.hostUserIds.length > 1)
  )
    errors.waitlist =
      'Waitlists are available only for one-on-one event types with a single host (not round-robin or collective).'
  // Untouched stored notes may predate tighter write rules; omission preserves them.
  if (
    comparableNotifications(draft.notifications) !==
    comparableNotifications(baseline?.notifications ?? defaultNotificationsDraft())
  )
    Object.assign(errors, validateNotificationsDraft(draft.notifications))
  if (draft.locationKind === 'zoom' && draft.autoCreateZoom) {
    if (draft.schedulingType !== 'individual' || draft.hostUserIds.length > 1)
      errors['location-kind'] = msg(
        'Automatic Zoom supports individual meetings with exactly one host.',
      )
    if (!draft.zoomConnectionId)
      errors.zoomConnectionId = msg('Choose your own authorized Zoom meetings account.')
  }
  if (
    draft.locationKind === 'google_meet' &&
    draft.autoCreateMeet &&
    draft.schedulingType === 'collective' &&
    !draft.hostUserIds.includes(draft.conferenceOrganizerUserId)
  )
    errors.conferenceOrganizer = msg('Choose the meeting organizer from the required hosts.')
  if (
    draft.schedulingType === 'collective' &&
    (draft.hostUserIds.length < 2 || draft.hostUserIds.length > 8)
  )
    errors.hosts = 'Choose two to eight required hosts.'
  if (
    draft.schedulingType === 'round_robin' &&
    (draft.hostUserIds.length < 1 || draft.hostUserIds.length > 8)
  )
    errors.hosts = 'Choose one to eight pool members.'
  if (new Set(draft.hostUserIds).size !== draft.hostUserIds.length)
    errors.hosts = 'Choose each host once.'
  const add = (field: string, problem: UiText | null) => {
    if (problem) errors[field] = problem
  }

  add('title', singleLineProblem(draft.title, 'a title', EVENT_TYPE.titleMaxLength))
  const slug = draft.slug.trim()
  if (slug === '') add('slug', 'Enter the last part of the booking link.')
  else if (slug.length > EVENT_TYPE.slugMaxLength) {
    add('slug', msg('Use at most {0} characters.', { '0': EVENT_TYPE.slugMaxLength }))
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
      msg('Use at most {0} characters (now {1}).', {
        '0': EVENT_TYPE.descriptionMaxLength,
        '1': description.length,
      }),
    )
  } else if (!isMultiLineText(description)) {
    add('description', 'Remove special control characters (tabs and line breaks are fine).')
  }

  for (const [name, required] of NUMBER_FIELDS) {
    add(name, wholeNumberProblem(draft[name], RULES[name], required))
  }
  add(
    'allowedDurationsMinutes',
    allowedDurationsProblem(draft.allowedDurationsMinutes, draft.durationMinutes),
  )
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
    add('questions', msg('Ask at most {0} questions.', { '0': QUESTIONS.maxQuestions }))
  }
  for (const q of draft.questions) {
    add(
      questionField(q, 'label'),
      singleLineProblem(q.label, 'a question', QUESTIONS.labelMaxLength),
    )
    if (!isChoice(q.type)) continue
    if (q.options.length === 0) add(questionField(q, 'options'), 'Add at least one option.')
    if (q.options.length > QUESTIONS.maxOptions) {
      add(
        questionField(q, 'options'),
        msg('Offer at most {0} options.', { '0': QUESTIONS.maxOptions }),
      )
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

function urlProblem(value: string): UiText | null {
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
  if (url.href.length > max) return msg('Use a link of at most {0} characters.', { '0': max })
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
      case 'zoom':
        return draft.autoCreateZoom ? { kind: 'zoom', autoCreate: true } : { kind: 'zoom' }
      case 'google_meet':
        return draft.autoCreateMeet
          ? { kind: 'google_meet', autoCreate: true }
          : { kind: 'google_meet' }
      default:
        return { kind: draft.locationKind }
    }
  })()
  return {
    ...(draft.hostUserIds.length > 0 && {
      schedulingType: draft.schedulingType,
      conferenceOrganizer:
        draft.schedulingType === 'collective' && draft.conferenceOrganizerUserId
          ? { userId: draft.conferenceOrganizerUserId }
          : null,
      hosts: draft.hostUserIds.map((userId) => ({ userId })),
    }),
    ...(draft.locationKind === 'zoom' &&
      draft.autoCreateZoom && { zoomConnectionId: draft.zoomConnectionId || null }),
    title: draft.title.trim(),
    slug: draft.slug.trim(),
    description: draft.description.trim() || null,
    durationMinutes: whole(draft.durationMinutes) as number,
    ...(draft.allowedDurationsMinutes.length > 1 && {
      allowedDurationsMinutes: [...draft.allowedDurationsMinutes],
    }),
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
    scheduleId: draft.schedulingType !== 'individual' ? null : draft.scheduleId || null,
    position: whole(draft.position) as number,
    isActive: draft.isActive,
    isHidden: draft.isHidden,
    allowGuests: draft.allowGuests,
    ...(draft.waitlistEnabled && { waitlist: { enabled: true } }),
    ...(draft.successRedirectUrl !== '' && { successRedirect: redirectInput(draft) }),
    ...(comparableNotifications(draft.notifications) !==
      comparableNotifications(defaultNotificationsDraft()) && {
      notifications: notificationsInput(draft.notifications),
    }),
  }
}

/** Preserve saved authorization and dormant pools during ordinary metadata edits. */
export function toPatchInput(draft: EventTypeDraft, baseline: EventTypeDraft): EventTypeBody {
  const body = toInput(draft)
  // A metadata save must preserve waitlist changes made outside this editor session.
  if (draft.waitlistEnabled === baseline.waitlistEnabled) delete body.waitlist
  else body.waitlist = { enabled: draft.waitlistEnabled }
  // Saved targets can stop meeting instance policy. Do not re-submit an untouched target,
  // or overwrite another client's redirect edit with this editor session's older copy.
  if (JSON.stringify(redirectInput(draft)) === JSON.stringify(redirectInput(baseline)))
    delete body.successRedirect
  else body.successRedirect = redirectInput(draft)
  // Only this session's changes replace the complete notification policy.
  if (
    comparableNotifications(draft.notifications) === comparableNotifications(baseline.notifications)
  )
    delete body.notifications
  else body.notifications = notificationsInput(draft.notifications)
  // Preserve a concurrent API edit when this session did not change the offered lengths.
  if (draft.allowedDurationsMinutes.join() === baseline.allowedDurationsMinutes.join())
    delete body.allowedDurationsMinutes
  else body.allowedDurationsMinutes = draft.allowedDurationsMinutes.slice()
  const sameHosts =
    draft.schedulingType === baseline.schedulingType &&
    [...draft.hostUserIds].sort().join() === [...baseline.hostUserIds].sort().join()
  if (sameHosts) {
    delete body.schedulingType
    delete body.hosts
    if (draft.conferenceOrganizerUserId === baseline.conferenceOrganizerUserId)
      delete body.conferenceOrganizer
  }
  if (draft.zoomConnectionId === baseline.zoomConnectionId) delete body.zoomConnectionId
  if (
    draft.locationKind === 'zoom' &&
    baseline.locationKind === 'zoom' &&
    draft.autoCreateZoom === baseline.autoCreateZoom
  )
    delete body.location
  if (
    (baseline.autoCreateMeet && draft.autoCreateMeet && draft.locationKind === 'google_meet') ||
    (baseline.autoCreateZoom && draft.autoCreateZoom && draft.locationKind === 'zoom')
  ) {
    if (draft.locationKind === 'google_meet') delete body.location
    if (draft.scheduleId === baseline.scheduleId) delete body.scheduleId
  }
  if (draft.schedulingType === 'round_robin' && sameHosts) delete body.scheduleId
  return body
}

/** Field labels for the error summary, by field id. */
export function fieldLabels(draft: EventTypeDraft): Record<string, UiText> {
  const labels: Record<string, UiText> = {
    hosts: 'Hosts',
    zoomConnectionId: 'Zoom meetings account',
    conferenceOrganizer: 'Meeting organizer',
    title: 'Title',
    slug: 'Booking link',
    description: 'Description',
    durationMinutes: 'Default duration',
    allowedDurationsMinutes: 'Allowed durations',
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
    waitlist: 'Booking waitlist',
    successRedirect: 'After booking',
    'successRedirect.url': 'Continue to URL',
    'successRedirect.parameters': 'URL parameters',
    'successRedirect.includeInviteePersonalData': 'Allow sharing invitee name and email',
    'successRedirect.allowEmbedParent': 'Allow embedded bookings to open the parent page',
    notifications: 'Reminders and follow-ups',
    'notifications.reminders': 'Pre-meeting reminders',
    'notifications.followUps': 'Post-meeting follow-ups',
  }
  for (const category of ['reminders', 'followUps'] as const) {
    draft.notifications[category].forEach((rule, index) => {
      const name = msg(category === 'reminders' ? 'Reminder {number}' : 'Follow-up {number}', {
        number: index + 1,
      })
      for (const part of ['id', 'offsetMinutes', 'recipients', 'hostNote'] as const)
        labels[notificationField(category, rule, part)] = name
    })
  }
  draft.questions.forEach((q, i) => {
    const name = msg('Question {0}', { '0': i + 1 })
    labels[questionField(q, 'label')] = name
    labels[questionField(q, 'type')] = msg('Question {0} type', { '0': i + 1 })
    labels[questionField(q, 'options')] = msg('Question {0} options', { '0': i + 1 })
    q.options.forEach((o, j) => {
      labels[optionField(q, o)] = msg('Question {0}, option {1}', { '0': i + 1, '1': j + 1 })
    })
  })
  return labels
}

const RULE_MESSAGES: Record<string, UiText> = Object.fromEntries(
  Object.entries(RULES).map(([name, { min, max }]) => [
    name,
    msg('Enter a number from {0} to {1}.', {
      '0': min.toLocaleString('en'),
      '1': max.toLocaleString('en'),
    }),
  ]),
)

/**
 * The server's refusal of a draft, as field messages where it names a field (its codes are
 * documented on the event type routes), and otherwise as a message for the whole form.
 */
export function serverErrors(
  err: unknown,
  draft: EventTypeDraft,
): { fields: FieldErrors; message: UiText | null } {
  if (!(err instanceof RequestError)) return { fields: {}, message: null }
  const notificationErrors = notificationServerErrors(err, draft.notifications)
  if (notificationErrors) return { fields: notificationErrors, message: null }
  const field = (id: string, message: UiText) => ({ fields: { [id]: message }, message: null })
  const detail = err.message
  if (
    (err.code === 'invalid_success_redirect' || err.code === 'invalid_request') &&
    err.field?.startsWith('successRedirect')
  ) {
    const messages: Record<string, UiText> = {
      successRedirect: 'Check the after-booking settings and try again.',
      'successRedirect.url':
        'Use an absolute HTTPS URL of at most 2000 characters, without spaces or user information. Local hosts need permission from your instance operator.',
      'successRedirect.parameters': 'Choose only the listed URL parameters, without duplicates.',
      'successRedirect.includeInviteePersonalData':
        'Allow sharing invitee name and email before selecting those parameters.',
      'successRedirect.allowEmbedParent':
        'Choose whether embedded bookings may open the parent page.',
    }
    const message = messages[err.field]
    if (message) return field(err.field, message)
  }
  switch (err.code) {
    case 'waitlist_unsupported':
      return field(
        'waitlist',
        'Waitlists are available only for one-on-one event types with a single host (not round-robin or collective).',
      )
    case 'automatic_zoom_disabled':
      return field('location-kind', 'Automatic Zoom meetings are disabled on this instance.')
    case 'automatic_zoom_unavailable':
    case 'invalid_zoom_connection':
      return field(
        'zoomConnectionId',
        'Choose your own active Zoom account with meeting permissions. Reconnect it in Conference accounts if needed.',
      )
    case 'automatic_zoom_host_policy':
      return field(
        'location-kind',
        'Automatic Zoom supports individual meetings with exactly one host.',
      )
    case 'zoom_host_session_required':
      return field(
        'zoomConnectionId',
        'The assigned host must configure Zoom in their own signed-in session.',
      )
    case 'invalid_conference_organizer':
      return field('conferenceOrganizer', 'Choose the meeting organizer from the required hosts.')
    case 'automatic_meet_disabled':
      return field(
        'location-kind',
        'Automatic creation is unavailable on this instance or meeting mode. You can keep the provider label or use your own meeting link.',
      )
    case 'automatic_meet_mode_unsupported':
      return field(
        'location-kind',
        'Automatic Google Meet supports individual meetings with one host only.',
      )
    case 'automatic_meet_unavailable':
      return field(
        'location-kind',
        'The organizer needs an owned, Meet-capable Google calendar. Other hosts can receive invitations without connecting a calendar. Configured Google calendars get ordinary copies after the link is ready.',
      )
    case 'invalid_slug':
      return field(
        'slug',
        'Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.',
      )
    case 'slug_taken':
      return field('slug', 'Another of your event types already uses this link. Choose another.')
    case 'invalid_hosts':
      return field(
        'hosts',
        'Choose one individual host, two to eight collective hosts, or one to eight round-robin pool members. Changes affect new bookings; existing meetings retain their original hosts.',
      )
    case 'invalid_schedule_id':
      return field('scheduleId', 'This schedule no longer exists. Choose another one.')
    case 'invalid_event_type': {
      // The message names the field first: "durationMinutes must be …".
      const name = /^([A-Za-z]+)\b/.exec(detail)?.[1] ?? ''
      if (name === 'allowedDurationsMinutes') {
        const problem = detail.includes('distinct')
          ? 'Offer each duration only once.'
          : detail.includes('include durationMinutes')
            ? 'Include the default duration in the allowed durations.'
            : 'Offer from 1 to 12 durations.'
        return field('allowedDurationsMinutes', problem)
      }
      if (Object.hasOwn(RULE_MESSAGES, name)) return field(name, RULE_MESSAGES[name] as UiText)
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
      return { fields: {}, message: literal(detail) }
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
      return field('location-kind', literal(detail))
    }
    case 'invalid_questions': {
      // "questions.2.options.1: …", "questions.0.label: …" or a message about the list.
      const match = /^questions\.(\d+)(?:\.(\w+))?(?:\.(\d+))?: (.*)$/s.exec(detail)
      const q = match ? draft.questions[Number(match[1])] : undefined
      if (!match || !q) return field('questions', literal(detail))
      const [, , part, optionIndex, problem = detail] = match
      if (part === 'options') {
        const o = optionIndex === undefined ? undefined : q.options[Number(optionIndex)]
        return o
          ? field(optionField(q, o), literal(problem))
          : field(questionField(q, 'options'), literal(problem))
      }
      if (part === 'type') return field(questionField(q, 'type'), literal(problem))
      return field(questionField(q, 'label'), literal(problem))
    }
    default:
      return { fields: {}, message: literal(detail) }
  }
}

function redirectInput(draft: EventTypeDraft): EventTypeBody['successRedirect'] {
  if (draft.successRedirectUrl === '') return null
  return {
    // Preserve the exact input for service validation, including rejected whitespace.
    url: draft.successRedirectUrl,
    parameters: SUCCESS_REDIRECT_PARAMETERS.filter((parameter) =>
      draft.successRedirectParameters.includes(parameter),
    ),
    includeInviteePersonalData: draft.includeInviteePersonalData,
    allowEmbedParent: draft.allowEmbedParent,
  }
}
