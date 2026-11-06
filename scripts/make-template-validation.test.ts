import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { WEBHOOK_EVENTS } from '@hourmere/webhooks'
import { describe, expect, it } from 'vitest'
import { openApiDocument } from '../apps/server/src/openapi-document.ts'
import * as validator from './make-template-validation.ts'

const directory = new URL('../tools/make-templates/', import.meta.url)
const names = readdirSync(directory)
const source = readFileSync(new URL('./make-template-validation.ts', import.meta.url), 'utf8')
// Evaluate the literal used by the production notifier, rather than maintaining a second
// payload schema. Extraction fails closed if the builder's structure changes.
const deliverySource = readFileSync(
  new URL('../packages/webhooks/src/delivery.ts', import.meta.url),
  'utf8',
)
const payloadExpression = deliverySource.match(
  /const payload = JSON.stringify\(([\s\S]*?)\n {4}\}\)/,
)?.[1]
if (!payloadExpression) throw new Error('Webhook payload builder moved; update extraction')
const payload = new Function(
  'booking',
  'eventId',
  'eventType',
  'now',
  `return (${payloadExpression}\n})`,
)(
  {
    id: 'id',
    organization_id: 'org',
    event_type_id: 'event',
    start_at: new Date(0),
    end_at: new Date(0),
    status: 'confirmed',
    source: 'web',
    rescheduled_from_id: null,
  },
  'event-id',
  'booking.created',
  { toString: () => 'instant' },
)
function fields(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return child && typeof child === 'object'
      ? [path, ...fields(child as Record<string, unknown>, path)]
      : [path]
  })
}
const payloadFields = [
  ...fields(payload),
  ...[...deliverySource.matchAll(/'(webhook-[a-z-]+)':/g)].map((match) => `headers.${match[1]}`),
]
const document = {
  paths: {
    '/api/v1/webhooks': {
      post: {
        parameters: [
          { in: 'query', name: 'limit' },
          { in: 'header', name: 'Idempotency-Key' },
        ],
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Body' } } },
        },
        responses: {
          '201': {
            content: {
              'application/json': {
                schema: {
                  allOf: [{ properties: { data: { items: { properties: { id: {} } } } } }],
                },
              },
            },
          },
        },
      },
    },
  },
  components: { schemas: { Body: { properties: { invitee: { properties: { name: {} } } } } } },
}
const request = {
  method: 'POST',
  path: '/api/v1/webhooks',
  body: ['invitee.name'],
  query: ['limit'],
  headers: ['idempotency-key'],
  response: { '201': ['data.id'] },
}
const recipe = {
  format: 'hourmere.make.manual-recipe.v1',
  id: 'synthetic',
  title: 'Synthetic',
  webhookEvents: ['booking.created'],
  webhookPayloadFields: ['data.bookingId'],
  requests: [request],
  connections: [],
  settings: { documentation: 'synthetic.md' },
}
const fence = (value: unknown) => `\n\`\`\`hourmere-fields\n${JSON.stringify(value)}\n\`\`\`\n`
const secretCases = [
  ['hm_synthetic_not_real', 'embedded API key'],
  ['whsec_synthetic_not_real', 'embedded webhook secret'],
  [`whsec_${'A'.repeat(43)}`, 'embedded webhook secret'],
  ['Bearer synthetic_not_real', 'embedded bearer token'],
  ['https://hook.us1.make.com/synthetic', 'embedded Make hook URL'],
  ['hook.us1.make.com/synthetic', 'embedded Make hook URL'],
  ['https://user:synthetic@example.com/', 'non-placeholder URL'],
  ['https://example.com.attacker.test/', 'non-placeholder URL'],
  ['https://[invalid', 'invalid URL'],
] as const
function verify(check: typeof validator) {
  expect(check.validateMakeRecipe(recipe, document, WEBHOOK_EVENTS, payloadFields)).toEqual([])
  expect(
    check.validateMakeRecipe(
      { ...recipe, secret: '<YOUR_WEBHOOK_SECRET>' },
      document,
      WEBHOOK_EVENTS,
      payloadFields,
    ),
  ).toEqual([])
  expect(
    check.validateMakeReferences(
      'Bearer <YOUR_API_KEY> https://help.make.com/blueprints',
      document,
      WEBHOOK_EVENTS,
      payloadFields,
    ),
  ).toEqual([])
  for (const [content, error] of secretCases) {
    expect(
      check.validateMakeRecipe(
        { ...recipe, title: content },
        document,
        WEBHOOK_EVENTS,
        payloadFields,
      ),
    ).toContain(error)
    expect(
      check.validateMakeReferences(content, document, WEBHOOK_EVENTS, payloadFields),
    ).toContain(error)
  }
  const negatives: [unknown, string][] = [
    [
      { ...recipe, requests: [{ ...request, body: { invitee: [{ nonexistentField: 1 }] } }] },
      'unknown request body field',
    ],
    [{ ...recipe, secret: 'synthetic' }, 'credential field must be a placeholder'],
    [{ ...recipe, format: 'blueprint' }, 'invalid manual recipe shape'],
    [{ ...recipe, requests: [] }, 'missing REST references'],
    [{ ...recipe, requests: [{ ...request, method: 'PUT' }] }, 'unknown REST method/path'],
    [
      { ...recipe, requests: [{ ...request, body: { invitee: { phoneNumber: 'synthetic' } } }] },
      'unknown request body field',
    ],
    [
      { ...recipe, requests: [{ ...request, query: ['nonexistentField'] }] },
      'unknown request parameter',
    ],
    [
      { ...recipe, requests: [{ ...request, headers: ['nonexistentField'] }] },
      'unknown request parameter',
    ],
    [
      { ...recipe, requests: [{ ...request, response: { '201': ['data.nonexistentField'] } }] },
      'unknown response field',
    ],
    [
      { ...recipe, webhookPayloadFields: ['data.nonexistentField'] },
      'unknown webhook payload field',
    ],
    [{ ...recipe, webhookEvents: ['booking.unknown'] }, 'unknown webhook event'],
  ]
  for (const [value, error] of negatives)
    expect(check.validateMakeRecipe(value, document, WEBHOOK_EVENTS, payloadFields)).toContain(
      error,
    )
  const markdown: [string, string][] = [
    ['booking.unknown', 'unknown inline webhook event'],
    ['`Webhook-Nonexistent`', 'unknown webhook header'],
    ['{{data.nonexistentField}}', 'unknown mapped payload field'],
    [
      `${fence({ requests: [request] })}\n\`\`\`json\n{"nonexistentField":1}\n\`\`\``,
      'unknown JSON example field',
    ],
    ['```json\nINVALID\n```', 'invalid JSON example'],
    ['/api/v1/unknown', 'unknown inline REST path'],
    ['PUT /api/v1/webhooks', 'unknown inline REST method'],
    ['Method `DELETE`; URL\n `{{BASE_URL}}/api/v1/webhooks`', 'unknown module REST method'],
    [
      `${fence({ requests: [request] })}| Field | Type | Mapping |\n| --- | --- | --- |\n| \`invitee.phoneNumber\` | Text | Input |\n\n`,
      'unknown body table field',
    ],
    [
      fence({ requests: [{ ...request, body: ['invitee.phoneNumber'] }] }),
      'unknown request body field',
    ],
    [`${fence({ requests: [request] })}\`body:invitee.phoneNumber\``, 'unknown request body field'],
    [`${fence({ requests: [request] })}\`query:nonexistentField\``, 'unknown request parameter'],
    [
      `${fence({ requests: [request] })}\`response:201:data.nonexistentField\``,
      'unknown response field',
    ],
    ['`payload:data.nonexistentField`', 'unknown webhook payload field'],
    ['`body:invitee.name`', 'ambiguous inline field context'],
    ['```hourmere-fields\nnot json\n```', 'invalid field declaration'],
  ]
  for (const [raw, error] of markdown)
    expect(check.validateMakeReferences(raw, document, WEBHOOK_EVENTS, payloadFields)).toContain(
      error,
    )
  expect(check.validateMakeInventory(names)).toEqual([])
  expect(check.validateMakeInventory([])).toHaveLength(3)
}
function sourceCopy(copy: string): typeof validator {
  const body = stripTypeScriptTypes(copy).replace(/^export /gm, '')
  return new Function(
    `${body}\nreturn { validateMakeRecipe, validateMakeReferences, validateMakeInventory, validateMakeSecrets, validateMakeFields }`,
  )()
}

