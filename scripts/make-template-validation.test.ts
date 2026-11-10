import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Db } from '@hourmere/db'
import {
  deliverWebhook,
  WEBHOOK_EVENTS,
  webhookAttendeeNoShowNotifier,
  webhookBookingNotifier,
} from '@hourmere/webhooks'
import {
  type CompiledQuery,
  type DatabaseConnection,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely'
import { describe, expect, it } from 'vitest'
import { openApiDocument } from '../apps/server/src/openapi-document.ts'
import { encryptWebhookSecret, newWebhookSecret } from '../packages/webhooks/src/crypto.ts'
import * as validator from './make-template-validation.ts'

const directory = new URL('../tools/make-templates/', import.meta.url)
const names = readdirSync(directory)
const source = readFileSync(new URL('./make-template-validation.ts', import.meta.url), 'utf8')

// Payload fields come from running the production notifiers and delivery job, not from a
// second schema or from parsing their source. Only the database driver is replaced: every
// query is compiled by Kysely's PostgreSQL compiler and answered with synthetic rows. Each
// change runs in every booking state below. An unexpected query, a bookings column without a
// synthetic value, or a capture that does not insert exactly one delivery fails closed.
type Row = Record<string, unknown>
function syntheticDb(answer: (query: CompiledQuery) => Row[] | undefined): Db {
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery) {
      const rows = answer(query)
      if (!rows)
        throw new Error(`Unexpected webhook query; update the Make derivation: ${query.sql}`)
      return { rows: rows as R[] }
    },
    streamQuery(): never {
      throw new Error('Unexpected streamed webhook query')
    },
  }
  return new Kysely({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createDriver: () => ({
        init: async () => {},
        acquireConnection: async () => connection,
        beginTransaction: async () => {},
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
        releaseConnection: async () => {},
        destroy: async () => {},
      }),
    },
  })
}
function fieldPaths(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return child && typeof child === 'object'
      ? [path, ...fieldPaths(child as Record<string, unknown>, path)]
      : [path]
  })
}
const ids = {
  booking: '00000000-0000-4000-8000-000000000001',
  organization: '00000000-0000-4000-8000-000000000002',
  eventType: '00000000-0000-4000-8000-000000000003',
  predecessor: '00000000-0000-4000-8000-000000000004',
  endpoint: '00000000-0000-4000-8000-000000000005',
  delivery: '00000000-0000-4000-8000-000000000006',
  request: '00000000-0000-4000-8000-000000000007',
  attendee: '00000000-0000-4000-8000-000000000008',
  user: '00000000-0000-4000-8000-000000000009',
}
const now = Temporal.Instant.from('2026-11-09T12:00:00Z')
type BookingRow = {
  id: string
  organization_id: string
  event_type_id: string | null
  start_at: Date
  end_at: Date
  status: string
  source: string
  rescheduled_from_id: string | null
}
async function captureDelivery(row: BookingRow, notify: (trx: Db) => Promise<void>) {
  const deliveries: Row[] = []
  const db = syntheticDb(({ sql, parameters }) => {
    // isImportedBooking: the synthetic booking is not imported.
    if (/^\s*WITH RECURSIVE connected/.test(sql)) return []
    const select = sql.match(/^select (.+) from "bookings" where "id" = \$1$/)
    if (select) {
      // A column the row lacks would read as undefined and vanish from the JSON payload.
      const columns = (select[1] ?? '').split(', ').map((column) => column.replace(/^"|"$/g, ''))
      if (columns.sort().join() !== Object.keys(row).sort().join())
        throw new Error(
          `Webhook capture selects bookings columns ${columns.join(', ')}; update the Make derivation rows`,
        )
      return [row]
    }
    // Capture selects every subscribed destination kind; Make receives the signed webhook.
    if (/^select "id", "destination_kind" from "webhooks" where /.test(sql))
      return [{ id: ids.endpoint, destination_kind: 'webhook' }]
    const insert = sql.match(/^insert into "webhook_deliveries" \(([^)]+)\) values \(([^)]+)\)/)
    if (insert) {
      const columns = (insert[1] ?? '').split(', ').map((column) => column.replaceAll('"', ''))
      const values = (insert[2] ?? '')
        .split(', ')
        .map((value) => parameters[Number(value.slice(1)) - 1])
      deliveries.push(Object.fromEntries(columns.map((column, i) => [column, values[i]])))
      return [{ id: ids.delivery }]
    }
    return undefined
  })
  await db.transaction().execute(notify)
  if (deliveries.length !== 1)
    throw new Error('Webhook capture did not insert exactly one delivery')
  const delivery = deliveries[0] as { event_type: string; payload: string }
  const payload = JSON.parse(delivery.payload)
  if (payload.type !== delivery.event_type) throw new Error('Webhook payload type mismatch')
  return delivery
}
const settings = { enabled: true }
const queue = { enqueue: async () => 'synthetic-job' }
const lifecycle = webhookBookingNotifier(queue, settings)
const attendance = webhookAttendeeNoShowNotifier(queue, settings)
const start = Temporal.Instant.from('2026-11-16T10:00:00Z')
const marked = { noShowMarkedAt: now.toString(), noShowMarkedBy: ids.user }
const unmarked = { noShowMarkedAt: null, noShowMarkedBy: null }
// Meeting times relative to now (12:00Z) that a booking can have when a notifier runs.
const meetings = {
  upcoming: ['2026-11-16T10:00:00Z', '2026-11-16T10:30:00Z'],
  'in progress': ['2026-11-09T11:45:00Z', '2026-11-09T12:15:00Z'],
  ended: ['2026-11-09T11:00:00Z', '2026-11-09T11:30:00Z'],
} as const
type Timing = keyof typeof meetings
// Each change with the booking status and meeting times it can have when the notifier runs:
// cancellation updates the row first, and the other changes apply to confirmed bookings.
// Booking changes need an upcoming meeting, attendance needs a started one, and a reschedule
// request can expire before, during or after the meeting because its expiry is capped at the
// start but processed later.
const changes: [string, string, Timing[], (trx: Db) => Promise<void>][] = [
  [
    'created',
    'confirmed',
    ['upcoming'],
    (trx) => lifecycle(trx, { type: 'created', bookingId: ids.booking, start }, now),
  ],
  [
    'rescheduled',
    'confirmed',
    ['upcoming'],
    (trx) => lifecycle(trx, { type: 'rescheduled', bookingId: ids.booking, start }, now),
  ],
  [
    'cancelled',
    'cancelled',
    ['upcoming'],
    (trx) => lifecycle(trx, { type: 'cancelled', bookingId: ids.booking }, now),
  ],
  [
    'reschedule requested',
    'confirmed',
    ['upcoming'],
    (trx) =>
      lifecycle(
        trx,
        { type: 'reschedule_requested', bookingId: ids.booking, requestId: ids.request },
        now,
      ),
  ],
  [
    'reschedule request expired',
    'confirmed',
    ['upcoming', 'in progress', 'ended'],
    (trx) =>
      lifecycle(
        trx,
        { type: 'reschedule_request_expired', bookingId: ids.booking, requestId: ids.request },
        now,
      ),
  ],
  [
    'no-show marked',
    'confirmed',
    ['in progress', 'ended'],
    (trx) => attendance(trx, { bookingId: ids.booking, attendeeId: ids.attendee, ...marked }, now),
  ],
  [
    'no-show unmarked',
    'confirmed',
    ['in progress', 'ended'],
    (trx) =>
      attendance(trx, { bookingId: ids.booking, attendeeId: ids.attendee, ...unmarked }, now),
  ],
]
// Every source a webhook can carry (bookings_source_check; imported chains never emit), with
// and without a predecessor and an event type, at each meeting time the change allows.
const sources = ['web', 'embed', 'api', 'mcp']
const captured: Record<string, { cell: string; fields: string[]; payload: string }[]> = {}
for (const [change, status, timings, notify] of changes)
  for (const timing of timings)
    for (const source of sources)
      for (const predecessor of [null, ids.predecessor])
        for (const eventType of [null, ids.eventType]) {
          const delivery = await captureDelivery(
            {
              id: ids.booking,
              organization_id: ids.organization,
              event_type_id: eventType,
              start_at: new Date(meetings[timing][0]),
              end_at: new Date(meetings[timing][1]),
              status,
              source,
              rescheduled_from_id: predecessor,
            },
            notify,
          )
          const cell = `${change}, ${timing}, ${source}, predecessor ${predecessor ? 'set' : 'null'}, event type ${eventType ? 'set' : 'null'}`
          captured[delivery.event_type] ??= []
          captured[delivery.event_type]?.push({
            cell,
            fields: fieldPaths(JSON.parse(delivery.payload)),
            payload: delivery.payload,
          })
        }
