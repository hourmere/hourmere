import { describe, expect, it } from 'vitest'
import { workflowMatches } from './definition.ts'
import {
  isWorkflowBooking,
  isWorkflowEventType,
  ownsEventType,
  ownsWebhook,
  scopeSelectsEventType,
  type WorkflowEventTypeFacts,
  WorkflowOwnerSelectorSchema,
  workflowOwnerSelector,
} from './ownership.ts'
import { booking, eventTypes, ids, personalOwner, teamOwner, webhooks } from './testing.ts'

const facts = (id: string) => eventTypes.get(id) as WorkflowEventTypeFacts
const all = { type: 'all_event_types' } as const
const only = (eventTypeId: string) => ({ type: 'event_type', eventTypeId }) as const

describe('workflow ownership selectors', () => {
  it('maps owners to their explicit selector and parses selectors strictly', () => {
    expect(workflowOwnerSelector(personalOwner)).toEqual({ kind: 'personal', id: ids.user })
    expect(workflowOwnerSelector(teamOwner)).toEqual({ kind: 'team', id: ids.team })
    expect(WorkflowOwnerSelectorSchema.parse({ kind: 'team', id: ids.team })).toEqual({
      kind: 'team',
      id: ids.team,
    })
    expect(
      WorkflowOwnerSelectorSchema.parse({ kind: 'personal', id: ids.user.toUpperCase() }),
    ).toEqual({ kind: 'personal', id: ids.user })
    for (const value of [
      { kind: 'organization', id: ids.team },
      { kind: 'team', id: 'not-a-uuid' },
      { kind: 'team', id: ids.team, role: 'admin' },
    ])
      expect(WorkflowOwnerSelectorSchema.safeParse(value).success).toBe(false)
  })

  it('gives a personal owner only its own personal event types', () => {
    expect(ownsEventType(personalOwner, facts(ids.event))).toBe(true)
    // A team event type the person merely hosts is the team's, never theirs.
    expect(ownsEventType(personalOwner, facts(ids.teamEvent))).toBe(false)
    expect(ownsEventType(personalOwner, facts(ids.foreignEvent))).toBe(false)
    expect(ownsEventType(personalOwner, facts(ids.hostedTeamPersonalLookalike))).toBe(false)
  })

  it('gives a team only its own team event types', () => {
    expect(ownsEventType(teamOwner, facts(ids.teamEvent))).toBe(true)
    expect(ownsEventType(teamOwner, facts(ids.event))).toBe(false)
    expect(ownsEventType(teamOwner, facts(ids.otherTeamEvent))).toBe(false)
    expect(ownsEventType(teamOwner, facts(ids.hostedTeamPersonalLookalike))).toBe(false)
  })

  it('accepts webhook endpoints only in the owner organization', () => {
    expect(ownsWebhook(personalOwner, webhooks.get(ids.webhook) as never)).toBe(true)
    expect(ownsWebhook(personalOwner, webhooks.get(ids.teamWebhook) as never)).toBe(false)
    expect(ownsWebhook(personalOwner, webhooks.get(ids.foreignWebhook) as never)).toBe(false)
    expect(ownsWebhook(teamOwner, webhooks.get(ids.teamWebhook) as never)).toBe(true)
    expect(ownsWebhook(teamOwner, webhooks.get(ids.webhook) as never)).toBe(false)
  })

  it('supports only individual, undeleted event types', () => {
    expect(isWorkflowEventType(facts(ids.event))).toBe(true)
    expect(isWorkflowEventType(facts(ids.groupEvent))).toBe(false)
    expect(isWorkflowEventType(facts(ids.deletedEvent))).toBe(false)
    expect(isWorkflowEventType({ ...facts(ids.event), bookingMode: 'seats' })).toBe(false)
    const { deleted: _deleted, ...withoutDeleted } = facts(ids.event)
    expect(isWorkflowEventType(withoutDeleted as never)).toBe(false)
  })

  it('lets an all-event scope select current and future own event types, skipping groups', () => {
    expect(scopeSelectsEventType(personalOwner, all, facts(ids.event))).toBe(true)
    expect(scopeSelectsEventType(personalOwner, all, facts(ids.secondEvent))).toBe(true)
    const future = { ...facts(ids.secondEvent), id: ids.missingEvent }
    expect(scopeSelectsEventType(personalOwner, all, future)).toBe(true)
    expect(scopeSelectsEventType(personalOwner, all, facts(ids.groupEvent))).toBe(false)
    expect(scopeSelectsEventType(personalOwner, all, facts(ids.deletedEvent))).toBe(false)
    expect(scopeSelectsEventType(personalOwner, all, facts(ids.teamEvent))).toBe(false)
    expect(scopeSelectsEventType(personalOwner, all, facts(ids.foreignEvent))).toBe(false)
    expect(scopeSelectsEventType(teamOwner, all, facts(ids.teamEvent))).toBe(true)
    expect(scopeSelectsEventType(teamOwner, all, facts(ids.teamGroupEvent))).toBe(false)
    expect(scopeSelectsEventType(teamOwner, all, facts(ids.event))).toBe(false)
  })

  it('lets an event-specific scope select only that event type of the same owner', () => {
    expect(scopeSelectsEventType(personalOwner, only(ids.event), facts(ids.event))).toBe(true)
    expect(scopeSelectsEventType(personalOwner, only(ids.event), facts(ids.secondEvent))).toBe(
      false,
    )
    expect(
      scopeSelectsEventType(personalOwner, only(ids.foreignEvent), facts(ids.foreignEvent)),
    ).toBe(false)
    expect(scopeSelectsEventType(personalOwner, only(ids.groupEvent), facts(ids.groupEvent))).toBe(
      false,
    )
    expect(scopeSelectsEventType(teamOwner, only(ids.event), facts(ids.event))).toBe(false)
  })

  it('fails closed for imported, group-seat and unknown-source bookings', () => {
    expect(isWorkflowBooking(booking())).toBe(true)
    for (const source of ['web', 'embed', 'api', 'mcp'])
      expect(isWorkflowBooking(booking({ source }))).toBe(true)
    expect(isWorkflowBooking(booking({ imported: true }))).toBe(false)
    expect(isWorkflowBooking(booking({ source: 'import' }))).toBe(false)
    expect(isWorkflowBooking(booking({ groupSeat: true }))).toBe(false)
    expect(isWorkflowBooking(booking({ source: '' }))).toBe(false)
    expect(isWorkflowBooking(booking({ imported: undefined as never }))).toBe(false)
    expect(isWorkflowBooking(booking({ groupSeat: null as never }))).toBe(false)
  })

  it('matches a booking only through scope, eligibility and every condition', () => {
    const definition = { scope: all, conditions: [] }
    expect(workflowMatches(personalOwner, definition, facts(ids.event), booking())).toBe(true)
    // An imported reschedule successor of a native booking stays silent.
    expect(
      workflowMatches(personalOwner, definition, facts(ids.event), booking({ imported: true })),
    ).toBe(false)
    expect(
      workflowMatches(personalOwner, definition, facts(ids.event), booking({ groupSeat: true })),
    ).toBe(false)
    expect(
      workflowMatches(
        personalOwner,
        definition,
        facts(ids.event),
        booking({ eventTypeId: ids.secondEvent }),
      ),
    ).toBe(false)
    expect(
      workflowMatches(
        personalOwner,
        definition,
        facts(ids.teamEvent),
        booking({ eventTypeId: ids.teamEvent }),
      ),
    ).toBe(false)
    expect(
      workflowMatches(
        personalOwner,
        {
          scope: only(ids.event),
          conditions: [{ field: 'guest_count', operator: 'equals', value: 5 }],
        },
        facts(ids.event),
        booking(),
      ),
    ).toBe(false)
  })
})
