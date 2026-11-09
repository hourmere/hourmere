import { DomainError } from '@hourmere/scheduling/errors'
import { describe, expect, it } from 'vitest'
import {
  parseWorkflowDefinition,
  validateWorkflowDefinition,
  WORKFLOW_CONTENT_LOCALES,
  type WorkflowValidationContext,
  workflowReferences,
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
import type { WorkflowEventTypeFacts, WorkflowWebhookFacts } from './ownership.ts'
import { candidate, ids, personalContext, teamContext } from './testing.ts'

/** The `path: constraint` message of the invalid_workflow refusal `run` throws. */
function refusal(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).kind).toBe('invalid')
    expect((error as DomainError).code).toBe('invalid_workflow')
    return (error as DomainError).message
  }
  throw new Error('expected an invalid_workflow refusal')
}
const validate = (value: unknown, context: WorkflowValidationContext = personalContext) =>
  validateWorkflowDefinition(value, context)
const refused = (value: unknown, context: WorkflowValidationContext = personalContext) =>
  refusal(() => validate(value, context))

const email = (overrides: Record<string, unknown> = {}) => ({
  type: 'email',
  recipients: ['booker'],
  ...overrides,
})
const content = (subject: string, body: string, locale = 'en') => ({ [locale]: { subject, body } })
/** A string of `bytes` UTF-8 bytes made of three-byte characters plus ASCII padding. */
const utf8 = (bytes: number) => '界'.repeat(Math.floor(bytes / 3)) + 'a'.repeat(bytes % 3)

