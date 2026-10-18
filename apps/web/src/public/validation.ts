// The booking form's rules, mirroring what the API documents and enforces (the route's
// schema, then packages/scheduling's bookings.ts, questions.ts and text.ts), so people learn
// about a problem before they submit. The server still decides; its answers are mapped back
// onto the fields by bookingErrors below.
import type { Schemas } from '../api/client.ts'
import type { RequestError } from '../api/errors.ts'
import { literal, msg, type UiText } from '../i18n/translate.ts'

export type Question = Schemas['Question']
export type Answer = string | string[] | boolean

export const LIMITS = {
  name: 200,
  email: 254,
  guests: 10,
  short_text: 500,
  long_text: 5000,
  phone: 32,
  reason: 1000,
  locale: 35,
} as const

// zod's email check, which the booking route applies before the service's own.
const EMAIL =
  /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/
const PHONE = /^\+?[0-9][0-9 ().-]*$/
const LOCALE = /^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8})*$/

/** Control characters the API refuses in text: C0 (but tab and line breaks when multi-line), DEL, C1, U+2028/9. */
function hasControlCharacters(value: string, multiline: boolean): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 0x20) {
      if (multiline && (c === 0x09 || c === 0x0a || c === 0x0d)) continue
      return true
    }
    if ((c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true
  }
  return false
}

const wellFormed = (value: string) =>
  typeof value.isWellFormed === 'function' ? value.isWellFormed() : true

export function isAllowedText(value: string, { multiline = false } = {}): boolean {
  return wellFormed(value) && !hasControlCharacters(value, multiline)
}

/** An error message for a person's name, or null when it is fine. */
export function nameError(value: string, who = 'your name'): UiText | null {
  const text = value.trim()
  if (!text) return who === 'your name' ? 'Enter your name.' : 'Enter a name.'
  if (text.length > LIMITS.name) return msg('Use at most {0} characters.', { '0': LIMITS.name })
  if (!isAllowedText(text)) return 'Use letters, digits and punctuation only, on one line.'
  return null
}

const EMAIL_HINT = 'Enter a valid email address, like name@example.com.'

export function emailError(value: string): UiText | null {
  const text = value.trim()
  if (!text) return 'Enter an email address.'
  if (text.length > LIMITS.email || !EMAIL.test(text)) return EMAIL_HINT
  return null
}

/** An error message for an answer, or null when it is fine (an empty optional answer is). */
export function answerError(q: Question, value: Answer | undefined): UiText | null {
  switch (q.type) {
    case 'short_text':
    case 'long_text':
    case 'phone': {
      const text = typeof value === 'string' ? value.trim() : ''
      if (!text) return q.required ? 'This answer is required.' : null
      const max = LIMITS[q.type]
      if (text.length > max) return msg('Use at most {0} characters.', { '0': max })
      if (!isAllowedText(text, { multiline: q.type === 'long_text' })) {
        return q.type === 'long_text'
          ? 'Remove control characters from this answer.'
          : 'Use one line without control characters.'
      }
      if (q.type === 'phone' && !PHONE.test(text)) {
        return 'Enter a phone number: digits, spaces and ( ) . - only, optionally starting with +.'
      }
      return null
    }
    case 'select':
      if (typeof value !== 'string' || value === '') {
        return q.required ? 'Choose an option.' : null
      }
      return q.options?.includes(value) ? null : 'Choose one of the options.'
    case 'multi_select':
      if (!Array.isArray(value) || value.length === 0) {
        return q.required ? 'Choose at least one option.' : null
      }
      return null
    case 'checkbox':
      return q.required && value !== true ? 'Check this box to continue.' : null
  }
}

/** Answers as the API takes them: text trimmed, empty optional answers left out. */
export function responsesFor(
  questions: readonly Question[],
  answers: Record<string, Answer | undefined>,
): Record<string, Answer> {
  const result: Record<string, Answer> = {}
  for (const q of questions) {
    const value = answers[q.id]
    if (q.type === 'checkbox') {
      result[q.id] = value === true
    } else if (Array.isArray(value)) {
      if (value.length)
        result[q.id] = q.options ? q.options.filter((o) => value.includes(o)) : value
    } else if (typeof value === 'string' && value.trim() !== '') {
      result[q.id] = q.type === 'select' ? value : value.trim()
    }
  }
  return result
}

