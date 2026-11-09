// Who owns a workflow and which event types, bookings and webhook endpoints it may select
// (docs/workflows.md, "Definitions, ownership and limits" and "Triggers, conditions and
// snapshots"). Everything here is pure: services load the facts by ID, without filtering by
// owner, and these functions decide. A fact of another owner is treated exactly like a
// missing one, so a cross-owner ID reveals nothing. Unknown values fail closed.

import { z } from 'zod'

/**
 * A resolved workflow owner. A personal owner is a user acting in their personal
 * organization; a team owner is the team organization itself, never the member who created
 * the definition.
 */
export type WorkflowOwner =
  | { kind: 'personal'; userId: string; organizationId: string }
  | { kind: 'team'; organizationId: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A UUID, lowercased like the IDs the database returns, so fact lookups match. */
export const uuidSchema = z.string().regex(UUID, { error: 'must be a UUID' }).toLowerCase()

/**
 * The explicit owner selector that create, list and preview carry: the user for a personal
 * owner, the team organization for a team. Services check it against the current principal.
 */
export const WorkflowOwnerSelectorSchema = z.strictObject({
  kind: z.enum(['personal', 'team'], { error: 'unknown owner kind' }),
  id: uuidSchema,
})
export type WorkflowOwnerSelector = z.output<typeof WorkflowOwnerSelectorSchema>

/** The selector that names `owner`. */
export function workflowOwnerSelector(owner: WorkflowOwner): WorkflowOwnerSelector {
  return owner.kind === 'personal'
    ? { kind: 'personal', id: owner.userId }
    : { kind: 'team', id: owner.organizationId }
}

/** What a workflow reads about a booking-form question. */
export interface WorkflowQuestionFacts {
  id: string
  type: string
  options?: readonly string[] | undefined
}

/** What a workflow reads about an event type, loaded by ID without an owner filter. */
export interface WorkflowEventTypeFacts {
  id: string
  organizationId: string
  /** The personal owner; null for a team event type. */
  ownerUserId: string | null
  /** `event_types.booking_mode`; only `individual` is supported in this version. */
  bookingMode: string
  deleted: boolean
  questions: readonly WorkflowQuestionFacts[]
}

/** What a workflow reads about a webhook endpoint, loaded by ID without an owner filter. */
export interface WorkflowWebhookFacts {
  id: string
  organizationId: string
}

/**
 * Whether `eventType` belongs to `owner`. A personal owner owns only event types of its own
 * personal page, never team event types it merely hosts; a team owns only its team event types.
 */
export function ownsEventType(owner: WorkflowOwner, eventType: WorkflowEventTypeFacts): boolean {
  if (eventType.organizationId !== owner.organizationId) return false
  return owner.kind === 'personal'
    ? eventType.ownerUserId === owner.userId
    : eventType.ownerUserId === null
}

/** Whether a webhook endpoint is in the owner's organization. */
export function ownsWebhook(owner: WorkflowOwner, webhook: WorkflowWebhookFacts): boolean {
  return webhook.organizationId === owner.organizationId
}

/**
 * Whether workflows may apply to an event type at all. Group event types are excluded in this
 * version; a deleted event type is selected by no scope, so its remaining bookings start no
 * further workflow run either; an unknown booking mode or a missing flag fails closed.
 */
export function isWorkflowEventType(eventType: WorkflowEventTypeFacts): boolean {
  return eventType.bookingMode === 'individual' && eventType.deleted === false
}

/** One event type of the owner, or all of its current and future event types. */
export const WorkflowScopeSchema = z.discriminatedUnion(
  'type',
  [
    z.strictObject({ type: z.literal('all_event_types') }),
    z.strictObject({ type: z.literal('event_type'), eventTypeId: uuidSchema }),
  ],
  { error: (issue) => (issue.code === 'invalid_union' ? 'unknown scope' : undefined) },
)
export type WorkflowScope = z.output<typeof WorkflowScopeSchema>

/**
 * Whether a definition of `owner` with `scope` selects `eventType`. An all-event scope skips
 * group event types; an event-specific scope matches only its own event type of the same owner.
 */
export function scopeSelectsEventType(
  owner: WorkflowOwner,
  scope: WorkflowScope,
  eventType: WorkflowEventTypeFacts,
): boolean {
  if (!ownsEventType(owner, eventType) || !isWorkflowEventType(eventType)) return false
  return scope.type === 'all_event_types' || scope.eventTypeId === eventType.id
}

/** Stored booking sources a workflow can see; imported bookings are never among them. */
export const WORKFLOW_BOOKING_SOURCES = ['web', 'embed', 'api', 'mcp'] as const
export type WorkflowBookingSource = (typeof WORKFLOW_BOOKING_SOURCES)[number]

/** What a workflow reads about a booking, from its captured snapshot. */
export interface WorkflowBookingFacts {
  eventTypeId: string | null
  /** The stored `bookings.source`. */
  source: string
  /** Whether the booking or its reschedule chain was imported (isImportedBooking). */
  imported: boolean
  /** Whether the booking is a seat in a group slot. */
  groupSeat: boolean
  /** The booker's saved answers, keyed by question ID. */
  responses: Readonly<Record<string, unknown>>
  /** The saved location's kind, or null without a location. */
  locationKind: string | null
  /** Attendees other than the booker saved on this booking. */
  guestCount: number
}

/**
 * Whether workflows may consider a booking. Imported bookings and their reschedule chains stay
 * silent, as they do for notifications; group seats are excluded; an unknown source fails closed.
 */
export function isWorkflowBooking(booking: WorkflowBookingFacts): boolean {
  // Only an explicit false clears a flag: a missing one fails closed.
  if (booking.imported !== false || booking.groupSeat !== false) return false
  return (WORKFLOW_BOOKING_SOURCES as readonly string[]).includes(booking.source)
}