describe('Make manual recipe artifacts', () => {
  it('validates every manifest, recipe, README and site page against real sources', async () => {
    const generated = (await openApiDocument()) as Parameters<
      typeof validator.validateMakeRecipe
    >[1]
    expect(validator.validateMakeInventory(names)).toEqual([])
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const value = JSON.parse(readFileSync(new URL(name, directory), 'utf8'))
      expect(
        validator.validateMakeRecipe(value, generated, WEBHOOK_EVENTS, payloadFields),
        name,
      ).toEqual([])
      expect(existsSync(new URL(value.settings.documentation, directory))).toBe(true)
    }
    const documents = names
      .filter((entry) => entry.endsWith('.md'))
      .map((name) => new URL(name, directory))
    documents.push(new URL('../apps/site/src/content/docs/docs/make.md', import.meta.url))
    for (const url of documents) {
      const raw = readFileSync(url, 'utf8')
      expect(
        validator.validateMakeReferences(raw, generated, WEBHOOK_EVENTS, payloadFields),
        url.pathname,
      ).toEqual([])
      for (const [secret, error] of secretCases) {
        expect(
          validator.validateMakeReferences(
            `${raw}\n${secret}`,
            generated,
            WEBHOOK_EVENTS,
            payloadFields,
          ),
          url.pathname,
        ).toContain(error)
      }
    }
  })
  it('rejects mutations in the actual Markdown instructions with declarations unchanged', async () => {
    const generated = (await openApiDocument()) as Parameters<
      typeof validator.validateMakeRecipe
    >[1]
    const booking = readFileSync(new URL('find-slots-create-booking.md', directory), 'utf8')
    const slack = readFileSync(new URL('booking-cancelled-slack.md', directory), 'utf8')
    const readme = readFileSync(new URL('README.md', directory), 'utf8')
    const site = readFileSync(
      new URL('../apps/site/src/content/docs/docs/make.md', import.meta.url),
      'utf8',
    )
    const mutations = [
      [
        booking,
        booking.replace('query:durationMinutes', 'query:nonexistentField'),
        'unknown request parameter',
      ],
      [
        booking,
        booking.replace('response:200:data.start', 'response:200:data.nonexistentField'),
        'unknown response field',
      ],
      [
        readme,
        readme.replace('payload:data.bookingId', 'payload:data.nonexistentField'),
        'unknown webhook payload field',
      ],
      [booking, booking.replace('Method `GET`', 'Method `DELETE`'), 'unknown module REST method'],
      [
        booking,
        booking.replace('| `body:invitee.name`', '| `invitee.phoneNumber`'),
        'unknown body table field',
      ],
      [
        slack,
        slack.replace('{{data.bookingId}}', '{{data.nonexistentField}}'),
        'unknown mapped payload field',
      ],
      [
        readme,
        readme.replace('"isActive": false', '"nonexistentField": false'),
        'unknown JSON example field',
      ],
      [
        site,
        site.replace('POST /api/v1/webhooks', 'PUT /api/v1/webhooks'),
        'unknown inline REST method',
      ],
    ]
    for (const [original, mutated, error] of mutations) {
      expect(mutated).not.toBe(original)
      expect(
        validator.validateMakeReferences(mutated ?? '', generated, WEBHOOK_EVENTS, payloadFields),
      ).toContain(error)
    }
  })
  it('rejects bad credentials, methods, parameters and nested fields in JSON and Markdown', () =>
    verify(validator))
})