/** The visitor's language for the booking, if it fits the API's rules (else none is sent). */
export function bookingLocale(locale: string): string | undefined {
  return locale.length <= LIMITS.locale && LOCALE.test(locale) ? locale : undefined
}

export function reasonError(value: string): UiText | null {
  const text = value.trim()
  if (text.length > LIMITS.reason) return msg('Use at most {0} characters.', { '0': LIMITS.reason })
  if (!isAllowedText(text, { multiline: true })) return 'Remove control characters from the reason.'
  return null
}

// --- Mapping the API's answers onto the form ---------------------------------------------

/** Field ids the booking form uses: name, email, timeZone, guests, guest-N-name/-email, q-<id>. */
export type FieldErrors = Record<string, UiText>

export interface MappedErrors {
  fields: FieldErrors
  /** A message for the form as a whole, when no field explains the problem. */
  form: UiText | null
}

const questionField = (id: string) => `q-${id}`

/**
 * What a failed booking request means for the form. `invalid_request` names fields in its
 * message ("invitee.email: …; guests.0.name: …"); the service's codes name the case.
 */
export function bookingErrors(err: RequestError, questions: readonly Question[]): MappedErrors {
  const fields: FieldErrors = {}
  const message = err.message
  const label = (id: string) => questions.find((q) => q.id === id)?.label
  switch (err.code) {
    case 'invalid_request': {
      let unplaced = false
      for (const part of message.split('; ')) {
        const path = part.slice(0, part.indexOf(':'))
        const guest = /^guests\.(\d+)\.(name|email)$/.exec(path)
        const response = /^responses\.([^.]+)/.exec(path)
        if (path === 'invitee.name') fields.name = 'Enter your name, at most 200 characters.'
        else if (path === 'invitee.email') fields.email = EMAIL_HINT
        else if (path === 'invitee.timeZone') fields.timeZone = 'Choose a time zone from the list.'
        else if (path === 'guests')
          fields.guests = msg('Add at most {0} guests.', { '0': LIMITS.guests })
        else if (guest) {
          fields[`guest-${guest[1]}-${guest[2]}`] =
            guest[2] === 'name' ? 'Enter a name, at most 200 characters.' : EMAIL_HINT
        } else if (response?.[1] && label(response[1]) !== undefined) {
          fields[questionField(response[1])] = 'Check this answer.'
        } else unplaced = true
      }
      return {
        fields,
        form: unplaced || !Object.keys(fields).length ? 'Check the form and try again.' : null,
      }
    }
    case 'invalid_invitee':
      if (/name/i.test(message))
        fields.name = 'Enter your name on one line, at most 200 characters.'
      else if (/email/i.test(message)) fields.email = EMAIL_HINT
      else return { fields, form: literal(message) }
      return { fields, form: null }
    case 'guests_not_allowed':
      fields.guests = 'The host no longer allows guests. Remove the guests to continue.'
      return { fields, form: null }
    case 'invalid_guests':
    case 'too_many_guests':
      fields.guests =
        err.code === 'too_many_guests'
          ? msg('Add at most {0} guests.', { '0': LIMITS.guests })
          : /email/i.test(message)
            ? 'Each guest needs a valid email address.'
            : 'Each guest needs a name on one line, at most 200 characters.'
      return { fields, form: null }
    case 'invalid_responses': {
      const id = /^Question "([^"]+)"/.exec(message)?.[1]
      const name = id === undefined ? undefined : label(id)
      if (id !== undefined && name !== undefined) {
        fields[questionField(id)] = 'Check this answer.'
        return { fields, form: null }
      }
      return {
        fields,
        form: 'The questions on this page have changed. Reload the page and try again.',
      }
    }
    case 'invalid_time_zone':
      fields.timeZone = 'Choose a time zone from the list.'
      return { fields, form: null }
    default:
      return { fields, form: literal(message) }
  }
}
