// Routing targets (docs/routing-forms.md, "Targets and failure behavior", "Scheduling
// interactions" and "Answer transfer, receipts and privacy"): the eligibility allowlist for an
// event target and the answer-mapping check against that event's current booking form.
// Publication refuses what these refuse; later steps reuse them to mark targets broken at
// run time. Eligibility is an allowlist that fails closed: an event qualifies only if it is
// enabled, not deleted, in the form's organization (owned as that organization's pages are),
// books one invitee per booking (`booking_mode = 'individual'`) with a known host mode, and
// requires no payment. Listed and hidden events qualify alike.
import type { Db } from '@hourmere/db'
import { isUuid } from './internal.ts'
import { parseQuestions, type Question } from './questions.ts'
import {
  type RoutingFormConfig,
  type RoutingMapping,
  type RoutingQuestion,
  type RoutingTarget,
  RoutingValidationError,
} from './routing-form-config.ts'

/** Host modes a routing target keeps as they are; any other mode fails closed. */
export const ROUTING_SCHEDULING_TYPES: readonly string[] = [
  'individual',
  'round_robin',
  'collective',
]

/** What eligibility and mappings read of a stored event type. */
export interface RoutingTargetEvent {
  id: string
  organizationId: string
  ownerUserId: string | null
  /** The user whose personal organization holds the event; null in a team organization. */
  personalUserId: string | null
  active: boolean
  deleted: boolean
  bookingMode: string
  schedulingType: string
  /** `none` when booking needs no payment; any other value is a payment requirement. */
  payment: string
  /** The event's current booking-form questions. */
  questions: readonly Question[]
}

export type RoutingTargetReason =
  | 'not_found'
  | 'deleted'
  | 'disabled'
  | 'group_booking'
  | 'unsupported_mode'
  | 'payment_required'

export type RoutingMappingReason =
  | 'unknown_destination'
  | 'incompatible_mapping'
  | 'incompatible_options'

/**
 * Why `event` cannot be a target of a form in `organizationId`, or undefined when it can.
 * Another organization's event is reported exactly like a missing one. Group booking is
 * refused because a route receipt covers one booking, not a seat; a payment requirement
 * because nothing binds receipt consumption to payment; an unknown booking or host mode
 * because nothing has established that routing supports it.
 */
export function routingTargetProblem(
  organizationId: string,
  event: RoutingTargetEvent | undefined,
): RoutingTargetReason | undefined {
  if (event === undefined) return 'not_found'
  if (event.organizationId !== organizationId) return 'not_found'
  // A personal organization's events are its user's own; a team's belong to the team page.
  if (event.ownerUserId !== event.personalUserId) return 'not_found'
  if (event.deleted) return 'deleted'
  if (!event.active) return 'disabled'
  if (event.bookingMode === 'group') return 'group_booking'
  if (event.bookingMode !== 'individual') return 'unsupported_mode'
  if (!ROUTING_SCHEDULING_TYPES.includes(event.schedulingType)) return 'unsupported_mode'
  if (event.payment !== 'none') return 'payment_required'
  return undefined
}

/**
 * Why `mapping` cannot prefill the event's current booking form, or undefined when it can.
 * Short text fills the invitee name or a short/long text question; an email address fills
 * the invitee email or a short/long text question; a select fills a select question only,
 * through a crosswalk whose every value is a current option of that question. Nothing is
 * converted to phone, checkbox or multiple choice.
 */
export function routingMappingProblem(
  source: RoutingQuestion,
  mapping: RoutingMapping,
  destinations: readonly Question[],
): RoutingMappingReason | undefined {
  const { destination } = mapping
  if (destination.kind === 'inviteeName')
    return source.type === 'short_text' ? undefined : 'incompatible_mapping'
  if (destination.kind === 'inviteeEmail')
    return source.type === 'email' ? undefined : 'incompatible_mapping'
  const field = destinations.find((question) => question.id === destination.questionId)
  if (field === undefined) return 'unknown_destination'
  if (source.type === 'select') {
    if (field.type !== 'select') return 'incompatible_mapping'
    const current = field.options ?? []
    if (Object.values(mapping.options ?? {}).some((value) => !current.includes(value)))
      return 'incompatible_options'
    return undefined
  }
  return field.type === 'short_text' || field.type === 'long_text'
    ? undefined
    : 'incompatible_mapping'
}

