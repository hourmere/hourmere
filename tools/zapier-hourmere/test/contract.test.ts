import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import Ajv, { type AnySchemaObject } from 'ajv'
import addFormats from 'ajv-formats'
import { beforeAll, describe, expect, it } from 'vitest'
import { openApiDocument } from '../../../apps/server/src/openapi-document.ts'

const require = createRequire(import.meta.url)
const app = require(process.env.HOURMERE_ZAPIER_TEST_APP || '../index.js')
type Schema = AnySchemaObject
type Operation = {
  parameters?: { name: string; in: string; required?: boolean; schema: Schema }[]
  requestBody?: { content: { 'application/json': { schema: Schema } } }
  responses: Record<string, { content?: { 'application/json'?: { schema: Schema } } }>
}
type Document = {
  paths: Record<string, Record<string, Operation>>
  components: { schemas: Record<string, Schema> }
}
const id = '00000000-0000-4000-8000-000000000001'
let document: Document
const ajv = new Ajv({ strict: false, allErrors: true })
addFormats(ajv)
beforeAll(async () => {
  document = (await openApiDocument()) as Document
})

function resolve(schema: Schema): Schema {
  if (schema.$ref) {
    const referred = document.components.schemas[schema.$ref.split('/').at(-1)]
    assert(referred, `Unresolved schema: ${schema.$ref}`)
    return resolve(referred)
  }
  return schema
}
function validate(schema: Schema, data: unknown, context: string) {
  const check = ajv.compile({ ...schema, components: document.components })
  expect(check(data), `${context}: ${ajv.errorsText(check.errors)}`).toBe(true)
}

// The server document supplies response fields as well as request validation. There is
// no second endpoint/field list to keep in sync with the app. These synthetic responses
// exercise property reads; an app-side typo or a server-side removal fails immediately.
function sample(schema: Schema, nullable: boolean): unknown {
  schema = resolve(schema)
  if (schema.allOf)
    return Object.assign({}, ...schema.allOf.map((s: Schema) => sample(s, nullable)))
  if (schema.anyOf || schema.oneOf) return sample((schema.anyOf ?? schema.oneOf)[0], nullable)
  if (schema.enum) return schema.enum[0]
  if (schema.const !== undefined) return schema.const
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  if (nullable && types.includes('null')) return null
  if (types.includes('object') || schema.properties)
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, value]) => [
        key,
        sample(value as Schema, nullable),
      ]),
    )
  if (types.includes('array')) return [sample(schema.items, nullable)]
  if (types.includes('boolean')) return false
  if (types.includes('integer') || types.includes('number')) return schema.minimum ?? 1
  if (types.includes('null') && types.length === 1) return null
  if (schema.format === 'uuid') return id
  if (schema.format === 'date-time') return '2026-12-02T10:00:00Z'
  if (schema.format === 'email') return 'invitee@example.test'
  if (schema.format === 'uri') return 'https://example.test/'
  return schema.example ?? 'synthetic'
}
function checkedResponse(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(checkedResponse)
  return new Proxy(
    Object.fromEntries(Object.entries(value).map(([k, v]) => [k, checkedResponse(v)])),
    {
      get(target, key, receiver) {
        // Promise resolution probes then; this is not an application response field.
        if (typeof key === 'string' && key !== 'then')
          expect(key in target, `Undocumented response field: ${key}`).toBe(true)
        return Reflect.get(target, key, receiver)
      },
    },
  )
}