describe('source-copy Make validator mutation checks', () => {
  it('passes unchanged source', () => verify(sourceCopy(source)))
  for (const error of [
    'embedded API key',
    'embedded webhook secret',
    'embedded bearer token',
    'embedded Make hook URL',
    'non-placeholder URL',
    'invalid URL',
    'credential field must be a placeholder',
    'missing REST references',
    'unknown REST method/path',
    'unknown request parameter',
    'unknown request body field',
    'unknown response field',
    'unknown webhook payload field',
    'unknown webhook event',
    'unknown inline webhook event',
    'unknown inline REST path',
    'unknown inline REST method',
    'ambiguous inline field context',
    'unknown module REST method',
    'unknown body table field',
    'unknown webhook header',
    'unknown mapped payload field',
    'unknown JSON example field',
    'invalid JSON example',
    'invalid field declaration',
  ]) {
    it(`kills removal of ${error}`, () => {
      const mutant = source.replace(`errors.push('${error}')`, 'errors.push()')
      expect(mutant).not.toBe(source)
      expect(() => verify(sourceCopy(mutant))).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    })
  }
  for (const [label, original, replacement] of [
    ['manual format', "recipe?.format !== 'hourmere.make.manual-recipe.v1'", 'false'],
    ['inventory', '!names.includes(name)', 'false'],
    ['array object fields', '...child.flatMap(', '...([] as unknown[]).flatMap('],
    ['bare hook host', '/\\b(?:hook[s]?\\.)', '/https?:\\/\\/(?:hook[s]?\\.)'],
  ]) {
    it(`kills removal of ${label}`, () => {
      const mutant = source.replace(original as string, replacement as string)
      expect(mutant).not.toBe(source)
      expect(() => verify(sourceCopy(mutant))).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    })
  }
})