// Headers come from one real delivery attempt through a capturing transport.
async function deliveryHeaders(eventType: string, payload: string) {
  const encryptionKey = Buffer.alloc(32, 7).toString('base64')
  let sent: Readonly<Record<string, string>> | undefined
  const db = syntheticDb(({ sql }) => {
    if (
      /^select "webhook_id", "destination_kind" from "webhook_deliveries" inner join "webhooks" on "webhooks"\."id" = "webhook_deliveries"\."webhook_id" where "webhook_deliveries"\."id" = \$1$/.test(
        sql,
      )
    )
      return [{ webhook_id: ids.endpoint, destination_kind: 'webhook' }]
    if (/^select \* from "webhooks" where "id" = \$1 for share$/.test(sql))
      return [
        {
          id: ids.endpoint,
          organization_id: ids.organization,
          destination_kind: 'webhook',
          event_type_id: null,
          url: 'https://receiver.example.com/hourmere',
          is_active: true,
          events: [eventType],
          secret_ciphertext: encryptWebhookSecret(
            newWebhookSecret(),
            encryptionKey,
            ids.endpoint,
            ids.organization,
          ),
        },
      ]
    if (/^select \* from "webhook_deliveries" where "id" = \$1 for update$/.test(sql))
      return [
        {
          id: ids.delivery,
          webhook_id: ids.endpoint,
          booking_id: null,
          event_id: ids.request,
          event_type: eventType,
          status: 'pending',
          attempts: 0,
          payload,
          created_at: new Date(now.epochMilliseconds),
        },
      ]
    if (/^update "webhook_deliveries" set /.test(sql)) return []
    return undefined
  })
  await deliverWebhook(
    {
      db,
      enabled: true,
      encryptionKey,
      now: () => now,
      transport: async ({ headers }) => {
        sent = headers
        return 204
      },
    },
    ids.delivery,
    new AbortController().signal,
  )
  if (!sent) throw new Error('Webhook delivery sent no request; update the Make derivation')
  return Object.keys(sent).map((name) => name.toLowerCase())
}
// A recipe may rely only on fields an event sends in every captured state; a test below
// also requires every state of an event to send the same fields.
const webhooks: validator.WebhookContract = {
  events: Object.fromEntries(
    Object.entries(captured).map(([event, cells]) => [
      event,
      cells.reduce(
        (common, { fields }) => common.filter((field) => fields.includes(field)),
        cells[0]?.fields ?? [],
      ),
    ]),
  ),
  headers: await deliveryHeaders(
    'booking.created',
    captured['booking.created']?.[0]?.payload ?? '{}',
  ),
}
// Each Make recipe document covers the events its manifest subscribes to.
const recipes: Record<string, string> = Object.fromEntries(
  names
    .filter((name) => name.endsWith('.recipe.json'))
    .flatMap((name) => {
      const manifest = JSON.parse(readFileSync(new URL(name, directory), 'utf8'))
      return (manifest.webhookEvents as string[]).map((event) => [
        event,
        manifest.settings.documentation as string,
      ])
    }),
)
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
const noShow = 'booking.attendee_no_show_changed'
const payloads = Object.values(webhooks.events)
const shared = payloads.reduce((a, b) => a.filter((field) => b.includes(field)))
function eventRow(event: string, overrides: { recipe?: string; fields?: string } = {}) {
  const recipe = recipes[event]
  const added = (webhooks.events[event] ?? []).filter((field) => !shared.includes(field))
  return `| \`${event}\` | ${overrides.recipe ?? (recipe ? `[Recipe](${recipe})` : 'None')} | ${
    overrides.fields ?? (added.length ? added.map((field) => `\`${field}\``).join(', ') : 'None')
  } |`
}
const eventTable = (rows: string[]) =>
  `| Event | Make recipe | Additional payload fields |\n| --- | --- | --- |\n${rows.join('\n')}\n`
const allRows = WEBHOOK_EVENTS.map((event) => eventRow(event))
function verify(check: typeof validator) {
  expect(check.validateMakeRecipe(recipe, document, webhooks)).toEqual([])
  expect(
    check.validateMakeRecipe({ ...recipe, secret: '<YOUR_WEBHOOK_SECRET>' }, document, webhooks),
  ).toEqual([])
  expect(
    check.validateMakeReferences(
      'Bearer <YOUR_API_KEY> https://help.make.com/blueprints',
      document,
      webhooks,
    ),
  ).toEqual([])
  // A no-show field is accepted only in a recipe subscribed to that event alone.
  expect(
    check.validateMakeRecipe(
      { ...recipe, webhookEvents: [noShow], webhookPayloadFields: ['data.attendeeId'] },
      document,
      webhooks,
    ),
  ).toEqual([])
  expect(check.validateMakeReferences(eventTable(allRows), document, webhooks, recipes)).toEqual([])
  for (const [content, error] of secretCases) {
    expect(check.validateMakeRecipe({ ...recipe, title: content }, document, webhooks)).toContain(
      error,
    )
    expect(check.validateMakeReferences(content, document, webhooks)).toContain(error)
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
    [{ ...recipe, webhookEvents: [] }, 'missing webhook event context'],
    [{ ...recipe, webhookPayloadFields: ['data.attendeeId'] }, 'unknown webhook payload field'],
    [
      {
        ...recipe,
        webhookEvents: ['booking.created', noShow],
        webhookPayloadFields: ['data.attendeeId'],
      },
      'unknown webhook payload field',
    ],
  ]
  for (const [value, error] of negatives)
    expect(check.validateMakeRecipe(value, document, webhooks)).toContain(error)
  const markdown: [string, string][] = [
    ['booking.unknown', 'unknown inline webhook event'],
    ['`Webhook-Nonexistent`', 'unknown webhook header'],
    ['get(map(headers; "value"; "name"; "webhook-nonexistent"); 1)', 'unknown webhook header'],
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
    [
      `${fence({ requests: [], webhookEvents: ['booking.created'] })}\`payload:data.nonexistentField\``,
      'unknown webhook payload field',
    ],
    [
      `${fence({ requests: [], webhookEvents: ['booking.created'] })}\`payload:data.noShowMarkedBy\``,
      'unknown webhook payload field',
    ],
    ['`payload:data.bookingId`', 'missing webhook event context'],
    [
      `${fence({ requests: [], webhookEvents: ['booking.cancelled'] })}{{data.attendeeId}}`,
      'unknown mapped payload field',
    ],
    [eventTable(allRows.slice(1)), 'incomplete webhook event table'],
    [eventTable([...allRows, allRows[0] ?? '']), 'invalid webhook event table row'],
    [
      eventTable([...allRows, '| booking.created | None | None |']),
      'invalid webhook event table row',
    ],
    [eventTable([...allRows, eventRow('booking.unknown')]), 'unknown webhook event'],
    [
      eventTable([eventRow('booking.created', { recipe: 'None' }), ...allRows.slice(1)]),
      'wrong event recipe coverage',
    ],
    [
      eventTable([
        ...allRows.filter((row) => !row.includes(noShow)),
        eventRow(noShow, { recipe: '[Recipe](booking-created-sheets.md)' }),
      ]),
      'wrong event recipe coverage',
    ],
    [
      eventTable([
        ...allRows.filter((row) => !row.includes(noShow)),
        eventRow(noShow, { fields: 'None' }),
      ]),
      'wrong additional payload fields',
    ],
    [
      eventTable([
        eventRow('booking.created', { fields: '`data.attendeeId`' }),
        ...allRows.slice(1),
      ]),
      'unknown webhook payload field',
    ],
    ['`body:invitee.name`', 'ambiguous inline field context'],
    ['```hourmere-fields\nnot json\n```', 'invalid field declaration'],
  ]
  for (const [raw, error] of markdown)
    expect(check.validateMakeReferences(raw, document, webhooks, recipes)).toContain(error)
  const created = fence({ requests: [], webhookEvents: ['booking.created'] })
  expect(check.validateMakeRecipeEvents(['booking.created'], created)).toEqual([])
  expect(check.validateMakeRecipeEvents([], 'No webhook events.')).toEqual([])
  for (const [events, raw] of [
    [[noShow], created],
    [['booking.created', 'booking.cancelled'], created],
    [[], created],
    [['booking.created'], 'No declaration.'],
  ] as const)
    expect(check.validateMakeRecipeEvents(events, raw)).toEqual([
      'recipe events differ from manifest',
    ])
  expect(check.validateMakeInventory(names)).toEqual([])
  expect(check.validateMakeInventory([])).toHaveLength(3)
}
function sourceCopy(copy: string): typeof validator {
  const body = stripTypeScriptTypes(copy).replace(/^export /gm, '')
  return new Function(
    `${body}\nreturn { validateMakeRecipe, validateMakeReferences, validateMakeRecipeEvents, validateMakeInventory, validateMakeSecrets, validateMakeFields }`,
  )()
}

