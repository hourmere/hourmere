// Binds the database checks of migration 0076 (workflow definitions and revisions) to this
// contract: storage accepts every definition the contract accepts, in the canonical form it
// returns, refuses just beyond each limit it mirrors, and lists exactly the contract's
// triggers, scopes, condition fields and actions, all derived here from the contract's own
// constants and schemas, so neither side can change without the other.
import { randomUUID } from 'node:crypto'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { LOCATION_KINDS, MAX_GUESTS } from '@hourmere/scheduling'
import { DomainError } from '@hourmere/scheduling/errors'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WorkflowConditionSchema } from './conditions.ts'
import {
  validateWorkflowDefinition,
  WORKFLOW_CONTENT_LOCALES,
  WorkflowActionSchema,
  WorkflowDefinitionSchema,
  WorkflowTriggerSchema,
  type WorkflowValidationContext,
} from './definition.ts'
import {
  WORKFLOW_BODY_MAX_BYTES,
  WORKFLOW_MAX_ACTIONS,
  WORKFLOW_MAX_CONDITIONS,
  WORKFLOW_MAX_OFFSET_MINUTES,
  WORKFLOW_MIN_TIMER_OFFSET_MINUTES,
  WORKFLOW_NAME_MAX_BYTES,
  WORKFLOW_SUBJECT_MAX_BYTES,
} from './limits.ts'
import { WorkflowScopeSchema } from './ownership.ts'
import { candidate, ids, personalContext, teamContext } from './testing.ts'
import { WORKFLOW_RECIPIENT_CLASSES } from './variables.ts'

const serverUrl = process.env.DATABASE_URL

/** A string of exactly `bytes` UTF-8 bytes, mostly three-byte characters. */
const utf8 = (bytes: number) => '界'.repeat(Math.floor(bytes / 3)) + 'a'.repeat(bytes % 3)

/** What a revision stores: the canonical definition without the definition row's flag. */
function stored(definition: Record<string, unknown>): Record<string, unknown> {
  const { enabled: _enabled, ...content } = definition
  return content
}

const triggerTypes = WorkflowTriggerSchema.options.map((option) => option.shape.type.value)
const lifecycleTriggers = WorkflowTriggerSchema.options
  .filter((option) => 'delayMinutes' in option.shape)
  .map((option) => option.shape.type.value)
const timerTriggers = WorkflowTriggerSchema.options
  .filter((option) => 'offsetMinutes' in option.shape)
  .map((option) => option.shape.type.value)
const scopeTypes = WorkflowScopeSchema.options.map((option) => option.shape.type.value)
const actionTypes = WorkflowActionSchema.options.map((option) => option.shape.type.value)
const conditionFields = WorkflowConditionSchema.options.map((option) => option.shape.field.value)

/** A valid personal condition for every field; a new field needs its example here. */
const conditionExamples: Record<string, Record<string, unknown>> = {
  event_type: { field: 'event_type', operator: 'equals', value: ids.event },
  booking_source: { field: 'booking_source', operator: 'equals', value: 'embed' },
  answer: { field: 'answer', questionId: 'plan', operator: 'equals', value: 'enterprise' },
  location_kind: { field: 'location_kind', operator: 'equals', value: LOCATION_KINDS[0] },
  guest_count: { field: 'guest_count', operator: 'at_most', value: MAX_GUESTS },
}
const actionExamples: Record<string, Record<string, unknown>> = {
  email: { type: 'email', recipients: ['booker'] },
  webhook: { type: 'webhook', webhookId: ids.webhook },
}
const scopeExamples: Record<string, Record<string, unknown>> = {
  all_event_types: { type: 'all_event_types' },
  event_type: { type: 'event_type', eventTypeId: ids.event },
}

/** The contract's canonical, stored form of a candidate, or its refusal. */
function canonical(
  value: Record<string, unknown>,
  context: WorkflowValidationContext = personalContext,
) {
  return stored(validateWorkflowDefinition(value, context) as Record<string, unknown>)
}
function contractRefuses(value: Record<string, unknown>) {
  expect(() => validateWorkflowDefinition(value, personalContext)).toThrow(DomainError)
}

