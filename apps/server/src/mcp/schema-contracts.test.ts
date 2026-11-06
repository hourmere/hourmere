import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { getOpenApiMetadata } from '@asteasolutions/zod-to-openapi'
import { createRoute, z } from '@hono/zod-openapi'
import * as core from '@hourmere/core'
import type { Db } from '@hourmere/db'
import * as scheduling from '@hourmere/scheduling'
import { Ajv } from 'ajv'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import * as openapi from '../openapi.ts'
import * as schemas from '../routes/event-types.ts'
import { productTools } from '../server.ts'
import * as teamManagement from '../team-management.ts'
import { prepareTools } from './tools.ts'

type JsonSchema = Record<string, unknown>
type Adapt = (ctx: { zodSchema: unknown; jsonSchema: JsonSchema }) => void

// Discovery behavior before redirect configuration: descriptions and examples are
// documentation; constraints come from zod, and response objects remain additive.
const previousDiscovery: Adapt = ({ zodSchema, jsonSchema }) => {
  const meta = getOpenApiMetadata(zodSchema as z.ZodType)
  if (typeof meta.description === 'string') jsonSchema.description = meta.description
  if (meta.example !== undefined) jsonSchema.examples = [meta.example]
  if (typeof jsonSchema.format === 'string') delete jsonSchema.pattern
  const def = (zodSchema as { _zod?: { def?: { type?: string; catchall?: unknown } } })._zod?.def
  if (def?.type === 'object' && def.catchall === undefined) {
    if (jsonSchema.additionalProperties === false) delete jsonSchema.additionalProperties
  }
}

function withoutRedirect(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRedirect)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'properties' && child && typeof child === 'object'
        ? withoutRedirect(
            Object.fromEntries(
              Object.entries(child).filter(([name]) => name !== 'successRedirect'),
            ),
          )
        : key === 'required' && Array.isArray(child)
          ? child.filter((name) => name !== 'successRedirect')
          : withoutRedirect(child),
    ]),
  )
}

function assertExistingDiscovery(adapt?: Adapt) {
  // No handlers run, so no connection pools or real provider dependencies are created.
  for (const prepared of prepareTools(productTools({ db: {} as Db, slotSnippetsEnabled: true }))) {
    for (const io of ['input', 'output'] as const) {
      for (const target of ['draft-7', 'draft-2020-12'] as const) {
        const schema = prepared.tool[io]
        const options = { target, io, unrepresentable: 'any' as const }
        const expected = z.toJSONSchema(schema, { ...options, override: previousDiscovery })
        const advertised = (io === 'input' ? prepared.inputSchema : prepared.outputSchema)[
          '~standard'
        ].jsonSchema[io]({ target: target === 'draft-7' ? 'draft-07' : target })
        const actual = adapt ? z.toJSONSchema(schema, { ...options, override: adapt }) : advertised
        expect(withoutRedirect(actual), `${prepared.tool.name} ${io} ${target}`).toEqual(
          withoutRedirect(expected),
        )
      }
    }
  }
}

function adapterSourceCopy(change?: readonly [string, string]): Adapt {
  const source = readFileSync('apps/server/src/mcp/tools.ts', 'utf8')
  const body = source.slice(
    source.indexOf('function adaptJsonSchema('),
    source.indexOf('/**\n * A zod schema'),
  )
  if (change) expect(body).toContain(change[0])
  return new Function(
    'getOpenApiMetadata',
    `${stripTypeScriptTypes(change ? body.replace(...change) : body)}; return adaptJsonSchema`,
  )(getOpenApiMetadata) as Adapt
}

function inputSourceCopy(change?: readonly [string, string]) {
  let source = readFileSync('apps/server/src/routes/event-types.ts', 'utf8')
  if (change) {
    expect(source).toContain(change[0])
    source = source.replace(...change)
  }
  const bindings = { createRoute, z, ...core, ...scheduling, ...openapi, ...teamManagement }
  return new Function(
    ...Object.keys(bindings),
    `${stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(/\bexport /g, '')}; return { EventTypeInput, EventTypeUpdate }`,
  )(...Object.values(bindings)) as Pick<typeof schemas, 'EventTypeInput' | 'EventTypeUpdate'>
}

function assertInternationalRedirects({
  EventTypeInput: input,
  EventTypeUpdate: update,
}: Pick<typeof schemas, 'EventTypeInput' | 'EventTypeUpdate'> = schemas) {
  const url = input.shape.successRedirect.unwrap().unwrap().shape.url
  expect(getOpenApiMetadata(url)).not.toHaveProperty('format')
  expect(getOpenApiMetadata(url)).toMatchObject({
    maxLength: scheduling.SUCCESS_REDIRECT_MAX_LENGTH,
  })
  const ajv = new Ajv({ strict: false, validateFormats: true })
  addFormats.default(ajv)
  const uri = ajv.compile({ type: 'string', format: 'uri' })
  for (const prepared of prepareTools(productTools({ db: {} as Db, slotSnippetsEnabled: true }))) {
    if (!['create_event_type', 'update_event_type'].includes(prepared.tool.name)) continue
    const tool = {
      ...prepared.tool,
      input: prepared.tool.name === 'create_event_type' ? input : update.extend({ id: z.uuid() }),
    }
    const advertised = prepareTools([tool])[0]?.inputSchema['~standard'].jsonSchema.input({
      target: 'draft-07',
    })
    const validate = ajv.compile(advertised as JsonSchema)
    for (const target of [
      'https://bücher.example/thanks',
      'https://target.example/路径',
      'https://bücher.example/路径?q=%zz&flag#完成',
    ]) {
      // Proves this client really enforces URI formats, including Unicode exclusion.
      expect(uri(target)).toBe(false)
      const arguments_ = {
        ...(prepared.tool.name === 'create_event_type'
          ? { slug: 'intro', title: 'Intro', durationMinutes: 30 }
          : { id: '00000000-0000-7000-8000-000000000001' }),
        successRedirect: { url: target },
      }
      expect(validate(arguments_), JSON.stringify(validate.errors)).toBe(true)
      expect(tool.input.safeParse(arguments_).success).toBe(true)
    }
  }
}

describe('MCP discovery schema compatibility', () => {
  it('keeps every existing input and output schema unchanged outside redirect fields', () => {
    assertExistingDiscovery()
    assertExistingDiscovery(adapterSourceCopy())
  })

  it.each(['format', 'maxLength', 'uniqueItems', 'default'])(
    'detects globally copying %s OpenAPI metadata into discovery',
    (key) => {
      const adapt = adapterSourceCopy([
        '  const meta = getOpenApiMetadata(ctx.zodSchema as z.ZodType)',
        `  const meta = getOpenApiMetadata(ctx.zodSchema as z.ZodType)\n  if (meta.${key} !== undefined) ctx.jsonSchema.${key} = structuredClone(meta.${key})`,
      ])
      expect(() => assertExistingDiscovery(adapt)).toThrowError(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    },
  )

  it('accepts IDN hosts and Unicode paths with client JSON Schema format validation enabled', () => {
    assertInternationalRedirects()
    assertInternationalRedirects(inputSourceCopy())
  })

  it('detects reintroducing URI format metadata on the redirect input', () => {
    const input = inputSourceCopy([
      '    maxLength: SUCCESS_REDIRECT_MAX_LENGTH,',
      "    maxLength: SUCCESS_REDIRECT_MAX_LENGTH,\n    format: 'uri',",
    ])
    expect(() => assertInternationalRedirects(input)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