const sitePage = new URL('../apps/site/src/content/docs/docs/make.md', import.meta.url)
const tableHeader = /^\| Event \| Make recipe \| Additional payload fields \|$/m

describe('Make manual recipe artifacts', () => {
  it('derives every accepted webhook event from the real notifiers', () => {
    // Any event added to WEBHOOK_EVENTS needs a capture above, or this fails.
    expect(Object.keys(webhooks.events).sort()).toEqual([...WEBHOOK_EVENTS].sort())
    for (const [event, fields] of Object.entries(webhooks.events))
      expect(fields, event).toEqual(expect.arrayContaining(['id', 'type', 'data.bookingId']))
    expect(Object.keys(recipes).sort()).toEqual(['booking.cancelled', 'booking.created'])
  })
  it('derives the same payload fields in every sampled booking state of an event', () => {
    // Fields that depend on booking data (status, source, predecessor, event type, meeting
    // time or an unmarked attendee) would otherwise be missing from, or wrongly promised by,
    // the docs.
    for (const [event, cells] of Object.entries(captured)) {
      expect(cells.length, event).toBeGreaterThanOrEqual(16)
      for (const { cell, fields } of cells)
        expect([...fields].sort(), `${event}: ${cell}`).toEqual(
          [...(webhooks.events[event] ?? [])].sort(),
        )
    }
  })
  it('derives exactly the delivery headers the shared recipe uses', () => {
    const readme = readFileSync(new URL('README.md', directory), 'utf8')
    const used = new Set(
      [...readme.matchAll(/["'`](webhook-[A-Za-z0-9-]+)["'`]/gi)].map((m) => m[1]?.toLowerCase()),
    )
    expect([...webhooks.headers].sort()).toEqual([...used].sort())
    expect(used.size).toBe(4)
  })
  it('keeps each recipe document subscribed to the events its manifest declares', () => {
    for (const name of names.filter((entry) => entry.endsWith('.recipe.json'))) {
      const manifest = JSON.parse(readFileSync(new URL(name, directory), 'utf8'))
      const raw = readFileSync(new URL(manifest.settings.documentation, directory), 'utf8')
      expect(validator.validateMakeRecipeEvents(manifest.webhookEvents, raw), name).toEqual([])
    }
  })
  it('validates every manifest, recipe, README and site page against real sources', async () => {
    const generated = (await openApiDocument()) as Parameters<
      typeof validator.validateMakeRecipe
    >[1]
    expect(validator.validateMakeInventory(names)).toEqual([])
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const value = JSON.parse(readFileSync(new URL(name, directory), 'utf8'))
      expect(validator.validateMakeRecipe(value, generated, webhooks), name).toEqual([])
      expect(existsSync(new URL(value.settings.documentation, directory))).toBe(true)
    }
    const documents = names
      .filter((entry) => entry.endsWith('.md'))
      .map((name) => new URL(name, directory))
    documents.push(sitePage)
    for (const url of documents) {
      const raw = readFileSync(url, 'utf8')
      expect(
        validator.validateMakeReferences(raw, generated, webhooks, recipes),
        url.pathname,
      ).toEqual([])
      for (const [secret, error] of secretCases) {
        expect(
          validator.validateMakeReferences(`${raw}\n${secret}`, generated, webhooks, recipes),
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
    const site = readFileSync(sitePage, 'utf8')
    const mutations = [
      [
        slack,
        slack.replace('{{data.bookingId}}', '{{data.attendeeId}}'),
        'unknown mapped payload field',
      ],
      [
        readme,
        readme.replace(', `data.noShowMarkedBy` |', ' |'),
        'wrong additional payload fields',
      ],
      [
        readme,
        readme.replace(/^\| `booking\.rescheduled` \|.*\n/m, ''),
        'incomplete webhook event table',
      ],
      [
        site,
        site.replace(
          '| `booking.reschedule_requested` | None | `data.requestId` |',
          '| `booking.reschedule_requested` | None | `data.attendeeId` |',
        ),
        'unknown webhook payload field',
      ],
      [
        site,
        site.replace(/^(\| `booking\.created` \| )[^|]+\|/m, '$1None |'),
        'wrong event recipe coverage',
      ],
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
        validator.validateMakeReferences(mutated ?? '', generated, webhooks, recipes),
      ).toContain(error)
    }
  })
  it('lists every accepted event in the README and site page, and fails when one is dropped', async () => {
    const generated = (await openApiDocument()) as Parameters<
      typeof validator.validateMakeRecipe
    >[1]
    const shared = [
      readFileSync(new URL('README.md', directory), 'utf8'),
      readFileSync(sitePage, 'utf8'),
    ]
    for (const raw of shared) expect(raw).toMatch(tableHeader)
    for (const event of WEBHOOK_EVENTS) {
      const reduced = {
        ...webhooks,
        events: Object.fromEntries(
          Object.entries(webhooks.events).filter(([key]) => key !== event),
        ),
      }
      for (const raw of shared)
        expect(
          validator.validateMakeReferences(raw, generated, reduced, recipes),
          event,
        ).not.toEqual([])
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
    'missing webhook event context',
    'invalid webhook event table row',
    'wrong event recipe coverage',
    'wrong additional payload fields',
    'incomplete webhook event table',
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
    ['fields every subscribed event sends', 'events.every((event) =>', 'events.some((event) =>'],
    ['fence event context', 'events.push(...(fields.webhookEvents ?? []))', 'void fields'],
    ['shared snapshot', 'filter((field) => !shared.includes(field))', 'filter(() => false)'],
    [
      'quoted header names',
      '/["\'`](webhook-[A-Za-z0-9-]+)["\'`]/gi',
      '/`(webhook-[A-Za-z0-9-]+)`/gi',
    ],
    ['recipe events', "['recipe events differ from manifest']", '[]'],
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
