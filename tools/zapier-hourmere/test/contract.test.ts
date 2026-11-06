import { beforeAll, describe, expect, it } from 'vitest'
import { openApiDocument } from '../../../apps/server/src/openapi-document.ts'

type Schema = {
  $ref?: string
  properties?: Record<string, Schema>
  items?: Schema
  allOf?: Schema[]
  anyOf?: Schema[]
  oneOf?: Schema[]
}
type Operation = {
  parameters?: { name: string; in: string; schema: Schema }[]
  requestBody?: { content: { 'application/json': { schema: Schema } } }
  responses: Record<string, { content?: { 'application/json'?: { schema: Schema } } }>
}
type Document = {
  paths: Record<string, Record<string, Operation>>
  components: { schemas: Record<string, Schema> }
}
let document: Document
beforeAll(async () => {
  document = (await openApiDocument()) as Document
})

function resolve(schema: Schema): Schema {
  if (schema.$ref) {
    const name = schema.$ref.split('/').at(-1) ?? ''
    const referred = document.components.schemas[name]
    expect(referred, `Unresolved OpenAPI reference: ${schema.$ref}`).toBeDefined()
    return resolve(referred as Schema)
  }
  return schema
}
function property(schema: Schema, key: string): Schema | undefined {
  const resolved = resolve(schema)
  if (key === '[]') return resolved.items
  if (resolved.properties?.[key]) return resolved.properties[key]
  for (const candidate of resolved.allOf ?? resolved.anyOf ?? resolved.oneOf ?? []) {
    const found = property(candidate, key)
    if (found) return found
  }
  return undefined
}
function fields(schema: Schema, names: string[]) {
  for (const name of names) {
    let current: Schema | undefined = schema
    for (const part of name.split('.')) {
      current = property(current as Schema, part)
      expect(current, `Undocumented field ${name} (segment ${part})`).toBeDefined()
    }
  }
}
function operation(path: string, method: string): Operation {
  const result = document.paths[path]?.[method]
  expect(result, `Undocumented endpoint: ${method.toUpperCase()} ${path}`).toBeDefined()
  return result as Operation
}
function response(op: Operation, status = '200'): Schema {
  const schema = op.responses[status]?.content?.['application/json']?.schema
  expect(schema, `Missing JSON response for ${status}`).toBeDefined()
  return schema as Schema
}
const bookingFields = [
  'id',
  'eventTypeId',
  'status',
  'start',
  'end',
  'title',
  'location',
  'responses',
  'attendees',
  'rescheduledFromId',
  'rescheduledToId',
  'cancelledAt',
  'cancelReason',
  'source',
  'createdAt',
]

describe('Zapier contract against the generated server OpenAPI document', () => {
  it('documents authentication and dynamic event type dropdown fields', () => {
    fields(response(operation('/api/v1/me', 'get')), ['user.id', 'organization.id'])
    fields(response(operation('/api/v1/event-types', 'get')), [
      'data',
      'data.[].id',
      'data.[].slug',
      'data.[].title',
    ])
  })
  it.each(['', '/teams'])(
    'documents every %s public booking input, retry header and response field',
    (team) => {
      const op = operation(`/api/v1/public${team}/{handle}/{slug}/bookings`, 'post')
      const parameters = op.parameters ?? []
      expect(parameters.map(({ name, in: location }) => `${location}:${name}`)).toEqual(
        expect.arrayContaining(['path:handle', 'path:slug', 'header:idempotency-key']),
      )
      fields(op.requestBody?.content['application/json'].schema as Schema, [
        'start',
        'durationMinutes',
        'invitee',
        'invitee.name',
        'invitee.email',
        'invitee.timeZone',
        'invitee.locale',
        'responses',
      ])
      fields(response(op, '201'), [
        'booking',
        ...bookingFields
          .filter((field) => field !== 'rescheduledToId')
          .map((field) => `booking.${field}`),
        'manageToken',
      ])
      fields(response(op, '200'), ['booking.id', 'manageToken'])
    },
  )
  it.each(['', '/teams'])('documents every %s slots input and output field', (team) => {
    const op = operation(`/api/v1/public${team}/{handle}/{slug}/slots`, 'get')
    expect(op.parameters?.map(({ name, in: location }) => `${location}:${name}`)).toEqual(
      expect.arrayContaining([
        'path:handle',
        'path:slug',
        'query:start',
        'query:end',
        'query:durationMinutes',
      ]),
    )
    fields(response(op), ['data', 'data.[].start', 'data.[].end'])
  })
  it('documents the host booking search and sample filters', () => {
    fields(response(operation('/api/v1/bookings/{id}', 'get')), bookingFields)
    const op = operation('/api/v1/bookings', 'get')
    expect(op.parameters?.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['limit', 'status', 'order']),
    )
    fields(response(op), [
      'data',
      'nextCursor',
      ...bookingFields.map((field) => `data.[].${field}`),
    ])
  })
  it('documents cancellation and reschedule input and output fields', () => {
    const cancel = operation('/api/v1/bookings/{id}/cancel', 'post')
    fields(cancel.requestBody?.content['application/json'].schema as Schema, ['reason'])
    fields(response(cancel), ['id', 'status'])
    const move = operation('/api/v1/bookings/{id}/reschedule', 'post')
    fields(move.requestBody?.content['application/json'].schema as Schema, [
      'start',
      'durationMinutes',
    ])
    fields(response(move), ['booking', 'booking.id', 'booking.rescheduledFromId', 'manageToken'])
  })
  it('documents hook registration, one-time secret and deletion', () => {
    const subscribe = operation('/api/v1/webhooks', 'post')
    fields(subscribe.requestBody?.content['application/json'].schema as Schema, ['url', 'events'])
    fields(response(subscribe, '201'), ['webhook.id', 'secret'])
    const unsubscribe = operation('/api/v1/webhooks/{id}', 'delete')
    expect(unsubscribe.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'id', in: 'path' })]),
    )
    expect(unsubscribe.responses['204']).toBeDefined()
  })
  it('documents API error codes for failed authentication', () => {
    fields(response(operation('/api/v1/me', 'get'), '401'), ['error'])
  })
  it('the contract assertion catches a removed field or endpoint', () => {
    expect(() => fields({ type: 'object', properties: {} } as Schema, ['id'])).toThrow(
      'Undocumented field',
    )
    expect(() => operation('/api/v1/no-such-zapier-endpoint', 'post')).toThrow(
      'Undocumented endpoint',
    )
  })
})
