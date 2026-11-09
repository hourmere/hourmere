// Fixtures for the workflow contract tests: one personal owner, one team and foreign facts
// the services would load by ID without an owner filter.
import type { WorkflowValidationContext } from './definition.ts'
import type {
  WorkflowBookingFacts,
  WorkflowEventTypeFacts,
  WorkflowOwner,
  WorkflowWebhookFacts,
} from './ownership.ts'

export const ids = {
  user: '10000000-0000-4000-8000-000000000001',
  otherUser: '10000000-0000-4000-8000-000000000002',
  personalOrganization: '20000000-0000-4000-8000-000000000001',
  otherPersonalOrganization: '20000000-0000-4000-8000-000000000002',
  team: '30000000-0000-4000-8000-000000000001',
  otherTeam: '30000000-0000-4000-8000-000000000002',
  event: '40000000-0000-4000-8000-000000000001',
  secondEvent: '40000000-0000-4000-8000-000000000002',
  groupEvent: '40000000-0000-4000-8000-000000000003',
  deletedEvent: '40000000-0000-4000-8000-000000000004',
  foreignEvent: '40000000-0000-4000-8000-000000000005',
  teamEvent: '40000000-0000-4000-8000-000000000006',
  teamGroupEvent: '40000000-0000-4000-8000-000000000007',
  otherTeamEvent: '40000000-0000-4000-8000-000000000008',
  hostedTeamPersonalLookalike: '40000000-0000-4000-8000-000000000009',
  missingEvent: '40000000-0000-4000-8000-00000000000a',
  personalOrganizationTeamRow: '40000000-0000-4000-8000-00000000000b',
  personalOrganizationOtherOwner: '40000000-0000-4000-8000-00000000000c',
  webhook: '50000000-0000-4000-8000-000000000001',
  teamWebhook: '50000000-0000-4000-8000-000000000002',
  foreignWebhook: '50000000-0000-4000-8000-000000000003',
} as const

export const personalOwner: WorkflowOwner = {
  kind: 'personal',
  userId: ids.user,
  organizationId: ids.personalOrganization,
}
export const teamOwner: WorkflowOwner = { kind: 'team', organizationId: ids.team }

const questions = [
  { id: 'plan', type: 'select', options: ['starter', 'enterprise'] },
  { id: 'consent', type: 'checkbox' },
  { id: 'company', type: 'short_text' },
  { id: 'notes', type: 'long_text' },
  { id: 'mobile', type: 'phone' },
  { id: 'topics', type: 'multi_select', options: ['a', 'b'] },
] as const

function eventType(
  id: string,
  facts: Partial<WorkflowEventTypeFacts> & Pick<WorkflowEventTypeFacts, 'organizationId'>,
): WorkflowEventTypeFacts {
  return {
    id,
    ownerUserId: null,
    bookingMode: 'individual',
    deleted: false,
    questions: [],
    ...facts,
  }
}

export const eventTypes: ReadonlyMap<string, WorkflowEventTypeFacts> = new Map(
  [
    eventType(ids.event, {
      organizationId: ids.personalOrganization,
      ownerUserId: ids.user,
      questions,
    }),
    eventType(ids.secondEvent, {
      organizationId: ids.personalOrganization,
      ownerUserId: ids.user,
    }),
    eventType(ids.groupEvent, {
      organizationId: ids.personalOrganization,
      ownerUserId: ids.user,
      bookingMode: 'group',
    }),
    eventType(ids.deletedEvent, {
      organizationId: ids.personalOrganization,
      ownerUserId: ids.user,
      deleted: true,
    }),
    eventType(ids.foreignEvent, {
      organizationId: ids.otherPersonalOrganization,
      ownerUserId: ids.otherUser,
      questions,
    }),
    eventType(ids.teamEvent, { organizationId: ids.team, questions }),
    eventType(ids.teamGroupEvent, { organizationId: ids.team, bookingMode: 'group' }),
    eventType(ids.otherTeamEvent, { organizationId: ids.otherTeam }),
    // A team-organization row carrying the user as owner fails closed for both owners.
    eventType(ids.hostedTeamPersonalLookalike, { organizationId: ids.team, ownerUserId: ids.user }),
    // Rows in the personal organization that are not the user's own fail closed too.
    eventType(ids.personalOrganizationTeamRow, { organizationId: ids.personalOrganization }),
    eventType(ids.personalOrganizationOtherOwner, {
      organizationId: ids.personalOrganization,
      ownerUserId: ids.otherUser,
    }),
  ].map((facts) => [facts.id, facts]),
)

export const webhooks: ReadonlyMap<string, WorkflowWebhookFacts> = new Map(
  [
    { id: ids.webhook, organizationId: ids.personalOrganization },
    { id: ids.teamWebhook, organizationId: ids.team },
    { id: ids.foreignWebhook, organizationId: ids.otherPersonalOrganization },
  ].map((facts) => [facts.id, facts]),
)

export const personalContext: WorkflowValidationContext = {
  owner: personalOwner,
  eventTypes,
  webhooks,
}
export const teamContext: WorkflowValidationContext = { owner: teamOwner, eventTypes, webhooks }

/** A valid personal candidate; override any part. */
export function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Prepare for our call',
    scope: { type: 'event_type', eventTypeId: ids.event },
    trigger: { type: 'before_start', offsetMinutes: 60 },
    actions: [{ type: 'email', recipients: ['booker'] }],
    ...overrides,
  }
}

export function booking(overrides: Partial<WorkflowBookingFacts> = {}): WorkflowBookingFacts {
  return {
    eventTypeId: ids.event,
    source: 'web',
    imported: false,
    groupSeat: false,
    responses: { plan: 'enterprise', consent: true, company: 'Example' },
    locationKind: 'zoom',
    guestCount: 2,
    ...overrides,
  }
}
