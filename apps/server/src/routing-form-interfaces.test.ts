import { randomUUID } from 'node:crypto'
import '@hono/zod-openapi'
import type { ApiKeyScope, CallerResolver, Principal } from '@hourmere/auth'
import { createDb, type Db, purgeExpiredRoutingReceipts } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { Mailer } from '@hourmere/mail'
import {
  BOOKING_NOTIFICATION_JOB,
  bookingNotifier,
  type NotificationQueue,
  sendBookingNotification,
} from '@hourmere/notifications'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import { sql } from 'kysely'
import createClient from 'openapi-fetch'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  evaluateRoutingForm,
  validateRoutingAnswers,
} from '../../../packages/scheduling/src/routing-form-config.ts'
import {
  archiveRoutingForm,
  createRoutingForm,
  publishRoutingForm,
  type RoutingForm,
  submitRoutingForm,
  updateRoutingForm,
} from '../../../packages/scheduling/src/routing-form-service.ts'
import { routingTokenDigest } from '../../../packages/scheduling/src/routing-receipt-crypto.ts'
import { runCli } from '../../../tools/cli/src/cli.ts'
import type { paths } from '../../web/src/api/schema.d.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { BOOKING_BODY_LIMIT, publicRoutes } from './routes/public.ts'
import { routingContinuationRoutes } from './routes/routing-continuations.ts'
import { escapedJson, openApiDocument } from './routes/test-app.ts'
import { parseRoutingFormsEnabled, resolveRoutingFormsEnabled } from './routing-form-setting.ts'
import { productRoutes, productTools } from './server.ts'

const paymentRequired = vi.hoisted(() => new Set<string>())

vi.mock(import('../../../packages/scheduling/src/routing-form-config.ts'), async (original) => {
  const actual = await original()
  return { ...actual, evaluateRoutingForm: vi.fn(actual.evaluateRoutingForm) }
})

// Event types do not store pricing yet. The normal loader still reads the real event;
// the fixture supplies the future payment projection only for the event under test.
vi.mock(import('../../../packages/scheduling/src/routing-form-targets.ts'), async (original) => {
  const actual = await original()
  return {
    ...actual,
    async loadRoutingTargetEvents(db: Db, ids: readonly string[]) {
      const events = await actual.loadRoutingTargetEvents(db, ids)
      for (const [id, event] of events) {
        if (paymentRequired.has(id)) event.payment = 'required'
      }
      return events
    },
  }
})

const publicUrl = 'http://localhost:4189'
const routingSecret = 'synthetic-routing-interface-secret'
const routingOwnerHandle = 'routing-public-owner'
const routedBookingPath = '/api/v1/routing-continuations/bookings'
const operations = ['list', 'get', 'create', 'update', 'archive', 'publish', 'preview'] as const
type Operation = (typeof operations)[number]
const tools = {
  list: 'list_routing_forms',
  get: 'get_routing_form',
  create: 'create_routing_form',
  update: 'update_routing_form',
  archive: 'archive_routing_form',
  publish: 'publish_routing_form',
  preview: 'preview_routing_form',
}
const methods = {
  list: 'GET',
  get: 'GET',
  create: 'POST',
  update: 'PATCH',
  archive: 'DELETE',
  publish: 'POST',
  preview: 'POST',
}
const draft = () => ({
  slug: `form-${randomUUID()}`,
  title: 'Routing form',
  fallback: { kind: 'message', message: 'Thank you' },
})