type Request = {
  url: string
  method?: string
  headers?: Record<string, string>
  params?: Record<string, unknown>
  body?: unknown
}
function requestContract(request: Request, nullable: boolean) {
  const url = new URL(request.url)
  const match = Object.entries(document.paths).find(([path]) =>
    new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(url.pathname),
  )
  assert(match, `Undocumented endpoint: ${url.pathname}`)
  const [path, methods] = match
  const op = methods[(request.method ?? 'GET').toLowerCase()]
  assert(op, `Undocumented method: ${request.method} ${path}`)
  const parameters = op.parameters ?? []
  const query = { ...Object.fromEntries(url.searchParams), ...request.params }
  for (const key of Object.keys(query))
    expect(
      parameters.some((p) => p.in === 'query' && p.name === key),
      `Undocumented query: ${key}`,
    ).toBe(true)
  const headers = Object.fromEntries(
    Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  )
  for (const key of Object.keys(headers).filter(
    (key) => !['authorization', 'content-type'].includes(key),
  ))
    expect(
      parameters.some((p) => p.in === 'header' && p.name.toLowerCase() === key),
      `Undocumented header: ${key}`,
    ).toBe(true)
  const pathValues = Object.fromEntries(
    path
      .split('/')
      .flatMap((part, i) =>
        part.startsWith('{')
          ? [[part.slice(1, -1), decodeURIComponent(url.pathname.split('/')[i] ?? '')]]
          : [],
      ),
  )
  for (const parameter of parameters) {
    const value =
      parameter.in === 'query'
        ? query[parameter.name]
        : parameter.in === 'path'
          ? pathValues[parameter.name]
          : headers[parameter.name.toLowerCase()]
    if (parameter.required)
      expect(value, `Missing ${parameter.in}: ${parameter.name}`).toBeDefined()
    if (value !== undefined) validate(parameter.schema, value, `${parameter.in}: ${parameter.name}`)
  }
  const bodySchema = op.requestBody?.content['application/json'].schema
  if (bodySchema) validate(bodySchema, request.body, `Request body ${path}`)
  else expect(request.body, `Undocumented request body ${path}`).toBeUndefined()
  const status = Object.keys(op.responses).find((code) => code.startsWith('2'))
  assert(status, `Missing successful response: ${path}`)
  const responseSchema = op.responses[status]?.content?.['application/json']?.schema
  const data = responseSchema ? sample(responseSchema, nullable) : undefined
  if (responseSchema) validate(responseSchema, data, `Response ${path}`)
  return { status: Number(status), data: checkedResponse(data), headers: new Headers() }
}

const inputData = {
  id,
  kind: 'personal',
  handle: 'ada',
  slug: 'intro',
  start: '2026-12-02T10:00:00Z',
  end: '2026-12-03T10:00:00Z',
  durationMinutes: 30,
  name: 'Invitee',
  email: 'invitee@example.test',
  timeZone: 'UTC',
  locale: 'en',
  idempotencyKey: '1ce709e0-5efe-4b13-bab7-d8457499bc18',
  responses: '{"question":"answer"}',
  reason: 'Changed plans',
}
const operations = [
  ['authentication', app.authentication.test],
  ...Object.entries(app.creates).map(([name, action]) => [
    name,
    (action as { operation: { perform: unknown } }).operation.perform,
  ]),
  ...Object.entries(app.searches).map(([name, action]) => [
    name,
    (action as { operation: { perform: unknown } }).operation.perform,
  ]),
  ...Object.entries(app.triggers).flatMap(([name, trigger]) =>
    Object.entries((trigger as { operation: Record<string, unknown> }).operation)
      .filter(
        ([key]) =>
          ['performSubscribe', 'performUnsubscribe', 'performList'].includes(key) ||
          (name === 'event_types' && key === 'perform'),
      )
      .map(([key, fn]) => [`${name}.${key}`, fn]),
  ),
] as [string, (z: unknown, bundle: unknown) => Promise<unknown>][]

describe('real Zapier operations against generated OpenAPI schemas', () => {
  for (const kind of ['personal', 'team']) {
    it.each(operations)(
      `${kind}: %s sends a strict valid request and consumes documented responses`,
      async (_name, perform) => {
        for (const nullable of [false, true]) {
          let calls = 0
          const z = {
            request: async (request: Request) => {
              calls++
              return requestContract(request, nullable)
            },
          }
          await perform(z, {
            authData: { baseUrl: 'https://hourmere.example.test', apiKey: 'synthetic' },
            inputData: { ...inputData, kind },
            targetUrl: 'https://hooks.example.test/synthetic',
            subscribeData: { id, secret: 'synthetic' },
          })
          expect(calls).toBe(1)
        }
      },
    )
  }
})
