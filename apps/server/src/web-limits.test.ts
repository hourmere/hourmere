// The web app checks the API's documented limits in its forms before sending
// (apps/web/src/limits.ts). This compares them with the OpenAPI document the server
// publishes, so a limit changed on one side fails here instead of drifting apart.
import { DISPLAY_NAME_MAX_LENGTH } from '@hourmere/auth'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT,
  BOOKING,
  EVENT_TYPE,
  PROFILE,
  QUESTIONS,
  RULES,
  SCHEDULE,
} from '../../web/src/limits.ts'
import { openApiDocument } from './openapi-document.ts'

interface SchemaObject {
  type?: string | string[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  maxItems?: number
  pattern?: string
  properties?: Record<string, SchemaObject>
  items?: SchemaObject
  oneOf?: SchemaObject[]
}

async function schemas(): Promise<Record<string, SchemaObject>> {
  const doc = (await openApiDocument()) as { components: { schemas: Record<string, SchemaObject> } }
  return doc.components.schemas
}

function property(schema: SchemaObject | undefined, name: string): SchemaObject {
  const found = schema?.properties?.[name]
  if (!found) throw new Error(`no property ${name}`)
  return found
}

/** The location variant of `kind` in EventTypeInput.location. */
function locationVariant(eventTypeInput: SchemaObject, kind: string): SchemaObject {
  const variant = property(eventTypeInput, 'location').oneOf?.find(
    (v) => (v.properties?.kind as { enum?: string[] } | undefined)?.enum?.[0] === kind,
  )
  if (!variant) throw new Error(`no location kind ${kind}`)
  return variant
}

describe("the web app's form limits", () => {
  it('match the display-name limit outside OpenAPI', () => {
    expect(ACCOUNT.nameMaxLength).toBe(DISPLAY_NAME_MAX_LENGTH)
  })

  it('match the event type schema', async () => {
    const s = await schemas()
    const input = s.EventTypeInput
    if (!input) throw new Error('no EventTypeInput')
    expect(property(input, 'title').maxLength).toBe(EVENT_TYPE.titleMaxLength)
    expect(property(input, 'description').maxLength).toBe(EVENT_TYPE.descriptionMaxLength)
    expect(property(input, 'slug').maxLength).toBe(EVENT_TYPE.slugMaxLength)
    expect(property(input, 'slug').pattern).toBe(EVENT_TYPE.slugPattern.source)
    expect(property(input, 'position')).toMatchObject({
      minimum: EVENT_TYPE.positionMin,
      maximum: EVENT_TYPE.positionMax,
    })
    for (const [name, { min, max }] of Object.entries(RULES)) {
      expect(property(input, name), name).toMatchObject({ minimum: min, maximum: max })
    }
    expect(property(locationVariant(input, 'phone'), 'number').pattern).toBe(
      EVENT_TYPE.phonePattern.source,
    )
    expect(property(locationVariant(input, 'in_person'), 'address').maxLength).toBe(
      EVENT_TYPE.addressMaxLength,
    )
    expect(property(locationVariant(input, 'link'), 'url').maxLength).toBe(EVENT_TYPE.urlMaxLength)
  })

  it('match the question schema', async () => {
    const s = await schemas()
    expect(property(s.EventTypeInput, 'questions').maxItems).toBe(QUESTIONS.maxQuestions)
    const question = s.QuestionInput
    expect(property(question, 'label').maxLength).toBe(QUESTIONS.labelMaxLength)
    expect(property(question, 'options').maxItems).toBe(QUESTIONS.maxOptions)
    expect(property(question, 'options').items?.maxLength).toBe(QUESTIONS.optionMaxLength)
  })

  it('match the schedule, profile and cancellation schemas', async () => {
    const s = await schemas()
    expect(property(s.ScheduleInput, 'name').maxLength).toBe(SCHEDULE.nameMaxLength)
    expect(property(s.ProfileInput, 'handle').maxLength).toBe(PROFILE.handleMaxLength)
    expect(property(s.ProfileInput, 'handle').pattern).toBe(PROFILE.handlePattern.source)
    expect(property(s.ProfileInput, 'locale').maxLength).toBe(PROFILE.localeMaxLength)
    expect(property(s.CancelBooking, 'reason').maxLength).toBe(BOOKING.cancelReasonMaxLength)
  })
})