it('charges both continuation routes to one bucket before transport and input refusals', async () => {
  const path = '/api/v1/routing-continuations'
  for (const [first, second] of [
    ['resolve', 'slots'],
    ['slots', 'resolve'],
  ] as const) {
    const application = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      routes: [
        routingContinuationRoutes(
          { db: {} as Db, now: () => Temporal.Now.instant(), routingFormsEnabled: true },
          { limit: 4, windowSeconds: 60 },
        ),
      ],
    })
    const post = (route: string, body: string, headers: Record<string, string> = {}) =>
      application.request(`${path}/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      })
    expect((await post(first, '{}', { authorization: 'Bearer invalid-fixture' })).status).toBe(401)
    expect((await post(second, '{}', { 'content-length': '65537' })).status).toBe(413)
    const invalid = await post(
      first,
      JSON.stringify({ routeToken: 'fixture', eventTypeId: 'forbidden' }),
    )
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'invalid_request' })
    expect((await post(second, '{')).status).toBe(400)
    const refused = await post(first, '{}')
    expect(refused.status).toBe(429)
    expect(refused.headers.get('Retry-After')).toMatch(/^\d+$/)
    expect(refused.headers.get('Cache-Control')).toBe('no-store')
    expect(refused.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(await refused.json()).toEqual({ error: 'rate_limited' })
  }
})

it('documents both continuation requests with complete strict schemas and optional keys', async () => {
  const application = createApp({
    publicUrl,
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
    routes: [routingContinuationRoutes({ db: {} as Db, now: () => Temporal.Now.instant() })],
  })
  const document = await openApiDocument(application)
  for (const [path, operationId, schema, required] of [
    ['resolve', 'resolveRoutingContinuation', 'RoutingContinuationInput', ['routeToken']],
    ['slots', 'findRoutedSlots', 'RoutingContinuationSlotsInput', ['routeToken', 'start', 'end']],
  ] as const) {
    expect(document.paths[`/api/v1/routing-continuations/${path}`]?.post).toMatchObject({
      operationId,
      security: [{}, { apiKey: [] }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
      },
      responses: { 200: {}, 400: {}, 401: {}, 403: {}, 404: {}, 409: {}, 413: {}, 429: {} },
    })
    expect(document.components.schemas[schema]).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required,
    })
  }
})

it('documents routed booking with a strict request and dedicated creation and replay result', async () => {
  const application = createApp({
    publicUrl,
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
    routes: [publicRoutes({ db: {} as Db })],
  })
  const document = await openApiDocument(application)
  const result = {
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/RoutedBookingResult' } },
    },
  }
  expect(document.paths[routedBookingPath]?.post).toMatchObject({
    operationId: 'createRoutedBooking',
    security: [{}, { apiKey: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/RoutedBookingInput' } },
      },
    },
    parameters: [expect.objectContaining({ in: 'header', name: 'idempotency-key' })],
    responses: {
      200: result,
      201: result,
      400: {},
      401: {},
      403: {},
      404: {},
      409: {},
      413: {},
      429: {},
    },
  })
  const input = document.components.schemas.RoutedBookingInput
  expect(input).toMatchObject({
    additionalProperties: false,
    required: ['start', 'invitee', 'routeToken'],
  })
  expect(input).not.toHaveProperty('properties.oneTimeToken')
  expect(input).not.toHaveProperty('properties.slug')
  expect(document.components.schemas.RoutedBookingResult).toMatchObject({
    required: ['booking', 'manageToken'],
  })
  expect(document.components.schemas.RoutedBookingResult).not.toHaveProperty(
    'properties.successRedirect',
  )
})

it('charges routed booking and ordinary public booking to the same book bucket', async () => {
  const application = createApp({
    publicUrl,
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
    routes: [publicRoutes({ db: {} as Db, rateLimits: { book: { limit: 1, windowSeconds: 60 } } })],
  })
  const post = (path: string) =>
    application.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  expect((await post(routedBookingPath)).status).toBe(400)
  const refused = await post('/api/v1/public/some-host/some-event/bookings')
  expect(refused.status).toBe(429)
  expect(refused.headers.get('Retry-After')).toMatch(/^\d+$/)
  expect(await refused.json()).toEqual({ error: 'rate_limited' })
})

describe.skipIf(!process.env.DATABASE_URL)('routing configuration interfaces', () => {
  let owned: TestDatabase
  let db: Db
  let owner: TestUser
  let admin: TestUser
  let member: TestUser
  let outsider: TestUser
  let team: Awaited<ReturnType<typeof createTestTeam>>
  const credentials = new Map<string, Principal>()
  const notify = vi.fn(async () => {})
  const resolveCaller: CallerResolver = async (headers) => {
    const principal = credentials.get(
      headers.get('authorization')?.replace(/^Bearer /, '') ?? headers.get('cookie') ?? '',
    )
    return principal
      ? { ok: true, principal, setCookie: [] }
      : { ok: false, error: 'unauthorized', setCookie: [] }
  }
  function app(
    enabled = true,
    routingBookingReceiptNow?: () => Temporal.Instant,
    notifyBooking?: ReturnType<typeof bookingNotifier>,
  ) {
    return createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller,
      routes: productRoutes({
        db,
        notify: notifyBooking ?? notify,
        publicUrl,
        socialProviders: {},
        invitationMailLimits: { secret: routingSecret },
        routingFormsEnabled: enabled,
        routingSecret,
        ...(routingBookingReceiptNow && { routingBookingReceiptNow }),
      }),
      mcp: mcpEndpoint({
        tools: productTools({
          db,
          notify: notifyBooking ?? notify,
          publicUrl,
          routingFormsEnabled: enabled,
          routingSecret,
          routingBookingReceiptNow,
        }),
      }),
    })
  }
  async function credential(
    user: TestUser,
    scope: ApiKeyScope = 'full',
    organization = user.principal.organization,
  ) {
    const { id } = await db
      .insertInto('auth.apikey')
      .values({
        configId: 'default',
        referenceId: user.id,
        key: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: JSON.stringify({ scope, organizationId: organization.id }),
        enabled: true,
        rateLimitEnabled: false,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const token = `hm_${randomUUID()}`
    credentials.set(token, {
      kind: 'api_key',
      user: user.principal.user,
      organization,
      apiKeyId: id,
      apiKeyScope: scope,
    })
    return token
  }
  async function session(user: TestUser) {
    const { id } = await db
      .insertInto('auth.session')
      .values({
        userId: user.id,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3600000),
        updatedAt: new Date(),
        activeOrganizationId: user.principal.organization.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const cookie = `session-${id}`
    credentials.set(cookie, {
      kind: 'session',
      sessionId: id,
      user: user.principal.user,
      organization: user.principal.organization,
    })
    return cookie
  }
  async function rpc(
    application: ReturnType<typeof app>,
    token: string,
    method: string,
    params: object = {},
  ) {
    const response = await application.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (
      'name' in params &&
      [
        'route_lead',
        'resolve_routing_continuation',
        'find_routed_slots',
        'create_booking',
      ].includes(String(params.name))
    ) {
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    }
    const text = await response.text()
    const event = text.split('\n').find((line) => line.startsWith('data: '))
    return JSON.parse(event ? event.slice(6) : text).result
  }
  async function call(
    surface: 'rest' | 'mcp' | 'cli',
    token: string,
    op: Operation,
    input: Record<string, unknown> = {},
    enabled = true,
  ) {
    const application = app(enabled)
    if (surface === 'rest') {
      const { id, ...body } = input
      const item = op === 'list' || op === 'create' ? '' : `/${id}`
      const action = op === 'publish' || op === 'preview' ? `/${op}` : ''
      const query = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]))
      const path = `/api/v1/routing-forms${item}${action}${op === 'list' ? `?${query}` : ''}`
      const response = await application.request(path, {
        method: methods[op],
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(methods[op] === 'GET' ? {} : { body: JSON.stringify(body) }),
      })
      expect(response.headers.get('cache-control')).toBe('no-store')
      return {
        ok: response.ok,
        body: response.status === 204 ? {} : await response.json(),
        status: response.status,
      }
    }
    if (surface === 'mcp') {
      const result = await rpc(application, token, 'tools/call', {
        name: tools[op],
        arguments: input,
      })
      return { ok: !result.isError, body: JSON.parse(result.content[0].text) }
    }
    return callCli(application, token, op, input)
  }
  async function callCli(
    application: ReturnType<typeof app>,
    token: string,
    op: Operation | 'public' | 'route' | 'resolve' | 'slots' | 'book',
    input: Record<string, unknown>,
  ) {
    let stdout = ''
    let stderr = ''
    const code = await runCli({
      argv: [...(op === 'book' ? [op] : ['routing-forms', op]), '--input', '-'],
      env: { HOURMERE_URL: publicUrl, HOURMERE_API_KEY: token },
      stdin: (async function* () {
        yield JSON.stringify(input)
      })(),
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      fetch: async (request, init) => application.request(request, init),
    })
    return { ok: code === 0, body: JSON.parse((code === 0 ? stdout : stderr) || '{}') }
  }
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'routing_api',
    })
    db = createDb(owned.pool)
    owner = await createTestUser(db, 'Owner')
    await db
      .insertInto('profiles')
      .values({ user_id: owner.id, handle: routingOwnerHandle, time_zone: 'UTC' })
      .execute()
    admin = await createTestUser(db, 'Admin')
    member = await createTestUser(db, 'Member')
    outsider = await createTestUser(db, 'Outsider')
    team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
  })
  afterAll(async () => {
    await owned?.drop()
  })

  const versions = (id: string) =>
    db.selectFrom('routing_form_versions').select('id').where('form_id', '=', id).execute()

  async function bookingReceipt(
    eventTypeId: string,
    topic?: { id: string; label: string; answer: string },
  ) {
    const principal = credentials.get(await credential(owner))
    if (!principal) throw Error('Expected a persisted fixture key')
    const context = testContext(db, principal)
    const form = await createRoutingForm(context, {
      ...draft(),
      ...(topic && { questions: [{ id: topic.id, label: topic.label, type: 'short_text' }] }),
      fallback: { kind: 'event', eventTypeId, mappings: [] },
    })
    const publication = await publishRoutingForm(context, form.id, {
      expectedRevision: form.draftRevision,
    })
    await updateRoutingForm(context, form.id, {
      expectedRevision: publication.form.draftRevision,
      enabled: true,
    })
    const receipt = await submitRoutingForm(
      { db, routingFormsEnabled: true, routingSecret },
      { organizationId: owner.principal.organization.id, formId: form.id },
      { versionId: publication.version.id, answers: topic ? { [topic.id]: topic.answer } : {} },
    )
    if (receipt.kind !== 'continuation') throw Error('Expected a booking capability')
    return receipt
  }

  const bookingStart = (time: string) => {
    const nextWeek = Temporal.Now.plainDateISO('UTC').add({ days: 7 })
    const monday = nextWeek.add({ days: (8 - nextWeek.dayOfWeek) % 7 })
    return `${monday}T${time}:00Z`
  }

  const effectiveSetting = (configured: string) =>
    resolveRoutingFormsEnabled({ db, routingFormsEnabled: parseRoutingFormsEnabled(configured) })

  it('identifies a rejected routed booking answer without echoing private input on any interface', async () => {
    const eventTypeId = await createFixtures(db).eventType(
      owner.principal.organization.id,
      owner.id,
      { questions: [{ id: 'reference', label: 'Reference', type: 'short_text', required: true }] },
    )
    const receipt = await bookingReceipt(eventTypeId)
    const key = await credential(outsider, 'bookings')
    const application = app(await effectiveSetting('true'))
    const input = {
      routeToken: receipt.routeToken,
      start: bookingStart('10:00'),
      invitee: { name: 'Fixture invitee', email: 'routing@example.test', timeZone: 'UTC' },
    }
    for (const { responses, field } of [
      { responses: { reference: true }, field: 'responses.reference' },
      { responses: { [receipt.routeToken]: 'Private answer' } },
    ]) {
      const body = { ...input, responses }
      const expected = { error: 'invalid_responses', ...(field && { field }) }
      const rest = await application.request(routedBookingPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      })
      expect(rest.status).toBe(400)
      expect(await rest.json()).toEqual(expected)
      const mcp = await rpc(application, key, 'tools/call', {
        name: 'create_booking',
        arguments: body,
      })
      expect(mcp.isError).toBe(true)
      expect(JSON.parse(mcp.content[0].text)).toEqual(expected)
      expect(
        await callCli(application, key, 'book', { ...body, idempotencyKey: randomUUID() }),
      ).toEqual({
        ok: false,
        body: { ...expected, outcomeMayBeUnknown: true },
      })
    }
  })

  it('books a hidden target and authorizes only exact routed replay after expiry and disablement', async () => {
    const fixtures = createFixtures(db)
    const slug = 'hidden-routed-booking-event'
    const redirect = 'https://host.example/after-booking'
    const scheduleId = await fixtures.schedule(owner.id, { timeZone: 'UTC', isDefault: false })
    const eventTypeId = await fixtures.eventType(owner.principal.organization.id, owner.id, {
      slug,
      hosts: [{ userId: owner.id, scheduleId }],
    })
    await db
      .updateTable('event_types')
      .set({
        is_hidden: true,
        success_redirect: JSON.stringify({
          url: redirect,
          parameters: ['eventTypeSlug'],
          includeInviteePersonalData: false,
          allowEmbedParent: false,
        }),
      })
      .where('id', '=', eventTypeId)
      .execute()

    const receipt = await bookingReceipt(eventTypeId)
    const key = await credential(outsider, 'bookings')
    const otherKey = await credential(outsider, 'bookings')
    const readKey = await credential(outsider, 'read')
    const idempotencyKey = randomUUID()
    const input = {
      routeToken: receipt.routeToken,
      start: bookingStart('10:00'),
      invitee: { name: 'Routed invitee', email: 'routed@example.test', timeZone: 'UTC' },
    }
    const enabled = app(await effectiveSetting('true'))
    const expiry = () => Temporal.Instant.from(receipt.expiresAt).add({ seconds: 1 })
    const expired = app(true, expiry)
    const off = app(await effectiveSetting('false'), expiry)
    const rest = async (
      application: ReturnType<typeof app>,
      args = input,
      requestKey = idempotencyKey,
      auth: string | null = key,
    ) => {
      const client = createClient<paths>({
        baseUrl: publicUrl,
        fetch: async (request) => application.request(request),
      })
      const { data, error, response } = await client.POST(
        '/api/v1/routing-continuations/bookings',
        {
          params: { header: { 'idempotency-key': requestKey } },
          headers: auth === null ? {} : { authorization: `Bearer ${auth}` },
          body: args,
        },
      )
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
      return { status: response.status, body: data ?? error }
    }
    expect(await rest(off)).toEqual({ status: 404, body: { error: 'routing_forms_disabled' } })
    expect(await rest(expired)).toEqual({ status: 409, body: { error: 'routing_unavailable' } })
    expect(await rest(enabled, input, idempotencyKey, readKey)).toMatchObject({
      status: 403,
      body: { error: 'insufficient_scope' },
    })
    expect(await rest(enabled, input, idempotencyKey, 'invalid-fixture')).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    })
    const mcp = (application: ReturnType<typeof app>, arguments_: object) =>
      rpc(application, key, 'tools/call', { name: 'create_booking', arguments: arguments_ })
    for (const field of ['oneTimeToken', 'waitlistToken']) {
      const mixed = { ...input, [field]: 'a'.repeat(43) }
      expect(await rest(enabled, mixed)).toEqual({
        status: 400,
        body: { error: 'invalid_request' },
      })
      const invalidMcp = await mcp(enabled, { ...mixed, idempotencyKey })
      expect(invalidMcp.isError).toBe(true)
      expect(JSON.parse(invalidMcp.content[0].text)).toMatchObject({ error: 'invalid_request' })
    }

    const { body, status } = await rest(enabled)
    expect(status).toBe(201)
    expect(body).toMatchObject({
      booking: { eventTypeId, status: 'confirmed', source: 'api' },
      manageToken: expect.any(String),
    })
    expect(Object.keys(body ?? {}).sort()).toEqual(['booking', 'manageToken'])
    for (const privateValue of [slug, redirect, receipt.routeToken, routingOwnerHandle]) {
      expect(JSON.stringify(body).includes(privateValue)).toBe(false)
    }
    const replay = { ...body, manageToken: null }
    expect(await rest(expired)).toEqual({ status: 200, body: replay })
    expect(await rest(off)).toEqual({ status: 200, body: replay })
    const mcpInput = { ...input, idempotencyKey }
    expect((await mcp(off, mcpInput)).structuredContent).toEqual({ ...replay, replayed: true })
    expect(await callCli(off, key, 'book', mcpInput)).toEqual({
      ok: true,
      body: { ...replay, replayed: true },
    })

    const changed = { ...input, invitee: { ...input.invitee, name: 'Changed' } }
    for (const [args, requestKey, auth] of [
      [changed, idempotencyKey, key],
      [input, randomUUID(), key],
      [input, idempotencyKey, otherKey],
      [input, idempotencyKey, null],
    ] as const) {
      expect(await rest(off, args, requestKey, auth)).toEqual({
        status: 404,
        body: { error: 'routing_forms_disabled' },
      })
      expect(await rest(expired, args, requestKey, auth)).toEqual({
        status: 409,
        body: { error: 'routing_unavailable' },
      })
    }
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where('event_type_id', '=', eventTypeId)
        .execute(),
    ).toHaveLength(1)
  })

  it('keeps routed confirmations, manage links and booking changes available after disabling routing', async () => {
    const fixtures = createFixtures(db)
    const scheduleId = await fixtures.schedule(owner.id, { timeZone: 'UTC', isDefault: false })
    const eventTypeId = await fixtures.eventType(owner.principal.organization.id, owner.id, {
      title: 'Routing consultation',
      hosts: [{ userId: owner.id, scheduleId }],
    })
    const topic = { id: randomUUID(), label: 'Call topic', answer: 'Discuss the handoff' }
    const receipt = await bookingReceipt(eventTypeId, topic)
    const enqueue = vi.fn<NotificationQueue['enqueue']>(async () => null)
    const notifier = bookingNotifier({ enqueue })
    const on = app(await effectiveSetting('true'), undefined, notifier)
    const client = (application: ReturnType<typeof app>) =>
      createClient<paths>({
        baseUrl: publicUrl,
        fetch: async (request) => application.request(request),
      })
    const invitee = { name: 'Fixture invitee', email: 'handoff@example.test', timeZone: 'UTC' }
    const start = bookingStart('15:00')
    const { data: created, response } = await client(on).POST(routedBookingPath, {
      body: { routeToken: receipt.routeToken, start, invitee },
    })
    expect(response.status).toBe(201)
    expect(created?.booking.status).toBe('confirmed')
    if (!created) throw new Error('Expected a completed routed booking')
    const { id } = created.booking

    const off = app(await effectiveSetting('false'), undefined, notifier)
    const hostHeaders = { authorization: `Bearer ${await credential(owner, 'read')}` }
    const detail = async (application: ReturnType<typeof app>) => {
      const result = await application.request(`/api/v1/bookings/${id}`, { headers: hostHeaders })
      expect(result.status).toBe(200)
      return result.json()
    }
    const hostDetail = await detail(on)
    expect(hostDetail).toMatchObject({
      id,
      status: 'confirmed',
      routing: {
        questions: [{ id: topic.id, label: topic.label }],
        answers: { [topic.id]: topic.answer },
      },
    })
    expect(await detail(off)).toEqual(hostDetail)

    // Deliver the confirmation queued before shutdown after composing the disabled app.
    expect(enqueue).toHaveBeenCalledWith(
      BOOKING_NOTIFICATION_JOB,
      { bookingId: id, kind: 'confirmed' },
      expect.any(Object),
    )
    const send = vi.fn<Mailer['send']>(async () => {})
    await sendBookingNotification(
      { db, mailer: { send }, secret: routingSecret, publicUrl },
      id,
      'confirmed',
    )
    const confirmation = send.mock.calls.find(([message]) => message.to === invitee.email)?.[0]
    expect(confirmation?.subject).toMatch(/^Confirmed: Routing consultation/)
    const emailToken = confirmation?.text?.match(
      /#token=([A-Za-z0-9_-]{43})&action=reschedule/,
    )?.[1]
    if (!emailToken) throw new Error('Expected the confirmation to contain a manage link')
    expect(confirmation?.text).toContain(`${publicUrl}/booking#token=${emailToken}&action=cancel`)

    const managed = async (application: ReturnType<typeof app>, token: string) => {
      const result = await application.request('/api/v1/bookings/manage', {
        headers: { 'x-manage-token': token },
      })
      expect(result.status).toBe(200)
      return result.json()
    }
    const routingAnswers = [{ label: topic.label, answer: topic.answer }]
    const inviteeDetail = await managed(on, emailToken)
    expect(inviteeDetail).toMatchObject({ id, status: 'confirmed', routingAnswers })
    expect(inviteeDetail).not.toHaveProperty('routing')
    expect(await managed(off, emailToken)).toEqual(inviteeDetail)

    const query = new URLSearchParams({
      from: start,
      to: Temporal.Instant.from(start).add({ hours: 3 }).toString(),
      eventTypeId,
    })
    const exportPath = `/api/v1/bookings/export.csv?${query}`
    const csv = async (application: ReturnType<typeof app>, suffix = '') => {
      const result = await application.request(exportPath + suffix, { headers: hostHeaders })
      expect(result.status).toBe(200)
      return result.text()
    }
    const withAnswers = '&includeRoutingAnswers=true'
    const routingCsv = await csv(on, withAnswers)
    expect(routingCsv).toContain('routing_answers')
    expect(routingCsv).toContain(topic.answer)
    const refused = await off.request(exportPath + withAnswers, { headers: hostHeaders })
    expect(refused.status).toBe(404)
    expect(await refused.json()).toEqual({ error: 'routing_forms_disabled' })
    const ordinaryCsv = await csv(off)
    expect(ordinaryCsv).toContain(invitee.email)
    expect(ordinaryCsv).not.toContain('routing_answers')
    expect(ordinaryCsv).not.toContain(topic.answer)
    expect(await csv(on)).toBe(ordinaryCsv)
    expect(await csv(off, '&includeRoutingAnswers=false')).toBe(ordinaryCsv)

    const params = { header: { 'x-manage-token': emailToken } }
    const offClient = client(off)
    const moved = await offClient.POST('/api/v1/bookings/manage/reschedule', {
      params,
      body: { start: bookingStart('16:00') },
    })
    expect(moved.response.status).toBe(200)
    expect(moved.data?.booking).toMatchObject({ rescheduledFromId: id, status: 'confirmed' })
    expect(await managed(off, emailToken)).toMatchObject({
      id: moved.data?.booking.id,
      status: 'confirmed',
      routingAnswers,
    })
    const cancelled = await offClient.POST('/api/v1/bookings/manage/cancel', {
      params,
      body: { reason: 'Fixture cancellation' },
    })
    expect(cancelled.response.status).toBe(200)
    expect(cancelled.data).toMatchObject({ id: moved.data?.booking.id, status: 'cancelled' })
    expect(await managed(off, emailToken)).toMatchObject({
      id: moved.data?.booking.id,
      status: 'cancelled',
      routingAnswers,
    })
  })

  it.each(['group', 'paid'] as const)(
    'refuses booking a target that becomes %s after issuing its receipt',
    async (mode) => {
      const fixtures = createFixtures(db)
      const scheduleId = await fixtures.schedule(owner.id, { timeZone: 'UTC', isDefault: false })
      const eventTypeId = await fixtures.eventType(owner.principal.organization.id, owner.id, {
        hosts: [{ userId: owner.id, scheduleId }],
      })
      const { routeToken } = await bookingReceipt(eventTypeId)
      const receipt = () =>
        db
          .selectFrom('routing_receipts')
          .selectAll()
          .where('token_hash', '=', routingTokenDigest(routingSecret, 'continuation', routeToken))
          .executeTakeFirstOrThrow()
      const bookings = () =>
        db
          .selectFrom('bookings')
          .select(['status', 'payment_hold_expires_at', 'group_slot_id'])
          .where('event_type_id', '=', eventTypeId)
          .execute()
      const before = await receipt()
      const application = app()
      const request = () =>
        application.request(routedBookingPath, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            routeToken,
            start: bookingStart(mode === 'group' ? '13:00' : '14:00'),
            invitee: { name: 'Routed invitee', email: 'routed@example.test', timeZone: 'UTC' },
          }),
        })
      const changeMode = (group: boolean) =>
        db
          .updateTable('event_types')
          .set({ booking_mode: group ? 'group' : 'individual', group_capacity: group ? 4 : null })
          .where('id', '=', eventTypeId)
          .execute()
      if (mode === 'group') await changeMode(true)
      else paymentRequired.add(eventTypeId)
      try {
        const response = await request()
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'routing_unavailable' })
        expect(await bookings()).toEqual([])
        expect(await receipt()).toEqual(before)
      } finally {
        paymentRequired.delete(eventTypeId)
      }
      if (mode === 'group') await changeMode(false)
      const restored = await request()
      expect({ status: restored.status, body: await restored.json() }).toMatchObject({
        status: 201,
        body: { booking: { status: 'confirmed' } },
      })
      expect(await bookings()).toEqual([
        {
          status: 'confirmed',
          payment_hold_expires_at: null,
          group_slot_id: null,
        },
      ])
    },
  )

  it('accepts the fully escaped maximum legal routed booking and rejects one byte over 2 MiB', async () => {
    const fixtures = createFixtures(db)
    const scheduleId = await fixtures.schedule(owner.id, { timeZone: 'UTC', isDefault: false })
    const options = Array.from(
      { length: 50 },
      (_, i) => String.fromCharCode(0x4e00 + i) + 'é'.repeat(199),
    )
    const questions = Array.from({ length: 20 }, (_, i) => ({
      id: `q${i}`.padEnd(64, 'x'),
      label: `Question ${i}`,
      type: 'multi_select',
      required: true,
      options,
    }))
    const eventTypeId = await fixtures.eventType(owner.principal.organization.id, owner.id, {
      questions,
      allowGuests: true,
      hosts: [{ userId: owner.id, scheduleId }],
    })
    await db
      .updateTable('event_types')
      .set({
        success_redirect: JSON.stringify({
          url: 'https://host.example/after-booking',
          parameters: ['eventTypeSlug'],
          includeInviteePersonalData: false,
          allowEmbedParent: false,
        }),
      })
      .where('id', '=', eventTypeId)
      .execute()
    const { routeToken } = await bookingReceipt(eventTypeId)
    const email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`
    const body = escapedJson({
      routeToken,
      start: bookingStart('11:00'),
      invitee: {
        name: 'é'.repeat(200),
        email,
        timeZone: 'Europe/Berlin',
        locale: 'abcdefgh-abcdefgh-abcdefgh-abcdefgh',
      },
      guests: Array.from({ length: 10 }, (_, index) => ({
        name: 'ü'.repeat(200),
        email: `${index}${email.slice(1)}`,
      })),
      responses: Object.fromEntries(questions.map(({ id }) => [id, options])),
    })
    expect(Buffer.byteLength(body)).toBeGreaterThan(1_200_000)
    const application = app()
    const idempotencyKey = randomUUID()
    const send = (size: number) =>
      application.request(routedBookingPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: body.padEnd(size, ' '),
      })
    const accepted = await send(BOOKING_BODY_LIMIT)
    expect(accepted.status).toBe(201)
    const result = (await accepted.json()) as { booking: { responses: Record<string, string[]> } }
    const firstQuestion = questions[0]?.id as string
    expect(result.booking.responses[firstQuestion]).toHaveLength(50)
    expect(result).not.toHaveProperty('successRedirect')
    const replay = await send(BOOKING_BODY_LIMIT)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ ...result, manageToken: null })
    const tooBig = await send(BOOKING_BODY_LIMIT + 1)
    expect(tooBig.status).toBe(413)
    expect(await tooBig.json()).toEqual({ error: 'payload_too_large' })
  })

  it('preserves stored forms and restores published links when routing is re-enabled', async () => {
    const token = await credential(owner)
    const principal = credentials.get(token)
    if (!principal) throw new Error('Expected a persisted fixture key')
    const context = testContext(db, principal)
    const eventTypeId = await createFixtures(db).eventType(
      context.principal.organization.id,
      owner.id,
    )
    const active = await createRoutingForm(context, {
      ...draft(),
      fallback: { kind: 'event', eventTypeId, mappings: [] },
    })
    const activeVersion = await publishRoutingForm(context, active.id, {
      expectedRevision: active.draftRevision,
    })
    const edited = await updateRoutingForm(context, active.id, {
      expectedRevision: activeVersion.form.draftRevision,
      enabled: true,
      questions: [{ id: randomUUID(), type: 'short_text', label: 'Unpublished draft question' }],
    })
    const draftOnly = await createRoutingForm(context, draft())
    const archived = await createRoutingForm(context, draft())
    const archivedVersion = await publishRoutingForm(context, archived.id, {
      expectedRevision: archived.draftRevision,
    })
    await archiveRoutingForm(context, archived.id, {
      expectedRevision: archivedVersion.form.draftRevision,
    })

    const ids = [active.id, draftOnly.id, archived.id]
    const storedForms = () =>
      Promise.all([
        db.selectFrom('routing_forms').selectAll().where('id', 'in', ids).orderBy('id').execute(),
        db
          .selectFrom('routing_form_versions')
          .selectAll()
          .where('form_id', 'in', ids)
          .orderBy('id')
          .execute(),
      ])
    const before = await storedForms()
    expect(before[0]).toHaveLength(3)
    expect(before[1]).toHaveLength(2)
    const address = (slug: string) => `/api/v1/public/-/routing/${routingOwnerHandle}/${slug}`
    const publicForm = async (assembly: ReturnType<typeof app>, slug: string) => {
      const response = await assembly.request(address(slug))
      expect(response.headers.get('location')).toBeNull()
      return { status: response.status, body: await response.json() }
    }

    const enabled = await effectiveSetting('true')
    const liveMetadata = await publicForm(app(enabled), active.slug)
    expect(liveMetadata).toEqual({
      status: 200,
      body: { title: active.title, versionId: activeVersion.version.id, questions: [] },
    })
    const liveForm = await call('rest', token, 'get', { id: active.id }, enabled)
    const liveDraft = await call('rest', token, 'get', { id: draftOnly.id }, enabled)
    expect(liveForm.status).toBe(200)
    expect(liveDraft.status).toBe(200)

    const disabled = await effectiveSetting('false')
    const off = app(disabled)
    expect(await publicForm(off, active.slug)).toEqual({
      status: 404,
      body: { error: 'routing_forms_disabled' },
    })
    const submit = (assembly: ReturnType<typeof app>, versionId: string) =>
      assembly.request(`${address(active.slug)}/route`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionId, answers: {} }),
      })
    const refused = await submit(off, activeVersion.version.id)
    expect(refused.status).toBe(404)
    expect(refused.headers.get('location')).toBeNull()
    expect(await refused.json()).toEqual({ error: 'routing_forms_disabled' })
    expect(await call('rest', token, 'list', {}, disabled)).toMatchObject({
      status: 404,
      body: { error: 'routing_forms_disabled' },
    })
    expect(
      await call(
        'rest',
        token,
        'archive',
        {
          id: active.id,
          expectedRevision: edited.draftRevision,
        },
        disabled,
      ),
    ).toMatchObject({ status: 404, body: { error: 'routing_forms_disabled' } })
    expect(await storedForms()).toEqual(before)

    const restored = await effectiveSetting('true')
    const onAgain = app(restored)
    expect(await publicForm(onAgain, active.slug)).toEqual(liveMetadata)
    for (const unavailable of [draftOnly, archived]) {
      expect(await publicForm(onAgain, unavailable.slug)).toEqual({
        status: 404,
        body: { error: 'routing_form_not_found' },
      })
    }
    expect(await call('rest', token, 'get', { id: active.id }, restored)).toEqual(liveForm)
    expect(await call('rest', token, 'get', { id: draftOnly.id }, restored)).toEqual(liveDraft)
    const submitted = await submit(onAgain, activeVersion.version.id)
    expect(submitted.status).toBe(200)
    expect(submitted.headers.get('location')).toBeNull()
    expect(await submitted.json()).toMatchObject({
      kind: 'continuation',
      continuationUrl: expect.stringMatching(/\/route\/continue#token=/),
    })
    expect(await storedForms()).toEqual(before)

    const stale = await submit(onAgain, randomUUID())
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'routing_form_changed' })
    await db
      .updateTable('event_types')
      .set({ is_active: false })
      .where('id', '=', eventTypeId)
      .execute()
    const unavailable = await submit(onAgain, activeVersion.version.id)
    expect(unavailable.status).toBe(409)
    expect(unavailable.headers.get('location')).toBeNull()
    expect(await unavailable.json()).toEqual({ error: 'routing_unavailable' })
  })

  it('keeps the original continuation expiry and purges expired answers while routing is off', async () => {
    const principal = credentials.get(await credential(owner))
    if (!principal) throw new Error('Expected a persisted fixture key')
    const context = testContext(db, principal)
    const organizationId = context.principal.organization.id
    const eventTypeId = await createFixtures(db).eventType(organizationId, owner.id)
    const questionId = randomUUID()
    const form = await createRoutingForm(context, {
      ...draft(),
      questions: [{ id: questionId, type: 'short_text', label: 'Name' }],
      fallback: {
        kind: 'event',
        eventTypeId,
        mappings: [{ questionId, destination: { kind: 'inviteeName' } }],
      },
    })
    const publication = await publishRoutingForm(context, form.id, {
      expectedRevision: form.draftRevision,
    })
    await updateRoutingForm(context, form.id, {
      expectedRevision: publication.form.draftRevision,
      enabled: true,
    })

    // Base the simulated downtime on PostgreSQL's clock, which the real purge uses.
    const { timestamp } = await db
      .selectNoFrom(sql<Date>`statement_timestamp()`.as('timestamp'))
      .executeTakeFirstOrThrow()
    const now = Temporal.Instant.fromEpochMilliseconds(timestamp.getTime())
    let checkedAt = now.subtract({ minutes: 10 })
    const restart = async (setting: string) => {
      const routingFormsEnabled = await effectiveSetting(setting)
      return createApp({
        publicUrl,
        checkDb: async () => {},
        authHandler: async () => new Response(null, { status: 404 }),
        resolveCaller,
        routes: [
          routingContinuationRoutes({
            db,
            now: () => checkedAt,
            receiptNow: () => checkedAt,
            routingFormsEnabled,
            routingSecret,
          }),
        ],
      })
    }
    const on = await restart('true')
    const issue = async (issuedAt: Temporal.Instant) => {
      const outcome = await submitRoutingForm(
        {
          db,
          routingFormsEnabled: await effectiveSetting('true'),
          routingSecret,
          now: () => issuedAt,
        },
        { organizationId, formId: form.id },
        { versionId: publication.version.id, answers: { [questionId]: 'Original invitee name' } },
      )
      if (outcome.kind !== 'continuation')
        throw new Error('Expected a pending routing continuation')
      expect(outcome.expiresAt).toBe(issuedAt.add({ minutes: 30 }).toString())
      return outcome
    }
    const expiresDuringDowntime = await issue(now.subtract({ minutes: 35 }))
    const survivesDowntime = await issue(checkedAt)
    const resolve = async (application: ReturnType<typeof app>, routeToken: string) => {
      const response = await application.request('/api/v1/routing-continuations/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ routeToken }),
      })
      return { status: response.status, body: await response.json() }
    }
    const readReceipt = (routeToken: string) =>
      db
        .selectFrom('routing_receipts')
        .selectAll()
        .where('token_hash', '=', routingTokenDigest(routingSecret, 'continuation', routeToken))
        .executeTakeFirst()
    const expiredBefore = await readReceipt(expiresDuringDowntime.routeToken)
    const liveBefore = await readReceipt(survivesDowntime.routeToken)
    expect(expiredBefore).toMatchObject({
      answers_ciphertext: expect.any(Buffer),
      consumed_booking_id: null,
    })
    expect(liveBefore).toMatchObject({
      answers_ciphertext: expect.any(Buffer),
      consumed_booking_id: null,
    })
    expect((await resolve(on, expiresDuringDowntime.routeToken)).status).toBe(200)
    expect((await resolve(on, survivesDowntime.routeToken)).status).toBe(200)

    const off = await restart('false')
    for (const token of [expiresDuringDowntime.routeToken, survivesDowntime.routeToken]) {
      expect(await resolve(off, token)).toEqual({
        status: 404,
        body: { error: 'routing_forms_disabled' },
      })
    }
    checkedAt = now
    expect(await resolve(off, expiresDuringDowntime.routeToken)).toEqual({
      status: 404,
      body: { error: 'routing_forms_disabled' },
    })
    expect(await readReceipt(expiresDuringDowntime.routeToken)).toEqual(expiredBefore)
    expect(await readReceipt(survivesDowntime.routeToken)).toEqual(liveBefore)

    const onAgain = await restart('true')
    // A restart can precede the next worker sweep. The stored token is already unusable.
    expect(await resolve(onAgain, expiresDuringDowntime.routeToken)).toEqual({
      status: 409,
      body: { error: 'routing_unavailable' },
    })
    expect(await readReceipt(expiresDuringDowntime.routeToken)).toEqual(expiredBefore)

    await purgeExpiredRoutingReceipts(db)
    expect(await readReceipt(expiresDuringDowntime.routeToken)).toBeUndefined()
    expect(await resolve(onAgain, survivesDowntime.routeToken)).toMatchObject({
      status: 200,
      body: {
        expiresAt: survivesDowntime.expiresAt,
        prefill: { inviteeName: 'Original invitee name' },
      },
    })
    expect(await readReceipt(survivesDowntime.routeToken)).toEqual(liveBefore)
  })

  it('resolves only the selected event over REST, MCP and CLI and refuses every token while off', async () => {
    const fixtures = createFixtures(db)
    const principal = credentials.get(await credential(owner))
    if (!principal) throw Error('Expected a persisted fixture key')
    const ownerContext = testContext(db, principal)
    const organizationId = owner.principal.organization.id
    const slug = 'private-routing-continuation-event'
    const questionId = randomUUID()
    const eventTypeId = await fixtures.eventType(organizationId, owner.id, {
      slug,
      title: 'Selected appointment',
      questions: [{ id: questionId, type: 'short_text', label: 'Company', required: true }],
    })
    await db
      .updateTable('event_types')
      .set({ is_hidden: true })
      .where('id', '=', eventTypeId)
      .execute()
    const scheduleId = await fixtures.schedule(owner.id, { timeZone: 'UTC', isDefault: false })
    await db
      .updateTable('event_type_hosts')
      .set({ schedule_id: scheduleId })
      .where('event_type_id', '=', eventTypeId)
      .execute()
    const nameId = randomUUID()
    const form = await createRoutingForm(ownerContext, {
      ...draft(),
      questions: [{ id: nameId, type: 'short_text', label: 'Name' }],
      fallback: {
        kind: 'event',
        eventTypeId,
        mappings: [{ questionId: nameId, destination: { kind: 'inviteeName' } }],
      },
    })
    const published = await publishRoutingForm(ownerContext, form.id, {
      expectedRevision: form.draftRevision,
    })
    await updateRoutingForm(ownerContext, form.id, {
      expectedRevision: published.form.draftRevision,
      enabled: true,
    })
    const issue = async (now?: () => Temporal.Instant) => {
      const result = await submitRoutingForm(
        { db, routingSecret, routingFormsEnabled: true, ...(now && { now }) },
        { organizationId, formId: form.id },
        { versionId: published.version.id, answers: { [nameId]: 'Routed invitee' } },
      )
      if (result.kind !== 'continuation') throw Error('Expected a continuation')
      return result
    }
    const valid = await issue()
    const expired = await issue(() => Temporal.Now.instant().subtract({ hours: 1 }))
    const unknown = 'z'.repeat(43)
    const receiptState = () =>
      db
        .selectFrom('routing_receipts')
        .selectAll()
        .where('form_id', '=', form.id)
        .orderBy('id')
        .execute()
    const before = await receiptState()
    expect(before).toHaveLength(2)

    const enabled = app()
    const off = app(false)
    const key = await credential(outsider, 'bookings')
    const readKey = await credential(outsider, 'read')
    const nextWeek = Temporal.Now.plainDateISO('UTC').add({ days: 7 })
    const monday = nextWeek.add({ days: (8 - nextWeek.dayOfWeek) % 7 })
    const range = { start: `${monday}T09:00:00Z`, end: `${monday}T10:00:00Z` }
    for (const [command, name] of [
      ['resolve', 'resolve_routing_continuation'],
      ['slots', 'find_routed_slots'],
    ] as const) {
      const input = (routeToken: string) => ({ routeToken, ...(command === 'slots' && range) })
      const rest = async (
        application: ReturnType<typeof app>,
        routeToken: string,
        authorization?: string,
      ) => {
        const response = await application.request(`/api/v1/routing-continuations/${command}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(authorization && { authorization: `Bearer ${authorization}` }),
          },
          body: JSON.stringify(input(routeToken)),
        })
        expect(response.headers.get('Cache-Control')).toBe('no-store')
        expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
        return { status: response.status, body: await response.json() }
      }
      const mcp = (application: ReturnType<typeof app>, routeToken: string, credential = key) =>
        rpc(application, credential, 'tools/call', { name, arguments: input(routeToken) })

      const tokens = [valid.routeToken, expired.routeToken, unknown]
      expect(await Promise.all(tokens.map((token) => rest(off, token)))).toEqual(
        tokens.map(() => ({ status: 404, body: { error: 'routing_forms_disabled' } })),
      )
      for (const token of tokens) {
        const result = await mcp(off, token, readKey)
        expect(result.isError).toBe(true)
        expect(JSON.parse(result.content[0].text)).toEqual({ error: 'routing_forms_disabled' })
        expect(await callCli(off, key, command, input(token))).toEqual({
          ok: false,
          body: { error: 'routing_forms_disabled', outcomeMayBeUnknown: true },
        })
      }
      expect((await rpc(off, key, 'tools/list')).tools).not.toContainEqual(
        expect.objectContaining({ name }),
      )
      expect(await receiptState()).toEqual(before)

      const accepted = await rest(enabled, valid.routeToken)
      expect(accepted.status).toBe(200)
      const { body } = accepted
      expect(await rest(enabled, valid.routeToken, readKey)).toMatchObject({
        status: 403,
        body: { error: 'insufficient_scope' },
      })
      for (const token of [expired.routeToken, unknown, 'malformed']) {
        expect(await rest(enabled, token)).toEqual({
          status: 409,
          body: { error: 'routing_unavailable' },
        })
      }
      expect((await rpc(enabled, key, 'tools/list')).tools).toContainEqual(
        expect.objectContaining({
          name,
          annotations: expect.objectContaining({ readOnlyHint: true }),
        }),
      )
      expect((await mcp(enabled, valid.routeToken)).structuredContent).toEqual(body)
      expect(await callCli(enabled, key, command, input(valid.routeToken))).toEqual({
        ok: true,
        body,
      })
      expect(JSON.stringify(body)).not.toContain(slug)
      expect(JSON.stringify(body)).not.toContain(eventTypeId)
      if (command === 'resolve') {
        expect(body).toEqual({
          eventType: {
            title: 'Selected appointment',
            description: null,
            durationMinutes: 30,
            location: null,
            locations: null,
            questions: [{ id: questionId, type: 'short_text', label: 'Company', required: true }],
            allowGuests: false,
            smsRemindersEnabled: false,
            host: { name: 'Owner', timeZone: 'UTC' },
          },
          prefill: { inviteeName: 'Routed invitee', responses: {} },
          expiresAt: valid.expiresAt,
        })
      } else {
        const ordinary = await enabled.request(
          `/api/v1/public/${routingOwnerHandle}/${slug}/slots?${new URLSearchParams(range)}`,
        )
        expect(ordinary.status).toBe(200)
        const { data } = (await ordinary.json()) as { data: unknown[] }
        expect(data).toHaveLength(2)
        expect(body).toEqual({ slots: data })
      }
      expect(await receiptState()).toEqual(before)
    }
  })

  async function previewSideEffects(id: string) {
    const { rows } = await owned.pool.query<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM routing_forms) AS forms,
              (SELECT count(*)::int FROM routing_form_versions) AS versions,
              (SELECT count(*)::int FROM routing_form_operations) AS operations,
              (SELECT count(*)::int FROM routing_target_dependencies) AS dependencies,
              (SELECT count(*)::int FROM routing_receipts) AS receipts,
              (SELECT count(*)::int FROM booking_routing) AS booking_routing,
              (SELECT count(*)::int FROM bookings) AS bookings,
              (SELECT count(*)::int FROM notification_email_sends) AS email_sends,
              (SELECT count(*)::int FROM sms_deliveries) AS sms_deliveries,
              (SELECT count(*)::int FROM webhook_deliveries) AS webhook_deliveries,
              (SELECT count(*)::int FROM audit_events) AS audit_events`,
    )
    return {
      counts: rows[0],
      form: await db
        .selectFrom('routing_forms')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst(),
    }
  }

  for (const surface of ['rest', 'mcp', 'cli'] as const) {
    it(`${surface}: creates, replays, lists, updates and archives with revision conflicts`, async () => {
      const token = await credential(owner)
      const input = { ...draft(), requestId: randomUUID() }
      const created = await call(surface, token, 'create', input)
      for (const invalid of [
        { ...draft(), unexpected: true },
        { ...draft(), fallback: { kind: 'message', message: 'Thanks', unexpected: true } },
      ]) {
        const rejected = await call(surface, token, 'create', invalid)
        expect(rejected.ok).toBe(false)
        expect(rejected.body.error).toBe('invalid_request')
      }
      expect(created.ok).toBe(true)
      const form = created.body as RoutingForm
      expect(form).toMatchObject({
        title: input.title,
        draftRevision: 1,
        enabled: false,
        health: null,
      })
      expect(await call(surface, token, 'create', input)).toEqual(created)
      expect(
        (await call(surface, token, 'create', { ...input, title: 'Different' })).body.error,
      ).toBe('idempotency_key_reused')
      expect((await call(surface, token, 'get', { id: form.id })).body).toEqual(form)
      expect((await call(surface, token, 'list')).body.data).toContainEqual(
        expect.objectContaining({ id: form.id, health: null }),
      )
      expect(
        (
          await call(surface, token, 'update', {
            id: form.id,
            expectedRevision: 1,
            title: 'Updated',
          })
        ).body,
      ).toMatchObject({ title: 'Updated', draftRevision: 2 })
      for (const op of ['update', 'archive'] as const)
        expect(
          (await call(surface, token, op, { id: form.id, expectedRevision: 1 })).body.error,
        ).toBe('routing_revision_conflict')
      expect((await call(surface, token, 'archive', { id: form.id, expectedRevision: 2 })).ok).toBe(
        true,
      )
      expect((await call(surface, token, 'get', { id: form.id })).body.error).toBe(
        'routing_form_not_found',
      )
      expect((await call(surface, token, 'list')).body.data).not.toContainEqual(
        expect.objectContaining({ id: form.id }),
      )
    })

    it(`${surface}: uses live team roles, organization isolation and key scopes`, async () => {
      const ownerKey = await credential(owner, 'full', team.as(owner).organization)
      const form = (await call(surface, ownerKey, 'create', draft())).body as RoutingForm
      for (const user of [owner, admin, member, outsider]) {
        for (const scope of ['full', 'read', 'bookings'] as const) {
          const token = await credential(user, scope, team.as(user).organization)
          for (const op of operations) {
            const input =
              op === 'list'
                ? {}
                : op === 'create'
                  ? draft()
                  : op === 'get'
                    ? { id: form.id }
                    : op === 'preview'
                      ? { id: form.id, answers: {} }
                      : { id: form.id, expectedRevision: 9999 }
            const result = await call(surface, token, op, input)
            const allowedScope =
              scope === 'full' || (scope === 'read' && (op === 'list' || op === 'get'))
            if (!allowedScope) expect(result.body.error).toBe('insufficient_scope')
            else if (user === member || user === outsider)
              expect(result.body.error).toBe('team_management_access_denied')
            else if (op === 'update' || op === 'archive' || op === 'publish')
              expect(result.body.error).toBe('routing_revision_conflict')
            else expect(result.ok).toBe(true)
          }
        }
      }
      const foreign = await credential(outsider)
      const missing = randomUUID()
      for (const id of [form.id, missing])
        for (const op of ['get', 'update', 'archive', 'publish'] as const)
          expect(
            (await call(surface, foreign, op, op === 'get' ? { id } : { id, expectedRevision: 1 }))
              .body.error,
          ).toBe('routing_form_not_found')
      const foreignPreview = await call(surface, foreign, 'preview', { id: form.id, answers: {} })
      expect(foreignPreview).toMatchObject({
        ok: false,
        body: { error: 'routing_form_not_found' },
      })
      expect(await call(surface, foreign, 'preview', { id: missing, answers: {} })).toEqual(
        foreignPreview,
      )
      const adminKey = await credential(admin, 'full', team.as(admin).organization)
      expect(
        (
          await call(surface, adminKey, 'update', {
            id: form.id,
            expectedRevision: 1,
            title: 'Admin edited',
          })
        ).ok,
      ).toBe(true)
      expect(
        (await call(surface, adminKey, 'archive', { id: form.id, expectedRevision: 2 })).ok,
      ).toBe(true)
      expect(await call(surface, adminKey, 'preview', { id: form.id, answers: {} })).toMatchObject({
        ok: false,
        body: { error: 'routing_form_not_found' },
      })
    })

    it(`${surface}: derives rule and fallback health even when invalidation was missed`, async () => {
      const token = await credential(owner)
      const principal = credentials.get(token) as Principal
      const event = await createFixtures(db).eventType(principal.organization.id, owner.id)
      const questionId = randomUUID()
      const ruleId = randomUUID()
      const form = (
        await call(surface, token, 'create', {
          ...draft(),
          questions: [{ id: questionId, type: 'short_text', label: 'Company' }],
          rules: [
            {
              id: ruleId,
              conditions: [{ questionId, operator: 'equals', value: 'Example' }],
              target: { kind: 'event', eventTypeId: event },
            },
          ],
          fallback: { kind: 'event', eventTypeId: event },
        })
      ).body as RoutingForm
      await publishRoutingForm(testContext(db, principal), form.id, { expectedRevision: 1 })
      await db
        .updateTable('event_types')
        .set({ is_active: false })
        .where('id', '=', event)
        .execute()
      expect(
        (
          await db
            .selectFrom('routing_target_dependencies')
            .select('health_code')
            .where('event_type_id', '=', event)
            .execute()
        ).map((r) => r.health_code),
      ).toEqual(['ok', 'ok'])
      const detail = (await call(surface, token, 'get', { id: form.id })).body as RoutingForm
      expect(detail.health).toMatchObject({
        status: 'unavailable',
        targets: [
          { ruleId, health: 'unavailable', reason: 'disabled' },
          { ruleId: 'fallback', health: 'unavailable', reason: 'disabled' },
        ],
      })
      expect((await call(surface, token, 'list')).body.data).toContainEqual(
        expect.objectContaining({ id: form.id, health: 'unavailable' }),
      )
    })

    it(`${surface}: publishes once and returns the original version on a same-input retry`, async () => {
      const token = await credential(owner)
      const { body: form } = await call(surface, token, 'create', draft())
      const input = { id: form.id, expectedRevision: 1, requestId: randomUUID() }
      for (const invalid of [
        { id: form.id, requestId: input.requestId },
        { ...input, requestId: 'invalid' },
        { ...input, enabled: true },
      ]) {
        expect(await call(surface, token, 'publish', invalid)).toMatchObject({
          ok: false,
          body: { error: 'invalid_request' },
        })
      }
      const published = await call(surface, token, 'publish', input)
      expect(published.ok).toBe(true)
      if (surface === 'rest') expect(published.status).toBe(201)
      expect(published.body).toMatchObject({
        form: { id: form.id, draftRevision: 2, enabled: false, publishedVersionNumber: 1 },
        version: { formId: form.id, versionNumber: 1, fallback: form.fallback },
      })
      expect(published.body.form.publishedVersionId).toBe(published.body.version.id)
      expect(await call(surface, token, 'publish', input)).toEqual(published)
      expect(
        await call(surface, token, 'publish', { ...input, expectedRevision: 2 }),
      ).toMatchObject({
        ok: false,
        body: { error: 'idempotency_key_reused' },
      })
      expect(
        await call(surface, token, 'publish', { id: form.id, expectedRevision: 1 }),
      ).toMatchObject({
        ok: false,
        body: { error: 'routing_revision_conflict' },
      })
      expect(await versions(form.id)).toEqual([{ id: published.body.version.id }])
    })

    it(`${surface}: reauthorizes publication retries and previews against current membership`, async () => {
      const space = await createTestTeam(db, [
        { user: owner, role: 'owner' },
        { user: admin, role: 'admin' },
      ])
      const token = await credential(admin, 'full', space.as(admin).organization)
      const { body: form } = await call(surface, token, 'create', draft())
      const input = { id: form.id, expectedRevision: 1, requestId: randomUUID() }
      const published = await call(surface, token, 'publish', input)
      expect(published.ok).toBe(true)
      const preview = { id: form.id, answers: {} }
      expect((await call(surface, token, 'preview', preview)).ok).toBe(true)
      await db
        .updateTable('auth.member')
        .set({ role: 'member' })
        .where('organizationId', '=', space.id)
        .where('userId', '=', admin.id)
        .execute()
      expect(await call(surface, token, 'publish', input)).toMatchObject({
        ok: false,
        body: { error: 'team_management_access_denied' },
      })
      expect(await call(surface, token, 'preview', preview)).toMatchObject({
        ok: false,
        body: { error: 'team_management_access_denied' },
      })
      expect(await versions(form.id)).toEqual([{ id: published.body.version.id }])
    })

    it(`${surface}: previews the current draft with evaluator parity and no side effects`, async () => {
      const token = await credential(owner)
      const created = await call(surface, token, 'create', draft())
      expect(created.ok).toBe(true)
      const { id } = created.body as RoutingForm
      expect((await call(surface, token, 'publish', { id, expectedRevision: 1 })).ok).toBe(true)

      const eventTypeId = await createFixtures(db).eventType(
        owner.principal.organization.id,
        owner.id,
      )
      const company = randomUUID()
      const topic = randomUUID()
      const first = randomUUID()
      const second = randomUUID()
      const third = randomUUID()
      const matchCompany = { questionId: company, operator: 'equals', value: 'Café Co' }
      const fallback = { kind: 'message', message: 'Contact our team' }
      const updated = await call(surface, token, 'update', {
        id,
        expectedRevision: 2,
        questions: [
          { id: company, type: 'short_text', label: 'Company', required: true },
          { id: topic, type: 'short_text', label: 'Topic' },
        ],
        rules: [
          {
            id: first,
            conditions: [matchCompany, { questionId: topic, operator: 'equals', value: 'sales' }],
            target: { kind: 'message', message: 'Speak to sales' },
          },
          {
            id: second,
            conditions: [matchCompany],
            target: {
              kind: 'event',
              eventTypeId,
              mappings: [{ questionId: company, destination: { kind: 'inviteeName' } }],
            },
          },
          {
            id: third,
            conditions: [matchCompany],
            target: { kind: 'message', message: 'This rule also matches' },
          },
        ],
        fallback,
      })
      expect(updated.ok).toBe(true)
      const current = updated.body as RoutingForm
      expect(current).toMatchObject({ draftRevision: 3, publishedVersionNumber: 1, enabled: false })
      const before = await previewSideEffects(id)
      const answers = { [company]: '  Cafe\u0301 Co  ', [topic]: null }
      const input = { id, answers }
      vi.mocked(evaluateRoutingForm).mockClear()
      const result = await call(surface, token, 'preview', input)
      expect(result.ok).toBe(true)
      if (surface === 'rest') expect(result.status).toBe(200)
      expect(evaluateRoutingForm).toHaveBeenCalled()
      const match = evaluateRoutingForm(current, validateRoutingAnswers(current.questions, answers))
      expect(match.ruleId).toBe(second)
      const rules = [
        {
          ruleId: first,
          matched: false,
          conditions: [
            { questionId: company, matched: true },
            { questionId: topic, matched: false },
          ],
        },
        { ruleId: second, matched: true, conditions: [{ questionId: company, matched: true }] },
      ]
      // Exact response also checks that no submitted answers or capabilities are returned.
      expect(result.body).toEqual({
        draftRevision: 3,
        matchedRuleId: match.ruleId,
        resolvedRuleId: match.ruleId,
        target: match.target,
        unavailableTargets: [],
        rules,
      })

      for (const invalid of [
        { id },
        { ...input, issueToken: true },
        { id, answers: [] },
        { id, answers: JSON.parse('{"__proto__":"invalid answer key"}') },
      ])
        expect(await call(surface, token, 'preview', invalid)).toMatchObject({
          ok: false,
          body: { error: 'invalid_request' },
        })
      const privateValue = 'synthetic preview answer to an unknown question'
      const rejected = await call(surface, token, 'preview', {
        id,
        answers: { ...answers, [randomUUID()]: privateValue },
      })
      expect(rejected).toMatchObject({
        ok: false,
        body: { error: 'invalid_routing_answers' },
      })
      if (surface !== 'cli') expect(rejected.body.message).toMatch(/^answers:/)
      expect(JSON.stringify(rejected.body)).not.toContain(privateValue)

      await db
        .updateTable('event_types')
        .set({ is_active: false })
        .where('id', '=', eventTypeId)
        .execute()
      expect(await call(surface, token, 'preview', input)).toMatchObject({
        ok: true,
        body: {
          draftRevision: 3,
          matchedRuleId: second,
          resolvedRuleId: 'fallback',
          target: fallback,
          unavailableTargets: [{ ruleId: second, reason: 'disabled' }],
          rules,
        },
      })
      expect(await previewSideEffects(id)).toEqual(before)
      expect(notify).not.toHaveBeenCalled()
    })

    it.each(['mapping', 'disabled', 'group', 'paid'] as const)(
      `${surface}: refuses a %s target changed after saving the draft`,
      async (problem) => {
        const token = await credential(owner)
        const event = await createFixtures(db).eventType(
          owner.principal.organization.id,
          owner.id,
          {
            questions: [{ id: 'company', label: 'Company', type: 'short_text', required: false }],
          },
        )
        const questionId = randomUUID()
        const saved = await call(surface, token, 'create', {
          ...draft(),
          questions: [{ id: questionId, type: 'short_text', label: 'Company' }],
          fallback: {
            kind: 'event',
            eventTypeId: event,
            mappings: [{ questionId, destination: { kind: 'question', questionId: 'company' } }],
          },
        })
        expect(saved.ok).toBe(true)
        const changes = {
          mapping: { questions: '[]' },
          disabled: { is_active: false },
          group: { booking_mode: 'group', group_capacity: 4 },
        }
        if (problem === 'paid') paymentRequired.add(event)
        else
          await db
            .updateTable('event_types')
            .set(changes[problem])
            .where('id', '=', event)
            .execute()
        try {
          const result = await call(surface, token, 'publish', {
            id: saved.body.id,
            expectedRevision: 1,
          })
          expect(result).toMatchObject({ ok: false, body: { error: 'invalid_routing_target' } })
          if (surface === 'rest') expect(result.status).toBe(400)
          expect(await versions(saved.body.id)).toEqual([])
        } finally {
          paymentRequired.delete(event)
        }
      },
    )

    it(`${surface}: off precedes validation, scopes and lookups and writes no rows`, async () => {
      const full = await credential(owner)
      const { body: form } = await call(surface, full, 'create', draft())
      const before = await db.selectFrom('routing_forms').select('id').execute()
      const off = await call(surface, full, 'publish', { id: form.id, expectedRevision: 1 }, false)
      expect(off).toMatchObject({ ok: false, body: { error: 'routing_forms_disabled' } })
      if (surface === 'rest') expect(off.status).toBe(404)
      vi.mocked(evaluateRoutingForm).mockClear()
      const preview = await call(surface, full, 'preview', { id: form.id, answers: {} }, false)
      expect(preview).toMatchObject({ ok: false, body: { error: 'routing_forms_disabled' } })
      if (surface === 'rest') expect(preview.status).toBe(404)
      for (const scope of ['full', 'read', 'bookings'] as const) {
        const token = await credential(owner, scope)
        for (const op of operations)
          for (const id of [randomUUID(), 'invalid']) {
            const result = await call(
              surface,
              token,
              op,
              op === 'list' ? { limit: -1 } : { id, unexpected: true },
              false,
            )
            expect(result.ok).toBe(false)
            expect(result.body.error).toBe('routing_forms_disabled')
          }
        const listed = await rpc(app(false), token, 'tools/list')
        expect(listed.tools.map((tool: { name: string }) => tool.name)).not.toEqual(
          expect.arrayContaining(Object.values(tools)),
        )
        for (const tool of listed.tools) expect(Object.values(tools)).not.toContain(tool.name)
      }
      expect(await db.selectFrom('routing_forms').select('id').execute()).toEqual(before)
      expect(await versions(form.id)).toEqual([])
      expect(evaluateRoutingForm).not.toHaveBeenCalled()
    })
  }

  it('requires authentication to preview and limits MCP discovery to full keys', async () => {
    const full = await credential(owner)
    const created = await call('rest', full, 'create', draft())
    expect(created.ok).toBe(true)
    const { id } = created.body as RoutingForm
    const application = app()
    vi.mocked(evaluateRoutingForm).mockClear()
    const rest = await application.request(`/api/v1/routing-forms/${id}/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: {} }),
    })
    expect(rest.status).toBe(401)
    expect(rest.headers.get('cache-control')).toBe('no-store')
    expect(await rest.json()).toEqual({ error: 'unauthorized' })
    const mcp = await application.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: tools.preview, arguments: { id, answers: {} } },
      }),
    })
    expect(mcp.status).toBe(401)
    expect(await mcp.json()).toMatchObject({ error: 'unauthorized' })
    expect(evaluateRoutingForm).not.toHaveBeenCalled()

    const listed = await rpc(application, full, 'tools/list')
    expect(
      listed.tools.find((tool: { name: string }) => tool.name === tools.preview),
    ).toMatchObject({
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    })
    for (const scope of ['read', 'bookings'] as const) {
      const scoped = await rpc(application, await credential(owner, scope), 'tools/list')
      expect(scoped.tools).not.toContainEqual(expect.objectContaining({ name: tools.preview }))
    }
  })

  it.each(['personal', 'team'] as const)(
    'reads only published %s metadata via MCP and CLI and refuses direct calls while off',
    async (kind) => {
      const organization =
        kind === 'personal' ? owner.principal.organization : team.as(owner).organization
      const token = await credential(owner, 'full', organization)
      const handle = routingOwnerHandle
      const eventTypeId = await createFixtures(db).eventType(
        organization.id,
        kind === 'personal' ? owner.id : null,
        { slug: 'private-target', hosts: [{ userId: owner.id }] },
      )
      await db
        .updateTable('event_types')
        .set({ is_hidden: true })
        .where('id', '=', eventTypeId)
        .execute()
      const questionId = randomUUID()
      const optionId = randomUUID()
      const questions = [
        {
          id: questionId,
          type: 'select',
          label: 'Published question',
          required: true,
          options: [{ id: optionId, label: 'Published option' }],
        },
      ]
      const created = await call('rest', token, 'create', {
        ...draft(),
        questions,
        rules: [
          {
            id: randomUUID(),
            conditions: [{ questionId, operator: 'equals', value: optionId }],
            target: { kind: 'event', eventTypeId },
          },
        ],
      })
      expect(created.ok).toBe(true)
      const { id, slug } = created.body as RoutingForm
      const published = await call('rest', token, 'publish', { id, expectedRevision: 1 })
      expect(published.ok).toBe(true)
      expect(
        (
          await call('rest', token, 'update', {
            id,
            expectedRevision: 2,
            enabled: true,
            title: 'Current form title',
            description: 'Public introduction',
            questions: [{ ...questions[0], label: 'Unpublished edit' }],
          })
        ).ok,
      ).toBe(true)

      const input = kind === 'personal' ? { handle, slug } : { teamSlug: organization.slug, slug }
      const unknown = { ...input, slug: 'missing-form' }
      const expected = {
        versionId: published.body.version.id,
        title: 'Current form title',
        description: 'Public introduction',
        questions,
      }
      const name = 'get_public_routing_form'
      const application = app()
      const off = app(false)
      const callTool = (instance: ReturnType<typeof app>, key: string, args: object) =>
        rpc(instance, key, 'tools/call', { name, arguments: args })
      const publicKey = await credential(outsider, 'read')
      const allowed = await callTool(application, publicKey, input)
      expect(allowed.isError).toBeFalsy()
      expect(allowed.structuredContent).toEqual(expected)
      expect(JSON.parse(allowed.content[0].text)).toEqual(expected)
      expect(await callCli(application, publicKey, 'public', input)).toEqual({
        ok: true,
        body: expected,
      })

      for (const args of [
        { slug },
        { handle, teamSlug: organization.slug, slug },
        { ...input, id },
      ]) {
        const invalid = await callTool(application, publicKey, args)
        expect(invalid.isError).toBe(true)
        expect(JSON.parse(invalid.content[0].text)).toHaveProperty('error', 'invalid_request')
      }

      const listed = await rpc(off, publicKey, 'tools/list')
      expect(listed.tools).not.toContainEqual(expect.objectContaining({ name }))
      for (const args of [input, unknown, { unexpected: true }]) {
        const disabled = await callTool(off, publicKey, args)
        expect(disabled.isError).toBe(true)
        expect(disabled.structuredContent).toBeUndefined()
        expect(JSON.parse(disabled.content[0].text)).toEqual({ error: 'routing_forms_disabled' })
      }
      expect(await callCli(off, publicKey, 'public', input)).toMatchObject({
        ok: false,
        body: { error: 'routing_forms_disabled' },
      })

      expect((await call('rest', token, 'archive', { id, expectedRevision: 3 })).ok).toBe(true)
      const archived = await callTool(application, publicKey, input)
      expect(archived.isError).toBe(true)
      expect(archived.structuredContent).toBeUndefined()
      expect(JSON.parse(archived.content[0].text)).toHaveProperty('error', 'routing_form_not_found')
      expect(await callTool(application, publicKey, unknown)).toEqual(archived)
    },
  )

  it.each(['personal', 'team'] as const)(
    'submits version-pinned %s answers over MCP and redacts the CLI receipt',
    async (kind) => {
      const principal = kind === 'personal' ? owner.principal : team.as(owner)
      const organization = principal.organization
      const adminKey = await credential(owner, 'full', organization)
      const handle = routingOwnerHandle
      const questionId = randomUUID()
      const answer = 'Synthetic routing answer'
      const eventTypeId = await createFixtures(db).eventType(
        organization.id,
        kind === 'personal' ? owner.id : null,
        { slug: `submission-${randomUUID()}`, hosts: [{ userId: owner.id }] },
      )
      const { body: form, ok: created } = await call('rest', adminKey, 'create', {
        ...draft(),
        questions: [{ id: questionId, type: 'short_text', required: false, label: 'Reason' }],
        rules: [
          {
            id: randomUUID(),
            conditions: [{ questionId, operator: 'equals', value: answer }],
            target: { kind: 'event', eventTypeId },
          },
        ],
      })
      expect(created).toBe(true)
      const { id, slug } = form as RoutingForm
      const published = await call('rest', adminKey, 'publish', { id, expectedRevision: 1 })
      expect(published.ok).toBe(true)
      expect(
        (await call('rest', adminKey, 'update', { id, expectedRevision: 2, enabled: true })).ok,
      ).toBe(true)

      const name = 'route_lead'
      const address = kind === 'personal' ? { handle, slug } : { teamSlug: organization.slug, slug }
      const args = {
        ...address,
        versionId: published.body.version.id,
        answers: { [questionId]: answer },
      }
      const application = app()
      const off = app(false)
      const route = (instance: ReturnType<typeof app>, key: string, input: object) =>
        rpc(instance, key, 'tools/call', { name, arguments: input })
      const keys = {
        bookings: await credential(outsider, 'bookings'),
        read: await credential(outsider, 'read'),
        full: await credential(outsider),
      }
      const error = (result: { isError: boolean; content: { text: string }[] }) => {
        expect(result.isError).toBe(true)
        return JSON.parse(result.content[0]?.text ?? '')
      }
      const receipts = () =>
        db.selectFrom('routing_receipts').select('version_id').where('form_id', '=', id).execute()

      expect((await rpc(off, keys.full, 'tools/list')).tools).not.toContainEqual(
        expect.objectContaining({ name }),
      )
      expect(error(await route(off, keys.bookings, args))).toEqual({
        error: 'routing_forms_disabled',
      })
      expect(error(await route(off, keys.read, { unexpected: true }))).toEqual({
        error: 'routing_forms_disabled',
      })
      expect(await receipts()).toEqual([])

      expect(error(await route(application, keys.read, args))).toHaveProperty(
        'error',
        'insufficient_scope',
      )
      for (const input of [
        { slug, versionId: args.versionId, answers: args.answers },
        { ...args, handle, teamSlug: organization.slug },
        { ...args, [answer]: true },
      ]) {
        expect(error(await route(application, keys.bookings, input))).toEqual({
          error: 'invalid_request',
          message: 'Invalid routing submission',
        })
      }
      const message = await route(application, keys.full, { ...args, answers: {} })
      expect(message.structuredContent).toEqual({ kind: 'message', message: 'Thank you' })
      expect(await receipts()).toEqual([])

      const receipt = await route(application, keys.bookings, args)
      expect(receipt.isError).toBeFalsy()
      const { routeToken } = receipt.structuredContent
      expect(receipt.structuredContent).toEqual({
        kind: 'continuation',
        routeToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        continuationUrl: `${publicUrl}/route/continue#token=${encodeURIComponent(routeToken)}`,
        expiresAt: expect.any(String),
      })
      expect(JSON.parse(receipt.content[0].text)).toEqual(receipt.structuredContent)
      expect(await callCli(application, keys.bookings, 'route', args)).toEqual({
        ok: true,
        body: {
          kind: 'continuation',
          routeToken: '[redacted]',
          continuationUrl: '[redacted]',
          expiresAt: expect.any(String),
        },
      })
      const issued = [{ version_id: args.versionId }, { version_id: args.versionId }]
      expect(await receipts()).toEqual(issued)

      const republished = await call('rest', adminKey, 'publish', { id, expectedRevision: 3 })
      expect(republished.ok).toBe(true)
      expect(error(await route(application, keys.bookings, args))).toEqual({
        error: 'routing_form_changed',
      })
      expect(await receipts()).toEqual(issued)
    },
  )

  it('accepts same-origin session preview and honors an expected organization', async () => {
    const created = await call('rest', await credential(owner), 'create', draft())
    expect(created.ok).toBe(true)
    const { id } = created.body as RoutingForm
    const cookie = await session(owner)
    const application = app()
    const send = (headers: Record<string, string>) =>
      application.request(`/api/v1/routing-forms/${id}/preview`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ answers: {} }),
      })
    expect((await send({ origin: publicUrl })).status).toBe(200)
    expect(
      (
        await send({
          referer: `${publicUrl}/app`,
          'x-expected-organization-id': owner.principal.organization.id,
        })
      ).status,
    ).toBe(200)
    const crossOrigin = await send({ origin: 'https://untrusted.example' })
    expect(crossOrigin.status).toBe(403)
    const wrongSpace = await send({
      origin: publicUrl,
      'x-expected-organization-id': outsider.principal.organization.id,
    })
    expect(wrongSpace.status).toBe(403)
    expect(await wrongSpace.json()).toMatchObject({ error: 'team_management_access_denied' })
  })

  it('returns identical REST and MCP diagnostics for UUIDs accepted by draft storage', async () => {
    const token = await credential(owner)
    const principal = credentials.get(token) as Principal
    const eventTypeId = await createFixtures(db).eventType(
      owner.principal.organization.id,
      owner.id,
    )
    const questionId = '11111111-1111-1111-1111-111111111111'
    const ruleId = '22222222-2222-2222-2222-222222222222'
    const form = await createRoutingForm(testContext(db, principal), {
      ...draft(),
      questions: [{ id: questionId, type: 'short_text', label: 'Company' }],
      rules: [
        {
          id: ruleId,
          conditions: [{ questionId, operator: 'equals', value: 'Cobalt' }],
          target: {
            kind: 'event',
            eventTypeId,
            mappings: [{ questionId, destination: { kind: 'inviteeName' } }],
          },
        },
      ],
    })
    const input = { id: form.id, answers: { [questionId]: 'Cobalt' } }
    const rest = await call('rest', token, 'preview', input)
    expect(rest.body).toMatchObject({ matchedRuleId: ruleId, resolvedRuleId: ruleId })
    const mcp = await call('mcp', token, 'preview', input)
    expect(mcp.ok).toBe(true)
    expect(mcp.body).toEqual(rest.body)
  })

  it('supports all configuration operations through the generated web client contract', async () => {
    const token = await credential(owner)
    const application = app()
    const client = createClient<paths>({
      baseUrl: publicUrl,
      headers: { authorization: `Bearer ${token}` },
      fetch: async (request) => application.request(request),
    })
    const created = await client.POST('/api/v1/routing-forms', {
      body: {
        slug: `client-${randomUUID()}`,
        title: 'Client form',
        fallback: { kind: 'message', message: 'Thanks' },
      },
    })
    expect(created.response.status).toBe(201)
    const id = created.data?.id as string
    const got = await client.GET('/api/v1/routing-forms/{id}', { params: { path: { id } } })
    expect(got.data).toEqual(created.data)
    const listed = await client.GET('/api/v1/routing-forms', { params: { query: { limit: 100 } } })
    expect(listed.data?.data).toContainEqual(expect.objectContaining({ id }))
    const updated = await client.PATCH('/api/v1/routing-forms/{id}', {
      params: { path: { id } },
      body: { expectedRevision: 1, title: 'Client update' },
    })
    expect(updated.data?.draftRevision).toBe(2)
    const published = await client.POST('/api/v1/routing-forms/{id}/publish', {
      params: { path: { id } },
      body: { expectedRevision: 2, requestId: randomUUID() },
    })
    expect(published.response.status).toBe(201)
    expect(published.data?.version.formId).toBe(id)
    expect(published.data?.form.publishedVersionId).toBe(published.data?.version.id)
    const preview = await client.POST('/api/v1/routing-forms/{id}/preview', {
      params: { path: { id } },
      body: { answers: {} },
    })
    expect(preview.response.status).toBe(200)
    expect(preview.data).toMatchObject({
      draftRevision: 3,
      matchedRuleId: 'fallback',
      resolvedRuleId: 'fallback',
      target: { kind: 'message', message: 'Thanks' },
    })
    const activated = await client.PATCH('/api/v1/routing-forms/{id}', {
      params: { path: { id } },
      body: { expectedRevision: 3, enabled: true },
    })
    expect(activated.data?.draftRevision).toBe(4)
    const submit = () =>
      application.request(
        `/api/v1/public/-/routing/${routingOwnerHandle}/${created.data?.slug}/route`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ versionId: published.data?.version.id, answers: {} }),
        },
      )
    const beforeArchive = await submit()
    expect(beforeArchive.status).toBe(200)
    expect(await beforeArchive.json()).toEqual({ kind: 'message', message: 'Thanks' })

    const archived = await client.DELETE('/api/v1/routing-forms/{id}', {
      params: { path: { id } },
      body: { expectedRevision: 4 },
    })
    expect(archived.response.status).toBe(204)
    const afterArchive = await client.GET('/api/v1/routing-forms', {
      params: { query: { limit: 100 } },
    })
    expect(afterArchive.response.status).toBe(200)
    expect(afterArchive.data?.data).not.toContainEqual(expect.objectContaining({ id }))
    const rejected = await submit()
    expect(rejected.status).toBe(404)
    expect(await rejected.json()).toEqual({ error: 'routing_form_not_found' })
  })

  it('fences session writes by Origin/Referer and the expected organization', async () => {
    const cookie = await session(owner)
    const application = app()
    const send = (headers: Record<string, string>, formId?: string) =>
      application.request(
        formId ? `/api/v1/routing-forms/${formId}/publish` : '/api/v1/routing-forms',
        {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json', ...headers },
          body: JSON.stringify(formId ? { expectedRevision: 1 } : draft()),
        },
      )
    const expected = { 'x-expected-organization-id': owner.principal.organization.id }
    expect((await send({ ...expected, origin: publicUrl })).status).toBe(201)
    const created = await send({ ...expected, referer: `${publicUrl}/app` })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    for (const formId of [undefined, id]) {
      expect(
        (await send({ ...expected, origin: 'https://untrusted.example' }, formId)).status,
      ).toBe(403)
      expect(
        (await send({ ...expected, referer: 'https://untrusted.example/page' }, formId)).status,
      ).toBe(403)
      expect(await (await send({ origin: publicUrl }, formId)).json()).toMatchObject({
        error: 'organization_context_changed',
      })
      expect(
        await (
          await send(
            {
              origin: publicUrl,
              'x-expected-organization-id': outsider.principal.organization.id,
            },
            formId,
          )
        ).json(),
      ).toMatchObject({ error: 'team_management_access_denied' })
    }
    expect(await versions(id)).toEqual([])
    expect((await send({ ...expected, origin: publicUrl }, id)).status).toBe(201)
  })
})
