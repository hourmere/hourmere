import { randomUUID } from 'node:crypto'
import type { CallerResolver, Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import createClient from 'openapi-fetch'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RoutingForm } from '../../../../packages/scheduling/src/routing-form-service.ts'
import type { components, paths } from '../../../web/src/api/schema.d.ts'
import { createApp } from '../app.ts'
import { chunkedBody } from '../chunked-body.ts'
import { productRoutes } from '../server.ts'
import { publicRoutes } from './public.ts'
import {
  escapedJson,
  openApiDocument,
  responseAndRequestStrictness,
  syntheticSessionCookie,
} from './test-app.ts'

const publicUrl = 'https://routing.example.test'
const routingSecret = 'synthetic-public-routing-receipt-fixture'
const personalTemplate = '/api/v1/public/-/routing/{handle}/{slug}'
const teamTemplate = '/api/v1/public/-/routing/teams/{teamSlug}/{slug}'
const personalSubmissionTemplate = `${personalTemplate}/route` as const
const teamSubmissionTemplate = `${teamTemplate}/route` as const
const personalPath = '/api/v1/public/-/routing/route/consultation'
const teamPath = '/api/v1/public/-/routing/teams/Advisory/consultation'
const readPaths = [personalPath, teamPath]
const submissionPaths = readPaths.map((path) => `${path}/route`)
const formNotFound = { error: 'routing_form_not_found' }
const disabled = { error: 'routing_forms_disabled' }
const unauthorized = { ok: false, error: 'unauthorized', setCookie: [] } as const

function app(
  routes: NonNullable<Parameters<typeof createApp>[0]['routes']>,
  resolveCaller?: CallerResolver,
) {
  return createApp({
    publicUrl,
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller: resolveCaller ?? (async () => ({ ...unauthorized, setCookie: [] })),
    routes,
  })
}

function product(db: Db, routingFormsEnabled?: boolean) {
  return productRoutes({
    db,
    publicUrl,
    routingSecret,
    notify: async () => {},
    socialProviders: {},
    invitationMailLimits: { secret: 'synthetic-public-routing-fixture' },
    meetingPollSecret: 'synthetic-poll-collision-fixture',
    ...(routingFormsEnabled === undefined ? {} : { routingFormsEnabled }),
  })
}