type EventTarget = Extract<RoutingTarget, { kind: 'event' }>

/** Each event target with its field: the rules' in order, then the fallback's. */
function eventTargets(config: RoutingFormConfig): [string, EventTarget][] {
  const targets: [string, RoutingTarget][] = config.rules.map((rule, i) => [
    `rules.${i}.target`,
    rule.target,
  ])
  targets.push(['fallback', config.fallback])
  const events: [string, EventTarget][] = []
  for (const [field, target] of targets) if (target.kind === 'event') events.push([field, target])
  return events
}

/**
 * Checks every event target of a validated version, rules first and then the fallback,
 * against the loaded events: eligibility first, then each mapping against that event's
 * current booking form. Throws the first problem as `invalid_routing_target` with its
 * `field` and `reason`.
 */
export function validateRoutingTargets(
  organizationId: string,
  config: RoutingFormConfig,
  events: ReadonlyMap<string, RoutingTargetEvent>,
): void {
  const questions = new Map(config.questions.map((question) => [question.id, question]))
  for (const [field, target] of eventTargets(config)) {
    const event = events.get(target.eventTypeId)
    const problem = routingTargetProblem(organizationId, event)
    if (problem !== undefined || event === undefined)
      throw new RoutingValidationError(
        'invalid_routing_target',
        field,
        'must be an enabled event type of this organization that routing supports',
        problem ?? 'not_found',
      )
    target.mappings.forEach((mapping, i) => {
      const source = questions.get(mapping.questionId)
      const reason =
        source === undefined
          ? 'invalid_mapping'
          : routingMappingProblem(source, mapping, event.questions)
      if (reason !== undefined)
        throw new RoutingValidationError(
          'invalid_routing_target',
          `${field}.mappings.${i}`,
          "must fit the event type's current booking form",
          reason,
        )
    })
  }
}

/**
 * Reads the stored event types with these IDs, in any organization, for eligibility and
 * mapping checks. IDs that are not UUIDs or match no row are absent from the result.
 */
export async function loadRoutingTargetEvents(
  db: Db,
  eventTypeIds: readonly string[],
): Promise<Map<string, RoutingTargetEvent>> {
  const ids = [...new Set(eventTypeIds.filter(isUuid))]
  if (ids.length === 0) return new Map()
  const rows = await db
    .selectFrom('event_types as e')
    .leftJoin('personal_organizations as p', 'p.organization_id', 'e.organization_id')
    .select([
      'e.id',
      'e.organization_id',
      'e.owner_user_id',
      'p.user_id as personal_user_id',
      'e.is_active',
      'e.deleted_at',
      'e.booking_mode',
      'e.scheduling_type',
      'e.questions',
    ])
    .where('e.id', 'in', ids)
    .execute()
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        organizationId: row.organization_id,
        ownerUserId: row.owner_user_id,
        personalUserId: row.personal_user_id,
        active: row.is_active,
        deleted: row.deleted_at !== null,
        bookingMode: row.booking_mode,
        schedulingType: row.scheduling_type,
        // Event types have no price setting yet (docs/payments.md). A later price setting
        // must project its requirement here, so routing refuses paid events at once.
        payment: 'none',
        questions: parseQuestions(row.questions),
      },
    ]),
  )
}

/**
 * Loads every event target of a validated version from `db` (a transaction when publishing)
 * and checks them with validateRoutingTargets.
 */
export async function checkRoutingTargets(
  db: Db,
  organizationId: string,
  config: RoutingFormConfig,
): Promise<void> {
  const ids = eventTargets(config).map(([, target]) => target.eventTypeId)
  validateRoutingTargets(organizationId, config, await loadRoutingTargetEvents(db, ids))
}
