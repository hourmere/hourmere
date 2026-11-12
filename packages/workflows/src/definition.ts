// The workflow definition contract (docs/workflows.md, "Definitions, ownership and limits",
// "Triggers, conditions and snapshots" and "Email and webhook actions"). Request shapes are
// strict: unknown fields, triggers, conditions, operators, actions, recipient classes, locales
// and variables are refused, never dropped. validateWorkflowDefinition adds the checks that
// need the owner and the facts a service loaded for the IDs the definition references.
// Errors are `invalid_workflow` with a path and a fixed constraint, never a submitted value.

import { interfaceLanguages } from '@hourmere/core/language'
import { DomainError } from '@hourmere/scheduling/errors'
import { isMultiLineText, isSingleLineText } from '@hourmere/scheduling/text'
import { type core, z } from 'zod'
import {
  evaluateConditions,
  PERSONAL_ONLY_CONDITION_FIELDS,
  type WorkflowCondition,
  WorkflowConditionsSchema,
} from './conditions.ts'
import {
  WORKFLOW_BODY_MAX_BYTES,
  WORKFLOW_MAX_ACTIONS,
  WORKFLOW_MAX_OFFSET_MINUTES,
  WORKFLOW_MIN_TIMER_OFFSET_MINUTES,
  WORKFLOW_NAME_MAX_BYTES,
  WORKFLOW_SUBJECT_MAX_BYTES,
} from './limits.ts'
import {
  isWorkflowEventType,
  ownsEventType,
  ownsWebhook,
  scopeSelectsEventType,
  uuidSchema,
  type WorkflowBookingFacts,
  type WorkflowEventTypeFacts,
  type WorkflowOwner,
  type WorkflowScope,
  WorkflowScopeSchema,
  type WorkflowWebhookFacts,
} from './ownership.ts'
import {
  templatePlaceholders,
  templateVariableProblem,
  WORKFLOW_RECIPIENT_CLASSES,
  type WorkflowRecipientClass,
} from './variables.ts'

const delayMinutes = z
  .number()
  .int({ error: 'must be a whole number of minutes' })
  .min(0, { error: 'must not be negative' })
  .max(WORKFLOW_MAX_OFFSET_MINUTES, {
    error: `must be at most ${WORKFLOW_MAX_OFFSET_MINUTES} minutes`,
  })
  .default(0)
const offsetMinutes = z
  .number()
  .int({ error: 'must be a whole number of minutes' })
  .min(WORKFLOW_MIN_TIMER_OFFSET_MINUTES, {
    error: `must be at least ${WORKFLOW_MIN_TIMER_OFFSET_MINUTES} minutes`,
  })
  .max(WORKFLOW_MAX_OFFSET_MINUTES, {
    error: `must be at most ${WORKFLOW_MAX_OFFSET_MINUTES} minutes`,
  })

/**
 * Lifecycle triggers take an optional delay (zero: eligible right after commit); timer
 * triggers take their offset and no second delay. Reschedule requests and attendee no-show
 * changes are not triggers.
 */
export const WorkflowTriggerSchema = z.discriminatedUnion(
  'type',
  [
    z.strictObject({ type: z.literal('booking.created'), delayMinutes }),
    z.strictObject({ type: z.literal('booking.cancelled'), delayMinutes }),
    z.strictObject({ type: z.literal('booking.rescheduled'), delayMinutes }),
    z.strictObject({ type: z.literal('before_start'), offsetMinutes }),
    z.strictObject({ type: z.literal('after_end'), offsetMinutes }),
  ],
  { error: (issue) => (issue.code === 'invalid_union' ? 'is not a known trigger' : undefined) },
)
export type WorkflowTrigger = z.output<typeof WorkflowTriggerSchema>
export type WorkflowTriggerType = WorkflowTrigger['type']

/** The public locales custom content may be written in, from the shared registry. */
export const WORKFLOW_CONTENT_LOCALES: readonly string[] = Object.freeze(
  interfaceLanguages('public'),
)

const localizedContent = z.strictObject({ subject: z.string(), body: z.string() })
const content = z
  .strictObject(
    Object.fromEntries(WORKFLOW_CONTENT_LOCALES.map((code) => [code, localizedContent.optional()])),
  )
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    error: 'must contain at least one locale',
  })

const emailAction = z.strictObject({
  type: z.literal('email'),
  recipients: z
    .array(z.enum(WORKFLOW_RECIPIENT_CLASSES, { error: 'is not a known recipient class' }), {
      error: 'must be a list',
    })
    .min(1, { error: 'must name at least one recipient class' })
    .max(WORKFLOW_RECIPIENT_CLASSES.length, { error: 'must not repeat a recipient class' })
    .refine((classes) => new Set(classes).size === classes.length, {
      error: 'must not repeat a recipient class',
    }),
  /** Custom subject and body per locale; omitted locales use the built-in template. */
  content: content.optional(),
})
const webhookAction = z.strictObject({ type: z.literal('webhook'), webhookId: uuidSchema })