function post(
  server: ReturnType<typeof createApp>,
  path: string,
  body: string,
  headers: Record<string, string> = {},
) {
  return server.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

async function assertReply(response: Response, status: number, body: unknown) {
  expect(response.status).toBe(status)
  expect(await response.json()).toEqual(body)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
}

describe('public routing form REST transport', () => {
  it('documents both operations with optional bearer authentication and a single public schema', async () => {
    const doc = await openApiDocument(app(product({} as Db)))
    for (const [path, operationId, addressParameter] of [
      [personalTemplate, 'getPublicRoutingForm', 'handle'],
      [teamTemplate, 'getPublicTeamRoutingForm', 'teamSlug'],
    ] as const) {
      expect(Object.keys(doc.paths[path] ?? {})).toEqual(['get'])
      expect(doc.paths[path]?.get).toMatchObject({
        operationId,
        security: [{}, { apiKey: [] }],
        parameters: [
          { name: addressParameter, in: 'path', required: true },
          { name: 'slug', in: 'path', required: true },
        ],
        responses: {
          200: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PublicRoutingForm' } },
            },
          },
          401: {},
          403: {},
          404: { description: expect.stringContaining('routing_forms_disabled') },
          429: {},
        },
      })
    }
    expect(Object.keys(doc.components.schemas.PublicRoutingForm?.properties ?? {}).sort()).toEqual([
      'description',
      'questions',
      'title',
      'versionId',
    ])
  })

  it('documents strict submission requests and both public outcomes on both routes', async () => {
    const doc = await openApiDocument(app(product({} as Db)))
    for (const [path, operationId, addressParameter] of [
      [personalSubmissionTemplate, 'routeLead', 'handle'],
      [teamSubmissionTemplate, 'routeTeamLead', 'teamSlug'],
    ] as const) {
      expect(Object.keys(doc.paths[path] ?? {})).toEqual(['post'])
      expect(doc.paths[path]?.post).toMatchObject({
        operationId,
        security: [{}, { apiKey: [] }],
        parameters: [
          { name: addressParameter, in: 'path', required: true },
          { name: 'slug', in: 'path', required: true },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/RoutingSubmission' } },
          },
        },
        responses: {
          200: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RoutingSubmissionResponse' },
              },
            },
          },
          400: {},
          401: {},
          403: {},
          404: { description: expect.stringContaining('routing_forms_disabled') },
          409: { description: expect.stringContaining('routing_form_changed') },
          413: {},
          429: {},
        },
      })
    }
    expect(
      responseAndRequestStrictness(doc, [personalSubmissionTemplate, teamSubmissionTemplate]),
    ).toEqual({ closedResponses: [], openRequests: [] })
    expect(doc.components.schemas.RoutingSubmissionResponse).toMatchObject({
      oneOf: [
        { required: ['kind', 'message'] },
        { required: ['kind', 'routeToken', 'expiresAt', 'continuationUrl'] },
      ],
    })
  })

  it.each(readPaths)(
    'counts credential and off-state refusals in the shared page bucket from %s',
    async (first) => {
      const resolveCaller = vi.fn<CallerResolver>(async () => ({ ...unauthorized, setCookie: [] }))
      const server = app(
        [publicRoutes({ db: {} as Db, rateLimits: { page: { limit: 2, windowSeconds: 60 } } })],
        resolveCaller,
      )
      const other = first === personalPath ? teamPath : personalPath
      await assertReply(
        await server.request(first, { headers: { authorization: 'Bearer hm_invalid' } }),
        401,
        { error: 'unauthorized' },
      )
      await assertReply(await server.request(other), 404, disabled)
      for (const path of readPaths) {
        const response = await server.request(path, {
          headers: { authorization: 'Bearer hm_invalid', 'X-Forwarded-For': '203.0.113.20' },
        })
        expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0)
        await assertReply(response, 429, { error: 'rate_limited' })
      }
      expect((await server.request('/api/v1/public/route/consultation')).status).toBe(429)
      expect(resolveCaller).toHaveBeenCalledTimes(1)
    },
  )

  it('redacts public routing addresses and unexpected error details from server logs', async () => {
    const detail = 'synthetic-sensitive-routing-diagnostic'
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const server = app(product({} as Db, true), async () => {
        throw new Error(detail)
      })
      for (const path of readPaths) {
        await assertReply(
          await server.request(`${path}?diagnostic=${detail}`, {
            headers: { authorization: 'Bearer hm_invalid' },
          }),
          500,
          { error: 'internal_error' },
        )
      }
      const encodedPath = '/api/v1/public/%2d/%72outing/ada/encoded-secret'
      const encoded = await server.request(`${encodedPath}?diagnostic=${detail}`)
      expect(encoded.headers.get('Referrer-Policy')).toBe('no-referrer')
      expect(encoded.headers.get('Cache-Control')).toBe('no-store')
      expect(log.mock.calls).toEqual([])
      expect(error.mock.calls.length).toBeGreaterThanOrEqual(2)
      for (const [line] of error.mock.calls) {
        expect(line).toContain('/api/v1/public/-/routing/[redacted]')
        expect(line).not.toContain('consultation')
        expect(line).not.toContain('encoded-secret')
        expect(line).not.toContain(detail)
      }
    } finally {
      error.mockRestore()
      log.mockRestore()
    }
  })

  it.each(submissionPaths)(
    'shares the submission bucket and counts every refusal from %s before reading a body',
    async (path) => {
      const server = app([
        publicRoutes({
          db: {} as Db,
          routingFormsEnabled: true,
          routingSecret,
          rateLimits: { routingSubmission: { limit: 3, windowSeconds: 60 } },
        }),
      ])
      const other = submissionPaths.find((candidate) => candidate !== path) as string
      const refused = await post(server, path, '{}', { authorization: 'Bearer hm_invalid' })
      expect(refused.headers.get('WWW-Authenticate')).toBe('Bearer')
      await assertReply(refused, 401, { error: 'unauthorized' })
      await assertReply(await post(server, other, '{}'), 400, { error: 'invalid_request' })
      await assertReply(await post(server, path, '{}', { 'content-length': '65537' }), 413, {
        error: 'payload_too_large',
      })
      for (const candidate of submissionPaths) {
        const { init, pulled } = chunkedBody('{}')
        const response = await server.request(candidate, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Forwarded-For': '203.0.113.20' },
          ...init,
        })
        expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0)
        await assertReply(response, 429, { error: 'rate_limited' })
        expect(pulled()).toBe(0)
      }
    },
  )

  it('omits submitted answers, capability tokens and private route addresses from diagnostics', async () => {
    const answer = 'synthetic sensitive routing contact'
    const token = 'synthetic private routing capability'
    const body = JSON.stringify({ versionId: randomUUID(), answers: { [randomUUID()]: answer } })
    const lookup = vi.fn(() => {
      throw new Error(`Database diagnostic containing ${body} and ${token}`)
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const server = app(product({ selectFrom: lookup } as unknown as Db, true))
      for (const path of submissionPaths) {
        await assertReply(
          await post(server, `${path}?token=${encodeURIComponent(token)}`, body),
          500,
          { error: 'internal_error' },
        )
        await assertReply(await post(server, path, JSON.stringify({ [answer]: token })), 400, {
          error: 'invalid_request',
        })
      }
      expect(lookup).toHaveBeenCalledTimes(2)
      expect(log.mock.calls).toEqual([])
      expect(error.mock.calls).toHaveLength(2)
      for (const [line] of error.mock.calls) {
        expect(line).toContain('POST /api/v1/public/-/routing/[redacted]')
        expect(line).not.toContain('consultation')
        expect(line).not.toContain(answer)
        expect(line).not.toContain(token)
      }
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
  })
})

