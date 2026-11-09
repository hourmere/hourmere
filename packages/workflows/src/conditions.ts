// Workflow conditions (docs/workflows.md, "Triggers, conditions and snapshots"): fixed
// predicates joined only by AND, with no nesting, OR, regex, scripts or lookups. They are
// evaluated against the captured booking snapshot. Anything absent, unknown or of the wrong
// type evaluates to false, and a failed evaluation reveals nothing but `false`.

import { LOCATION_KINDS, MAX_GUESTS } from '@hourmere/scheduling'
import { z } from 'zod'
import { WORKFLOW_MAX_CONDITIONS } from './limits.ts'
import {
  isWorkflowBooking,
  uuidSchema,
  WORKFLOW_BOOKING_SOURCES,
  type WorkflowBookingFacts,
  type WorkflowOwner,
} from './ownership.ts'

const equals = z.enum(['equals'], { error: 'uses an unknown operator' })

const eventTypeCondition = z.strictObject({
  field: z.literal('event_type'),
  operator: equals,
  value: uuidSchema,
})
const bookingSourceCondition = z.strictObject({
  field: z.literal('booking_source'),
  operator: equals,
  value: z.enum(WORKFLOW_BOOKING_SOURCES, { error: 'is not a known booking source' }),
})
const answerCondition = z.strictObject({
  field: z.literal('answer'),
  questionId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, { error: 'must be 1 to 64 letters, digits, "_" or "-"' }),
  operator: equals,
  value: z.union([z.string(), z.boolean()], { error: 'must be a string or a boolean' }),
})
const locationKindCondition = z.strictObject({
  field: z.literal('location_kind'),
  operator: equals,
  value: z.enum(LOCATION_KINDS, { error: 'is not a known location kind' }),
})
const guestCountCondition = z.strictObject({
  field: z.literal('guest_count'),
  operator: z.enum(['equals', 'at_least', 'at_most'], { error: 'uses an unknown operator' }),
  value: z
    .number()
    .int({ error: 'must be a whole number' })
    .min(0, { error: 'must not be negative' })
    .max(MAX_GUESTS, { error: `must be at most ${MAX_GUESTS}` }),
})

export const WorkflowConditionSchema = z.discriminatedUnion(
  'field',
  [
    eventTypeCondition,
    bookingSourceCondition,
    answerCondition,
    locationKindCondition,
    guestCountCondition,
  ],
  { error: (issue) => (issue.code === 'invalid_union' ? 'is not a known condition' : undefined) },
)
export type WorkflowCondition = z.output<typeof WorkflowConditionSchema>

export const WorkflowConditionsSchema = z
  .array(WorkflowConditionSchema, { error: 'must be a list' })
  .max(WORKFLOW_MAX_CONDITIONS, {
    error: `must have at most ${WORKFLOW_MAX_CONDITIONS} conditions`,
  })

/** Conditions only personal definitions may use: they read hidden booking data. */
export const PERSONAL_ONLY_CONDITION_FIELDS: readonly WorkflowCondition['field'][] = [
  'booking_source',
  'answer',
  'location_kind',
]

/** One predicate against the snapshot; absent or mistyped data is false. */
export function evaluateCondition(
  condition: WorkflowCondition,
  booking: WorkflowBookingFacts,
): boolean {
  switch (condition.field) {
    case 'event_type':
      return booking.eventTypeId !== null && booking.eventTypeId === condition.value
    case 'booking_source':
      return booking.source === condition.value
    case 'answer': {
      // An absent answer is false, never a match; equality is exact, type included.
      if (!Object.hasOwn(booking.responses, condition.questionId)) return false
      return booking.responses[condition.questionId] === condition.value
    }
    case 'location_kind':
      return booking.locationKind !== null && booking.locationKind === condition.value
    case 'guest_count': {
      const count = booking.guestCount
      if (!Number.isInteger(count) || count < 0) return false
      if (condition.operator === 'equals') return count === condition.value
      if (condition.operator === 'at_least') return count >= condition.value
      if (condition.operator === 'at_most') return count <= condition.value
      return false
    }
    default:
      return false
  }
}

/**
 * Whether every condition holds (AND; no conditions holds). The booking must be one workflows
 * may consider at all, and a team definition never matches on a personal-only predicate.
 */
export function evaluateConditions(
  owner: WorkflowOwner,
  conditions: readonly WorkflowCondition[],
  booking: WorkflowBookingFacts,
): boolean {
  if (!isWorkflowBooking(booking)) return false
  return conditions.every(
    (condition) =>
      !(owner.kind === 'team' && PERSONAL_ONLY_CONDITION_FIELDS.includes(condition.field)) &&
      evaluateCondition(condition, booking),
  )
}
