import { describe, expect, it } from 'vitest'
import { evaluateCondition, evaluateConditions, type WorkflowCondition } from './conditions.ts'
import { booking, ids, personalOwner, teamOwner } from './testing.ts'

const answer = (questionId: string, value: string | boolean): WorkflowCondition => ({
  field: 'answer',
  questionId,
  operator: 'equals',
  value,
})
const guests = (operator: 'equals' | 'at_least' | 'at_most', value: number): WorkflowCondition => ({
  field: 'guest_count',
  operator,
  value,
})

describe('workflow condition evaluation', () => {
  it('joins conditions with AND, and no conditions hold', () => {
    const plan = answer('plan', 'enterprise')
    const zoom: WorkflowCondition = { field: 'location_kind', operator: 'equals', value: 'zoom' }
    const phone: WorkflowCondition = { field: 'location_kind', operator: 'equals', value: 'phone' }
    expect(evaluateConditions(personalOwner, [], booking())).toBe(true)
    expect(evaluateConditions(personalOwner, [plan, zoom], booking())).toBe(true)
    expect(evaluateConditions(personalOwner, [plan, phone], booking())).toBe(false)
    expect(evaluateConditions(personalOwner, [phone, plan], booking())).toBe(false)
    expect(evaluateConditions(personalOwner, [phone], booking())).toBe(false)
  })

  it('evaluates an absent answer as false', () => {
    const responses = { consent: false }
    expect(evaluateCondition(answer('plan', 'enterprise'), booking({ responses }))).toBe(false)
    expect(evaluateCondition(answer('company', ''), booking({ responses: {} }))).toBe(false)
    expect(evaluateCondition(answer('consent', false), booking({ responses: {} }))).toBe(false)
    // Inherited properties are not answers.
    for (const questionId of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
      expect(evaluateCondition(answer(questionId, 'x'), booking({ responses: {} }))).toBe(false)
    expect(
      evaluateConditions(personalOwner, [answer('plan', 'enterprise')], booking({ responses })),
    ).toBe(false)
  })

  it('compares answers with exact typed scalar equality', () => {
    expect(evaluateCondition(answer('plan', 'enterprise'), booking())).toBe(true)
    expect(evaluateCondition(answer('plan', 'Enterprise'), booking())).toBe(false)
    expect(evaluateCondition(answer('plan', 'starter'), booking())).toBe(false)
    expect(evaluateCondition(answer('consent', true), booking())).toBe(true)
    expect(evaluateCondition(answer('consent', false), booking())).toBe(false)
    const mistyped = { plan: ['enterprise'], consent: 'true', flag: 1 }
    expect(evaluateCondition(answer('plan', 'enterprise'), booking({ responses: mistyped }))).toBe(
      false,
    )
    expect(evaluateCondition(answer('consent', true), booking({ responses: mistyped }))).toBe(false)
    expect(
      evaluateCondition(answer('consent', 'true'), booking({ responses: { consent: true } })),
    ).toBe(false)
  })

  it('evaluates event type, source and location predicates exactly', () => {
    const event: WorkflowCondition = { field: 'event_type', operator: 'equals', value: ids.event }
    expect(evaluateCondition(event, booking())).toBe(true)
    expect(evaluateCondition(event, booking({ eventTypeId: ids.secondEvent }))).toBe(false)
    expect(evaluateCondition(event, booking({ eventTypeId: null }))).toBe(false)
    const embed: WorkflowCondition = { field: 'booking_source', operator: 'equals', value: 'embed' }
    expect(evaluateCondition(embed, booking({ source: 'embed' }))).toBe(true)
    expect(evaluateCondition(embed, booking({ source: 'web' }))).toBe(false)
    const zoom: WorkflowCondition = { field: 'location_kind', operator: 'equals', value: 'zoom' }
    expect(evaluateCondition(zoom, booking())).toBe(true)
    expect(evaluateCondition(zoom, booking({ locationKind: 'google_meet' }))).toBe(false)
    expect(evaluateCondition(zoom, booking({ locationKind: null }))).toBe(false)
  })

  it('compares guest counts inclusively', () => {
    const two = booking({ guestCount: 2 })
    expect(evaluateCondition(guests('equals', 2), two)).toBe(true)
    expect(evaluateCondition(guests('equals', 1), two)).toBe(false)
    expect(evaluateCondition(guests('at_least', 2), two)).toBe(true)
    expect(evaluateCondition(guests('at_least', 3), two)).toBe(false)
    expect(evaluateCondition(guests('at_most', 2), two)).toBe(true)
    expect(evaluateCondition(guests('at_most', 1), two)).toBe(false)
    expect(evaluateCondition(guests('at_most', 10), booking({ guestCount: Number.NaN }))).toBe(
      false,
    )
    expect(evaluateCondition(guests('at_most', 10), booking({ guestCount: -1 }))).toBe(false)
    expect(evaluateCondition(guests('at_least', 0), booking({ guestCount: 1.5 }))).toBe(false)
  })

  it('evaluates an unknown stored predicate or operator as false', () => {
    const unknown = { field: 'no_show', operator: 'equals', value: true } as never
    expect(evaluateCondition(unknown, booking())).toBe(false)
    expect(evaluateConditions(personalOwner, [unknown], booking())).toBe(false)
    const operator = { field: 'guest_count', operator: 'between', value: 2 } as never
    expect(evaluateCondition(operator, booking())).toBe(false)
  })

  it('fails closed for imported, group and unknown-source bookings', () => {
    expect(evaluateConditions(personalOwner, [], booking({ imported: true }))).toBe(false)
    expect(evaluateConditions(personalOwner, [], booking({ source: 'import' }))).toBe(false)
    expect(evaluateConditions(personalOwner, [], booking({ groupSeat: true }))).toBe(false)
    expect(evaluateConditions(personalOwner, [], booking({ source: 'calendar' }))).toBe(false)
    const imported: WorkflowCondition = {
      field: 'booking_source',
      operator: 'equals',
      value: 'import' as never,
    }
    expect(evaluateConditions(personalOwner, [imported], booking({ source: 'import' }))).toBe(false)
  })

  it('never matches a team definition on a personal-only predicate', () => {
    const embed: WorkflowCondition = { field: 'booking_source', operator: 'equals', value: 'web' }
    const zoom: WorkflowCondition = { field: 'location_kind', operator: 'equals', value: 'zoom' }
    const plan = answer('plan', 'enterprise')
    for (const condition of [embed, zoom, plan]) {
      expect(evaluateConditions(personalOwner, [condition], booking())).toBe(true)
      expect(evaluateConditions(teamOwner, [condition], booking())).toBe(false)
    }
    expect(evaluateConditions(teamOwner, [guests('at_least', 1)], booking())).toBe(true)
  })
})
