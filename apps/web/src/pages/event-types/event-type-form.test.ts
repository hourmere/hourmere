import { describe, expect, it } from 'vitest'
import { RequestError } from '../../api/errors.ts'
import {
  emptyDraft,
  newOption,
  newQuestion,
  optionField,
  questionField,
  questionIds,
  serverErrors,
  slugify,
  validateDraft,
} from './event-type-form.ts'

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

describe('questionIds', () => {
  it('keeps saved ids and derives unique new ones from labels', () => {
    const saved = { ...newQuestion(), id: 'company', label: 'Company' }
    const again = { ...newQuestion(), label: 'Company' }
    const blank = { ...newQuestion(), label: '¿?' }
    const blank2 = { ...newQuestion(), label: '' }
    expect(questionIds([saved, again, blank, blank2])).toEqual([
      'company',
      'company-2',
      'question',
      'question-2',
    ])
  })
})

describe('validateDraft', () => {
  it('accepts the defaults with a title and slug', () => {
    expect(validateDraft({ ...emptyDraft(), title: 'Intro', slug: 'intro' })).toEqual({})
  })

  it('refuses control characters and overlong text the way the server does', () => {
    const errors = validateDraft({
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
    expect(validateDraft({ ...base, description: 'a\n\tb' })).toEqual({})
    expect(validateDraft({ ...base, description: 'a b' })).toHaveProperty('description')
  })

  it('needs options for choice questions, at most 50', () => {
    const q = {
      ...newQuestion(),
      label: 'Pick',
      type: 'select' as const,
      options: Array.from({ length: 51 }, (_, i) => newOption(`o${i}`)),
    }
    expect(validateDraft({ ...emptyDraft(), title: 'T', slug: 't', questions: [q] })).toEqual({
      [questionField(q, 'options')]: 'Offer at most 50 options.',
    })
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

  it('keeps unknown codes for the whole form', () => {
    expect(serverErrors(refused('something_new', 'Something new.'), draft)).toEqual({
      fields: {},
      message: 'Something new.',
    })
    expect(serverErrors(new TypeError('Failed to fetch'), draft)).toEqual({
      fields: {},
      message: null,
    })
  })
})
