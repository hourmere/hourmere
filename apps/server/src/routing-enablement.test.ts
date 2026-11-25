import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createAuth, createAuthPool } from '@hourmere/auth'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import createClient from 'openapi-fetch'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { paths } from '../../web/src/api/schema.d.ts'
import { startServer } from './server.ts'

const databaseUrl = process.env.DATABASE_URL
const publicUrl = 'http://localhost'
const secret = randomBytes(32).toString('base64url')
const disabled = '{"error":"routing_forms_disabled"}'
const routingTools = new Set<string>([
  'list_routing_forms',
  'get_routing_form',
  'create_routing_form',
  'update_routing_form',
  'archive_routing_form',
  'publish_routing_form',
  'preview_routing_form',
  'get_public_routing_form',
  'route_lead',
  'resolve_routing_continuation',
  'find_routed_slots',
])

function environment(url: string, value?: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: url,
    PUBLIC_URL: publicUrl,
    BETTER_AUTH_SECRET: secret,
    HOURMERE_ROLE: 'web',
    SIGNUP: 'closed',
    PORT: '0',
    ...(value !== undefined && { ROUTING_FORMS_ENABLED: value }),
  }
}

it('refuses an invalid setting at startup before any SQL', async () => {
  const queries = vi.spyOn(pg.Client.prototype, 'query')
  try {
    const running = startServer(environment('postgres://synthetic@127.0.0.1:9/routing', 'TRUE'))
    await expect(running.then(async (server) => server.close())).rejects.toThrow(
      'ROUTING_FORMS_ENABLED must be true or false',
    )
    expect(queries).not.toHaveBeenCalled()
  } finally {
    queries.mockRestore()
  }
})

