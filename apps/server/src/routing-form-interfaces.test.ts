import { randomUUID } from 'node:crypto'
import '@hono/zod-openapi'
import type { ApiKeyScope, CallerResolver, Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import createClient from 'openapi-fetch'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  publishRoutingForm,
  type RoutingForm,
} from '../../../packages/scheduling/src/routing-form-service.ts'
import { runCli } from '../../../tools/cli/src/cli.ts'
import type { paths } from '../../web/src/api/schema.d.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { productRoutes, productTools } from './server.ts'

const paymentRequired = vi.hoisted(() => new Set<string>())

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
const operations = ['list', 'get', 'create', 'update', 'archive', 'publish'] as const
type Operation = (typeof operations)[number]
const tools = {
  list: 'list_routing_forms',
  get: 'get_routing_form',
  create: 'create_routing_form',
  update: 'update_routing_form',
  archive: 'archive_routing_form',
  publish: 'publish_routing_form',
}
const methods = {
  list: 'GET',
  get: 'GET',
  create: 'POST',
  update: 'PATCH',
  archive: 'DELETE',
  publish: 'POST',
}
const draft = () => ({
  slug: `form-${randomUUID()}`,
  title: 'Routing form',
  fallback: { kind: 'message', message: 'Thank you' },
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
  const resolveCaller: CallerResolver = async (headers) => {
    const principal = credentials.get(
      headers.get('authorization')?.replace(/^Bearer /, '') ?? headers.get('cookie') ?? '',
    )
    return principal
      ? { ok: true, principal, setCookie: [] }
      : { ok: false, error: 'unauthorized', setCookie: [] }
  }
  function app(enabled = true) {
    return createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller,
      routes: productRoutes({
        db,
        socialProviders: {},
        invitationMailLimits: { secret: 'synthetic-routing-interface-secret' },
        routingFormsEnabled: enabled,
      }),
      mcp: mcpEndpoint({ tools: productTools({ db, routingFormsEnabled: enabled }) }),
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
      const query = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]))
      const path = `/api/v1/routing-forms${item}${op === 'publish' ? '/publish' : ''}${op === 'list' ? `?${query}` : ''}`
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
    let stdout = ''
    let stderr = ''
    const code = await runCli({
      argv: ['routing-forms', op, '--input', '-'],
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
      for (const id of [form.id, randomUUID()])
        for (const op of ['get', 'update', 'archive', 'publish'] as const)
          expect(
            (await call(surface, foreign, op, op === 'get' ? { id } : { id, expectedRevision: 1 }))
              .body.error,
          ).toBe('routing_form_not_found')
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

    it(`${surface}: reauthorizes a publication retry against current membership`, async () => {
      const space = await createTestTeam(db, [
        { user: owner, role: 'owner' },
        { user: admin, role: 'admin' },
      ])
      const token = await credential(admin, 'full', space.as(admin).organization)
      const { body: form } = await call(surface, token, 'create', draft())
      const input = { id: form.id, expectedRevision: 1, requestId: randomUUID() }
      const published = await call(surface, token, 'publish', input)
      expect(published.ok).toBe(true)
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
      expect(await versions(form.id)).toEqual([{ id: published.body.version.id }])
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
    })
  }

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
    const archived = await client.DELETE('/api/v1/routing-forms/{id}', {
      params: { path: { id } },
      body: { expectedRevision: 3 },
    })
    expect(archived.response.status).toBe(204)
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
