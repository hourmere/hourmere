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
  evaluateRoutingForm,
  validateRoutingAnswers,
} from '../../../packages/scheduling/src/routing-form-config.ts'
import {
  createRoutingForm,
  publishRoutingForm,
  type RoutingForm,
} from '../../../packages/scheduling/src/routing-form-service.ts'
import { runCli } from '../../../tools/cli/src/cli.ts'
import type { paths } from '../../web/src/api/schema.d.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
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
  function app(enabled = true) {
    return createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller,
      routes: productRoutes({
        db,
        notify,
        publicUrl,
        socialProviders: {},
        invitationMailLimits: { secret: routingSecret },
        routingFormsEnabled: enabled,
        routingSecret,
      }),
      mcp: mcpEndpoint({
        tools: productTools({ db, notify, publicUrl, routingFormsEnabled: enabled, routingSecret }),
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
    if ('name' in params && params.name === 'route_lead') {
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
    op: Operation | 'public' | 'route',
    input: Record<string, unknown>,
  ) {
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
