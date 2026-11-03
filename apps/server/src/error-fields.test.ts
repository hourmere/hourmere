import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { z } from '@hono/zod-openapi'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { errorAliases } from './error-aliases.ts'
import { ErrorBody } from './openapi.ts'
import { openApiDocument } from './openapi-document.ts'
import { SUCCESS_REDIRECT_ERROR_FIELDS } from './success-redirect-errors.ts'

function verifyFields(schema: typeof ErrorBody) {
  for (const field of [...SUCCESS_REDIRECT_ERROR_FIELDS, 'futureFeature.options[0].name']) {
    const response = { error: 'invalid_request', field }
    expect(schema.safeParse(response).success).toBe(true)
    expect(schema.parse(response)).toEqual(response)
  }
  expect(schema.safeParse({ error: 'invalid_request' }).success).toBe(true)
  expect(schema.parse({ error: 'invalid_request' })).toEqual({ error: 'invalid_request' })
}

function sourceCopy(change?: readonly [string, string]): typeof ErrorBody {
  const original = readFileSync(new URL('./openapi.ts', import.meta.url), 'utf8')
  let source = original.slice(
    original.indexOf('export const ErrorAlias'),
    original.indexOf('export const json'),
  )
  if (change) {
    expect(source).toContain(change[0])
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source).replace(/\bexport /g, '')
  return new Function(
    'z',
    'errorAliases',
    'SUCCESS_REDIRECT_ERROR_FIELDS',
    `${source}; return ErrorBody`,
  )(z, errorAliases, SUCCESS_REDIRECT_ERROR_FIELDS)
}

describe('additive validation error fields', () => {
  it('accepts known and future field names while keeping field optional', () => {
    verifyFields(ErrorBody)
    verifyFields(sourceCopy())
  })

  it('publishes an open string and documents how to handle future values', async () => {
    const document = (await openApiDocument()) as {
      components: { schemas: { Error: { properties: Record<string, object>; required: string[] } } }
    }
    const error = document.components.schemas.Error
    expect(error.properties.field).toEqual({
      type: 'string',
      description: expect.stringContaining(
        'New values may appear within /api/v1; ignore unknown values',
      ),
    })
    for (const field of SUCCESS_REDIRECT_ERROR_FIELDS) {
      expect(error.properties.field).toHaveProperty('description', expect.stringContaining(field))
    }
    expect(error.required).toEqual(['error'])
    const validate = new Ajv2020().compile(error.properties.field ?? {})
    expect(validate('futureFeature.options[0].name')).toBe(true)
  })

  it.each<readonly [string, string]>([
    ['field: z\n      .string()', 'field: z\n      .enum(SUCCESS_REDIRECT_ERROR_FIELDS)'],
    ['.string()\n      .optional()', '.string()'],
  ])('detects a closed or required field in a source copy: %s', (from, to) => {
    const changed = sourceCopy([from, to])
    expect(() => verifyFields(changed)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    verifyFields(sourceCopy())
  })
})
