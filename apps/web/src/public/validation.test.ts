import { describe, expect, it } from 'vitest'
import { RequestError } from '../api/errors.ts'
import { translateMessage } from '../i18n/translate.ts'
import {
  answerError,
  bookingErrors,
  bookingLocale,
  emailError,
  nameError,
  type Question,
  reasonError,
  responsesFor,
} from './validation.ts'

const q = (type: Question['type'], more: Partial<Question> = {}): Question => ({
  id: type,
  label: type,
  type,
  required: true,
  ...(type === 'select' || type === 'multi_select' ? { options: ['A', 'B'] } : {}),
  ...more,
})

const nameErrorText = (...args: Parameters<typeof nameError>) => {
  const result = nameError(...args)
  return result === null ? null : translateMessage('en', result)
}

const answerErrorText = (...args: Parameters<typeof answerError>) => {
  const result = answerError(...args)
  return result === null ? null : translateMessage('en', result)
}

const reasonErrorText = (...args: Parameters<typeof reasonError>) => {
  const result = reasonError(...args)
  return result === null ? null : translateMessage('en', result)
}
describe('the booking form’s rules mirror the API’s', () => {
  it('checks names and emails', () => {
    expect(nameErrorText('  ')).toBe('Enter your name.')
    expect(nameErrorText('a'.repeat(200))).toBeNull()
    expect(nameErrorText('a'.repeat(201))).toMatch(/at most 200/)
    expect(nameErrorText(` ${'a'.repeat(200)} `)).toBeNull() // trimmed, as the service does
    expect(nameErrorText('Ada\u0007')).toMatch(/one line/)
    expect(nameErrorText('Ada\nLovelace')).toMatch(/one line/)
    expect(emailError('ada@example.com')).toBeNull()
    expect(emailError(' ada@example.com ')).toBeNull()
    for (const bad of [
      'ada',
      'ada@example',
      'ada@@example.com',
      'a b@example.com',
      '.ada@example.com',
    ]) {
      expect(emailError(bad), bad).toMatch(/valid email/)
    }
    expect(emailError(`${'a'.repeat(64)}@${'b'.repeat(186)}.com`)).toMatch(/valid email/) // 255
  })

  it('checks each kind of answer', () => {
    expect(answerErrorText(q('short_text'), '')).toBe('This answer is required.')
    expect(answerErrorText(q('short_text', { required: false }), '')).toBeNull()
    expect(answerErrorText(q('short_text'), 'x'.repeat(501))).toMatch(/at most 500/)
    expect(answerErrorText(q('long_text'), 'line one\nline two')).toBeNull()
    expect(answerErrorText(q('long_text'), 'x'.repeat(5001))).toMatch(/at most 5000/)
    expect(answerErrorText(q('short_text'), 'line one\nline two')).toMatch(/one line/)
    expect(answerErrorText(q('phone'), '+49 (30) 123-45.67')).toBeNull()
    expect(answerErrorText(q('phone'), 'call me')).toMatch(/phone number/)
    expect(answerErrorText(q('phone'), `+${'1'.repeat(32)}`)).toMatch(/at most 32/)
    expect(answerErrorText(q('select'), '')).toBe('Choose an option.')
    expect(answerErrorText(q('select'), 'A')).toBeNull()
    expect(answerErrorText(q('multi_select'), [])).toBe('Choose at least one option.')
    expect(answerErrorText(q('multi_select', { required: false }), [])).toBeNull()
    expect(answerErrorText(q('checkbox'), false)).toBe('Check this box to continue.')
    expect(answerErrorText(q('checkbox', { required: false }), false)).toBeNull()
  })

  it('sends answers as the API takes them', () => {
    const questions = [
      q('short_text', { required: false }),
      q('select', { required: false }),
      q('multi_select'),
      q('checkbox', { required: false }),
    ]
    expect(
      responsesFor(questions, { short_text: '  hi  ', select: '', multi_select: ['B', 'A'] }),
    ).toEqual({ short_text: 'hi', multi_select: ['A', 'B'], checkbox: false })
  })

  it('checks reasons and locales', () => {
    expect(reasonErrorText('x'.repeat(1000))).toBeNull()
    expect(reasonErrorText('x'.repeat(1001))).toMatch(/at most 1000/)
    expect(reasonErrorText('Sorry,\nsomething came up')).toBeNull()
    expect(bookingLocale('en-US')).toBe('en-US')
    expect(bookingLocale('x-'.repeat(20))).toBeUndefined()
  })
})

describe('server errors on the form', () => {
  const questions = [q('short_text', { id: 'topic', label: 'Topic' })]
  const error = (code: string, message: string) => new RequestError(400, code, message)

  it('places invalid_request issues on their fields', () => {
    expect(
      bookingErrors(
        error('invalid_request', 'invitee.email: Invalid email address; guests.1.name: Too big'),
        questions,
      ),
    ).toEqual({
      fields: {
        email: 'Enter a valid email address, like name@example.com.',
        'guest-1-name': 'Enter a name, at most 200 characters.',
      },
      form: null,
    })
    expect(bookingErrors(error('invalid_request', 'start: Invalid'), questions).form).toBe(
      'Check the form and try again.',
    )
  })

  it('names the question an invalid_responses is about by its label', () => {
    expect(
      bookingErrors(error('invalid_responses', 'Question "topic" is required'), questions),
    ).toEqual({ fields: { 'q-topic': { literal: '“Topic” is required' } }, form: null })
    expect(
      bookingErrors(
        error('invalid_responses', 'responses answers a question this event type does not ask'),
        questions,
      ).form,
    ).toMatch(/Reload the page/)
  })

  it('maps the service’s other codes', () => {
    expect(
      bookingErrors(error('invalid_invitee', 'The invitee needs a valid email address'), questions)
        .fields,
    ).toHaveProperty('email')
    expect(
      bookingErrors(
        error('invalid_invitee', 'The invitee needs a name of 1 to 200 characters'),
        questions,
      ).fields,
    ).toHaveProperty('name')
    expect(bookingErrors(error('too_many_guests', 'At most 10 guests'), questions).fields).toEqual({
      guests: { key: 'Add at most {0} guests.', values: { '0': 10 } },
    })
    expect(bookingErrors(error('invalid_time_zone', 'x'), questions).fields).toHaveProperty(
      'timeZone',
    )
  })
})