describe('workflow definition shape', () => {
  it('accepts a minimal definition and fills the documented defaults', () => {
    expect(validate(candidate())).toEqual({
      name: 'Prepare for our call',
      enabled: false,
      scope: { type: 'event_type', eventTypeId: ids.event },
      trigger: { type: 'before_start', offsetMinutes: 60 },
      conditions: [],
      actions: [{ type: 'email', recipients: ['booker'] }],
    })
  })

  it('accepts every trigger, with a lifecycle delay defaulting to zero', () => {
    for (const type of ['booking.created', 'booking.cancelled', 'booking.rescheduled'] as const) {
      expect(validate(candidate({ trigger: { type } })).trigger).toEqual({ type, delayMinutes: 0 })
      expect(validate(candidate({ trigger: { type, delayMinutes: 30 } })).trigger).toEqual({
        type,
        delayMinutes: 30,
      })
    }
    for (const type of ['before_start', 'after_end'] as const)
      expect(validate(candidate({ trigger: { type, offsetMinutes: 15 } })).trigger).toEqual({
        type,
        offsetMinutes: 15,
      })
  })

  it('accepts both scopes and an explicit enabled flag', () => {
    const all = validate(candidate({ scope: { type: 'all_event_types' }, enabled: true }))
    expect(all.scope).toEqual({ type: 'all_event_types' })
    expect(all.enabled).toBe(true)
    expect(validate(candidate({ scope: { type: 'all_event_types' } }), teamContext).scope).toEqual({
      type: 'all_event_types',
    })
    expect(
      validate(
        candidate({ scope: { type: 'event_type', eventTypeId: ids.teamEvent } }),
        teamContext,
      ).scope,
    ).toEqual({ type: 'event_type', eventTypeId: ids.teamEvent })
  })

  it('accepts every condition with its operators and keeps them in order', () => {
    const conditions = [
      { field: 'event_type', operator: 'equals', value: ids.event },
      { field: 'booking_source', operator: 'equals', value: 'embed' },
      { field: 'answer', questionId: 'plan', operator: 'equals', value: 'enterprise' },
      { field: 'location_kind', operator: 'equals', value: 'in_person' },
      { field: 'guest_count', operator: 'at_least', value: 1 },
    ]
    expect(validate(candidate({ conditions })).conditions).toEqual(conditions)
    for (const operator of ['equals', 'at_least', 'at_most'])
      expect(
        validate(candidate({ conditions: [{ field: 'guest_count', operator, value: 0 }] }))
          .conditions,
      ).toHaveLength(1)
    expect(
      validate(
        candidate({
          conditions: [{ field: 'answer', questionId: 'consent', operator: 'equals', value: true }],
        }),
      ).conditions,
    ).toHaveLength(1)
    for (const value of ['web', 'embed', 'api', 'mcp'])
      expect(
        validate(
          candidate({ conditions: [{ field: 'booking_source', operator: 'equals', value }] }),
        ).conditions,
      ).toHaveLength(1)
  })

  it('accepts recipient classes in any order, sorted, and custom text per public locale', () => {
    const action = validate(
      candidate({
        actions: [
          email({
            recipients: ['hosts', 'booker', 'guests'],
            content: {
              en: { subject: '  Hi {{ recipient.name }} ', body: 'Line one\r\nLine two\rEnd ' },
              'zh-CN': {
                subject: '你好',
                body: '{{event_type.title}} 将于 {{booking.start}} 开始',
              },
            },
          }),
        ],
      }),
    ).actions[0]
    expect(action).toEqual({
      type: 'email',
      recipients: ['booker', 'guests', 'hosts'],
      content: {
        en: { subject: 'Hi {{ recipient.name }}', body: 'Line one\nLine two\nEnd' },
        'zh-CN': { subject: '你好', body: '{{event_type.title}} 将于 {{booking.start}} 开始' },
      },
    })
    expect(WORKFLOW_CONTENT_LOCALES).toEqual(['en', 'zh-CN', 'de', 'fr', 'es', 'pt-BR'])
    for (const locale of WORKFLOW_CONTENT_LOCALES)
      expect(
        validate(candidate({ actions: [email({ content: content('Subject', 'Body', locale) })] }))
          .actions,
      ).toHaveLength(1)
  })

  it('accepts a webhook action of the same organization', () => {
    expect(
      validate(candidate({ actions: [{ type: 'webhook', webhookId: ids.webhook }] })).actions,
    ).toEqual([{ type: 'webhook', webhookId: ids.webhook }])
    expect(
      validate(
        candidate({
          scope: { type: 'all_event_types' },
          actions: [{ type: 'webhook', webhookId: ids.teamWebhook }],
        }),
        teamContext,
      ).actions,
    ).toEqual([{ type: 'webhook', webhookId: ids.teamWebhook }])
  })

  it('rejects unknown fields at every level instead of dropping them', () => {
    const cases: [Record<string, unknown>, string][] = [
      [candidate({ owner: { kind: 'team', id: ids.team } }), 'workflow'],
      [candidate({ revision: 3 }), 'workflow'],
      [candidate({ scope: { type: 'all_event_types', eventTypeId: ids.event } }), 'scope'],
      [
        candidate({ trigger: { type: 'before_start', offsetMinutes: 60, delayMinutes: 5 } }),
        'trigger',
      ],
      [candidate({ trigger: { type: 'booking.created', offsetMinutes: 60 } }), 'trigger'],
      [
        candidate({
          conditions: [{ field: 'guest_count', operator: 'equals', value: 1, negate: true }],
        }),
        'conditions[0]',
      ],
      [candidate({ actions: [email({ cc: ['someone@example.com'] })] }), 'actions[0]'],
      [candidate({ actions: [email({ from: 'host@example.com' })] }), 'actions[0]'],
      [
        candidate({
          actions: [{ type: 'webhook', webhookId: ids.webhook, url: 'https://x.test' }],
        }),
        'actions[0]',
      ],
      [
        candidate({
          actions: [email({ content: { en: { subject: 'S', body: 'B', html: '<b>B</b>' } } })],
        }),
        'actions[0].content.en',
      ],
    ]
    for (const [value, path] of cases)
      expect(refused(value)).toBe(`${path}: contains an unknown field`)
    expect(
      refused(
        candidate({ actions: [email({ content: { 'en-GB': { subject: 'S', body: 'B' } } })] }),
      ),
    ).toBe('actions[0].content: uses an unknown locale')
    expect(refused(candidate({ actions: [email({ content: {} })] }))).toBe(
      'actions[0].content: must contain at least one locale',
    )
  })

  it('rejects an extra field on every accepted shape', () => {
    const extra = { caseInsensitive: true }
    const triggers = [
      { type: 'booking.created' },
      { type: 'booking.cancelled', delayMinutes: 5 },
      { type: 'booking.rescheduled' },
      { type: 'before_start', offsetMinutes: 60 },
      { type: 'after_end', offsetMinutes: 60 },
    ]
    for (const trigger of triggers) {
      expect(validate(candidate({ trigger })).trigger.type).toBe(trigger.type)
      expect(refused(candidate({ trigger: { ...trigger, ...extra } }))).toBe(
        'trigger: contains an unknown field',
      )
    }
    const conditions = [
      { field: 'event_type', operator: 'equals', value: ids.event },
      { field: 'booking_source', operator: 'equals', value: 'web' },
      { field: 'answer', questionId: 'plan', operator: 'equals', value: 'enterprise' },
      { field: 'location_kind', operator: 'equals', value: 'zoom' },
      { field: 'guest_count', operator: 'at_most', value: 3 },
    ]
    for (const condition of conditions) {
      expect(validate(candidate({ conditions: [condition] })).conditions).toEqual([condition])
      expect(refused(candidate({ conditions: [{ ...condition, ...extra }] }))).toBe(
        'conditions[0]: contains an unknown field',
      )
    }
    for (const scope of [
      { type: 'all_event_types' },
      { type: 'event_type', eventTypeId: ids.event },
    ])
      expect(refused(candidate({ scope: { ...scope, ...extra } }))).toBe(
        'scope: contains an unknown field',
      )
    for (const action of [email(), { type: 'webhook', webhookId: ids.webhook }])
      expect(refused(candidate({ actions: [{ ...action, ...extra }] }))).toBe(
        'actions[0]: contains an unknown field',
      )
    expect(
      refused(
        candidate({
          actions: [email({ content: { en: { subject: 'S', body: 'B', ...extra } } })],
        }),
      ),
    ).toBe('actions[0].content.en: contains an unknown field')
    expect(refused({ ...candidate(), ...extra })).toBe('workflow: contains an unknown field')
  })

  it('accepts IDs in any case and returns them lowercased', () => {
    const upper = (id: string) => id.toUpperCase()
    const definition = validate(
      candidate({
        scope: { type: 'event_type', eventTypeId: upper(ids.event) },
        conditions: [{ field: 'event_type', operator: 'equals', value: upper(ids.event) }],
        actions: [{ type: 'webhook', webhookId: upper(ids.webhook) }],
      }),
    )
    expect(definition.scope).toEqual({ type: 'event_type', eventTypeId: ids.event })
    expect(definition.conditions[0]).toMatchObject({ value: ids.event })
    expect(definition.actions[0]).toEqual({ type: 'webhook', webhookId: ids.webhook })
  })

  it('rejects unknown operators on every condition', () => {
    const conditions = [
      { field: 'event_type', value: ids.event },
      { field: 'booking_source', value: 'web' },
      { field: 'answer', questionId: 'plan', value: 'enterprise' },
      { field: 'location_kind', value: 'zoom' },
      { field: 'guest_count', value: 1 },
    ]
    for (const condition of conditions)
      for (const operator of ['contains', 'not_equals', 'matches', 'greater_than', 'EQUALS'])
        expect(refused(candidate({ conditions: [{ ...condition, operator }] }))).toBe(
          'conditions[0].operator: uses an unknown operator',
        )
    for (const operator of ['at_least', 'at_most'])
      expect(
        refused(candidate({ conditions: [{ field: 'booking_source', operator, value: 'web' }] })),
      ).toBe('conditions[0].operator: uses an unknown operator')
  })

  it('rejects unknown triggers, conditions, actions, scopes and values', () => {
    for (const type of ['booking.updated', 'booking.paid', 'meeting.started', 'Booking.Created'])
      expect(refused(candidate({ trigger: { type } }))).toBe('trigger.type: is not a known trigger')
    for (const field of ['title', 'cancel_reason', 'attendee_email', 'regex', 'or'])
      expect(refused(candidate({ conditions: [{ field, operator: 'equals', value: 'x' }] }))).toBe(
        'conditions[0].field: is not a known condition',
      )
    for (const type of ['sms', 'whatsapp', 'http'])
      expect(refused(candidate({ actions: [{ type }] }))).toBe(
        'actions[0].type: is not a known action',
      )
    expect(refused(candidate({ scope: { type: 'team_event_types' } }))).toBe(
      'scope.type: unknown scope',
    )
    for (const recipients of [['cc'], ['someone@example.com'], ['attendees']])
      expect(refused(candidate({ actions: [email({ recipients })] }))).toBe(
        'actions[0].recipients[0]: is not a known recipient class',
      )
    expect(
      refused(
        candidate({
          conditions: [{ field: 'booking_source', operator: 'equals', value: 'import' }],
        }),
      ),
    ).toBe('conditions[0].value: is not a known booking source')
    expect(
      refused(
        candidate({ conditions: [{ field: 'location_kind', operator: 'equals', value: 'teams' }] }),
      ),
    ).toBe('conditions[0].value: is not a known location kind')
  })

  it('rejects a no-show trigger, condition or variable as unknown', () => {
    for (const type of [
      'booking.attendee_no_show_changed',
      'attendee_no_show_changed',
      'no_show',
      'booking.no_show',
    ])
      expect(refused(candidate({ trigger: { type } }))).toBe('trigger.type: is not a known trigger')
    for (const field of ['no_show', 'attendee_no_show', 'no_show_marked', 'attendance'])
      expect(refused(candidate({ conditions: [{ field, operator: 'equals', value: true }] }))).toBe(
        'conditions[0].field: is not a known condition',
      )
    for (const variable of [
      'no_show',
      'booking.no_show',
      'attendee.no_show',
      'recipient.no_show',
      'attendee.no_show_marked_at',
    ])
      expect(
        refused(candidate({ actions: [email({ content: content('Hello', `{{${variable}}}`) })] })),
      ).toBe('actions[0].content.en.body: uses an unknown variable')
  })

  it('rejects reschedule-request lifecycle events as triggers', () => {
    for (const type of ['booking.reschedule_requested', 'booking.reschedule_request_expired'])
      expect(refused(candidate({ trigger: { type } }))).toBe('trigger.type: is not a known trigger')
  })

  it('reports missing and mistyped fields without echoing values', () => {
    expect(refused({ ...candidate(), name: undefined })).toBe('name: is required')
    expect(refused(candidate({ trigger: { offsetMinutes: 60 } }))).toBe('trigger.type: is required')
    expect(refused(candidate({ name: 42 }))).toBe('name: has the wrong type')
    expect(refused(candidate({ actions: 'email' }))).toBe('actions: must be a list')
    expect(refused('definition')).toBe('workflow: has the wrong type')
    expect(refused(candidate({ name: 'secret-value\u0000' }))).not.toContain('secret-value')
  })
})

