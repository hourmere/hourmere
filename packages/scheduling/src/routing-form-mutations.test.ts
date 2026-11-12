// Source-copy mutation controls for routing validation, evaluation and target eligibility:
// each removes one protection from a copy of the module and requires a real assertion about
// that protection to fail, while the same assertion passes on the shipped module.
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectKilled, guardCopy } from '../../../scripts/source-copy-guard.ts'
import type { Question } from './questions.ts'
import * as Config from './routing-form-config.ts'
import * as Targets from './routing-form-targets.ts'
import { createFixtures } from './testing.ts'

type ConfigModule = typeof Config
type TargetsModule = typeof Targets

async function sourceCopy<T>(file: string, from: string, to: string): Promise<T> {
  const location = new URL(file, import.meta.url)
  const original = readFileSync(location, 'utf8')
  // Exactly one occurrence, so each mutation removes the protection it names.
  expect(original.split(from)).toHaveLength(2)
  const source = stripTypeScriptTypes(original.replace(from, to)).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return guardCopy(
    await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`),
  ) as T
}

const uuid = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`
const Q = { company: uuid(1), email: uuid(2), size: uuid(3) }
const O = { small: uuid(11), large: uuid(12) }
const R = { first: uuid(21), second: uuid(22) }
const E = { sales: uuid(31), support: uuid(32) }
const questions = [
  { id: Q.company, type: 'short_text', label: 'Company', required: true },
  { id: Q.email, type: 'email', label: 'Work email' },
  {
    id: Q.size,
    type: 'select',
    label: 'Company size',
    options: [
      { id: O.small, label: '1–10' },
      { id: O.large, label: '200+' },
    ],
  },
]
const event = (eventTypeId: string, mappings: unknown[] = []) => ({
  kind: 'event',
  eventTypeId,
  mappings,
})
const sizeIsLarge = { questionId: Q.size, operator: 'equals', value: O.large }
const form = (
  rules: unknown[] = [],
  fallback: unknown = { kind: 'message', message: 'Thanks' },
) => ({
  questions,
  rules,
  fallback,
})
const rule = (id: string, conditions: unknown[], target: unknown = event(E.sales)) => ({
  id,
  conditions,
  target,
})
const crosswalk = { [O.small]: 'Small', [O.large]: 'Large' }

function rejects(module: ConfigModule, input: unknown, expected: Record<string, unknown>) {
  expect(() => module.validateRoutingFormConfig(input)).toThrow(expect.objectContaining(expected))
}
function rejectsAnswers(module: ConfigModule, given: unknown, field: string) {
  const config = module.validateRoutingFormConfig(form())
  expect(() => module.validateRoutingAnswers(config.questions, given)).toThrow(
    expect.objectContaining({ code: 'invalid_routing_answers', field }),
  )
}
function route(module: ConfigModule, rules: unknown[], given: Record<string, string>) {
  const config = module.validateRoutingFormConfig(form(rules))
  return module.evaluateRoutingForm(config, module.validateRoutingAnswers(config.questions, given))
    .ruleId
}

const configMutations: {
  name: string
  from: string
  to: string
  verify: (module: ConfigModule) => void
}[] = [
  {
    name: 'first match wins (evaluator returns a later match)',
    from: 'for (const rule of config.rules) {',
    to: 'for (const rule of config.rules.toReversed()) {',
    verify: (m) => {
      const rules = [
        rule(R.first, [sizeIsLarge], event(E.sales)),
        rule(R.second, [{ questionId: Q.company, operator: 'equals', value: 'Acme' }]),
      ]
      expect(route(m, rules, { [Q.company]: 'Acme', [Q.size]: O.large })).toBe(R.first)
    },
  },
  {
    name: 'absent optional answer never matches',
    from: '  if (answer === undefined) return false',
    to: '  if (answer === undefined) return true',
    verify: (m) => {
      const rules = [rule(R.first, [{ questionId: Q.email, operator: 'equals', value: 'a@b.co' }])]
      expect(route(m, rules, { [Q.company]: 'Acme' })).toBe('fallback')
    },
  },
  {
    name: 'every condition of a rule (AND)',
    from: 'rule.conditions.every((condition)',
    to: 'rule.conditions.some((condition)',
    verify: (m) => {
      const rules = [
        rule(R.first, [sizeIsLarge, { questionId: Q.company, operator: 'equals', value: 'Acme' }]),
      ]
      expect(route(m, rules, { [Q.company]: 'Other', [Q.size]: O.large })).toBe('fallback')
    },
  },
  {
    name: 'rule without conditions never matches',
    from: 'rule.conditions.length > 0 &&',
    to: 'true &&',
    verify: (m) => {
      const config = m.validateRoutingFormConfig(form())
      const target = { kind: 'event' as const, eventTypeId: E.sales, mappings: [] }
      const answers = m.validateRoutingAnswers(config.questions, { [Q.company]: 'Acme' })
      expect(
        m.evaluateRoutingForm(
          { ...config, rules: [{ id: R.first, conditions: [], target }] },
          answers,
        ).ruleId,
      ).toBe('fallback')
    },
  },
  {
    name: 'NFC text comparison',
    from: "if (type === 'short_text') return value.normalize('NFC')",
    to: "if (type === 'short_text') return value",
    verify: (m) => {
      const rules = [rule(R.first, [{ questionId: Q.company, operator: 'equals', value: 'Café' }])]
      expect(route(m, rules, { [Q.company]: 'Café' })).toBe(R.first)
    },
  },
  {
    name: 'literals stored as written (validation idempotent)',
    from: "invalidForm(field, 'must be an email address')\n  return text",
    to: "invalidForm(field, 'must be an email address')\n  return text.normalize('NFC')",
    verify: (m) => {
      const config = m.validateRoutingFormConfig(
        form([
          rule(R.first, [
            { questionId: Q.company, operator: 'equals', value: '\u0958'.repeat(500) },
          ]),
        ]),
      )
      expect(() => m.validateRoutingFormConfig(config)).not.toThrow()
    },
  },
  {
    name: 'invitee email normalization in comparisons',
    from: "if (type === 'email') return value.toLowerCase()",
    to: '',
    verify: (m) => {
      const rules = [
        rule(R.first, [{ questionId: Q.email, operator: 'equals', value: 'Sales@Example.com' }]),
      ]
      expect(route(m, rules, { [Q.company]: 'Acme', [Q.email]: 'sales@example.com' })).toBe(R.first)
    },
  },
  {
    name: 'one_of on select questions only',
    from: "if (question.type !== 'select')",
    to: 'if (false)',
    verify: (m) =>
      rejects(
        m,
        form([rule(R.first, [{ questionId: Q.company, operator: 'one_of', values: ['Acme'] }])]),
        {
          field: 'rules.0.conditions.0.operator',
        },
      ),
  },
  {
    name: 'dangling condition question',
    from: '  if (question === undefined)\n    throw',
    to: '  if (false)\n    throw',
    verify: (m) =>
      rejects(
        m,
        form([rule(R.first, [{ questionId: uuid(999), operator: 'equals', value: 'x' }])]),
        {
          code: 'invalid_routing_form',
          field: 'rules.0.conditions.0.questionId',
        },
      ),
  },
  {
    name: 'select literals are option IDs of that question',
    from: '    if (!question.options.some((option) => option.id === value))\n      throw invalidForm(field, "must be one of the question\'s option IDs")',
    to: '',
    verify: (m) =>
      rejects(
        m,
        form([rule(R.first, [{ questionId: Q.size, operator: 'equals', value: '200+' }])]),
        {
          field: 'rules.0.conditions.0.value',
        },
      ),
  },
  {
    name: 'empty literal',
    from: "  if (text === '') throw invalidForm(field, 'must not be blank')",
    to: '',
    verify: (m) =>
      rejects(
        m,
        form([rule(R.first, [{ questionId: Q.company, operator: 'equals', value: '  ' }])]),
        {
          field: 'rules.0.conditions.0.value',
        },
      ),
  },
  {
    name: 'length bound before trimming',
    from: '  if (value.length > max) return undefined',
    to: '  if (value.trim().length > max) return undefined',
    verify: (m) =>
      rejectsAnswers(m, { [Q.company]: ` ${'x'.repeat(499)} ` }, `answers.${Q.company}`),
  },
  {
    name: 'bidirectional controls',
    from: '  if (BIDI_CONTROLS.test(text)) return undefined',
    to: '',
    verify: (m) => rejectsAnswers(m, { [Q.company]: 'Acme ‮corp' }, `answers.${Q.company}`),
  },
  {
    name: 'distinct identities',
    from: "  if (ids.has(value)) throw invalidForm(field, 'must not repeat another ID of this form')",
    to: '',
    verify: (m) =>
      rejects(m, form([rule(R.first, [sizeIsLarge]), rule(R.first, [sizeIsLarge])]), {
        field: 'rules.1.id',
      }),
  },
  {
    name: 'required answers',
    from: "if (question.required) throw invalidAnswers(field, 'is required')",
    to: '',
    verify: (m) => rejectsAnswers(m, { [Q.company]: '   ' }, `answers.${Q.company}`),
  },
  {
    name: 'unknown answer IDs',
    from: 'if (Object.keys(value).some((id) => !known.has(id)))',
    to: 'if (false)',
    verify: (m) => rejectsAnswers(m, { [Q.company]: 'Acme', [uuid(999)]: 'x' }, 'answers'),
  },
  {
    name: 'select answers are option IDs',
    from: "if (question.type === 'select' && !question.options.some((option) => option.id === given))",
    to: 'if (false)',
    verify: (m) =>
      rejectsAnswers(m, { [Q.company]: 'Acme', [Q.size]: '200+' }, `answers.${Q.size}`),
  },
  {
    name: 'email answers follow the invitee rule',
    from: "    if (question.type === 'email' && cleanInviteeEmail(text) === undefined)\n      throw invalidAnswers(",
    to: '    if (false)\n      throw invalidAnswers(',
    verify: (m) =>
      rejectsAnswers(m, { [Q.company]: 'Acme', [Q.email]: 'not-an-email' }, `answers.${Q.email}`),
  },
  {
    name: 'unsupported target kinds',
    from: "if (value.kind === 'event') {",
    to: "if (value.kind !== 'message') {",
    verify: (m) =>
      rejects(m, form([], { kind: 'url', eventTypeId: E.sales }), {
        code: 'invalid_routing_target',
        reason: 'unsupported_target',
      }),
  },
  {
    name: 'no member or other selector on event targets',
    from: "strict(value, ['kind', 'eventTypeId', 'mappings'], unsupported)",
    to: 'void 0',
    verify: (m) =>
      rejects(m, form([], { ...event(E.sales), memberId: uuid(500) }), {
        code: 'invalid_routing_target',
        reason: 'unsupported_target',
      }),
  },
  {
    name: 'dangling mapping source',
    from: "  if (source === undefined) throw error('.questionId')('must name a question of this form')",
    to: '',
    verify: (m) =>
      rejects(
        m,
        form([], event(E.sales, [{ questionId: uuid(999), destination: { kind: 'inviteeName' } }])),
        { code: 'invalid_routing_target', field: 'fallback.mappings.0.questionId' },
      ),
  },
  {
    name: 'one source per destination',
    from: '      if (destinations.has(key))',
    to: '      if (false)',
    verify: (m) =>
      rejects(
        m,
        form(
          [],
          event(E.sales, [
            { questionId: Q.company, destination: { kind: 'inviteeName' } },
            { questionId: Q.company, destination: { kind: 'inviteeName' } },
          ]),
        ),
        { code: 'invalid_routing_target', reason: 'invalid_mapping' },
      ),
  },
  {
    name: 'complete select crosswalk',
    from: '  for (const option of source.options) {\n',
    to: '  for (const option of source.options) {\n    if (!Object.hasOwn(crosswalk, option.id)) continue\n',
    verify: (m) =>
      rejects(
        m,
        form(
          [],
          event(E.sales, [
            {
              questionId: Q.size,
              destination: { kind: 'question', questionId: 'size' },
              options: { [O.small]: 'Small' },
            },
          ]),
        ),
        { code: 'invalid_routing_target', field: 'fallback.mappings.0.options' },
      ),
  },
  {
    name: 'no dangling crosswalk option IDs',
    from: '    source.options.map((option) => option.id),',
    to: '    Object.keys(isRecord(m.options) ? m.options : {}),',
    verify: (m) =>
      rejects(
        m,
        form(
          [],
          event(E.sales, [
            {
              questionId: Q.size,
              destination: { kind: 'question', questionId: 'size' },
              options: { ...crosswalk, [uuid(999)]: 'Other' },
            },
          ]),
        ),
        { code: 'invalid_routing_target', field: 'fallback.mappings.0.options' },
      ),
  },
]

const ORG = uuid(100)
const USER = uuid(101)
const bookingQuestions: Question[] = [
  { id: 'notes', label: 'Notes', type: 'long_text', required: false },
  { id: 'phone', label: 'Phone', type: 'phone', required: false },
  { id: 'size', label: 'Size', type: 'select', required: true, options: ['Small', 'Large'] },
]
function targetEvent(overrides: Partial<Targets.RoutingTargetEvent> = {}) {
  return {
    id: E.sales,
    organizationId: ORG,
    ownerUserId: USER,
    personalUserId: USER,
    active: true,
    deleted: false,
    bookingMode: 'individual',
    schedulingType: 'individual',
    payment: 'none',
    questions: bookingQuestions,
    ...overrides,
  }
}
function targetReason(
  module: TargetsModule,
  overrides: Partial<Targets.RoutingTargetEvent>,
  mappings: unknown[] = [],
) {
  const config = Config.validateRoutingFormConfig(form([], event(E.sales, mappings)))
  try {
    module.validateRoutingTargets(ORG, config, new Map([[E.sales, targetEvent(overrides)]]))
    return undefined
  } catch (error) {
    expect(error).toMatchObject({ code: 'invalid_routing_target' })
    return (error as Config.RoutingValidationError).reason
  }
}

const targetMutations: {
  name: string
  from: string
  to: string
  verify: (module: TargetsModule) => void
}[] = [
  {
    name: 'same organization (cross-org accepted)',
    from: "  if (event.organizationId !== organizationId) return 'not_found'",
    to: '',
    verify: (m) => expect(targetReason(m, { organizationId: uuid(102) })).toBe('not_found'),
  },
  {
    name: "the organization's ownership",
    from: "  if (event.ownerUserId !== event.personalUserId) return 'not_found'",
    to: '',
    verify: (m) => expect(targetReason(m, { ownerUserId: uuid(103) })).toBe('not_found'),
  },
  {
    name: 'not deleted',
    from: "  if (event.deleted) return 'deleted'",
    to: '',
    verify: (m) => expect(targetReason(m, { deleted: true })).toBe('deleted'),
  },
  {
    name: 'enabled',
    from: "  if (!event.active) return 'disabled'",
    to: '',
    verify: (m) => expect(targetReason(m, { active: false })).toBe('disabled'),
  },
  {
    name: "booking_mode = 'individual' (both mode checks)",
    from: "  if (event.bookingMode === 'group') return 'group_booking'\n  if (event.bookingMode !== 'individual') return 'unsupported_mode'",
    to: '',
    verify: (m) => expect(targetReason(m, { bookingMode: 'group' })).toBe('group_booking'),
  },
  {
    name: 'group-mode reason',
    from: "  if (event.bookingMode === 'group') return 'group_booking'",
    to: '',
    verify: (m) => expect(targetReason(m, { bookingMode: 'group' })).toBe('group_booking'),
  },
  {
    name: 'unknown booking modes fail closed (unknown mode accepted)',
    from: "  if (event.bookingMode !== 'individual') return 'unsupported_mode'",
    to: '',
    verify: (m) => expect(targetReason(m, { bookingMode: 'auction' })).toBe('unsupported_mode'),
  },
  {
    name: 'unknown host modes fail closed',
    from: "  if (!ROUTING_SCHEDULING_TYPES.includes(event.schedulingType)) return 'unsupported_mode'",
    to: '',
    verify: (m) => expect(targetReason(m, { schedulingType: 'managed' })).toBe('unsupported_mode'),
  },
  {
    name: 'no payment requirement',
    from: "  if (event.payment !== 'none') return 'payment_required'",
    to: '',
    verify: (m) => expect(targetReason(m, { payment: 'required' })).toBe('payment_required'),
  },
  {
    name: 'mappings checked against the event',
    from: '    target.mappings.forEach((mapping, i) => {',
    to: '    ;[].forEach((mapping, i) => {',
    verify: (m) =>
      expect(
        targetReason(m, {}, [
          { questionId: Q.company, destination: { kind: 'question', questionId: 'phone' } },
        ]),
      ).toBe('incompatible_mapping'),
  },
  {
    name: 'text destinations are short or long text',
    from: "  return field.type === 'short_text' || field.type === 'long_text'\n    ? undefined\n    : 'incompatible_mapping'",
    to: '  return undefined',
    verify: (m) =>
      expect(
        targetReason(m, {}, [
          { questionId: Q.email, destination: { kind: 'question', questionId: 'phone' } },
        ]),
      ).toBe('incompatible_mapping'),
  },
  {
    name: 'invitee name takes short text only',
    from: "    return source.type === 'short_text' ? undefined : 'incompatible_mapping'",
    to: '    return undefined',
    verify: (m) =>
      expect(
        targetReason(m, {}, [{ questionId: Q.email, destination: { kind: 'inviteeName' } }]),
      ).toBe('incompatible_mapping'),
  },
  {
    name: 'invitee email takes email only',
    from: "    return source.type === 'email' ? undefined : 'incompatible_mapping'",
    to: '    return undefined',
    verify: (m) =>
      expect(
        targetReason(m, {}, [{ questionId: Q.company, destination: { kind: 'inviteeEmail' } }]),
      ).toBe('incompatible_mapping'),
  },
  {
    name: 'select sources fill select questions only',
    from: "    if (field.type !== 'select') return 'incompatible_mapping'",
    to: '',
    verify: (m) =>
      expect(
        targetReason(m, {}, [
          {
            questionId: Q.size,
            destination: { kind: 'question', questionId: 'notes' },
            options: crosswalk,
          },
        ]),
      ).toBe('incompatible_mapping'),
  },
  {
    name: 'crosswalk values are current destination options',
    from: '.some((value) => !current.includes(value))',
    to: '.some(() => false)',
    verify: (m) =>
      expect(
        targetReason(
          m,
          {
            questions: bookingQuestions.map((q) =>
              q.id === 'size' ? { ...q, options: ['Small', 'Medium'] } : q,
            ),
          },
          [
            {
              questionId: Q.size,
              destination: { kind: 'question', questionId: 'size' },
              options: crosswalk,
            },
          ],
        ),
      ).toBe('incompatible_options'),
  },
  {
    name: 'dangling destination question',
    from: "  if (field === undefined) return 'unknown_destination'",
    to: '',
    verify: (m) =>
      expect(
        targetReason(m, {}, [
          { questionId: Q.company, destination: { kind: 'question', questionId: 'missing' } },
        ]),
      ).toBe('unknown_destination'),
  },
]

describe('routing validation and evaluation source-copy mutations', () => {
  // Some removed guards make the code crash instead of refusing; the unmutated copy tells
  // that apart from a broken copy.
  it.each(configMutations)('detects removed $name', async ({ from, to, verify }) => {
    verify(Config)
    const copy = await sourceCopy<ConfigModule>('./routing-form-config.ts', from, to)
    const unmutated = await sourceCopy<ConfigModule>('./routing-form-config.ts', from, from)
    await expectKilled(copy, verify, { unmutated })
  })

  it.each(targetMutations)(
    'detects removed eligibility or mapping check: $name',
    async ({ from, to, verify }) => {
      verify(Targets)
      const copy = await sourceCopy<TargetsModule>('./routing-form-targets.ts', from, to)
      const unmutated = await sourceCopy<TargetsModule>('./routing-form-targets.ts', from, from)
      await expectKilled(copy, verify, { unmutated })
    },
  )
})

// The stored-event projection: each field eligibility reads must come from the row.
const serverUrl = process.env.DATABASE_URL
describe.skipIf(!serverUrl)('routing target loading source-copy mutations', () => {
  let owned: TestDatabase
  let db: Db
  const events: Record<string, string> = {}
  let organization = ''
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    const f = createFixtures(db)
    const host = await f.host()
    const other = await f.host()
    organization = host.organizationId
    const personal = (o = {}) => f.eventType(organization, host.userId, o)
    events.listed = await personal({ questions: bookingQuestions })
    events.hidden = await personal()
    events.deleted = await personal({ deletedAt: '2026-11-01T00:00:00Z' })
    events.disabled = await personal({ isActive: false })
    events.group = await personal()
    events.misowned = await f.eventType(organization, other.userId)
    await db
      .updateTable('event_types')
      .set({ is_hidden: true })
      .where('id', '=', events.hidden)
      .execute()
    await db
      .updateTable('event_types')
      .set({ booking_mode: 'group', group_capacity: 3 })
      .where('id', '=', events.group)
      .execute()
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function reasonFor(module: TargetsModule, key: string, mappings: unknown[] = []) {
    const config = Config.validateRoutingFormConfig(
      form([], event(events[key] as string, mappings)),
    )
    try {
      await module.checkRoutingTargets(db, organization, config)
      return undefined
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_routing_target' })
      return (error as Config.RoutingValidationError).reason
    }
  }

  it.each([
    {
      name: 'hidden events stay eligible',
      from: "    .where('e.id', 'in', ids)",
      to: "    .where('e.id', 'in', ids)\n    .where('e.is_hidden', '=', false)",
      verify: async (m: TargetsModule) => expect(await reasonFor(m, 'hidden')).toBeUndefined(),
    },
    {
      name: 'stored personal owner',
      from: '        personalUserId: row.personal_user_id,',
      to: '        personalUserId: row.owner_user_id,',
      verify: async (m: TargetsModule) => expect(await reasonFor(m, 'misowned')).toBe('not_found'),
    },
    {
      name: 'stored deletion',
      from: '        deleted: row.deleted_at !== null,',
      to: '        deleted: false,',
      verify: async (m: TargetsModule) => expect(await reasonFor(m, 'deleted')).toBe('deleted'),
    },
    {
      name: 'stored enabled flag',
      from: '        active: row.is_active,',
      to: '        active: true,',
      verify: async (m: TargetsModule) => expect(await reasonFor(m, 'disabled')).toBe('disabled'),
    },
    {
      name: 'stored booking mode',
      from: '        bookingMode: row.booking_mode,',
      to: "        bookingMode: 'individual',",
      verify: async (m: TargetsModule) => expect(await reasonFor(m, 'group')).toBe('group_booking'),
    },
    {
      name: 'stored booking questions',
      from: '        questions: parseQuestions(row.questions),',
      to: '        questions: [],',
      verify: async (m: TargetsModule) =>
        expect(
          await reasonFor(m, 'listed', [
            { questionId: Q.company, destination: { kind: 'question', questionId: 'notes' } },
          ]),
        ).toBeUndefined(),
    },
  ])('detects a projection that ignores the $name', async ({ from, to, verify }) => {
    await verify(Targets)
    const copy = await sourceCopy<TargetsModule>('./routing-form-targets.ts', from, to)
    await expectKilled(copy, verify)
    expect(owned.pool.totalCount).toBeLessThanOrEqual(10)
  })
})