export const WorkflowActionSchema = z.discriminatedUnion('type', [emailAction, webhookAction], {
  error: (issue) => (issue.code === 'invalid_union' ? 'is not a known action' : undefined),
})
export type WorkflowAction = z.output<typeof WorkflowActionSchema>

/** A candidate definition: what create accepts and an update produces. Creation is disabled. */
export const WorkflowDefinitionSchema = z.strictObject({
  name: z.string(),
  enabled: z.boolean().default(false),
  scope: WorkflowScopeSchema,
  trigger: WorkflowTriggerSchema,
  conditions: WorkflowConditionsSchema.default([]),
  actions: z
    .array(WorkflowActionSchema, { error: 'must be a list' })
    .min(1, { error: 'must contain an action' })
    .max(WORKFLOW_MAX_ACTIONS, { error: `must contain at most ${WORKFLOW_MAX_ACTIONS} action` }),
})
export type WorkflowDefinition = z.output<typeof WorkflowDefinitionSchema>

/** Facts a service loaded for the IDs a definition references (workflowReferences). */
export interface WorkflowValidationContext {
  owner: WorkflowOwner
  eventTypes: ReadonlyMap<string, WorkflowEventTypeFacts>
  webhooks: ReadonlyMap<string, WorkflowWebhookFacts>
}

/**
 * Question types an answer condition may compare: one option or one box. Free text has no
 * exact-match condition, and multi-select answers are lists.
 */
export const WORKFLOW_ANSWER_CONDITION_QUESTION_TYPES = Object.freeze([
  'select',
  'checkbox',
] as const)

const invalid = (path: string, constraint: string) =>
  new DomainError('invalid', 'invalid_workflow', `${path}: ${constraint}`)

function pathText(path: readonly PropertyKey[]): string {
  let text = ''
  for (const key of path)
    text += typeof key === 'number' ? `[${key}]` : `${text ? '.' : ''}${String(key)}`
  return text || 'workflow'
}

function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, key))
      return undefined
    current = (current as Record<PropertyKey, unknown>)[key]
  }
  return current
}

function shapeError(value: unknown, issue: core.$ZodIssue): DomainError {
  const path = pathText(issue.path)
  if (issue.code === 'unrecognized_keys')
    return invalid(
      path,
      issue.path.at(-1) === 'content' ? 'uses an unknown locale' : 'contains an unknown field',
    )
  if (valueAt(value, issue.path) === undefined && issue.path.length > 0)
    return invalid(path, 'is required')
  // Zod's own messages can describe the input; the schema's custom constraints never do.
  if (issue.message.startsWith('Invalid input')) return invalid(path, 'has the wrong type')
  return invalid(path, issue.message)
}

/**
 * The strict request shape alone, with the create defaults (disabled, no conditions, no
 * delay). It is not a reader for stored revisions: those keep the canonical form
 * validateWorkflowDefinition returns, and a later step reads them without defaults.
 */
export function parseWorkflowDefinition(value: unknown): WorkflowDefinition {
  const result = WorkflowDefinitionSchema.safeParse(value)
  if (result.success) return result.data
  const [issue] = result.error.issues
  throw issue ? shapeError(value, issue) : invalid('workflow', 'is invalid')
}

/** Every event type and webhook ID a definition references, for the service to load. */
export function workflowReferences(definition: WorkflowDefinition): {
  eventTypeIds: string[]
  webhookIds: string[]
} {
  const eventTypeIds = new Set<string>()
  if (definition.scope.type === 'event_type') eventTypeIds.add(definition.scope.eventTypeId)
  for (const condition of definition.conditions)
    if (condition.field === 'event_type') eventTypeIds.add(condition.value)
  const webhookIds = new Set<string>()
  for (const action of definition.actions)
    if (action.type === 'webhook') webhookIds.add(action.webhookId)
  return { eventTypeIds: [...eventTypeIds], webhookIds: [...webhookIds] }
}

const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8')

/**
 * Checks one event type ID: a missing or foreign one is the same opaque not-found. The owner's
 * own group or deleted event type is refused as unsupported instead; ownership is checked
 * first, so that answer says nothing about other owners' event types.
 */
function checkedEventType(
  path: string,
  id: string,
  context: WorkflowValidationContext,
): WorkflowEventTypeFacts {
  const eventType = context.eventTypes.get(id)
  if (!eventType || eventType.id !== id || !ownsEventType(context.owner, eventType))
    throw invalid(path, 'names an event type that was not found')
  if (!isWorkflowEventType(eventType))
    throw invalid(path, 'names an event type workflows do not support')
  return eventType
}

function checkedName(name: string): string {
  const text = name.trim()
  if (!text) throw invalid('name', 'must not be empty')
  if (!isSingleLineText(text))
    throw invalid('name', 'must be a single line of text without control characters')
  if (utf8Bytes(text) > WORKFLOW_NAME_MAX_BYTES)
    throw invalid('name', `must be at most ${WORKFLOW_NAME_MAX_BYTES} bytes of UTF-8`)
  return text
}