describe('workflow definition limits', () => {
  it('limits the name to the documented UTF-8 bytes after trimming', () => {
    expect(validate(candidate({ name: ` ${utf8(WORKFLOW_NAME_MAX_BYTES)} ` })).name).toBe(
      utf8(WORKFLOW_NAME_MAX_BYTES),
    )
    expect(refused(candidate({ name: utf8(WORKFLOW_NAME_MAX_BYTES + 1) }))).toBe(
      `name: must be at most ${WORKFLOW_NAME_MAX_BYTES} bytes of UTF-8`,
    )
    expect(refused(candidate({ name: '   ' }))).toBe('name: must not be empty')
    expect(refused(candidate({ name: 'Two\nlines' }))).toBe(
      'name: must be a single line of text without control characters',
    )
  })

  it('limits the custom subject and body to the documented UTF-8 bytes', () => {
    const action = (subject: string, body: string) =>
      candidate({ actions: [email({ content: content(subject, body) })] })
    expect(validate(action(utf8(WORKFLOW_SUBJECT_MAX_BYTES), 'Body')).actions).toHaveLength(1)
    expect(refused(action(utf8(WORKFLOW_SUBJECT_MAX_BYTES + 1), 'Body'))).toBe(
      `actions[0].content.en.subject: must be at most ${WORKFLOW_SUBJECT_MAX_BYTES} bytes of UTF-8`,
    )
    expect(validate(action('Subject', utf8(WORKFLOW_BODY_MAX_BYTES))).actions).toHaveLength(1)
    expect(refused(action('Subject', utf8(WORKFLOW_BODY_MAX_BYTES + 1)))).toBe(
      `actions[0].content.en.body: must be at most ${WORKFLOW_BODY_MAX_BYTES} bytes of UTF-8`,
    )
    // The body limit applies after line endings are normalized: CRLF counts as one byte.
    const lines = 'a\r\n'.repeat(WORKFLOW_BODY_MAX_BYTES / 2 - 1)
    expect(validate(action('Subject', `${lines}ab`)).actions).toHaveLength(1)
  })

  it('refuses header line breaks and control characters in custom text', () => {
    const action = (subject: string, body: string) =>
      candidate({ actions: [email({ content: content(subject, body) })] })
    for (const subject of ['Hi\r\nBcc: x@example.com', 'Hi\nthere', 'Hi\u0007'])
      expect(refused(action(subject, 'Body'))).toBe(
        'actions[0].content.en.subject: must be a single line of text without control characters',
      )
    expect(refused(action('Subject', 'Body\u0000'))).toBe(
      'actions[0].content.en.body: must be text without control characters other than tabs and line breaks',
    )
    expect(refused(action('Subject', '\ud800'))).toBe(
      'actions[0].content.en.body: must be text without control characters other than tabs and line breaks',
    )
    expect(refused(action('Subject', ' \n '))).toBe('actions[0].content.en.body: must not be empty')
  })

  it(`allows at most ${WORKFLOW_MAX_CONDITIONS} conditions`, () => {
    const condition = { field: 'guest_count', operator: 'at_least', value: 0 }
    expect(
      validate(candidate({ conditions: Array(WORKFLOW_MAX_CONDITIONS).fill(condition) }))
        .conditions,
    ).toHaveLength(WORKFLOW_MAX_CONDITIONS)
    expect(
      refused(candidate({ conditions: Array(WORKFLOW_MAX_CONDITIONS + 1).fill(condition) })),
    ).toBe(`conditions: must have at most ${WORKFLOW_MAX_CONDITIONS} conditions`)
  })

  it(`allows exactly ${WORKFLOW_MAX_ACTIONS} action`, () => {
    expect(refused(candidate({ actions: Array(WORKFLOW_MAX_ACTIONS + 1).fill(email()) }))).toBe(
      `actions: must contain at most ${WORKFLOW_MAX_ACTIONS} action`,
    )
    expect(refused(candidate({ actions: [] }))).toBe('actions: must contain an action')
    expect(refused({ ...candidate(), actions: undefined })).toBe('actions: is required')
  })

  it('bounds timer offsets and lifecycle delays to whole documented minutes', () => {
    for (const type of ['before_start', 'after_end']) {
      for (const offsetMinutes of [WORKFLOW_MIN_TIMER_OFFSET_MINUTES, WORKFLOW_MAX_OFFSET_MINUTES])
        expect(validate(candidate({ trigger: { type, offsetMinutes } })).trigger).toEqual({
          type,
          offsetMinutes,
        })
      expect(
        refused(
          candidate({ trigger: { type, offsetMinutes: WORKFLOW_MIN_TIMER_OFFSET_MINUTES - 1 } }),
        ),
      ).toBe(`trigger.offsetMinutes: must be at least ${WORKFLOW_MIN_TIMER_OFFSET_MINUTES} minutes`)
      expect(
        refused(candidate({ trigger: { type, offsetMinutes: WORKFLOW_MAX_OFFSET_MINUTES + 1 } })),
      ).toBe(`trigger.offsetMinutes: must be at most ${WORKFLOW_MAX_OFFSET_MINUTES} minutes`)
      expect(refused(candidate({ trigger: { type, offsetMinutes: 30.5 } }))).toBe(
        'trigger.offsetMinutes: must be a whole number of minutes',
      )
      expect(refused(candidate({ trigger: { type } }))).toBe('trigger.offsetMinutes: is required')
    }
    for (const delayMinutes of [0, WORKFLOW_MAX_OFFSET_MINUTES])
      expect(
        validate(candidate({ trigger: { type: 'booking.cancelled', delayMinutes } })).trigger,
      ).toEqual({ type: 'booking.cancelled', delayMinutes })
    expect(
      refused(
        candidate({
          trigger: { type: 'booking.created', delayMinutes: WORKFLOW_MAX_OFFSET_MINUTES + 1 },
        }),
      ),
    ).toBe(`trigger.delayMinutes: must be at most ${WORKFLOW_MAX_OFFSET_MINUTES} minutes`)
    expect(refused(candidate({ trigger: { type: 'booking.created', delayMinutes: -1 } }))).toBe(
      'trigger.delayMinutes: must not be negative',
    )
  })

  it('refuses repeated or empty recipient classes', () => {
    expect(refused(candidate({ actions: [email({ recipients: [] })] }))).toBe(
      'actions[0].recipients: must name at least one recipient class',
    )
    expect(refused(candidate({ actions: [email({ recipients: ['booker', 'booker'] })] }))).toBe(
      'actions[0].recipients: must not repeat a recipient class',
    )
  })
})