describe.skipIf(!serverUrl)('workflow definition storage and the definition contract', () => {
  let owned: TestDatabase
  let organization: string
  let workflow: string

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'wf_contract' })
    organization = (
      await owned.pool.query<{ id: string }>(
        `INSERT INTO auth.organization (name,slug,"createdAt") VALUES ('Synthetic workflow team',$1,now()) RETURNING id`,
        [randomUUID()],
      )
    ).rows[0]?.id as string
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      workflow = (
        await client.query<{ id: string }>(
          'INSERT INTO workflow_definitions (organization_id) VALUES ($1) RETURNING id',
          [organization],
        )
      ).rows[0]?.id as string
      await client.query(
        'INSERT INTO workflow_revisions (organization_id,workflow_id,revision,definition) VALUES ($1,$2,1,$3)',
        [organization, workflow, JSON.stringify(canonical(candidate()))],
      )
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })
  afterAll(async () => {
    await owned?.drop()
  })

  /**
   * Stores `content` as the next revision in a rolled-back transaction and returns what the
   * database read back, or the refusal.
   */
  async function store(content: unknown): Promise<unknown> {
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ definition: unknown }>(
        'INSERT INTO workflow_revisions (organization_id,workflow_id,revision,definition) VALUES ($1,$2,2,$3) RETURNING definition',
        [organization, workflow, JSON.stringify(content)],
      )
      return rows[0]?.definition
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }
  const accepted = async (content: Record<string, unknown>, label: string) =>
    expect(await store(content), label).toEqual(content)
  const refused = (content: unknown, constraint: string, label: string) =>
    expect(store(content), label).rejects.toMatchObject({ code: '23514', constraint })

  it('stores the contract output without the live enabled flag, which the definition row keeps', async () => {
    expect(Object.keys(WorkflowDefinitionSchema.shape).sort()).toEqual([
      'actions',
      'conditions',
      'enabled',
      'name',
      'scope',
      'trigger',
    ])
    const content = canonical(candidate({ enabled: true }))
    expect(Object.keys(content).sort()).toEqual([
      'actions',
      'conditions',
      'name',
      'scope',
      'trigger',
    ])
    await accepted(content, 'a canonical definition')
    await refused({ ...content, enabled: true }, 'workflow_revisions_shape', 'with enabled')
  })

  it('accepts every definition the contract accepts, at each of its limits, unchanged', async () => {
    const maximal = Object.fromEntries(
      WORKFLOW_CONTENT_LOCALES.map((locale) => [
        locale,
        {
          subject: utf8(WORKFLOW_SUBJECT_MAX_BYTES),
          // A second line after a line feed, which the body keeps.
          body: `${utf8(WORKFLOW_BODY_MAX_BYTES - 8)}\nline 2!`,
        },
      ]),
    )
    const candidates: [string, Record<string, unknown>, WorkflowValidationContext?][] = [
      ['a name at its byte limit', candidate({ name: ` ${utf8(WORKFLOW_NAME_MAX_BYTES)}\t` })],
      ['a name of one byte', candidate({ name: 'a' })],
      ...conditionFields.map((field): [string, Record<string, unknown>] => [
        `the ${field} condition`,
        candidate({ conditions: [conditionExamples[field]] }),
      ]),
      [
        'conditions at their limit',
        candidate({
          conditions: Array.from(
            { length: WORKFLOW_MAX_CONDITIONS },
            (_, index) =>
              conditionExamples[conditionFields[index % conditionFields.length] as string],
          ),
        }),
      ],
      [
        'actions at their limit',
        candidate({
          actions: Array.from({ length: WORKFLOW_MAX_ACTIONS }, () => actionExamples.email),
        }),
      ],
      [
        'custom text in every locale at its byte limits',
        candidate({ actions: [{ ...actionExamples.email, content: maximal }] }),
      ],
      [
        'every recipient class',
        candidate({
          // Out of order: the contract sorts them.
          actions: [{ type: 'email', recipients: [...WORKFLOW_RECIPIENT_CLASSES].reverse() }],
        }),
      ],
      ...scopeTypes.map((type): [string, Record<string, unknown>] => [
        `the ${type} scope`,
        candidate({ scope: scopeExamples[type] }),
      ]),
      ...actionTypes.map((type): [string, Record<string, unknown>] => [
        `the ${type} action`,
        candidate({ actions: [actionExamples[type]] }),
      ]),
      ...lifecycleTriggers.flatMap((type): [string, Record<string, unknown>][] => [
        [`${type} by default`, candidate({ trigger: { type } })],
        [
          `${type} at the largest delay`,
          candidate({ trigger: { type, delayMinutes: WORKFLOW_MAX_OFFSET_MINUTES } }),
        ],
      ]),
      ...timerTriggers.flatMap((type): [string, Record<string, unknown>][] => [
        [
          `${type} at the smallest offset`,
          candidate({ trigger: { type, offsetMinutes: WORKFLOW_MIN_TIMER_OFFSET_MINUTES } }),
        ],
        [
          `${type} at the largest offset`,
          candidate({ trigger: { type, offsetMinutes: WORKFLOW_MAX_OFFSET_MINUTES } }),
        ],
      ]),
      [
        'a team definition',
        candidate({ scope: { type: 'event_type', eventTypeId: ids.teamEvent } }),
        teamContext,
      ],
    ]
    expect(triggerTypes).toEqual([...lifecycleTriggers, ...timerTriggers])
    for (const [label, value, context] of candidates) {
      const content = canonical(value, context)
      await accepted(content, label)
      // What storage returns is canonical: validating it again changes nothing.
      expect(canonical({ ...content }, context), label).toEqual(content)
    }
  })

  it('refuses beyond each limit it mirrors, exactly where the contract does', async () => {
    const base = canonical(candidate())
    const beyond: [string, string, Record<string, unknown>][] = [
      [
        'workflow_revisions_name',
        'a name one byte over',
        { name: utf8(WORKFLOW_NAME_MAX_BYTES + 1) },
      ],
      [
        'workflow_revisions_conditions',
        'one condition too many',
        {
          conditions: Array.from(
            { length: WORKFLOW_MAX_CONDITIONS + 1 },
            () => conditionExamples.guest_count,
          ),
        },
      ],
      [
        'workflow_revisions_actions',
        'one action too many',
        {
          actions: Array.from({ length: WORKFLOW_MAX_ACTIONS + 1 }, () => actionExamples.email),
        },
      ],
      ['workflow_revisions_actions', 'no action', { actions: [] }],
      ...timerTriggers.flatMap((type): [string, string, Record<string, unknown>][] => [
        [
          'workflow_revisions_trigger',
          `${type} below the smallest offset`,
          { trigger: { type, offsetMinutes: WORKFLOW_MIN_TIMER_OFFSET_MINUTES - 1 } },
        ],
        [
          'workflow_revisions_trigger',
          `${type} above the largest offset`,
          { trigger: { type, offsetMinutes: WORKFLOW_MAX_OFFSET_MINUTES + 1 } },
        ],
        [
          'workflow_revisions_trigger',
          `${type} with a delay`,
          { trigger: { type, offsetMinutes: 60, delayMinutes: 0 } },
        ],
      ]),
      ...lifecycleTriggers.flatMap((type): [string, string, Record<string, unknown>][] => [
        [
          'workflow_revisions_trigger',
          `${type} delayed by -1`,
          { trigger: { type, delayMinutes: -1 } },
        ],
        [
          'workflow_revisions_trigger',
          `${type} above the largest delay`,
          { trigger: { type, delayMinutes: WORKFLOW_MAX_OFFSET_MINUTES + 1 } },
        ],
        [
          'workflow_revisions_trigger',
          `${type} with an offset`,
          { trigger: { type, delayMinutes: 0, offsetMinutes: 60 } },
        ],
      ]),
    ]
    for (const [constraint, label, overrides] of beyond) {
      contractRefuses({ ...candidate(), ...overrides })
      await refused({ ...base, ...overrides }, constraint, label)
    }
    // The empty name the contract refuses after trimming is refused by storage too.
    contractRefuses(candidate({ name: '  ' }))
    await refused({ ...base, name: '' }, 'workflow_revisions_name', 'an empty name')
  })

  it('refuses every trigger, scope, condition and action the contract does not know', async () => {
    const base = canonical(candidate())
    const unknown: [string, string, Record<string, unknown>][] = [
      [
        'workflow_revisions_trigger',
        'trigger',
        { trigger: { type: 'booking.attendee_no_show_changed', delayMinutes: 0 } },
      ],
      [
        'workflow_revisions_trigger',
        'request trigger',
        { trigger: { type: 'booking.reschedule_requested', delayMinutes: 0 } },
      ],
      ['workflow_revisions_scope', 'scope', { scope: { type: 'team_event_types' } }],
      [
        'workflow_revisions_conditions',
        'condition',
        { conditions: [{ field: 'attendee_no_show', operator: 'equals', value: true }] },
      ],
      [
        'workflow_revisions_actions',
        'action',
        { actions: [{ type: 'sms', recipients: ['booker'] }] },
      ],
    ]
    for (const [constraint, label, overrides] of unknown) {
      contractRefuses({ ...candidate(), ...overrides })
      await refused({ ...base, ...overrides }, constraint, label)
    }
  })

  it('names exactly the contract catalogues in its checks, with one condition position per allowed condition', async () => {
    const { rows } = await owned.pool.query<{ name: string; definition: string }>(
      `SELECT conname AS name,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='workflow_revisions'::regclass AND contype='c'`,
    )
    /** The string lists of every `= ANY (ARRAY[…])` in a check, in order. */
    const lists = (name: string) =>
      [
        ...(rows.find((row) => row.name === name)?.definition ?? '').matchAll(
          /= ANY \(ARRAY\[([^\]]*)\]\)/g,
        ),
      ].map(([, list]) =>
        [...(list as string).matchAll(/'([^']*)'::text/g)].map(([, value]) => value),
      )
    expect(lists('workflow_revisions_scope')).toEqual([scopeTypes])
    expect(lists('workflow_revisions_trigger')).toEqual([lifecycleTriggers, timerTriggers])
    expect(lists('workflow_revisions_actions')).toEqual([actionTypes])
    expect(lists('workflow_revisions_conditions')).toEqual(
      Array.from({ length: WORKFLOW_MAX_CONDITIONS }, () => conditionFields),
    )
  })

  it('closes every pool it opens', () => {
    expect(owned.pool.totalCount).toBeLessThanOrEqual(2)
  })
})