describe.skipIf(!process.env.DATABASE_URL)('public routing form REST with published forms', () => {
  let owned: TestDatabase
  let db: Db
  let enabled: ReturnType<typeof createApp>
  let off: ReturnType<typeof createApp>
  let personalForm: RoutingForm
  let teamForm: RoutingForm
  let personalOwner: Principal
  let teamOwner: Principal
  let teamEvent: string
  const option = { id: randomUUID(), label: 'Advice' }
  const otherOption = { id: randomUUID(), label: 'Other' }
  const selectQuestionId = randomUUID()
  const questions = [
    {
      id: selectQuestionId,
      type: 'select',
      label: 'What are you looking for?',
      required: true,
      options: [option, otherOption],
    },
    { id: randomUUID(), type: 'email', label: 'Work email', required: false },
    { id: randomUUID(), type: 'short_text', label: 'Your name', required: false },
  ]
  const credentials = new Map<string, Principal>()
  const resolveCaller: CallerResolver = async (headers) => {
    const auth = headers.get('authorization')
    const key = /^Bearer (\S+)$/.exec(auth ?? '')?.[1]
    const session = /^hourmere_test_session=(\S+)$/.exec(headers.get('cookie') ?? '')?.[1]
    // Simulate a session-capable resolver. The public scope binding must strip cookies
    // before handing it any supplied Authorization value.
    const principal = (key && credentials.get(key)) || (session && credentials.get(session))
    return principal ? { ok: true, principal, setCookie: [] } : { ...unauthorized, setCookie: [] }
  }

  async function ownerHeaders(principal: Principal) {
    const cookie = randomUUID()
    const { id: sessionId } = await db
      .insertInto('auth.session')
      .values({
        userId: principal.user.id,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        activeOrganizationId: principal.organization.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    credentials.set(cookie, { ...principal, kind: 'session', sessionId })
    return {
      cookie: syntheticSessionCookie(cookie),
      origin: publicUrl,
      'content-type': 'application/json',
      'X-Expected-Organization-Id': principal.organization.id,
    }
  }

  async function configure(principal: Principal, draft: Record<string, unknown>, publish = true) {
    const headers = await ownerHeaders(principal)
    const created = await enabled.request('/api/v1/routing-forms', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        slug: 'consultation',
        title: 'Consult us',
        questions,
        fallback: { kind: 'message', message: 'private-fallback-message' },
        ...draft,
      }),
    })
    expect(created.status).toBe(201)
    const form = (await created.json()) as RoutingForm
    if (!publish) return form
    const path = `/api/v1/routing-forms/${form.id}`
    const published = await enabled.request(`${path}/publish`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ expectedRevision: form.draftRevision }),
    })
    expect(published.status).toBe(201)
    const publication = (await published.json()) as { form: RoutingForm }
    const updated = await enabled.request(path, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        expectedRevision: publication.form.draftRevision,
        enabled: true,
        questions: questions.map((question) => ({
          ...question,
          label: 'private-unpublished-label',
        })),
      }),
    })
    expect(updated.status).toBe(200)
    return (await updated.json()) as RoutingForm
  }

  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
    enabled = app(product(db, true), resolveCaller)
    off = app(product(db), resolveCaller)
    const owner = await createTestUser(db)
    const outsider = await createTestUser(db)
    const team = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    await db
      .updateTable('auth.organization')
      .set({ slug: 'Advisory' })
      .where('id', '=', team.id)
      .execute()
    await db
      .insertInto('profiles')
      .values({ user_id: owner.id, handle: 'route', time_zone: 'UTC' })
      .execute()
    await db
      .insertInto('profiles')
      .values({ user_id: outsider.id, handle: 'about', time_zone: 'UTC' })
      .execute()
    const fixtures = createFixtures(db)
    const ownerOrg = owner.principal.organization.id
    await fixtures.eventType(ownerOrg, owner.id, {
      slug: 'consultation',
      title: 'Personal booking',
    })
    teamEvent = await fixtures.eventType(team.id, null, {
      slug: 'consultation',
      title: 'Team booking',
      hosts: [{ userId: owner.id }],
    })
    const hidden = await fixtures.eventType(ownerOrg, owner.id, { slug: 'private-hidden-target' })
    await db.updateTable('event_types').set({ is_hidden: true }).where('id', '=', hidden).execute()
    const rule = (eventTypeId: string) => ({
      id: randomUUID(),
      conditions: [{ questionId: selectQuestionId, operator: 'equals', value: option.id }],
      target: { kind: 'event', eventTypeId, mappings: [] },
    })
    personalOwner = owner.principal
    personalForm = await configure(personalOwner, {
      description: 'Which consultation is right for you?',
      rules: [rule(hidden)],
    })
    teamOwner = team.as(owner)
    teamOwner.organization.slug = 'Advisory'
    teamForm = await configure(teamOwner, { title: 'Team consultation', rules: [rule(teamEvent)] })
    await configure(owner.principal, { slug: 'draft' }, false)
    await configure(outsider.principal, {})
    for (const apiKeyScope of ['read', 'bookings', 'full'] as const) {
      credentials.set(`hm_${apiKeyScope}`, {
        ...outsider.principal,
        kind: 'api_key',
        apiKeyId: randomUUID(),
        apiKeyScope,
      })
    }
    credentials.set('outsider-session', {
      ...outsider.principal,
      kind: 'session',
      sessionId: randomUUID(),
    })
  })

  afterAll(async () => {
    await owned?.drop()
  })

  async function receiptCount(formId: string) {
    const { count } = await db
      .selectFrom('routing_receipts')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('form_id', '=', formId)
      .executeTakeFirstOrThrow()
    return Number(count)
  }

  it('mints same-origin continuations through both generated operations and returns messages without a receipt', async () => {
    const server = app(product(db, true), resolveCaller)
    const client = createClient<paths>({
      baseUrl: 'https://request-host.example.test',
      fetch: async (request) => server.fetch(request),
    })
    const personalBefore = await receiptCount(personalForm.id)
    const teamBefore = await receiptCount(teamForm.id)
    const input = (form: RoutingForm) => ({
      versionId: form.publishedVersionId as string,
      answers: { [selectQuestionId]: option.id },
    })
    const personal = await client.POST(personalSubmissionTemplate, {
      params: { path: { handle: 'route', slug: 'consultation' } },
      body: input(personalForm),
    })
    const team = await client.POST(teamSubmissionTemplate, {
      params: { path: { teamSlug: 'Advisory', slug: 'consultation' } },
      body: input(teamForm),
    })
    for (const result of [personal, team]) {
      expect(result.response.status).toBe(200)
      expect(result.response.headers.get('Cache-Control')).toBe('no-store')
      expect(result.response.headers.get('Referrer-Policy')).toBe('no-referrer')
      expect(result.data?.kind).toBe('continuation')
      if (result.data?.kind !== 'continuation') throw new Error('Expected a routing receipt')
      expect(Object.keys(result.data).sort()).toEqual([
        'continuationUrl',
        'expiresAt',
        'kind',
        'routeToken',
      ])
      expect(/^[A-Za-z0-9_-]{43}$/.test(result.data.routeToken)).toBe(true)
      expect(
        result.data.continuationUrl ===
          `${publicUrl}/route/continue#token=${encodeURIComponent(result.data.routeToken)}`,
      ).toBe(true)
      expect(Temporal.Instant.from(result.data.expiresAt).epochMilliseconds).toBeGreaterThan(
        Date.now(),
      )
    }
    await assertReply(
      await post(
        server,
        `${teamPath}/route`,
        JSON.stringify({ ...input(teamForm), answers: { [selectQuestionId]: otherOption.id } }),
      ),
      200,
      { kind: 'message', message: 'private-fallback-message' },
    )
    expect(await receiptCount(personalForm.id)).toBe(personalBefore + 1)
    expect(await receiptCount(teamForm.id)).toBe(teamBefore + 1)
  })

  it.each(readPaths)('accepts only bookings/full bearers for %s', async (path) => {
    const server = app(product(db, true), resolveCaller)
    const form = path === personalPath ? personalForm : teamForm
    const before = await receiptCount(form.id)
    const address = `${path}/route`
    const body = JSON.stringify({
      versionId: form.publishedVersionId,
      answers: { [selectQuestionId]: option.id },
    })
    const cookie = syntheticSessionCookie('outsider-session')
    for (const authorization of ['Bearer hm_invalid', 'Basic nonsense', '']) {
      const response = await post(server, address, body, { authorization, cookie })
      expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
      await assertReply(response, 401, { error: 'unauthorized' })
    }
    const denied = await post(server, address, body, { authorization: 'Bearer hm_read', cookie })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: 'insufficient_scope' })
    for (const answers of [
      `{"${selectQuestionId}":"${option.id}","__proto__":"unknown"}`,
      `{"${selectQuestionId}":"${option.id}","unknown":"sensitive"}`,
      `{"${selectQuestionId}":{"nested":{"value":"sensitive"}}}`,
    ]) {
      const response = await post(
        server,
        address,
        `{"versionId":"${form.publishedVersionId}","answers":${answers}}`,
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: expect.stringMatching(/^invalid_(request|routing_answers)$/),
      })
    }
    expect(await receiptCount(form.id)).toBe(before)
    for (const scope of ['bookings', 'full']) {
      const response = await post(server, address, body, { authorization: `Bearer hm_${scope}` })
      expect(response.status).toBe(200)
      expect(((await response.json()) as { kind?: string }).kind).toBe('continuation')
    }
    expect(await receiptCount(form.id)).toBe(before + 2)
  })

  it.each(readPaths)('enforces the byte cap for maximum valid submissions to %s', async (path) => {
    const server = app(product(db, true), resolveCaller)
    const principal = path === personalPath ? personalOwner : teamOwner
    const maxQuestions = Array.from({ length: 20 }, (_, i) => ({
      id: randomUUID(),
      label: `Question ${i + 1}`,
      type: 'short_text',
      required: true,
    }))
    const form = await configure(principal, { slug: 'max-answers', questions: maxQuestions })
    const route = `${path.replace(/consultation$/, 'max-answers')}/route`
    const input = {
      versionId: form.publishedVersionId,
      answers: Object.fromEntries(maxQuestions.map(({ id }) => [id, '汉'.repeat(500)])),
    }
    const unescaped = JSON.stringify(input)
    const escaped = escapedJson(input)
    expect(Buffer.byteLength(unescaped)).toBe(30_904)
    expect(Buffer.byteLength(escaped)).toBe(64_764)
    const limit = 65_536
    const atLimit = escaped.padEnd(limit)
    for (const body of [unescaped, escaped, atLimit]) {
      await assertReply(await post(server, route, body), 200, {
        kind: 'message',
        message: 'private-fallback-message',
      })
    }
    const tooBig = `${atLimit} `
    await assertReply(
      await post(server, route, tooBig, { 'content-length': String(limit + 1) }),
      413,
      { error: 'payload_too_large' },
    )
    const { init } = chunkedBody(tooBig)
    await assertReply(
      await server.request(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...init,
      }),
      413,
      { error: 'payload_too_large' },
    )
  })

  it('permits refreshing a stale version without minting a receipt for it', async () => {
    const server = app(product(db, true), resolveCaller)
    const path = '/api/v1/public/-/routing/teams/Advisory/refresh'
    const form = await configure(teamOwner, {
      slug: 'refresh',
      fallback: { kind: 'event', eventTypeId: teamEvent },
    })
    const old = await server.request(path)
    expect(old.status).toBe(200)
    const { versionId: oldVersion } =
      (await old.json()) as components['schemas']['PublicRoutingForm']
    const published = await post(
      server,
      `/api/v1/routing-forms/${form.id}/publish`,
      JSON.stringify({ expectedRevision: form.draftRevision }),
      await ownerHeaders(teamOwner),
    )
    expect(published.status).toBe(201)
    const answers = { [selectQuestionId]: option.id }
    await assertReply(
      await post(server, `${path}/route`, JSON.stringify({ versionId: oldVersion, answers })),
      409,
      { error: 'routing_form_changed' },
    )
    expect(await receiptCount(form.id)).toBe(0)
    const fresh = await server.request(path)
    expect(fresh.status).toBe(200)
    const { versionId, questions: publishedQuestions } =
      (await fresh.json()) as components['schemas']['PublicRoutingForm']
    expect(versionId).not.toBe(oldVersion)
    expect(publishedQuestions[0]?.label).toBe('private-unpublished-label')
    const routed = await post(server, `${path}/route`, JSON.stringify({ versionId, answers }))
    expect(routed.status).toBe(200)
    expect(((await routed.json()) as { kind?: string }).kind).toBe('continuation')
    expect(await receiptCount(form.id)).toBe(1)
  })

  it('refuses both submissions while off before reading answers or issuing receipts', async () => {
    const server = app(product(db), resolveCaller)
    for (const [path, form] of [
      [personalPath, personalForm],
      [teamPath, teamForm],
    ] as const) {
      const before = await receiptCount(form.id)
      const body = JSON.stringify({
        versionId: form.publishedVersionId,
        answers: { [selectQuestionId]: option.id },
      })
      for (const authorization of [undefined, 'Bearer hm_read', 'Bearer hm_bookings']) {
        const { init, pulled } = chunkedBody(body)
        await assertReply(
          await server.request(`${path}/route`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(authorization === undefined ? {} : { authorization }),
            },
            ...init,
          }),
          404,
          disabled,
        )
        expect(pulled()).toBe(0)
      }
      await assertReply(await post(server, `${path}-missing/route`, '{}'), 404, disabled)
      expect(await receiptCount(form.id)).toBe(before)
    }
  })

  it('returns the version and published questions through both generated operations', async () => {
    const client = createClient<paths>({
      baseUrl: publicUrl,
      fetch: async (request) => enabled.fetch(request),
    })
    const personal = await client.GET(personalTemplate, {
      params: { path: { handle: 'route', slug: 'consultation' } },
    })
    const team = await client.GET(teamTemplate, {
      params: { path: { teamSlug: 'Advisory', slug: 'consultation' } },
    })
    const personalMetadata = {
      title: 'Consult us',
      description: 'Which consultation is right for you?',
      versionId: personalForm.publishedVersionId,
      questions,
    }
    const teamMetadata = {
      title: 'Team consultation',
      versionId: teamForm.publishedVersionId,
      questions,
    }
    expect(personal.response.status).toBe(200)
    expect(personal.data).toEqual(personalMetadata)
    expect(team.response.status).toBe(200)
    expect(team.data).toEqual(teamMetadata)
    for (const scope of ['read', 'bookings', 'full']) {
      const headers = { authorization: `Bearer hm_${scope}` }
      await assertReply(await enabled.request(personalPath, { headers }), 200, personalMetadata)
      await assertReply(await enabled.request(teamPath, { headers }), 200, teamMetadata)
    }
  })

  it('keeps existing named namespaces and reserved handles separate', async () => {
    for (const [path, title] of [
      ['/api/v1/public/route/consultation', 'Personal booking'],
      ['/api/v1/public/teams/Advisory/consultation', 'Team booking'],
    ] as const) {
      const response = await enabled.request(path)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ title })
    }
    const poll = await enabled.request('/api/v1/public/meeting-polls/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'unknown' }),
    })
    expect(poll.status).toBe(404)
    expect(await poll.json()).toEqual({ error: 'poll_not_found' })
    const reserved = await enabled.request('/api/v1/public/about')
    expect(reserved.status).toBe(404)
    expect(await reserved.json()).toMatchObject({ error: 'host_not_found' })
    await assertReply(
      await enabled.request('/api/v1/public/-/routing/about/consultation'),
      404,
      formNotFound,
    )
    await assertReply(
      await enabled.request('/api/v1/public/-/routing/teams/advisory/consultation'),
      404,
      formNotFound,
    )
    await assertReply(
      await enabled.request('/api/v1/public/-/routing/Advisory/consultation'),
      404,
      formNotFound,
    )
  })

  it('refuses invalid or malformed supplied authorization even alongside a valid session', async () => {
    for (const path of readPaths) {
      for (const authorization of ['Bearer hm_invalid', 'Basic nonsense', '']) {
        const headers = { authorization, cookie: syntheticSessionCookie('outsider-session') }
        const response = await enabled.request(path, { headers })
        expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
        await assertReply(response, 401, { error: 'unauthorized' })
      }
    }
  })

  it('answers identically for current and unknown metadata with the production default off', async () => {
    for (const path of readPaths) {
      for (const candidate of [path, `${path}-missing`]) {
        await assertReply(await off.request(candidate), 404, disabled)
        await assertReply(
          await off.request(candidate, { headers: { authorization: 'Bearer hm_bookings' } }),
          404,
          disabled,
        )
      }
    }
  })

  it('uses one neutral response for missing, draft, disabled and archived forms', async () => {
    await db
      .updateTable('routing_forms')
      .set({ archived_at: new Date(), enabled: false })
      .where('id', '=', teamForm.id)
      .execute()
    try {
      for (const path of [
        teamPath,
        `${teamPath}-missing`,
        `${personalPath}-missing`,
        '/api/v1/public/-/routing/route/draft',
      ]) {
        await assertReply(await enabled.request(path), 404, formNotFound)
      }
      await db
        .updateTable('routing_forms')
        .set({ enabled: false })
        .where('id', '=', personalForm.id)
        .execute()
      await assertReply(await enabled.request(personalPath), 404, formNotFound)
    } finally {
      await db
        .updateTable('routing_forms')
        .set({ enabled: true })
        .where('id', '=', personalForm.id)
        .execute()
      await db
        .updateTable('routing_forms')
        .set({ archived_at: null, enabled: true })
        .where('id', '=', teamForm.id)
        .execute()
    }
  })
})
