import { beforeAll, expect, it } from 'vitest'
import { openApiDocument } from '../../apps/server/src/openapi-document.ts'
import { WEBHOOK_EVENTS } from '../../packages/webhooks/src/service.ts'
import { EVENTS } from './nodes/HourmereTrigger/signature'

type Schema = {
  $ref?: string
  properties?: Record<string, Schema>
  items?: Schema
  enum?: string[]
}
type Operation = {
  parameters?: { in: string; name: string }[]
  requestBody?: { content: { 'application/json': { schema: Schema } } }
  responses: Record<string, { content?: { 'application/json': { schema: Schema } } }>
}
let document: {
  paths: Record<string, Record<string, Operation>>
  components: { schemas: Record<string, Schema> }
}
beforeAll(async () => {
  document = (await openApiDocument()) as typeof document
})
function required<T>(value: T | undefined, label: string): T {
  expect(value, label).toBeDefined()
  if (value === undefined) throw new Error(`Missing OpenAPI ${label}`)
  return value
}
function resolve(schema: Schema): Schema {
  if (!schema.$ref) return schema
  const name = required(schema.$ref.split('/').at(-1), 'reference name')
  return required(document.components.schemas[name], schema.$ref)
}
function operation(path: string, method: string): Operation {
  return required(document.paths[`/api/v1${path}`]?.[method], `${method} ${path}`)
}
function response(op: Operation, status = '200'): Schema {
  return required(op.responses[status]?.content?.['application/json']?.schema, `response ${status}`)
}
function request(op: Operation): Schema {
  return required(op.requestBody?.content['application/json'].schema, 'request body')
}
function fields(schema: Schema, names: string[]) {
  for (const path of names) {
    let current = schema
    for (const part of path.split('.')) {
      const value = resolve(current)
      current = required(part === '[]' ? value.items : value.properties?.[part], `field ${path}`)
      expect(current, `OpenAPI field ${path}`).toBeDefined()
    }
  }
}
it('keeps all action and credential endpoints and consumed fields in generated OpenAPI', () => {
  const get = operation
  get('/profile', 'get')
  fields(response(get('/event-types', 'get')), ['data'])
  const bookings = get('/bookings', 'get')
  for (const name of ['from', 'to', 'endAfter', 'endTo', 'cursor', 'status', 'order', 'limit'])
    expect(bookings.parameters).toContainEqual(expect.objectContaining({ in: 'query', name }))
  fields(response(bookings), ['data', 'nextCursor'])
  get('/bookings/{id}', 'get')
  fields(request(get('/bookings/{id}/cancel', 'post')), ['reason'])
  fields(request(get('/bookings/{id}/reschedule', 'post')), ['start', 'durationMinutes'])
  for (const prefix of ['/public', '/public/teams']) {
    const slots = get(`${prefix}/{handle}/{slug}/slots`, 'get')
    for (const name of ['handle', 'slug', 'start', 'end', 'durationMinutes'])
      expect(slots.parameters).toContainEqual(expect.objectContaining({ name }))
    fields(response(slots), ['data.[].start', 'data.[].end'])
    const create = get(`${prefix}/{handle}/{slug}/bookings`, 'post')
    expect(create.parameters).toContainEqual(
      expect.objectContaining({ name: 'idempotency-key', in: 'header' }),
    )
    fields(request(create), [
      'start',
      'durationMinutes',
      'invitee.name',
      'invitee.email',
      'invitee.timeZone',
      'responses',
      'guests.[].name',
      'guests.[].email',
    ])
  }
})
it('matches the server webhook event source of truth', () => {
  expect([...EVENTS]).toEqual([...WEBHOOK_EVENTS])
})
it('keeps trigger registration and lifecycle contracts in generated OpenAPI', () => {
  const list = operation('/webhooks', 'get')
  fields(response(list), ['[].id', '[].url', '[].events', '[].isActive'])
  const create = operation('/webhooks', 'post')
  const body = request(create)
  fields(body, ['url', 'events', 'isActive'])
  expect(
    resolve(required(required(resolve(body).properties?.events, 'events').items, 'event items'))
      .enum,
  ).toEqual([...EVENTS])
  fields(response(create, '201'), ['webhook.id', 'secret'])
  operation('/webhooks/{id}', 'delete')
})
