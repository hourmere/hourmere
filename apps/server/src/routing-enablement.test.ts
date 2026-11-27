import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { createAuth, createAuthPool } from '@hourmere/auth'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import createClient from 'openapi-fetch'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { runCli } from '../../../tools/cli/src/cli.ts'
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
    SCIM_PROVISIONING_ENABLED: 'false',
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
  let outsiderAuthorization: string
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
      const mint = async (owner: typeof host) => {
        const { key } = await auth.api.createApiKey({
          body: {
            userId: owner.userId,
            name: 'Routing enablement',
            metadata: { scope: 'full', organizationId: owner.organizationId },
            rateLimitEnabled: false,
          },
        })
        return `Bearer ${key}`
      }
      authorization = await mint(host)
      outsiderAuthorization = await mint(await fixtures.host({ handle: 'another-host' }))
    } finally {
      await pool.end()
    }
  }, 60_000)

  afterAll(async () => {
    await owned?.drop()
  })

  async function withServer<T>(
    setting: string | undefined,
    verify: (origin: string, startupStatements: (string | undefined)[]) => Promise<T>,
  ) {
    const queries = vi.spyOn(pg.Client.prototype, 'query')
    try {
      const running = await startServer(environment(owned.url, setting))
      const startupStatements = queries.mock.calls.map(([query]) =>
        typeof query === 'string' ? query : (query as { text?: string })?.text,
      )
      return await verify(`http://127.0.0.1:${running.port}`, startupStatements).finally(() =>
        running.close(),
      )
    } finally {
      queries.mockRestore()
    }
  }

  async function mcp(origin: string, method: string, params?: object) {
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        authorization,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    expect(response.status).toBe(200)
    return response.text()
  }

  function rpcResult<T>(body: string) {
    const event = body.split('\n').find((line) => line.startsWith('data: '))
    return (JSON.parse(event ? event.slice(6) : body) as { result: T }).result
  }

  async function listedTools(origin: string) {
    return mcp(origin, 'tools/list')
  }

  function catalogue(body: string) {
    return rpcResult<{
      tools: { name: string; description?: string }[]
    }>(body)
  }

  async function cli(origin: string, command: string[], input: object) {
    let stdout = ''
    let stderr = ''
    const code = await runCli({
      argv: [...command, '--input', '-'],
      env: { HOURMERE_URL: origin, HOURMERE_API_KEY: authorization.slice('Bearer '.length) },
      stdin: (async function* () {
        yield JSON.stringify(input)
      })(),
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
    })
    return { code, stdout, stderr }
  }

  it('preserves off responses and queries, adding exactly eleven MCP tools on an empty instance', async () => {
    const offCatalogue = await withServer('false', async (origin, startupStatements) => {
      expect(startupStatements).not.toContainEqual(expect.stringMatching(/lower\("handle"\)/))
      // Finish Better Auth's asynchronous schema introspection before counting request SQL.
      const bodyBeforeRequests = await listedTools(origin)
      const queries = vi.mocked(pg.Client.prototype.query)
      for (const [path, status, body] of [
        [
          '/api/v1/instance',
          200,
          '{"publicUrl":"http://localhost","hostedSignupUrl":"https://hourmere.com","smsRemindersAvailable":false,"automaticGoogleMeet":false,"automaticZoom":false,"followUpHostNotesEnabled":true,"embedEnabled":false,"slotSnippetsEnabled":false,"ssoOidcEnabled":false,"ssoSamlEnabled":false,"routingFormsEnabled":false,"workflowsEnabled":true,"scimProvisioningEnabled":false,"signIn":{"email":true,"google":false,"microsoft":false}}',
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
      expect(catalogue(body).tools.map(({ name }) => name)).not.toContainEqual(
        expect.stringMatching(/routing|routed|^route_lead$/),
      )

      const result = await cli(origin, ['routing-forms', 'list'], {})
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(JSON.parse(result.stderr)).toMatchObject({ error: 'routing_forms_disabled' })
      return catalogue(body)
    })
    await withServer(undefined, async (origin) => {
      const on = catalogue(await listedTools(origin))
      expect(on.tools.filter(({ name }) => routingTools.has(name))).toHaveLength(11)
      expect(on.tools.filter(({ name }) => !routingTools.has(name))).toEqual(offCatalogue.tools)
      const result = await cli(origin, ['routing-forms', 'list'], {})
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ data: [], nextCursor: null })
    })
  }, 60_000)

  it.each([
    ['unset', undefined],
    ['Compose default', ''],
    [
      'copied .env.example',
      parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'))
        .ROUTING_FORMS_ENABLED,
    ],
  ] as const)(
    'books and exposes answers only on authorized surfaces with the %s setting',
    async (source, setting) => {
      if (source === 'Compose default') {
        const { services } = parseYaml(
          readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8'),
        )
        expect(services.app.environment.ROUTING_FORMS_ENABLED).toBe(`\${ROUTING_FORMS_ENABLED:-}`)
      }
      if (source !== 'unset') expect(setting).toBe('')
      await withServer(setting, async (origin) => {
        const instance = await fetch(`${origin}/api/v1/instance`)
        expect(await instance.json()).toHaveProperty('routingFormsEnabled', true)
        const listed = catalogue(await listedTools(origin)).tools.filter(({ name }) =>
          routingTools.has(name),
        )
        expect(listed.map(({ name }) => name).toSorted()).toEqual([...routingTools].toSorted())
        for (const { name, description } of listed) {
          expect(description, name).toContain('ROUTING_FORMS_ENABLED=false')
        }

        const visitor = createClient<paths>({ baseUrl: origin })
        const owner = createClient<paths>({ baseUrl: origin, headers: { authorization } })
        expect((await visitor.GET('/api/v1/routing-forms')).response.status).toBe(401)
        const question = {
          id: randomUUID(),
          type: 'email',
          label: 'Email',
          required: true,
        } as const
        const topic = {
          id: randomUUID(),
          type: 'short_text',
          label: 'Private topic',
          required: true,
        } as const
        const email = 'routed@example.test'
        const privateAnswer = `Synthetic private answer ${randomUUID()}`
        const slug = `${formSlug}-${source.toLowerCase().replaceAll(/[^a-z]+/g, '-')}`
        const created = await owner.POST('/api/v1/routing-forms', {
          body: {
            slug,
            title: 'Intake form',
            questions: [question, topic],
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

        const address = { handle, slug }
        const metadata = await visitor.GET('/api/v1/public/-/routing/{handle}/{slug}', {
          params: { path: address },
        })
        expect(metadata.response.status).toBe(200)
        assert(metadata.data)
        expect(metadata.data).toMatchObject({
          title: 'Intake form',
          versionId: published.data.version.id,
          questions: [question, topic],
        })
        expect(metadata.data).not.toHaveProperty('fallback')

        const submitted = await visitor.POST('/api/v1/public/-/routing/{handle}/{slug}/route', {
          params: { path: address },
          body: {
            versionId: metadata.data.versionId,
            answers: { [question.id]: email, [topic.id]: privateAnswer },
          },
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
        expect(JSON.stringify(booked.data)).not.toContain(privateAnswer)
        assert(booked.data?.manageToken)
        const id = booked.data.booking.id

        const detail = await owner.GET('/api/v1/bookings/{id}', { params: { path: { id } } })
        expect(detail.response.status).toBe(200)
        expect(detail.data).toMatchObject({
          id,
          routing: {
            versionId: metadata.data.versionId,
            answers: { [topic.id]: privateAnswer },
          },
        })
        const rpc = rpcResult<{ structuredContent: unknown }>(
          await mcp(origin, 'tools/call', {
            name: 'get_booking',
            arguments: { bookingId: id },
          }),
        )
        expect(rpc.structuredContent).toEqual(detail.data)
        const cliDetail = await cli(origin, ['booking'], { bookingId: id })
        expect(cliDetail.code).toBe(0)
        expect(JSON.parse(cliDetail.stdout)).toEqual(detail.data)
        expect(
          (await visitor.GET('/api/v1/bookings/{id}', { params: { path: { id } } })).response
            .status,
        ).toBe(401)
        const outsider = await visitor.GET('/api/v1/bookings/{id}', {
          params: { path: { id } },
          headers: { authorization: outsiderAuthorization },
        })
        expect(outsider.response.status).toBe(404)
        expect(outsider.error).toMatchObject({ error: 'booking_not_found' })

        const manage = await fetch(`${origin}/api/v1/bookings/manage`, {
          headers: { 'x-manage-token': booked.data.manageToken },
        })
        expect(manage.status).toBe(200)
        expect(await manage.json()).toMatchObject({
          id,
          routingAnswers: [
            { label: question.label, answer: email },
            { label: topic.label, answer: privateAnswer },
          ],
        })

        const range = {
          from: slot.start,
          to: Temporal.Instant.from(slot.start).add({ hours: 1 }).toString(),
          eventTypeId,
        }
        const exportCsv = async (includeRoutingAnswers?: 'true') => {
          const response = await fetch(
            `${origin}/api/v1/bookings/export.csv?${new URLSearchParams({
              ...range,
              ...(includeRoutingAnswers && { includeRoutingAnswers }),
            })}`,
            { headers: { authorization } },
          )
          expect(response.status).toBe(200)
          return response.text()
        }
        const ordinaryCsv = await exportCsv()
        expect(ordinaryCsv).toContain(email)
        expect(ordinaryCsv).not.toContain('routing_answers')
        expect(ordinaryCsv).not.toContain(privateAnswer)
        const routingCsv = await exportCsv('true')
        expect(routingCsv).toContain('routing_answers')
        expect(routingCsv).toContain(privateAnswer)
        const cliExport = await cli(origin, ['export'], { ...range, includeRoutingAnswers: true })
        expect(cliExport.code).toBe(0)
        expect(cliExport.stdout).toBe(routingCsv)
      })
    },
    60_000,
  )

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
      await withServer(undefined, async (origin) => {
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
      await withServer(undefined, async (origin) => {
        const response = await fetch(`${origin}/api/v1/instance`)
        expect(await response.json()).toHaveProperty('routingFormsEnabled', false)
        const form = await fetch(`${origin}/api/v1/public/-/routing/${handle}/${formSlug}`)
        expect(form.status).toBe(404)
        expect(await form.text()).toBe(disabled)
        const legacy = await fetch(`${origin}/api/v1/public/route`)
        expect(legacy.status).toBe(200)
        expect(await legacy.json()).toMatchObject({ handle: 'route' })
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