describe('workflow definition ownership', () => {
  const scoped = (eventTypeId: string, overrides: Record<string, unknown> = {}) =>
    candidate({ scope: { type: 'event_type', eventTypeId }, ...overrides })
  const notFound = 'scope.eventTypeId: names an event type that was not found'

  it('rejects a cross-owner event type exactly like a missing one', () => {
    for (const id of [ids.foreignEvent, ids.teamEvent, ids.otherTeamEvent, ids.missingEvent])
      expect(refused(scoped(id))).toBe(notFound)
    for (const id of [ids.event, ids.foreignEvent, ids.otherTeamEvent, ids.missingEvent])
      expect(refused(scoped(id), teamContext)).toBe(notFound)
    // A row whose organization and owner disagree belongs to neither owner.
    expect(refused(scoped(ids.hostedTeamPersonalLookalike))).toBe(notFound)
    expect(refused(scoped(ids.hostedTeamPersonalLookalike), teamContext)).toBe(notFound)
  })

  it('rejects a fact loaded under another ID', () => {
    const eventTypes = new Map(personalContext.eventTypes)
    eventTypes.set(
      ids.missingEvent,
      personalContext.eventTypes.get(ids.event) as WorkflowEventTypeFacts,
    )
    expect(refused(scoped(ids.missingEvent), { ...personalContext, eventTypes })).toBe(notFound)
    const webhooks = new Map(personalContext.webhooks)
    webhooks.set(
      ids.foreignWebhook,
      personalContext.webhooks.get(ids.webhook) as WorkflowWebhookFacts,
    )
    expect(
      refused(candidate({ actions: [{ type: 'webhook', webhookId: ids.foreignWebhook }] }), {
        ...personalContext,
        webhooks,
      }),
    ).toBe('actions[0].webhookId: names a webhook that was not found')
  })

  it('rejects cross-owner event type conditions and webhook endpoints', () => {
    expect(
      refused(
        candidate({
          scope: { type: 'all_event_types' },
          conditions: [{ field: 'event_type', operator: 'equals', value: ids.foreignEvent }],
        }),
      ),
    ).toBe('conditions[0].value: names an event type that was not found')
    for (const [webhookId, context] of [
      [ids.foreignWebhook, personalContext],
      [ids.teamWebhook, personalContext],
      [ids.webhook, teamContext],
      [ids.missingEvent, personalContext],
    ] as const)
      expect(
        refused(
          candidate({
            scope: { type: 'all_event_types' },
            actions: [{ type: 'webhook', webhookId }],
          }),
          context,
        ),
      ).toBe('actions[0].webhookId: names a webhook that was not found')
  })

  it('fails closed for group, deleted and unknown-mode event types', () => {
    const unsupported = 'scope.eventTypeId: names an event type workflows do not support'
    expect(refused(scoped(ids.groupEvent))).toBe(unsupported)
    expect(refused(scoped(ids.teamGroupEvent), teamContext)).toBe(unsupported)
    expect(refused(scoped(ids.deletedEvent))).toBe(unsupported)
    const eventTypes = new Map(personalContext.eventTypes)
    eventTypes.set(ids.event, {
      ...(personalContext.eventTypes.get(ids.event) as WorkflowEventTypeFacts),
      bookingMode: 'seats',
    })
    expect(refused(scoped(ids.event), { ...personalContext, eventTypes })).toBe(unsupported)
    expect(
      refused(
        candidate({
          scope: { type: 'all_event_types' },
          conditions: [{ field: 'event_type', operator: 'equals', value: ids.groupEvent }],
        }),
      ),
    ).toBe('conditions[0].value: names an event type workflows do not support')
  })

  it('refuses source, answer and location conditions on team definitions', () => {
    for (const condition of [
      { field: 'booking_source', operator: 'equals', value: 'web' },
      { field: 'answer', questionId: 'plan', operator: 'equals', value: 'enterprise' },
      { field: 'location_kind', operator: 'equals', value: 'zoom' },
    ])
      expect(refused(scoped(ids.teamEvent, { conditions: [condition] }), teamContext)).toBe(
        'conditions[0].field: is not available to team workflows',
      )
    for (const condition of [
      { field: 'event_type', operator: 'equals', value: ids.teamEvent },
      { field: 'guest_count', operator: 'at_most', value: 3 },
    ])
      expect(
        validate(scoped(ids.teamEvent, { conditions: [condition] }), teamContext).conditions,
      ).toEqual([condition])
  })

  it('checks answer conditions against the single event type question', () => {
    const answer = (questionId: string, value: unknown, scope = ids.event) =>
      refused(
        scoped(scope, { conditions: [{ field: 'answer', questionId, operator: 'equals', value }] }),
      )
    expect(
      refused(
        candidate({
          scope: { type: 'all_event_types' },
          conditions: [{ field: 'answer', questionId: 'plan', operator: 'equals', value: 'x' }],
        }),
      ),
    ).toBe('conditions[0]: needs a workflow scoped to one event type')
    expect(answer('deleted_question', 'x')).toBe(
      'conditions[0].questionId: names a question the event type does not ask',
    )
    expect(answer('plan', 'unknown-option')).toBe(
      'conditions[0].value: is not an option of the question',
    )
    expect(answer('plan', true)).toBe('conditions[0].value: is not an option of the question')
    expect(answer('consent', 'yes')).toBe('conditions[0].value: must be a boolean')
    for (const questionId of ['company', 'notes', 'mobile', 'topics'])
      expect(answer(questionId, 'x')).toBe(
        'conditions[0].questionId: names a question that supports no equality condition',
      )
    expect(answer('plan', ['enterprise'])).toBe(
      'conditions[0].value: must be a string or a boolean',
    )
  })

  it('lists the referenced IDs for the service to load', () => {
    const definition = parseWorkflowDefinition(
      candidate({
        conditions: [
          { field: 'event_type', operator: 'equals', value: ids.secondEvent },
          { field: 'event_type', operator: 'equals', value: ids.event },
        ],
        actions: [{ type: 'webhook', webhookId: ids.webhook }],
      }),
    )
    expect(workflowReferences(definition)).toEqual({
      eventTypeIds: [ids.event, ids.secondEvent],
      webhookIds: [ids.webhook],
    })
  })
})

