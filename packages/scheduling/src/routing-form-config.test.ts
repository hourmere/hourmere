import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  evaluateRoutingForm,
  MAX_MAPPINGS_PER_TARGET,
  ROUTING_FORM_LIMITS,
  type RoutingFormConfig,
  RoutingValidationError,
  validateRoutingAnswers,
  validateRoutingFormConfig,
} from './routing-form-config.ts'

// Opaque identities as the configuration services will allocate them.
const uuid = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`
const Q = { company: uuid(1), email: uuid(2), size: uuid(3), region: uuid(4) }
const O = { small: uuid(11), medium: uuid(12), large: uuid(13), emea: uuid(14), apac: uuid(15) }
const R = { first: uuid(21), second: uuid(22), third: uuid(23) }
const E = { sales: uuid(31), support: uuid(32) }

type Json = Record<string, unknown>

function form(overrides: Json = {}): Json {
  return {
    questions: [
      { id: Q.company, type: 'short_text', label: 'Company', required: true },
      { id: Q.email, type: 'email', label: 'Work email' },
      {
        id: Q.size,
        type: 'select',
        label: 'Company size',
        options: [
          { id: O.small, label: '1–10' },
          { id: O.medium, label: '11–200' },
          { id: O.large, label: '200+' },
        ],
      },
      {
        id: Q.region,
        type: 'select',
        label: 'Region',
        options: [
          { id: O.emea, label: 'EMEA' },
          { id: O.apac, label: 'APAC' },
        ],
      },
    ],
    rules: [],
    fallback: { kind: 'message', message: 'Thank you' },
    ...overrides,
  }
}
const questions = (form().questions as Json[]).map((q) => ({ ...q }))
const withQuestion = (index: number, change: Json) =>
  form({ questions: questions.map((q, i) => (i === index ? { ...q, ...change } : q)) })
const rule = (conditions: unknown, target: unknown = { kind: 'event', eventTypeId: E.sales }) => ({
  id: R.first,
  conditions,
  target,
})
const withCondition = (condition: Json) => form({ rules: [rule([condition])] })
const withTarget = (target: unknown) => form({ rules: [rule([sizeIsLarge], target)] })
const withMappings = (mappings: unknown) =>
  withTarget({ kind: 'event', eventTypeId: E.sales, mappings })
const sizeIsLarge = { questionId: Q.size, operator: 'one_of', values: [O.large] }

function rejects(input: unknown, expected: Partial<RoutingValidationError>) {
  let thrown: unknown
  try {
    validateRoutingFormConfig(input)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(RoutingValidationError)
  expect(thrown).toMatchObject({ kind: 'invalid', code: 'invalid_routing_form', ...expected })
}
const rejectsTarget = (input: unknown, field: string, reason: string) =>
  rejects(input, { code: 'invalid_routing_target', field, reason })

describe('routing form limits', () => {
  it('equal the numeric register in the design', () => {
    const document = readFileSync(
      new URL('../../../docs/routing-forms.md', import.meta.url),
      'utf8',
    )
    const register = Object.fromEntries(
      [...document.matchAll(/^\| ([a-z_]+) \| (\d+) \|/gm)].map(([, key, value]) => [
        key,
        Number(value),
      ]),
    )
    expect(ROUTING_FORM_LIMITS).toEqual({
      questionsPerForm: register.questions_per_form,
      optionsPerQuestion: register.options_per_question,
      rulesPerForm: register.rules_per_form,
      conditionsPerRule: register.conditions_per_rule,
      labelLength: register.label_length,
      textAnswerLength: register.text_answer_length,
      messageLength: register.message_length,
    })
  })
})

describe('routing question validation', () => {
  it('accepts every question type and returns the configuration normalized', () => {
    const result = validateRoutingFormConfig(
      withQuestion(0, { label: '  Company  ', required: undefined }),
    )
    expect(result.questions.map((q) => [q.type, q.label, q.required])).toEqual([
      ['short_text', 'Company', false],
      ['email', 'Work email', false],
      ['select', 'Company size', false],
      ['select', 'Region', false],
    ])
    expect(validateRoutingFormConfig(form()).questions[0]?.required).toBe(true)
    expect(result.rules).toEqual([])
    expect(result.fallback).toEqual({ kind: 'message', message: 'Thank you' })
  })

  it('accepts a fallback-only form with no questions or rules', () => {
    expect(validateRoutingFormConfig(form({ questions: [] }))).toEqual({
      questions: [],
      rules: [],
      fallback: { kind: 'message', message: 'Thank you' },
    })
  })

  it.each([
    'long_text',
    'phone',
    'number',
    'multi_select',
    'checkbox',
    'hidden',
    'file',
    undefined,
  ])('rejects the unsupported question type %s', (type) => {
    rejects(withQuestion(0, { type }), { field: 'questions.0.type' })
  })

  it('accepts 20 questions and rejects 21', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: uuid(1000 + i),
        type: 'short_text',
        label: `Q${i}`,
      }))
    expect(validateRoutingFormConfig(form({ questions: many(20) })).questions).toHaveLength(20)
    rejects(form({ questions: many(21) }), { field: 'questions' })
    rejects(form({ questions: 'none' }), { field: 'questions' })
  })

  it('bounds labels in code units as submitted, before trimming', () => {
    const label = (value: string) =>
      validateRoutingFormConfig(withQuestion(0, { label: value })).questions[0]?.label
    expect(label('x'.repeat(200))).toBe('x'.repeat(200))
    expect(label(`${'東'.repeat(200)}`)).toHaveLength(200)
    // 100 astral characters are 200 UTF-16 code units.
    expect(label('😀'.repeat(100))).toHaveLength(200)
    expect(label(` ${'x'.repeat(198)} `)).toBe('x'.repeat(198))
    for (const value of [
      'x'.repeat(201),
      ` ${'x'.repeat(199)} `,
      `${'😀'.repeat(100)}x`,
      '',
      '   ',
      '\t\n',
    ])
      rejects(withQuestion(0, { label: value }), { field: 'questions.0.label' })
  })

  it.each([
    ['NUL', 'a\u0000b'],
    ['bell', 'a\u0007b'],
    ['line feed', 'a\nb'],
    ['tab', 'a\tb'],
    ['DEL', 'a\u007fb'],
    ['C1 control', 'a\u0085b'],
    ['line separator', 'a b'],
    ['left-to-right embedding', 'a‪b'],
    ['right-to-left embedding', 'a‫b'],
    ['pop directional formatting', 'a‬b'],
    ['left-to-right override', 'a‭b'],
    ['right-to-left override', 'a‮b'],
    ['left-to-right isolate', 'a⁦b'],
    ['right-to-left isolate', 'a⁧b'],
    ['first strong isolate', 'a⁨b'],
    ['pop directional isolate', 'a⁩b'],
    ['lone surrogate', 'a\uD800b'],
  ])('rejects a label with a %s', (_, value) => {
    rejects(withQuestion(0, { label: value }), { field: 'questions.0.label' })
    rejects(
      withQuestion(2, {
        options: [
          { id: O.small, label: value },
          { id: O.medium, label: 'Medium' },
        ],
      }),
      { field: 'questions.2.options.0.label' },
    )
  })

  it('keeps directional marks, which are not embedding or isolate controls', () => {
    const label = 'שלום‎ (Hebrew)'
    expect(validateRoutingFormConfig(withQuestion(0, { label })).questions[0]?.label).toBe(label)
  })

  it('defaults required to false and accepts only booleans', () => {
    expect(
      validateRoutingFormConfig(withQuestion(1, { required: false })).questions[1]?.required,
    ).toBe(false)
    for (const required of ['true', 1, null])
      rejects(withQuestion(1, { required }), { field: 'questions.1.required' })
  })

  it('takes 1 to 50 options with distinct labels for select questions only', () => {
    const options = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ id: uuid(2000 + i), label: `Band ${i}` }))
    const select = (value: unknown) => withQuestion(2, { options: value })
    expect(validateRoutingFormConfig(select(options(50))).questions[2]).toMatchObject({
      options: options(50),
    })
    expect(validateRoutingFormConfig(select(options(1))).questions[2]).toMatchObject({
      options: options(1),
    })
    rejects(select(options(51)), { field: 'questions.2.options' })
    rejects(select([]), { field: 'questions.2.options' })
    rejects(select(undefined), { field: 'questions.2.options' })
    rejects(withQuestion(0, { options: options(2) }), { field: 'questions.0.options' })
    rejects(withQuestion(1, { options: options(2) }), { field: 'questions.1.options' })
    rejects(
      select([
        { id: O.small, label: 'Small' },
        { id: O.medium, label: ' Small ' },
      ]),
      { field: 'questions.2.options.1.label' },
    )
    // Canonically equivalent labels look identical to the invitee.
    rejects(
      select([
        { id: O.small, label: 'Café' },
        { id: O.medium, label: 'Café' },
      ]),
      { field: 'questions.2.options.1.label' },
    )
    rejects(select([{ id: O.small, label: 'Small', value: 'small' }]), {
      field: 'questions.2.options.0',
    })
  })

  it('requires lowercase UUID identities that no other question, option or rule repeats', () => {
    for (const id of [O.small.toUpperCase(), 'company', 7, undefined, `${Q.company} `])
      rejects(withQuestion(0, { id }), { field: 'questions.0.id' })
    rejects(withQuestion(1, { id: Q.company }), { field: 'questions.1.id' })
    rejects(withQuestion(0, { id: O.large }), { field: 'questions.2.options.2.id' })
    rejects(
      withQuestion(3, {
        options: [
          { id: O.emea, label: 'EMEA' },
          { id: O.emea, label: 'APAC' },
        ],
      }),
      { field: 'questions.3.options.1.id' },
    )
    rejects(form({ rules: [{ ...rule([sizeIsLarge]), id: Q.size }] }), { field: 'rules.0.id' })
    rejects(form({ rules: [rule([sizeIsLarge]), rule([sizeIsLarge])] }), { field: 'rules.1.id' })
    rejects(form({ rules: [{ ...rule([sizeIsLarge]), id: R.first.toUpperCase() }] }), {
      field: 'rules.0.id',
    })
  })

  it('rejects unknown fields and non-objects at every level', () => {
    rejects(null, { field: undefined })
    rejects([], { field: undefined })
    rejects(form({ title: 'Qualification' }), { field: undefined })
    rejects(form({ fallback: undefined }), {
      code: 'invalid_routing_target',
      field: 'fallback',
      reason: 'unsupported_target',
    })
    rejects(withQuestion(0, { placeholder: 'Acme' }), { field: 'questions.0' })
    rejects(form({ questions: ['Company'] }), { field: 'questions.0' })
    rejects(form({ rules: [{ ...rule([sizeIsLarge]), enabled: true }] }), { field: 'rules.0' })
    rejects(withCondition({ ...sizeIsLarge, negate: true }), { field: 'rules.0.conditions.0' })
    rejects(form({ rules: {} }), { field: 'rules' })
  })
})

describe('routing rule validation', () => {
  it('accepts 50 ordered rules and rejects 51', () => {
    const rules = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ ...rule([sizeIsLarge]), id: uuid(3000 + i) }))
    const result = validateRoutingFormConfig(form({ rules: rules(50) }))
    expect(result.rules.map((r) => r.id)).toEqual(rules(50).map((r) => r.id))
    rejects(form({ rules: rules(51) }), { field: 'rules' })
  })

  it('requires 1 to 10 conditions per rule', () => {
    const conditions = (count: number) => Array.from({ length: count }, () => sizeIsLarge)
    expect(
      validateRoutingFormConfig(form({ rules: [rule(conditions(10))] })).rules[0]?.conditions,
    ).toHaveLength(10)
    rejects(form({ rules: [rule(conditions(11))] }), { field: 'rules.0.conditions' })
    rejects(form({ rules: [rule([])] }), { field: 'rules.0.conditions' })
    rejects(form({ rules: [rule(undefined)] }), { field: 'rules.0.conditions' })
  })

  it('allows equals on short text, email and select questions', () => {
    const value = (condition: Json) =>
      validateRoutingFormConfig(withCondition(condition)).rules[0]?.conditions[0]
    expect(value({ questionId: Q.company, operator: 'equals', value: '  Acme  ' })).toEqual({
      questionId: Q.company,
      operator: 'equals',
      value: 'Acme',
    })
    expect(
      value({ questionId: Q.email, operator: 'equals', value: ' Sales@Example.com ' }),
    ).toEqual({ questionId: Q.email, operator: 'equals', value: 'Sales@Example.com' })
    expect(value({ questionId: Q.size, operator: 'equals', value: O.large })).toEqual({
      questionId: Q.size,
      operator: 'equals',
      value: O.large,
    })
  })

  it('keeps literals as written, so validating its own output changes nothing', () => {
    const decomposed = 'Cafe\u0301'
    expect(
      validateRoutingFormConfig(
        withCondition({ questionId: Q.company, operator: 'equals', value: ` ${decomposed} ` }),
      ).rules[0]?.conditions[0],
    ).toMatchObject({ value: decomposed })
    // NFC lengthens U+0958 to two code units: a normalized copy of this legal literal
    // would exceed the limit the validator checks.
    const long = '\u0958'.repeat(500)
    expect(long.normalize('NFC')).toHaveLength(1000)
    const config = validateRoutingFormConfig(
      form({
        rules: [
          rule(
            [
              { questionId: Q.company, operator: 'equals', value: long },
              { questionId: Q.email, operator: 'equals', value: ' Sales@Example.com ' },
              sizeIsLarge,
            ],
            {
              kind: 'event',
              eventTypeId: E.sales,
              mappings: [{ questionId: Q.company, destination: { kind: 'inviteeName' } }],
            },
          ),
        ],
      }),
    )
    expect(validateRoutingFormConfig(config)).toEqual(config)
    expect(
      evaluateRoutingForm(
        config,
        validateRoutingAnswers(config.questions, {
          [Q.company]: long,
          [Q.email]: 'sales@example.com',
          [Q.size]: O.large,
        }),
      ).ruleId,
    ).toBe(R.first)
  })

  it('allows one_of on select questions only, with a nonempty distinct subset of its options', () => {
    const condition = (values: unknown, questionId = Q.size) =>
      withCondition({ questionId, operator: 'one_of', values })
    expect(
      validateRoutingFormConfig(condition([O.large, O.small])).rules[0]?.conditions[0],
    ).toEqual({ questionId: Q.size, operator: 'one_of', values: [O.large, O.small] })
    expect(
      validateRoutingFormConfig(condition([O.small, O.medium, O.large])).rules[0]?.conditions,
    ).toHaveLength(1)
    rejects(condition([O.large], Q.company), { field: 'rules.0.conditions.0.operator' })
    rejects(condition([O.large], Q.email), { field: 'rules.0.conditions.0.operator' })
    for (const values of [
      [],
      [O.large, O.large],
      [O.small, O.medium, O.large, O.large],
      [O.emea],
      ['200+'],
      [O.large.toUpperCase()],
      [1],
      O.large,
      undefined,
    ])
      rejects(condition(values), { field: 'rules.0.conditions.0.values' })
  })

  it('compares select equals only with an option ID of that question, never a label', () => {
    for (const value of ['200+', O.emea, O.large.toUpperCase(), ` ${O.large}`, '', 13])
      rejects(withCondition({ questionId: Q.size, operator: 'equals', value }), {
        field: 'rules.0.conditions.0.value',
      })
  })

  it('rejects blank, overlong and controlled literals and invalid email literals', () => {
    const text = (value: unknown, questionId = Q.company) =>
      withCondition({ questionId, operator: 'equals', value })
    expect(validateRoutingFormConfig(text('x'.repeat(500))).rules[0]?.conditions[0]).toMatchObject({
      value: 'x'.repeat(500),
    })
    for (const value of ['', '   ', 'x'.repeat(501), ` ${'x'.repeat(499)} `, 'a\nb', 'a‮b', 5])
      rejects(text(value), { field: 'rules.0.conditions.0.value' })
    for (const value of ['sales', 'sales@', 'a b@example.com', `${'a'.repeat(250)}@example.com`])
      rejects(text(value, Q.email), { field: 'rules.0.conditions.0.value' })
  })

  it.each([
    'contains',
    'not_equals',
    'regex',
    'matches',
    'starts_with',
    'greater_than',
    'in',
    'oneOf',
    undefined,
  ])('rejects the unsupported operator %s', (operator) => {
    rejects(withCondition({ questionId: Q.company, operator, value: 'Acme' }), {
      field: 'rules.0.conditions.0.operator',
    })
  })

  it('rejects mismatched operator arguments', () => {
    rejects(withCondition({ questionId: Q.size, operator: 'equals', values: [O.large] }), {
      field: 'rules.0.conditions.0.values',
    })
    rejects(
      withCondition({ questionId: Q.size, operator: 'one_of', value: O.large, values: [O.large] }),
      { field: 'rules.0.conditions.0.value' },
    )
  })

  it('rejects conditions on dangling question IDs', () => {
    for (const questionId of [uuid(999), O.large, R.first, 'Company', undefined])
      rejects(withCondition({ questionId, operator: 'equals', value: 'Acme' }), {
        field: 'rules.0.conditions.0.questionId',
      })
  })
})

describe('routing target shape', () => {
  it('accepts event and plain-text message targets for rules and the fallback', () => {
    const result = validateRoutingFormConfig(
      form({
        rules: [rule([sizeIsLarge], { kind: 'message', message: '  Line one\nLine two  ' })],
        fallback: { kind: 'event', eventTypeId: E.support },
      }),
    )
    expect(result.rules[0]?.target).toEqual({ kind: 'message', message: 'Line one\nLine two' })
    expect(result.fallback).toEqual({ kind: 'event', eventTypeId: E.support, mappings: [] })
  })

  it('bounds messages at 2000 code units and rejects blank or controlled ones', () => {
    const message = (value: unknown) => form({ fallback: { kind: 'message', message: value } })
    expect(validateRoutingFormConfig(message('x'.repeat(2000))).fallback).toEqual({
      kind: 'message',
      message: 'x'.repeat(2000),
    })
    for (const value of ['x'.repeat(2001), '', '  \n ', 'a\u0000b', 'a⁧b', undefined])
      rejectsTarget(message(value), 'fallback.message', 'invalid_message')
  })

  it.each(['url', 'external_url', 'redirect', 'link', 'member', undefined])(
    'rejects the unsupported target kind %s, including for the fallback',
    (kind) => {
      rejectsTarget(
        withTarget({ kind, url: 'https://example.com' }),
        'rules.0.target.kind',
        'unsupported_target',
      )
      rejectsTarget(form({ fallback: { kind } }), 'fallback.kind', 'unsupported_target')
    },
  )

  it.each(['memberId', 'hostUserId', 'hosts', 'url', 'successRedirect', 'slug'])(
    'rejects an event target with a %s selector',
    (key) => {
      rejectsTarget(
        withTarget({ kind: 'event', eventTypeId: E.sales, [key]: uuid(500) }),
        'rules.0.target',
        'unsupported_target',
      )
      rejectsTarget(
        form({ fallback: { kind: 'message', message: 'Thanks', [key]: 'x' } }),
        'fallback',
        'unsupported_target',
      )
    },
  )

  it('rejects malformed event type IDs', () => {
    for (const eventTypeId of [E.sales.toUpperCase(), 'sales-call', 31, undefined])
      rejectsTarget(
        withTarget({ kind: 'event', eventTypeId }),
        'rules.0.target.eventTypeId',
        'not_found',
      )
  })
})

describe('routing answer mapping shape', () => {
  const crosswalk = { [O.small]: 'Small', [O.medium]: 'Medium', [O.large]: 'Large' }

  it('accepts explicit mappings by question ID and stores them as given', () => {
    const mappings = [
      { questionId: Q.company, destination: { kind: 'inviteeName' } },
      { questionId: Q.email, destination: { kind: 'inviteeEmail' } },
      { questionId: Q.email, destination: { kind: 'question', questionId: 'work_email' } },
      {
        questionId: Q.size,
        destination: { kind: 'question', questionId: 'size' },
        options: crosswalk,
      },
    ]
    expect(validateRoutingFormConfig(withMappings(mappings)).rules[0]?.target).toEqual({
      kind: 'event',
      eventTypeId: E.sales,
      mappings,
    })
  })

  it('rejects mappings from dangling source questions', () => {
    for (const questionId of [uuid(999), O.large, 'company'])
      rejectsTarget(
        withMappings([{ questionId, destination: { kind: 'inviteeName' } }]),
        'rules.0.target.mappings.0.questionId',
        'invalid_mapping',
      )
  })

  it('names each destination at most once per target', () => {
    rejectsTarget(
      withMappings([
        { questionId: Q.company, destination: { kind: 'inviteeName' } },
        { questionId: Q.company, destination: { kind: 'inviteeName' } },
      ]),
      'rules.0.target.mappings.1.destination',
      'invalid_mapping',
    )
    rejectsTarget(
      withMappings([
        { questionId: Q.company, destination: { kind: 'question', questionId: 'notes' } },
        { questionId: Q.email, destination: { kind: 'question', questionId: 'notes' } },
      ]),
      'rules.0.target.mappings.1.destination',
      'invalid_mapping',
    )
  })

  it('rejects malformed destinations', () => {
    for (const destination of [
      'inviteeName',
      { kind: 'inviteePhone' },
      { kind: 'inviteeName', questionId: 'name' },
      { kind: 'question' },
      { kind: 'question', questionId: 'bad id' },
      { kind: 'question', questionId: 'x'.repeat(65) },
      { kind: 'question', questionId: 'notes', label: 'Notes' },
    ])
      rejectsTarget(
        withMappings([{ questionId: Q.company, destination }]),
        'rules.0.target.mappings.0.destination',
        'invalid_mapping',
      )
  })

  it('requires a complete crosswalk for select sources and none for text sources', () => {
    const select = (options: unknown) =>
      withMappings([
        { questionId: Q.size, destination: { kind: 'question', questionId: 'size' }, options },
      ])
    const field = 'rules.0.target.mappings.0.options'
    for (const options of [
      undefined,
      {},
      { [O.small]: 'Small', [O.medium]: 'Medium' },
      { ...crosswalk, [O.large]: '' },
      { ...crosswalk, [O.large]: 3 },
      { ...crosswalk, [O.large]: 'x'.repeat(201) },
      [crosswalk],
    ])
      rejectsTarget(select(options), field, 'invalid_mapping')
    // Option IDs of another question, or of none, are dangling.
    rejectsTarget(select({ ...crosswalk, [O.emea]: 'EMEA' }), field, 'invalid_mapping')
    rejectsTarget(select({ ...crosswalk, [uuid(999)]: 'Other' }), field, 'invalid_mapping')
    rejectsTarget(
      withMappings([
        { questionId: Q.company, destination: { kind: 'inviteeName' }, options: crosswalk },
      ]),
      field,
      'invalid_mapping',
    )
  })

  it('bounds mappings per target and rejects unknown mapping fields', () => {
    const mappings = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        questionId: Q.company,
        destination: { kind: 'question', questionId: `q${i}` },
      }))
    expect(
      validateRoutingFormConfig(withMappings(mappings(MAX_MAPPINGS_PER_TARGET))).rules[0]?.target,
    ).toMatchObject({ mappings: mappings(MAX_MAPPINGS_PER_TARGET) })
    rejectsTarget(
      withMappings(mappings(MAX_MAPPINGS_PER_TARGET + 1)),
      'rules.0.target.mappings',
      'invalid_mapping',
    )
    rejectsTarget(withMappings({}), 'rules.0.target.mappings', 'invalid_mapping')
    rejectsTarget(
      withMappings([
        { questionId: Q.company, destination: { kind: 'inviteeName' }, transform: 'upper' },
      ]),
      'rules.0.target.mappings.0',
      'invalid_mapping',
    )
  })
})

describe('routing answer validation', () => {
  const config = validateRoutingFormConfig(form())
  const answers = (value: unknown) => validateRoutingAnswers(config.questions, value)
  function rejectsAnswers(value: unknown, field: string) {
    expect(() => answers(value)).toThrow(
      expect.objectContaining({ code: 'invalid_routing_answers', kind: 'invalid', field }),
    )
  }

  it('returns trimmed answers keyed by question ID, without a prototype', () => {
    const result = answers({
      [Q.company]: '  Acme 東京  ',
      [Q.email]: ' Lead@Example.com ',
      [Q.size]: O.large,
      [Q.region]: O.apac,
    })
    expect({ ...result }).toEqual({
      [Q.company]: 'Acme 東京',
      [Q.email]: 'Lead@Example.com',
      [Q.size]: O.large,
      [Q.region]: O.apac,
    })
    expect(Object.getPrototypeOf(result)).toBe(null)
  })

  it('omits blank, null and absent optional answers', () => {
    for (const blank of [undefined, null, '', '   ', '\t'])
      expect({
        ...answers({
          [Q.company]: 'Acme',
          ...(blank === undefined ? {} : { [Q.email]: blank, [Q.size]: blank }),
        }),
      }).toEqual({ [Q.company]: 'Acme' })
  })

  it('requires a nonblank answer to a required question, not merely a present key', () => {
    for (const value of [{}, { [Q.company]: '' }, { [Q.company]: '  ' }, { [Q.company]: null }])
      rejectsAnswers(value, `answers.${Q.company}`)
    const required = validateRoutingFormConfig(withQuestion(2, { required: true }))
    expect(() => validateRoutingAnswers(required.questions, { [Q.company]: 'Acme' })).toThrow(
      expect.objectContaining({ field: `answers.${Q.size}` }),
    )
  })

  it('rejects unknown answer IDs without echoing them', () => {
    for (const key of [uuid(999), O.large, 'constructor', '__proto__']) {
      const value = JSON.parse(`{"${Q.company}":"Acme","${key}":"x"}`)
      rejectsAnswers(value, 'answers')
      expect(() => answers(value)).toThrow(
        expect.not.objectContaining({ message: expect.stringContaining(key) }),
      )
    }
    for (const value of [null, [], 'Acme', 5]) rejectsAnswers(value, 'answers')
  })

  it('accepts strings only', () => {
    for (const value of [5, true, ['Acme'], { text: 'Acme' }])
      rejectsAnswers({ [Q.company]: value }, `answers.${Q.company}`)
  })

  it('bounds text answers at 500 code units as submitted, before trimming', () => {
    expect(answers({ [Q.company]: 'x'.repeat(500) })[Q.company]).toHaveLength(500)
    expect(answers({ [Q.company]: '汉'.repeat(500) })[Q.company]).toHaveLength(500)
    expect(answers({ [Q.company]: ` ${'x'.repeat(498)} ` })[Q.company]).toHaveLength(498)
    for (const value of ['x'.repeat(501), ` ${'x'.repeat(499)} `, `${'😀'.repeat(250)}x`])
      rejectsAnswers({ [Q.company]: value }, `answers.${Q.company}`)
    rejectsAnswers({ [Q.company]: 'Acme', [Q.size]: ' '.repeat(501) }, `answers.${Q.size}`)
  })

  it('rejects controls and bidirectional controls in text answers', () => {
    for (const value of ['a\nb', 'a\u0000b', 'a‮b', 'a⁦b', 'a\uDC00b'])
      rejectsAnswers({ [Q.company]: value }, `answers.${Q.company}`)
  })

  it('applies the invitee email rule to email answers', () => {
    for (const value of [
      'lead',
      'lead@',
      'lead @example.com',
      `${'a'.repeat(250)}@example.com`,
      'lead@exa‮mple.com',
    ])
      rejectsAnswers({ [Q.company]: 'Acme', [Q.email]: value }, `answers.${Q.email}`)
  })

  it('accepts only an exact option ID of that question as a select answer', () => {
    for (const value of ['200+', O.emea, O.large.toUpperCase(), ` ${O.large}`, uuid(999)])
      rejectsAnswers({ [Q.company]: 'Acme', [Q.size]: value }, `answers.${Q.size}`)
  })
})

describe('routing evaluation', () => {
  const event = (eventTypeId: string) => ({ kind: 'event', eventTypeId })
  function evaluate(rules: unknown[], given: Json, extra: Json = {}) {
    const config = validateRoutingFormConfig(form({ rules, ...extra }))
    return evaluateRoutingForm(config, validateRoutingAnswers(config.questions, given))
  }
  const companyIs = (value: string) => ({ questionId: Q.company, operator: 'equals', value })
  const emailIs = (value: string) => ({ questionId: Q.email, operator: 'equals', value })
  const sizeIn = (...values: string[]) => ({ questionId: Q.size, operator: 'one_of', values })
  const regionIs = (value: string) => ({ questionId: Q.region, operator: 'equals', value })
  const base = { [Q.company]: 'Acme', [Q.size]: O.large, [Q.region]: O.emea }

  it('returns the first matching rule, not a later one', () => {
    const rules = [
      { id: R.first, conditions: [sizeIn(O.large)], target: event(E.sales) },
      { id: R.second, conditions: [companyIs('Acme')], target: event(E.support) },
      { id: R.third, conditions: [regionIs(O.emea)], target: { kind: 'message', message: 'Hi' } },
    ]
    expect(evaluate(rules, base)).toEqual({
      ruleId: R.first,
      target: { kind: 'event', eventTypeId: E.sales, mappings: [] },
    })
    expect(evaluate(rules, { ...base, [Q.size]: O.small })).toEqual({
      ruleId: R.second,
      target: { kind: 'event', eventTypeId: E.support, mappings: [] },
    })
    expect(evaluate(rules, { ...base, [Q.size]: O.small, [Q.company]: 'Other' }).ruleId).toBe(
      R.third,
    )
  })

  it('uses the fallback when no rule matches', () => {
    const rules = [{ id: R.first, conditions: [sizeIn(O.small)], target: event(E.sales) }]
    expect(evaluate(rules, base)).toEqual({
      ruleId: 'fallback',
      target: { kind: 'message', message: 'Thank you' },
    })
    expect(evaluate(rules, base, { fallback: event(E.support) })).toEqual({
      ruleId: 'fallback',
      target: { kind: 'event', eventTypeId: E.support, mappings: [] },
    })
    expect(evaluate([], base).ruleId).toBe('fallback')
  })

  it('requires every condition of a rule (AND)', () => {
    const rules = [
      { id: R.first, conditions: [sizeIn(O.large), regionIs(O.apac)], target: event(E.sales) },
    ]
    expect(evaluate(rules, base).ruleId).toBe('fallback')
    expect(evaluate(rules, { ...base, [Q.region]: O.apac }).ruleId).toBe(R.first)
    // An earlier condition that fails blocks the rule even when the last one holds.
    const lastHolds = [
      { id: R.first, conditions: [regionIs(O.apac), sizeIn(O.large)], target: event(E.sales) },
    ]
    expect(evaluate(lastHolds, base).ruleId).toBe('fallback')
    expect(evaluate(lastHolds, { ...base, [Q.region]: O.apac }).ruleId).toBe(R.first)
  })

  it('expresses OR with one_of inside a select and with adjacent rules', () => {
    const oneOf = [{ id: R.first, conditions: [sizeIn(O.medium, O.large)], target: event(E.sales) }]
    expect(evaluate(oneOf, base).ruleId).toBe(R.first)
    expect(evaluate(oneOf, { ...base, [Q.size]: O.medium }).ruleId).toBe(R.first)
    expect(evaluate(oneOf, { ...base, [Q.size]: O.small }).ruleId).toBe('fallback')
    const adjacent = [
      { id: R.first, conditions: [regionIs(O.apac)], target: event(E.sales) },
      { id: R.second, conditions: [companyIs('Acme')], target: event(E.sales) },
    ]
    expect(evaluate(adjacent, base)).toMatchObject({ ruleId: R.second, target: event(E.sales) })
    expect(evaluate(adjacent, { ...base, [Q.region]: O.apac }).ruleId).toBe(R.first)
  })

  it('compares select answers by option ID', () => {
    const rules = [{ id: R.first, conditions: [regionIs(O.apac)], target: event(E.sales) }]
    expect(evaluate(rules, { ...base, [Q.region]: O.apac }).ruleId).toBe(R.first)
    expect(evaluate(rules, base).ruleId).toBe('fallback')
  })

  it('compares text exactly after trimming and NFC normalization, case-sensitively', () => {
    const rules = (value: string) => [
      { id: R.first, conditions: [companyIs(value)], target: event(E.sales) },
    ]
    expect(evaluate(rules('Acme'), { ...base, [Q.company]: '  Acme  ' }).ruleId).toBe(R.first)
    expect(evaluate(rules('Acme'), { ...base, [Q.company]: 'acme' }).ruleId).toBe('fallback')
    expect(evaluate(rules('Acme'), { ...base, [Q.company]: 'Acme Inc' }).ruleId).toBe('fallback')
    expect(evaluate(rules('Café'), { ...base, [Q.company]: 'Café' }).ruleId).toBe(R.first)
    expect(evaluate(rules('Café'), { ...base, [Q.company]: 'Café' }).ruleId).toBe(R.first)
  })

  it('compares email addresses with the invitee normalization', () => {
    const rules = [
      { id: R.first, conditions: [emailIs('Sales@Example.com')], target: event(E.sales) },
    ]
    expect(evaluate(rules, { ...base, [Q.email]: ' sales@EXAMPLE.com ' }).ruleId).toBe(R.first)
    expect(evaluate(rules, { ...base, [Q.email]: 'support@example.com' }).ruleId).toBe('fallback')
  })

  it('never matches a missing optional answer and moves on to later rules', () => {
    const rules = [
      { id: R.first, conditions: [emailIs('sales@example.com')], target: event(E.sales) },
      { id: R.second, conditions: [regionIs(O.emea)], target: event(E.support) },
      { id: R.third, conditions: [sizeIn(O.small, O.medium, O.large)], target: event(E.sales) },
    ]
    expect(evaluate(rules, { [Q.company]: 'Acme', [Q.email]: '' }).ruleId).toBe('fallback')
    expect(evaluate(rules, { [Q.company]: 'Acme', [Q.region]: O.emea }).ruleId).toBe(R.second)
    expect(evaluate(rules, { [Q.company]: 'Acme', [Q.size]: O.small }).ruleId).toBe(R.third)
  })

  it('never matches a rule without conditions or with a dangling question', () => {
    const config: RoutingFormConfig = validateRoutingFormConfig(form())
    const answers = validateRoutingAnswers(config.questions, base)
    const target = { kind: 'event' as const, eventTypeId: E.sales, mappings: [] }
    expect(
      evaluateRoutingForm({ ...config, rules: [{ id: R.first, conditions: [], target }] }, answers)
        .ruleId,
    ).toBe('fallback')
    expect(
      evaluateRoutingForm(
        {
          ...config,
          rules: [
            {
              id: R.first,
              conditions: [{ questionId: uuid(999), operator: 'equals', value: 'Acme' }],
              target,
            },
          ],
        },
        answers,
      ).ruleId,
    ).toBe('fallback')
  })
})
