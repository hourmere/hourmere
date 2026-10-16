import { describe, expect, it } from 'vitest'
import {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  parseQuestions,
  type Question,
  QuestionsSchema,
  ResponsesSchema,
  validateResponses,
} from './questions.ts'

describe('QuestionsSchema', () => {
  it('accepts every type, trims labels and options, and defaults required to false', () => {
    expect(
      QuestionsSchema.parse([
        { id: 'topic', label: ' Topic ', type: 'short_text', required: true },
        { id: 'notes', label: 'Notes', type: 'long_text' },
        { id: 'phone', label: 'Phone', type: 'phone' },
        { id: 'size', label: 'Team size', type: 'select', options: [' 1 ', '2-10'] },
        { id: 'tools', label: 'Tools', type: 'multi_select', options: ['a', 'b'] },
        { id: 'terms_ok', label: 'I agree', type: 'checkbox', required: true },
      ]),
    ).toEqual([
      { id: 'topic', label: 'Topic', type: 'short_text', required: true },
      { id: 'notes', label: 'Notes', type: 'long_text', required: false },
      { id: 'phone', label: 'Phone', type: 'phone', required: false },
      { id: 'size', label: 'Team size', type: 'select', required: false, options: ['1', '2-10'] },
      { id: 'tools', label: 'Tools', type: 'multi_select', required: false, options: ['a', 'b'] },
      { id: 'terms_ok', label: 'I agree', type: 'checkbox', required: true },
    ])
  })

  const q = (over: Record<string, unknown>) => ({
    id: 'q',
    label: 'Q',
    type: 'short_text',
    ...over,
  })
  it.each([
    ['too many questions', Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => q({ id: `q${i}` }))],
    ['repeated ids', [q({}), q({})]],
    ['an id with spaces', [q({ id: 'my question' })]],
    ['an id longer than 64', [q({ id: 'x'.repeat(65) })]],
    ['an empty label', [q({ label: '  ' })]],
    ['a label longer than 200', [q({ label: 'x'.repeat(201) })]],
    ['an unknown type', [q({ type: 'date' })]],
    ['a select without options', [q({ type: 'select' })]],
    ['a select with no options', [q({ type: 'select', options: [] })]],
    [
      'too many options',
      [q({ type: 'select', options: Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => `o${i}`) })],
    ],
    ['repeated options', [q({ type: 'multi_select', options: ['a', 'a'] })]],
    ['an option longer than 200', [q({ type: 'select', options: ['x'.repeat(201)] })]],
    ['options on a text question', [q({ options: ['a'] })]],
    ['an unknown field', [q({ placeholder: 'e.g. Acme' })]],
    ['a non-boolean required', [q({ required: 'yes' })]],
    ['not a list', { q: q({}) }],
  ])('refuses %s', (_, value) => {
    expect(QuestionsSchema.safeParse(value).success).toBe(false)
  })

  it('treats stored questions that do not match as a bug', () => {
    expect(parseQuestions([])).toEqual([])
    expect(() => parseQuestions([{ id: 'q', type: 'short_text' }])).toThrow(/QuestionsSchema/)
  })
})

describe('validateResponses', () => {
  const questions: Question[] = [
    { id: 'text', label: 'Text', type: 'short_text', required: false },
    { id: 'phone', label: 'Phone', type: 'phone', required: true },
    { id: 'one', label: 'One', type: 'select', required: false, options: ['a', 'b'] },
    { id: 'many', label: 'Many', type: 'multi_select', required: true, options: ['a', 'b'] },
    { id: 'ok', label: 'OK', type: 'checkbox', required: true },
  ]
  const valid = { phone: '+1 (555) 010-0', many: ['b', 'a'], ok: true }
  const check = (given: unknown) => validateResponses(questions, given)

  it('accepts and normalizes valid answers, leaving out empty optional ones', () => {
    expect(check({ ...valid, text: '  ', one: '' })).toEqual(valid)
    expect(check({ ...valid, text: ' hi ', one: 'a' })).toEqual({ ...valid, text: 'hi', one: 'a' })
    expect(ResponsesSchema.safeParse(check(valid)).success).toBe(true)
  })

  it.each([
    ['not an object', []],
    ['a missing required answer', { ...valid, phone: undefined }],
    ['an unknown question', { ...valid, other: 'x' }],
    ['an option that does not exist', { ...valid, one: 'c' }],
    ['repeated options', { ...valid, many: ['a', 'a'] }],
    ['no option for a required multi-select', { ...valid, many: [] }],
    ['an unchecked required checkbox', { ...valid, ok: false }],
    ['a non-boolean checkbox', { ...valid, ok: 'yes' }],
    ['short text longer than 500', { ...valid, text: 'x'.repeat(501) }],
    ['a phone number longer than 32', { ...valid, phone: '1'.repeat(33) }],
    ['a phone number with letters', { ...valid, phone: 'call me' }],
    ['a number for text', { ...valid, text: 5 }],
  ])('refuses %s with invalid_responses', (_, given) => {
    expect(() => check(given)).toThrow(
      expect.objectContaining({ kind: 'invalid', code: 'invalid_responses' }),
    )
  })

  it('allows long text up to 5000 characters', () => {
    const long: Question[] = [{ id: 'notes', label: 'Notes', type: 'long_text', required: false }]
    expect(validateResponses(long, { notes: 'x'.repeat(5000) })).toEqual({
      notes: 'x'.repeat(5000),
    })
    expect(() => validateResponses(long, { notes: 'x'.repeat(5001) })).toThrow()
  })
})
