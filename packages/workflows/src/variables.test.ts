import { describe, expect, it } from 'vitest'
import { eventTypes, ids } from './testing.ts'
import {
  templatePlaceholders,
  templateVariableProblem,
  WORKFLOW_RECIPIENT_CLASSES,
  WORKFLOW_TEMPLATE_VARIABLES,
  type WorkflowTemplateContext,
} from './variables.ts'

const personal: WorkflowTemplateContext = {
  owner: 'personal',
  recipients: ['booker', 'hosts'],
  eventType: eventTypes.get(ids.event),
}

describe('workflow template variable catalog', () => {
  it('offers exactly the common variables and the three recipient classes', () => {
    expect(Object.keys(WORKFLOW_TEMPLATE_VARIABLES)).toEqual([
      'recipient.name',
      'recipient.time_zone',
      'event_type.title',
      'event_type.public_path',
      'booking.start',
      'booking.end',
    ])
    expect(Object.isFrozen(WORKFLOW_TEMPLATE_VARIABLES)).toBe(true)
    expect(WORKFLOW_RECIPIENT_CLASSES).toEqual(['booker', 'guests', 'hosts'])
  })

  it('names no excluded, no-show or inherited variable', () => {
    for (const name of [
      'no_show',
      'booking.no_show',
      'attendee.no_show',
      'booking.meeting_url',
      'booking.cancel_reason',
      'booking.title',
      'attendee.email',
      'booking.manage_token',
      'toString',
      'constructor',
      '__proto__',
    ])
      expect(templateVariableProblem(name, personal), name).toBe('uses an unknown variable')
  })

  it('finds placeholders in one pass and refuses malformed ones', () => {
    expect(templatePlaceholders('Plain text with {single} braces')).toEqual([])
    expect(
      templatePlaceholders('{{recipient.name}}, {{ booking.start }}{{answer.plan-2}}'),
    ).toEqual(['recipient.name', 'booking.start', 'answer.plan-2'])
    for (const text of [
      '{{',
      '}}',
      'a }} b {{c}}',
      '{{recipient.name}',
      '{{ recipient name }}',
      '{{<b>x</b>}}',
      `{{${'a'.repeat(81)}}}`,
    ])
      expect(templatePlaceholders(text), text).toBeUndefined()
    // Bounded input: a long run of openers is refused without backtracking.
    expect(templatePlaceholders('{{'.repeat(4000))).toBeUndefined()
  })
})