describe('workflow template variables in definitions', () => {
  const withBody = (
    body: string,
    overrides: Record<string, unknown> = {},
    recipients = ['booker'],
  ) =>
    candidate({ ...overrides, actions: [email({ recipients, content: content('Hello', body) })] })

  it('accepts every common variable for personal and team definitions', () => {
    const body = [
      'recipient.name',
      'recipient.time_zone',
      'event_type.title',
      'event_type.public_path',
      'booking.start',
      'booking.end',
    ]
      .map((name) => `{{${name}}}`)
      .join(' ')
    for (const recipients of [['booker'], ['guests'], ['hosts'], ['booker', 'guests', 'hosts']]) {
      expect(validate(withBody(body, {}, recipients)).actions).toHaveLength(1)
      expect(
        validate(withBody(body, { scope: { type: 'all_event_types' } }, recipients), teamContext)
          .actions,
      ).toHaveLength(1)
    }
  })

  it('rejects unknown and excluded variables in subjects and bodies', () => {
    for (const name of [
      'booking.title',
      'booking.cancel_reason',
      'booking.meeting_url',
      'booking.location',
      'booking.manage_url',
      'attendee.email',
      'recipient.email',
      'host.email',
      'conference.organizer',
      'booking.source',
    ]) {
      expect(refused(withBody(`{{${name}}}`))).toBe(
        'actions[0].content.en.body: uses an unknown variable',
      )
      expect(
        refused(candidate({ actions: [email({ content: content(`Re {{${name}}}`, 'Body') })] })),
      ).toBe('actions[0].content.en.subject: uses an unknown variable')
    }
  })

  it('rejects malformed placeholders', () => {
    for (const body of ['{{recipient.name', 'recipient.name}}', '{{ }}', '{{a b}}', '{{{{x}}}}'])
      expect(refused(withBody(body))).toBe(
        'actions[0].content.en.body: contains a malformed placeholder',
      )
    expect(validate(withBody('Use {braces} freely')).actions).toHaveLength(1)
  })

  it('allows answer variables only for personal hosts or bookers of one event type', () => {
    for (const recipients of [['booker'], ['hosts'], ['booker', 'hosts']])
      for (const question of ['plan', 'consent', 'company', 'notes', 'mobile'])
        expect(validate(withBody(`{{answer.${question}}}`, {}, recipients)).actions).toHaveLength(1)
    expect(refused(withBody('{{answer.plan}}', {}, ['guests']))).toBe(
      'actions[0].content.en.body: uses an answer variable, which guests cannot receive',
    )
    expect(refused(withBody('{{answer.plan}}', {}, ['booker', 'guests']))).toBe(
      'actions[0].content.en.body: uses an answer variable, which guests cannot receive',
    )
    expect(
      refused(
        withBody('{{answer.plan}}', {
          scope: { type: 'event_type', eventTypeId: ids.teamEvent },
        }),
        teamContext,
      ),
    ).toBe('actions[0].content.en.body: uses an answer variable, which team workflows cannot')
    expect(refused(withBody('{{answer.plan}}', { scope: { type: 'all_event_types' } }))).toBe(
      'actions[0].content.en.body: uses an answer variable without a single event type scope',
    )
    expect(refused(withBody('{{answer.removed}}'))).toBe(
      'actions[0].content.en.body: uses an answer variable for a question the event type does not ask',
    )
    expect(refused(withBody('{{answer.topics}}'))).toBe(
      'actions[0].content.en.body: uses an answer variable for a question without a single answer',
    )
    expect(refused(withBody('{{answer.}}'))).toBe(
      'actions[0].content.en.body: uses an unknown variable',
    )
  })
})