describe.skipIf(!databaseUrl)('routing enablement in the running server', () => {
  let owned: TestDatabase
  let handle: string
  let eventTypeId: string
  let authorization: string
  const title = 'Private routing target'
  const formSlug = 'intake'
  const eventSlug = 'private-consultation'

  beforeAll(async () => {
    assert(databaseUrl)
    owned = await createTestDatabase(databaseUrl, undefined, { tag: 'routing_enable' })
    const db = createDb(owned.pool)
    const fixtures = createFixtures(db)
    const host = await fixtures.host({ handle: 'routing-host', timeZone: 'UTC' })
    handle = host.handle
    const scheduleId = await fixtures.schedule(host.userId, { timeZone: 'UTC' })
    eventTypeId = await fixtures.eventType(host.organizationId, host.userId, {
      title,
      slug: eventSlug,
      hosts: [{ userId: host.userId, scheduleId }],
    })
    await db
      .updateTable('event_types')
      .set({
        is_hidden: true,
        success_redirect: JSON.stringify({
          url: 'https://host.example.test/after-booking',
          parameters: ['eventTypeSlug'],
          includeInviteePersonalData: false,
          allowEmbedParent: false,
        }),
      })
      .where('id', '=', eventTypeId)
      .execute()

    const signup = { mode: 'closed', allowedDomains: [] } as const
    const pool = createAuthPool(owned.url, signup)
    try {
      const auth = createAuth({
        pool,
        db,
        baseURL: publicUrl,
        secret,
        signup,
        mailer: { send: async () => {} },
      })
      const { key } = await auth.api.createApiKey({
        body: {
          userId: host.userId,
          name: 'Routing enablement',
          metadata: { scope: 'full', organizationId: host.organizationId },
          rateLimitEnabled: false,
        },
      })
      authorization = `Bearer ${key}`
    } finally {
      await pool.end()
    }
  }, 60_000)

  afterAll(async () => {
    await owned?.drop()
  })

  async function withServer(
    setting: string | undefined,
    verify: (origin: string, startupStatements: (string | undefined)[]) => Promise<void>,
  ) {
    const queries = vi.spyOn(pg.Client.prototype, 'query')
    try {
      const running = await startServer(environment(owned.url, setting))
      const startupStatements = queries.mock.calls.map(([query]) =>
        typeof query === 'string' ? query : (query as { text?: string })?.text,
      )
      await verify(`http://127.0.0.1:${running.port}`, startupStatements).finally(() =>
        running.close(),
      )
    } finally {
      queries.mockRestore()
    }
  }

  async function listedTools(origin: string) {
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        authorization,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    })
    expect(response.status).toBe(200)
    return response.text()
  }

  function catalogue(body: string) {
    const event = body.split('\n').find((line) => line.startsWith('data: '))
    return JSON.parse(event ? event.slice(6) : body) as {
      result: { tools: { name: string; description?: string }[] }
    }
  }

  it('preserves off response bytes and query counts for unset, empty and false', async () => {
    let offCatalogue: string | undefined
    for (const setting of [undefined, '', 'false']) {
      await withServer(setting, async (origin, startupStatements) => {
        expect(startupStatements).not.toContainEqual(expect.stringMatching(/lower\("handle"\)/))
        // Finish Better Auth's asynchronous schema introspection before counting request SQL.
        const bodyBeforeRequests = await listedTools(origin)
        const queries = vi.mocked(pg.Client.prototype.query)
        for (const [path, status, body] of [
          [
            '/api/v1/instance',
            200,
            '{"publicUrl":"http://localhost","hostedSignupUrl":"https://hourmere.com","smsRemindersAvailable":false,"eventTypePaymentAvailability":"stripe_not_configured","automaticGoogleMeet":false,"automaticZoom":false,"followUpHostNotesEnabled":true,"embedEnabled":false,"slotSnippetsEnabled":false,"ssoOidcEnabled":false,"ssoSamlEnabled":false,"routingFormsEnabled":false,"workflowsEnabled":false,"scimProvisioningEnabled":false,"signIn":{"email":true,"google":false,"microsoft":false}}',
          ],
          ['/route', 404, '404 Not Found'],
          ['/route/routing-host/intake', 404, '404 Not Found'],
          ['/route/team/advisory/intake', 404, '404 Not Found'],
          ['/route/continue', 404, '404 Not Found'],
          ['/api/v1/public/-/routing/routing-host/intake', 404, disabled],
        ] as const) {
          queries.mockClear()
          const response = await fetch(`${origin}${path}`)
          expect(response.status, path).toBe(status)
          expect(await response.text(), path).toBe(body)
          expect(queries, path).not.toHaveBeenCalled()
        }
        queries.mockClear()
        const body = await listedTools(origin)
        expect(queries, 'tools/list').toHaveBeenCalledTimes(5)
        expect(body).toBe(bodyBeforeRequests)
        expect(catalogue(body).result.tools.map(({ name }) => name)).not.toContainEqual(
          expect.stringMatching(/routing|routed|^route_lead$/),
        )
        offCatalogue ??= body
        expect(body).toBe(offCatalogue)
      })
    }
    await withServer('true', async (origin) => {
      const on = catalogue(await listedTools(origin))
      on.result.tools = on.result.tools.filter(({ name }) => !routingTools.has(name))
      assert(offCatalogue)
      expect(JSON.stringify(on)).toBe(JSON.stringify(catalogue(offCatalogue)))
    })
  }, 60_000)

  it('discovers all eleven tools and books through an enabled form', async () => {
    await withServer('true', async (origin) => {
      const instance = await fetch(`${origin}/api/v1/instance`)
      expect(await instance.json()).toHaveProperty('routingFormsEnabled', true)
      const listed = catalogue(await listedTools(origin)).result.tools.filter(({ name }) =>
        routingTools.has(name),
      )
      expect(listed.map(({ name }) => name).toSorted()).toEqual([...routingTools].toSorted())
      for (const { name, description } of listed) {
        expect(description, name).toContain('ROUTING_FORMS_ENABLED=true')
      }

      const visitor = createClient<paths>({ baseUrl: origin })
      const owner = createClient<paths>({ baseUrl: origin, headers: { authorization } })
      expect((await visitor.GET('/api/v1/routing-forms')).response.status).toBe(401)
      const question = { id: randomUUID(), type: 'email', label: 'Email', required: true } as const
      const email = 'routed@example.test'
      const created = await owner.POST('/api/v1/routing-forms', {
        body: {
          slug: formSlug,
          title: 'Intake form',
          questions: [question],
          fallback: {
            kind: 'event',
            eventTypeId,
            mappings: [{ questionId: question.id, destination: { kind: 'inviteeEmail' } }],
          },
        },
      })
      expect(created.response.status).toBe(201)
      assert(created.data)
      const form = { id: created.data.id }
      const published = await owner.POST('/api/v1/routing-forms/{id}/publish', {
        params: { path: form },
        body: { expectedRevision: created.data.draftRevision },
      })
      expect(published.response.status).toBe(201)
      assert(published.data)
      const enabled = await owner.PATCH('/api/v1/routing-forms/{id}', {
        params: { path: form },
        body: { expectedRevision: published.data.form.draftRevision, enabled: true },
      })
      expect(enabled.data).toHaveProperty('enabled', true)

      const address = { handle, slug: formSlug }
      const metadata = await visitor.GET('/api/v1/public/-/routing/{handle}/{slug}', {
        params: { path: address },
      })
      expect(metadata.response.status).toBe(200)
      assert(metadata.data)
      expect(metadata.data).toMatchObject({
        title: 'Intake form',
        versionId: published.data.version.id,
        questions: [question],
      })
      expect(metadata.data).not.toHaveProperty('fallback')

      const submitted = await visitor.POST('/api/v1/public/-/routing/{handle}/{slug}/route', {
        params: { path: address },
        body: { versionId: metadata.data.versionId, answers: { [question.id]: email } },
      })
      expect(submitted.response.status).toBe(200)
      assert(submitted.data?.kind === 'continuation')
      const { routeToken, continuationUrl, expiresAt } = submitted.data
      expect(continuationUrl).toBe(`${publicUrl}/route/continue#token=${routeToken}`)
      const resolved = await visitor.POST('/api/v1/routing-continuations/resolve', {
        body: { routeToken },
      })
      expect(resolved.response.status).toBe(200)
      expect(resolved.data).toMatchObject({
        eventType: { title },
        expiresAt,
        prefill: { inviteeEmail: email },
      })
      expect(resolved.data?.eventType).not.toHaveProperty('slug')
      expect(JSON.stringify(resolved.data)).not.toContain(eventSlug)

      const start = Temporal.Now.instant().add({ hours: 24 })
      const slots = await visitor.POST('/api/v1/routing-continuations/slots', {
        body: { routeToken, start: start.toString(), end: start.add({ hours: 168 }).toString() },
      })
      expect(slots.response.status).toBe(200)
      const slot = slots.data?.slots[0]
      assert(slot)
      const booked = await visitor.POST('/api/v1/routing-continuations/bookings', {
        body: {
          routeToken,
          start: slot.start,
          invitee: { name: 'Routed invitee', email, timeZone: 'UTC' },
        },
      })
      expect(booked.response.status).toBe(201)
      expect(booked.data?.booking).toMatchObject({
        title: `${title} with Routed invitee`,
        status: 'confirmed',
      })
      expect(booked.data?.manageToken).toEqual(expect.any(String))
      expect(booked.data).not.toHaveProperty('successRedirect')
      expect(JSON.stringify(booked.data)).not.toContain(eventSlug)
    })
  }, 60_000)

  it('enables routing without a collision warning for a legacy poll handle', async ({
    onTestFinished,
  }) => {
    const db = createDb(owned.pool)
    const { userId } = await createFixtures(db).host({ handle: 'poll' })
    onTestFinished(async () => {
      await db.deleteFrom('profiles').where('user_id', '=', userId).execute()
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await withServer('true', async (origin) => {
        const response = await fetch(`${origin}/api/v1/instance`)
        expect(await response.json()).toHaveProperty('routingFormsEnabled', true)
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Routing forms are disabled'))
      })
    } finally {
      warn.mockRestore()
    }
  }, 60_000)

  it('warns and forces routing off for a legacy route handle', async () => {
    await createFixtures(createDb(owned.pool)).host({ handle: 'route' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await withServer('true', async (origin) => {
        const response = await fetch(`${origin}/api/v1/instance`)
        expect(await response.json()).toHaveProperty('routingFormsEnabled', false)
        const form = await fetch(`${origin}/api/v1/public/-/routing/${handle}/${formSlug}`)
        expect(form.status).toBe(404)
        expect(await form.text()).toBe(disabled)
        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(
            /legacy personal handle.*"route".*rename with the owner in Settings > Profile.*restart Hourmere/,
          ),
        )
      })
    } finally {
      warn.mockRestore()
    }
  }, 60_000)
})