function checkedTemplate(
  path: string,
  text: string,
  multiline: boolean,
  maxBytes: number,
  check: (name: string) => string | undefined,
): string {
  const normalized = (multiline ? text.replace(/\r\n?/g, '\n') : text).trim()
  if (!normalized) throw invalid(path, 'must not be empty')
  if (!(multiline ? isMultiLineText(normalized) : isSingleLineText(normalized)))
    throw invalid(
      path,
      multiline
        ? 'must be text without control characters other than tabs and line breaks'
        : 'must be a single line of text without control characters',
    )
  if (utf8Bytes(normalized) > maxBytes)
    throw invalid(path, `must be at most ${maxBytes} bytes of UTF-8`)
  const names = templatePlaceholders(normalized)
  if (!names) throw invalid(path, 'contains a malformed placeholder')
  for (const name of names) {
    const problem = check(name)
    if (problem) throw invalid(path, problem)
  }
  return normalized
}

function checkedCondition(
  index: number,
  condition: WorkflowCondition,
  scopeEventType: WorkflowEventTypeFacts | undefined,
  context: WorkflowValidationContext,
): void {
  const path = `conditions[${index}]`
  if (context.owner.kind === 'team' && PERSONAL_ONLY_CONDITION_FIELDS.includes(condition.field))
    throw invalid(`${path}.field`, 'is not available to team workflows')
  if (condition.field === 'event_type') {
    checkedEventType(`${path}.value`, condition.value, context)
    return
  }
  if (condition.field !== 'answer') return
  if (!scopeEventType) throw invalid(path, 'needs a workflow scoped to one event type')
  const question = scopeEventType.questions.find(({ id }) => id === condition.questionId)
  if (!question) throw invalid(`${path}.questionId`, 'names a question the event type does not ask')
  if (!(WORKFLOW_ANSWER_CONDITION_QUESTION_TYPES as readonly string[]).includes(question.type))
    throw invalid(`${path}.questionId`, 'names a question that supports no equality condition')
  if (question.type === 'select') {
    if (typeof condition.value !== 'string' || !question.options?.includes(condition.value))
      throw invalid(`${path}.value`, 'is not an option of the question')
  } else if (typeof condition.value !== 'boolean') {
    throw invalid(`${path}.value`, 'must be a boolean')
  }
}

/**
 * Validates a candidate definition for `context.owner` and returns its canonical form: the
 * trimmed name, default delay and enabled flag, and normalized custom text. Every referenced
 * event type and webhook must be the owner's own; group and deleted event types are refused;
 * team definitions cannot read answers, sources or locations.
 */
export function validateWorkflowDefinition(
  value: unknown,
  context: WorkflowValidationContext,
): WorkflowDefinition {
  const definition = parseWorkflowDefinition(value)
  const name = checkedName(definition.name)
  const scopeEventType =
    definition.scope.type === 'event_type'
      ? checkedEventType('scope.eventTypeId', definition.scope.eventTypeId, context)
      : undefined
  for (const [index, condition] of definition.conditions.entries())
    checkedCondition(index, condition, scopeEventType, context)
  const actions = definition.actions.map((action, index): WorkflowAction => {
    const path = `actions[${index}]`
    if (action.type === 'webhook') {
      const webhook = context.webhooks.get(action.webhookId)
      if (!webhook || webhook.id !== action.webhookId || !ownsWebhook(context.owner, webhook))
        throw invalid(`${path}.webhookId`, 'names a webhook that was not found')
      return action
    }
    const recipients = [...action.recipients].sort(
      (a, b) => WORKFLOW_RECIPIENT_CLASSES.indexOf(a) - WORKFLOW_RECIPIENT_CLASSES.indexOf(b),
    ) as WorkflowRecipientClass[]
    if (!action.content) return { ...action, recipients }
    const check = (name: string) =>
      templateVariableProblem(name, {
        owner: context.owner.kind,
        recipients,
        eventType: scopeEventType,
      })
    const localized: Record<string, { subject: string; body: string }> = {}
    for (const [locale, entry] of Object.entries(action.content)) {
      if (!entry) continue
      const base = `${path}.content.${locale}`
      localized[locale] = {
        subject: checkedTemplate(
          `${base}.subject`,
          entry.subject,
          false,
          WORKFLOW_SUBJECT_MAX_BYTES,
          check,
        ),
        body: checkedTemplate(`${base}.body`, entry.body, true, WORKFLOW_BODY_MAX_BYTES, check),
      }
    }
    return { ...action, recipients, content: localized }
  })
  return { ...definition, name, actions }
}

/**
 * Whether a definition of `owner` applies to a booking of `eventType`: the booking is one
 * workflows may consider, its event type is selected by the scope, and every condition holds.
 */
export function workflowMatches(
  owner: WorkflowOwner,
  definition: { scope: WorkflowScope; conditions: readonly WorkflowCondition[] },
  eventType: WorkflowEventTypeFacts,
  booking: WorkflowBookingFacts,
): boolean {
  return (
    booking.eventTypeId === eventType.id &&
    scopeSelectsEventType(owner, definition.scope, eventType) &&
    evaluateConditions(owner, definition.conditions, booking)
  )
}
