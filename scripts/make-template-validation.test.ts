import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { WEBHOOK_EVENTS } from '@hourmere/webhooks'
import { describe, expect, it } from 'vitest'
import { openApiDocument } from '../apps/server/src/openapi-document.ts'
import {
  validateMakeInventory,
  validateMakeRecipe,
  validateMakeReferences,
} from './make-template-validation.ts'

const directory = new URL('../tools/make-templates/', import.meta.url)
const names = readdirSync(directory).filter((name) => name.endsWith('.json'))
const source = readFileSync(new URL('./make-template-validation.ts', import.meta.url), 'utf8')
type Checker = typeof validateMakeRecipe
const document = {
  paths: {
    '/api/v1/webhooks': { post: {} },
  },
}
const recipe = {
  format: 'hourmere.make.manual-recipe.v1',
  id: 'synthetic',
  title: 'Synthetic test recipe',
  webhookEvents: ['booking.created'],
  requests: [{ method: 'POST', path: '/api/v1/webhooks' }],
  connections: [],
  settings: {
    documentation: 'synthetic.md',
    apiKeyScope: 'full',
    signatureVerification: 'required',
  },
}

function verify(check: Checker) {
  expect(check(recipe, document, WEBHOOK_EVENTS)).toEqual([])
  expect(
    check({ ...recipe, url: 'https://hourmere.example.com' }, document, WEBHOOK_EVENTS),
  ).toEqual([])
  expect(check({ ...recipe, secret: '{{WEBHOOK_SECRET}}' }, document, WEBHOOK_EVENTS)).toEqual([])
  const negatives: [unknown, string][] = [
    [{ ...recipe, title: 'hm_synthetic_not_a_real_key' }, 'embedded credential'],
    [{ ...recipe, title: 'whsec_synthetic_not_a_real_secret' }, 'embedded credential'],
    [{ ...recipe, title: 'Bearer synthetic_not_a_real_token' }, 'embedded credential'],
    [
      { ...recipe, nested: { secret: 'synthetic-value' } },
      'credential field must be a placeholder',
    ],
    [
      { ...recipe, nested: { apiKey: 'synthetic-value' } },
      'credential field must be a placeholder',
    ],
    [{ ...recipe, url: 'https://hooks.make.com/synthetic' }, 'non-placeholder URL'],
    [{ ...recipe, url: 'https://example.com.attacker.test/synthetic' }, 'non-placeholder URL'],
    [{ ...recipe, url: 'https://user:synthetic@example.com/' }, 'non-placeholder URL'],
    [{ ...recipe, format: 'make-blueprint' }, 'invalid manual recipe shape'],
    [{ ...recipe, requests: [] }, 'missing REST references'],
    [
      { ...recipe, requests: [{ method: 'DELETE', path: '/api/v1/webhooks' }] },
      'unknown REST method/path',
    ],
    [
      { ...recipe, requests: [{ method: 'POST', path: '/api/v1/unknown' }] },
      'unknown REST method/path',
    ],
    [{ ...recipe, webhookEvents: ['booking.unknown'] }, 'unknown webhook event'],
    [{ ...recipe, title: 'Trigger booking.unknown' }, 'unknown inline webhook event'],
    [{ ...recipe, title: 'Call /api/v1/unknown' }, 'unknown inline REST path'],
  ]
  for (const [value, error] of negatives) {
    expect(check(value, document, WEBHOOK_EVENTS), error).toContain(error)
  }
}

function sourceCopy(copy: string) {
  const body = stripTypeScriptTypes(copy).replace(/^export /gm, '')
  return new Function(`${body}\nreturn { validateMakeRecipe, validateMakeInventory }`)() as {
    validateMakeRecipe: Checker
    validateMakeInventory: typeof validateMakeInventory
  }
}

function verifyInventory(check: typeof validateMakeInventory) {
  const required = [
    'booking-created-sheets.recipe.json',
    'booking-cancelled-slack.recipe.json',
    'find-slots-create-booking.recipe.json',
  ]
  expect(check(required)).toEqual([])
  for (const name of required)
    expect(check(required.filter((entry) => entry !== name))).toEqual([name])
  expect(check([])).toHaveLength(3)
}

describe('Make manual recipe artifacts', () => {
  it('requires all three recipes and parses every JSON against the generated API and event registry', async () => {
    expect(validateMakeInventory(names)).toEqual([])
    const generated = (await openApiDocument()) as Parameters<Checker>[1]
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.md'))) {
      expect(
        validateMakeReferences(
          readFileSync(new URL(name, directory), 'utf8'),
          generated,
          WEBHOOK_EVENTS,
        ),
        name,
      ).toEqual([])
    }
    for (const name of names) {
      const value = JSON.parse(readFileSync(new URL(name, directory), 'utf8'))
      expect(validateMakeRecipe(value, generated, WEBHOOK_EVENTS), name).toEqual([])
      expect(existsSync(new URL(value.settings.documentation, directory)), name).toBe(true)
    }
  })

  it('rejects credentials, real destinations, invalid formats and unknown API/event references', () => {
    verify(validateMakeRecipe)
    verifyInventory(validateMakeInventory)
  })
})

describe('source-copy Make validator mutation checks', () => {
  it('passes the same assertions using unchanged source', () => {
    const check = sourceCopy(source)
    verify(check.validateMakeRecipe)
    verifyInventory(check.validateMakeInventory)
  })

  for (const error of [
    'embedded credential',
    'credential field must be a placeholder',
    'non-placeholder URL',
    'missing REST references',
    'unknown REST method/path',
    'unknown webhook event',
    'unknown inline webhook event',
    'unknown inline REST path',
  ]) {
    it(`kills removal of ${error}`, () => {
      const mutant = source.replace(`errors.push('${error}')`, 'errors.push()')
      expect(mutant).not.toBe(source)
      expect(() => verify(sourceCopy(mutant).validateMakeRecipe)).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    })
  }
  it('kills removal of the manual-format marker check', () => {
    const mutant = source.replace("recipe?.format !== 'hourmere.make.manual-recipe.v1'", 'false')
    expect(mutant).not.toBe(source)
    expect(() => verify(sourceCopy(mutant).validateMakeRecipe)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('kills removal of the nonempty inventory check', () => {
    const mutant = source.replace('!names.includes(name)', 'false')
    expect(mutant).not.toBe(source)
    expect(() => verifyInventory(sourceCopy(mutant).validateMakeInventory)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
