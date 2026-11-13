import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { getOpenApiMetadata } from '@asteasolutions/zod-to-openapi'
import { createRoute, z } from '@hono/zod-openapi'
import * as core from '@hourmere/core'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import * as scheduling from '@hourmere/scheduling'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import * as openapi from '../openapi.ts'
import { openApiDocument } from '../openapi-document.ts'
import * as schemas from '../routes/event-types.ts'
import { productTools } from '../server.ts'
import * as teamManagement from '../team-management.ts'
import { catalogTools } from './catalog.ts'
import { mcpEndpoint } from './endpoint.ts'
import { eventTypeTools } from './event-types.ts'
import { defineTool, type McpCaller, runTool, type Tool } from './tools.ts'

type Factory = typeof eventTypeTools
type Change = readonly [string, string]
type Saved = { id: string; successRedirect: scheduling.SuccessRedirect | null }
type Result = Awaited<ReturnType<typeof runTool>>
const origin = 'https://hourmere.example.test'
const input = () => ({
  slug: `redirect-${randomUUID()}`,
  title: 'Continue after booking',
  durationMinutes: 30,
})
const redirect: scheduling.SuccessRedirect = {
  url: 'https://target.example.test/thanks?campaign=one#done',
  parameters: [
    'eventTypeSlug',
    'start',
    'end',
    'timeZone',
    'hostName',
    'inviteeName',
    'inviteeEmail',
  ],
  includeInviteePersonalData: true,
  allowEmbedParent: true,
}
function sourceCopy(change?: Change): Factory {
  let source = readFileSync('apps/server/src/mcp/event-types.ts', 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match').toBe(true)
    source = source.replace(...change)
  }
  const bindings = { z, ...scheduling, ...schemas, defineTool }
  return new Function(
    ...Object.keys(bindings),
    `${stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(/\bexport /g, '')}; return eventTypeTools`,
  )(...Object.values(bindings)) as Factory
}
function routeSourceCopy(change?: Change): typeof schemas.eventTypeRoutes {
  let source = readFileSync('apps/server/src/routes/event-types.ts', 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'route mutation must match').toBe(true)
    source = source.replace(...change)
  }
  const bindings = { createRoute, z, ...core, ...scheduling, ...openapi, ...teamManagement }
  return new Function(
    ...Object.keys(bindings),
    `${stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(/\bexport /g, '')}; return eventTypeRoutes`,
  )(...Object.values(bindings)) as typeof schemas.eventTypeRoutes
}
function productSourceCopy(change?: Change): Factory {
  const server = readFileSync('apps/server/src/server.ts', 'utf8')
  let source = server.slice(
    server.indexOf('export function productTools('),
    server.indexOf('export interface RunningServer'),
  )
  if (change) {
    expect(source.includes(change[0]), 'product mutation must match').toBe(true)
    source = source.replace(...change)
  }
  const bindings = {
    eventTypeTools,
    whoamiTool: { name: 'whoami' },
    bookingTools: () => [],
    catalogTools: () => [],
    integrationTools: () => [],
    oneTimeLinkTools: () => [],
    slackDestinationTools: () => [],
    openTimeSnippetTools: () => [],
    availabilityTroubleshootingTools: () => [],
    workflowTools: () => [],
    waitlistTools: () => [],
    brandingTools: () => [],
  }
  return new Function(
    ...Object.keys(bindings),
    `${stripTypeScriptTypes(source).replace(/\bexport /g, '')}; return productTools`,
  )(...Object.values(bindings)) as Factory
}
function ok(result: Result): Saved {
  expect(result.isError).toBeFalsy()
  return result.structuredContent as Saved
}
function error(result: Result) {
  expect(result.isError).toBe(true)
  const content = result.content[0]
  if (content?.type !== 'text') throw Error('Expected error text')
  return JSON.parse(content.text) as { error: string; field?: string; message?: string }
}

describe.skipIf(!process.env.DATABASE_URL)('redirect configuration across REST and MCP', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function setup(
    factory: Factory = productTools,
    policy: scheduling.SuccessRedirectPolicy = {},
    scope: 'full' | 'read' | 'bookings' = 'full',
    role?: string,
    routes = schemas.eventTypeRoutes,
  ) {
    const host = await createTestUser(db)
    const team = role ? await createTestTeam(db, [{ user: host, role }]) : null
    const caller = { ...(team ? team.as(host) : host.principal), apiKeyScope: scope } as McpCaller
    const tools = [
      ...new Map(
        [...catalogTools({ db }), ...factory({ db, successRedirectPolicy: policy })].map((tool) => [
          tool.name,
          tool,
        ]),
      ).values(),
    ]
    const app = createApp({
      publicUrl: origin,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: true, principal: caller, setCookie: [] }),
      routes: [routes({ db, successRedirectPolicy: policy })],
      mcp: mcpEndpoint({ tools }),
    })
    const call = (name: string, args: Record<string, unknown>) =>
      runTool(
        tools.find((tool) => tool.name === name) as Tool,
        args,
        { caller, rateLimit: () => {} },
        () => {
          throw Error('Unexpected tool failure')
        },
      )
    const rest = (method: string, id: string | undefined, body?: unknown) =>
      app.request(`/api/v1/event-types${id ? `/${id}` : ''}`, {
        method,
        headers: { authorization: 'Bearer hm_synthetic', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    return { host, caller, tools, app, call, rest }
  }
  it.each([undefined, 'owner', 'admin'])(
    'round trips the complete configuration with REST-identical MCP results for %s',
    async (role) => {
      const s = await setup(eventTypeTools, {}, 'full', role)
      const create = await s.rest('POST', undefined, { ...input(), successRedirect: redirect })
      expect(create.status).toBe(201)
      const saved = (await create.json()) as Saved
      expect(saved.successRedirect).toEqual(redirect)
      expect(ok(await s.call('get_event_type', { id: saved.id }))).toEqual(saved)
      const changed = ok(
        await s.call('update_event_type', {
          id: saved.id,
          successRedirect: { url: 'https://new.example.test/路径' },
        }),
      )
      expect(changed.successRedirect).toEqual({
        url: 'https://new.example.test/%E8%B7%AF%E5%BE%84',
        parameters: [],
        includeInviteePersonalData: false,
        allowEmbedParent: false,
      })
      const read = await s.rest('GET', saved.id)
      expect(await read.json()).toEqual(changed)
      const list = await s.rest('GET', undefined)
      expect(((await list.json()) as { data: Saved[] }).data).toContainEqual(changed)
      const unchanged = ok(
        await s.call('update_event_type', { id: saved.id, title: 'A new title' }),
      )
      expect(unchanged.successRedirect).toEqual(changed.successRedirect)
      expect(
        ok(await s.call('update_event_type', { id: saved.id, successRedirect: null }))
          .successRedirect,
      ).toBeNull()
      const defaulted = ok(await s.call('create_event_type', input()))
      expect(defaulted.successRedirect).toBeNull()
    },
  )
  it('uses the real MCP transport for full configuration, discovery and service validation', async () => {
    const s = await setup()
    const client = new Client({ name: 'redirect-transport-test', version: '1.0.0' })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
          fetch: async (i, init) => s.app.request(i, init),
          requestInit: { headers: { authorization: 'Bearer hm_synthetic' } },
        }),
      )
      const list = await client.listTools()
      for (const name of ['create_event_type', 'update_event_type'])
        expect(
          list.tools.find((tool) => tool.name === name)?.inputSchema.properties,
        ).toHaveProperty('successRedirect')
      expect(
        list.tools.find((tool) => tool.name === 'get_event_type')?.outputSchema?.properties,
      ).toHaveProperty('successRedirect')
      const restDoc = (await openApiDocument()) as {
        components: {
          schemas: Record<
            string,
            { properties?: { successRedirect?: { properties: Record<string, unknown> } } }
          >
        }
      }
      const restRedirect = restDoc.components.schemas.EventTypeInput?.properties?.successRedirect
      expect(restRedirect?.properties.url).toMatchObject({ type: 'string', maxLength: 2000 })
      expect(restRedirect?.properties.url).not.toHaveProperty('format')
      expect(restRedirect?.properties.parameters).toMatchObject({ uniqueItems: true, default: [] })
      for (const name of ['create_event_type', 'update_event_type']) {
        const schema = list.tools.find((tool) => tool.name === name)?.inputSchema.properties
          ?.successRedirect as { anyOf: { properties?: Record<string, unknown> }[] }
        const properties = schema.anyOf.find((branch) => branch.properties)?.properties
        expect(properties?.url).toMatchObject({ type: 'string' })
        expect(properties?.url).not.toHaveProperty('format')
        expect(properties?.parameters).toMatchObject({
          type: 'array',
          items: { enum: [...scheduling.SUCCESS_REDIRECT_PARAMETERS] },
        })
      }
      const created = await client.callTool({
        name: 'create_event_type',
        arguments: { ...input(), successRedirect: redirect },
      })
      expect(created.isError).toBeFalsy()
      const saved = created.structuredContent as Saved
      expect(saved.successRedirect).toEqual(redirect)
      const read = await client.callTool({ name: 'get_event_type', arguments: { id: saved.id } })
      expect(read.structuredContent).toEqual(saved)
      const invalid = await client.callTool({
        name: 'update_event_type',
        arguments: { id: saved.id, successRedirect: { ...redirect, parameters: ['unknown'] } },
      })
      expect(invalid.isError).toBe(true)
      expect(JSON.parse((invalid.content as { text: string }[])[0]?.text ?? '')).toMatchObject({
        error: 'invalid_success_redirect',
        field: 'successRedirect.parameters',
      })
      const clear = await client.callTool({
        name: 'update_event_type',
        arguments: { id: saved.id, successRedirect: null },
      })
      expect(clear.structuredContent).toHaveProperty('successRedirect', null)
    } finally {
      await client.close()
    }
  })
  async function verifyRest(factory: typeof schemas.eventTypeRoutes) {
    const s = await setup(eventTypeTools, {}, 'full', undefined, factory)
    const created = await s.rest('POST', undefined, { ...input(), successRedirect: redirect })
    expect(created.status).toBe(201)
    const saved = (await created.json()) as Saved
    expect(saved.successRedirect).toEqual(redirect)
    const read = await s.rest('GET', saved.id)
    expect(await read.json()).toHaveProperty('successRedirect', redirect)
    const changed = await s.rest('PATCH', saved.id, { successRedirect: null })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toHaveProperty('successRedirect', null)
  }
  it('checks unchanged REST source-copy round trips', async () => verifyRest(routeSourceCopy()))
  it.each<Change>([
    ['successRedirect: SuccessRedirectInput.optional(),', ''],
    [
      "              c.req.valid('json'),\n            ),\n          ),\n          201,",
      "              {...c.req.valid('json'), successRedirect: undefined},\n            ),\n          ),\n          201,",
    ],
    [
      "await getEventType(serviceContext(deps, c.var.principal), c.req.valid('param').id)",
      "({...await getEventType(serviceContext(deps, c.var.principal), c.req.valid('param').id), successRedirect: undefined})",
    ],
    [
      "              c.req.valid('json'),\n            ),\n          ),\n          200,\n        ),\n    )\n\n    app.openapi(\n      createRoute({\n        ...route,\n        middleware: callerWithBodyLimit(caller, 1024)",
      "              {...c.req.valid('json'), successRedirect: undefined},\n            ),\n          ),\n          200,\n        ),\n    )\n\n    app.openapi(\n      createRoute({\n        ...route,\n        middleware: callerWithBodyLimit(caller, 1024)",
    ],
  ])('detects removal of a REST configuration contract', async (from, to) => {
    await expect(verifyRest(routeSourceCopy([from, to]))).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
  const invalidCases: [string, unknown, string, string][] = [
    [
      'scheme',
      { url: 'http://target.example.test/' },
      'invalid_success_redirect',
      'successRedirect.url',
    ],
    [
      'userinfo',
      { url: 'https://private:private@target.example.test/' },
      'invalid_success_redirect',
      'successRedirect.url',
    ],
    ['local host', { url: 'https://intranet/' }, 'invalid_success_redirect', 'successRedirect.url'],
    [
      'IP literal',
      { url: 'https://203.0.113.1/' },
      'invalid_success_redirect',
      'successRedirect.url',
    ],
    [
      'duplicate parameter',
      { ...redirect, parameters: ['start', 'start'] },
      'invalid_success_redirect',
      'successRedirect.parameters',
    ],
    [
      'unknown parameter',
      { ...redirect, parameters: ['private-value'] },
      'invalid_success_redirect',
      'successRedirect.parameters',
    ],
    [
      'name consent',
      { ...redirect, parameters: ['inviteeName'], includeInviteePersonalData: false },
      'invalid_success_redirect',
      'successRedirect.includeInviteePersonalData',
    ],
    [
      'email consent',
      { ...redirect, parameters: ['inviteeEmail'], includeInviteePersonalData: false },
      'invalid_success_redirect',
      'successRedirect.includeInviteePersonalData',
    ],
    [
      'NUL URL',
      { url: 'https://target.example.test/\u0000' },
      'invalid_request',
      'successRedirect.url',
    ],
    [
      'malformed Unicode URL',
      { url: 'https://target.example.test/\ud800' },
      'invalid_request',
      'successRedirect.url',
    ],
    ['URL shape', { url: 5 }, 'invalid_request', 'successRedirect.url'],
    [
      'parameter shape',
      { ...redirect, parameters: 'start' },
      'invalid_request',
      'successRedirect.parameters',
    ],
    [
      'consent shape',
      { ...redirect, includeInviteePersonalData: 'yes' },
      'invalid_request',
      'successRedirect.includeInviteePersonalData',
    ],
    [
      'embed shape',
      { ...redirect, allowEmbedParent: 'yes' },
      'invalid_request',
      'successRedirect.allowEmbedParent',
    ],
    [
      'unknown setting',
      { ...redirect, privateSetting: true },
      'invalid_request',
      'successRedirect',
    ],
    ['config shape', false, 'invalid_request', 'successRedirect'],
  ]
  it.each(invalidCases)(
    'returns matching value-free stable field errors for %s',
    async (_, successRedirect, code, field) => {
      const s = await setup()
      const created = ok(await s.call('create_event_type', input()))
      for (const update of [false, true]) {
        const body = { ...(update ? {} : input()), successRedirect }
        const response = await s.rest(
          update ? 'PATCH' : 'POST',
          update ? created.id : undefined,
          body,
        )
        expect(response.status).toBe(400)
        const detail = await response.json()
        expect(detail).toMatchObject({ error: code, field })
        const result = error(
          await s.call(update ? 'update_event_type' : 'create_event_type', {
            ...(update ? { id: created.id } : {}),
            ...body,
          }),
        )
        expect(result).toEqual(detail)
        expect(result.message).not.toContain('private-value')
        expect(result.message).not.toContain('private:private')
      }
      expect(
        (
          await scheduling.getEventType(
            { db, principal: s.caller, now: () => Temporal.Now.instant() },
            created.id,
          )
        ).successRedirect,
      ).toBeNull()
    },
  )
  it.each(['read', 'bookings'] as const)(
    'refuses %s writes before shape validation and keeps scoped discovery',
    async (scope) => {
      const s = await setup(eventTypeTools, {}, scope)
      const created = await scheduling.createEventType(
        { db, principal: s.caller, now: () => Temporal.Now.instant() },
        input(),
      )
      for (const update of [false, true]) {
        const response = await s.rest(update ? 'PATCH' : 'POST', update ? created.id : undefined, {
          successRedirect: false,
        })
        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({ error: 'insufficient_scope' })
        expect(
          error(
            await s.call(update ? 'update_event_type' : 'create_event_type', {
              id: created.id,
              successRedirect: false,
            }),
          ).error,
        ).toBe('insufficient_scope')
      }
      const client = new Client({ name: 'redirect-scope-test', version: '1.0.0' })
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
            fetch: async (i, init) => s.app.request(i, init),
            requestInit: { headers: { authorization: 'Bearer hm_synthetic' } },
          }),
        )
        const list = await client.listTools()
        expect(list.tools.map((tool) => tool.name)).not.toContain('create_event_type')
        expect(list.tools.map((tool) => tool.name)).not.toContain('update_event_type')
        expect(list.tools.map((tool) => tool.name)).toContain('get_event_type')
        const result = await client.callTool({
          name: 'update_event_type',
          arguments: { id: created.id, successRedirect: redirect },
        })
        expect(result.isError).toBe(true)
        expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? '')).toMatchObject({
          error: 'insufficient_scope',
        })
      } finally {
        await client.close()
      }
      expect(
        (
          await scheduling.getEventType(
            { db, principal: s.caller, now: () => Temporal.Now.instant() },
            created.id,
          )
        ).successRedirect,
      ).toBeNull()
    },
  )
  it('retains team membership and ownership restrictions', async () => {
    const member = await setup(eventTypeTools, {}, 'full', 'member')
    const response = await member.rest('POST', undefined, { ...input(), successRedirect: redirect })
    expect(response.status).toBe(403)
    expect(
      error(await member.call('create_event_type', { ...input(), successRedirect: redirect }))
        .error,
    ).toBe('insufficient_role')
    const owner = await setup()
    const created = ok(
      await owner.call('create_event_type', { ...input(), successRedirect: redirect }),
    )
    expect((await member.rest('PATCH', created.id, { successRedirect: null })).status).toBe(404)
    expect(
      error(await member.call('update_event_type', { id: created.id, successRedirect: null }))
        .error,
    ).toBe('event_type_not_found')
  })
  it('preserves a stale target on unrelated edits while explicit resubmission is validated and clearing succeeds', async () => {
    const s = await setup()
    const saved = await scheduling.createEventType(
      {
        db,
        principal: s.caller,
        now: () => Temporal.Now.instant(),
        successRedirectPolicy: { allowIpHosts: true },
      },
      { ...input(), successRedirect: { url: 'https://203.0.113.5/private' } },
    )
    const unrelated = await s.rest('PATCH', saved.id, { title: 'Still editable' })
    expect(unrelated.status).toBe(200)
    expect(((await unrelated.json()) as Saved).successRedirect).toEqual(saved.successRedirect)
    expect(
      ok(await s.call('update_event_type', { id: saved.id, durationMinutes: 45 })).successRedirect,
    ).toEqual(saved.successRedirect)
    const explicit = await s.rest('PATCH', saved.id, { successRedirect: saved.successRedirect })
    expect(explicit.status).toBe(400)
    expect(await explicit.json()).toMatchObject({
      error: 'invalid_success_redirect',
      field: 'successRedirect.url',
    })
    expect(
      error(
        await s.call('update_event_type', { id: saved.id, successRedirect: saved.successRedirect }),
      ),
    ).toMatchObject({ error: 'invalid_success_redirect', field: 'successRedirect.url' })
    expect(
      ok(await s.call('update_event_type', { id: saved.id, successRedirect: null }))
        .successRedirect,
    ).toBeNull()
  })
  async function verifyWrite(factory: Factory, update: boolean) {
    const s = await setup(factory)
    const created = await scheduling.createEventType(
      { db, principal: s.caller, now: () => Temporal.Now.instant() },
      input(),
    )
    const saved = ok(
      await s.call(update ? 'update_event_type' : 'create_event_type', {
        ...(update ? { id: created.id } : input()),
        successRedirect: redirect,
      }),
    )
    expect(saved.successRedirect).toEqual(redirect)
    expect(
      (
        await scheduling.getEventType(
          { db, principal: s.caller, now: () => Temporal.Now.instant() },
          saved.id,
        )
      ).successRedirect,
    ).toEqual(redirect)
  }
  it('checks source-copy create and update forwarding', async () => {
    await verifyWrite(sourceCopy(), false)
    await verifyWrite(sourceCopy(), true)
  })
  it.each([false, true])('detects removed redirect forwarding for update=%s', async (update) => {
    const change: Change = update
      ? [
          'return updateEventType(context(call.caller), id, changes)',
          'return updateEventType(context(call.caller), id, {...changes, successRedirect: undefined})',
        ]
      : [
          'return createEventType(context(call.caller), args)',
          'return createEventType(context(call.caller), {...args, successRedirect: undefined})',
        ]
    await expect(verifyWrite(sourceCopy(change), update)).rejects.toMatchObject({
      name: 'AssertionError',
    })
  })
  async function verifyPolicy(factory: Factory, update: boolean) {
    for (const policy of [{ publicUrl: 'https://localhost' }, { allowIpHosts: true }]) {
      const s = await setup(factory, policy)
      const created = await scheduling.createEventType(
        { db, principal: s.caller, now: () => Temporal.Now.instant() },
        input(),
      )
      const saved = ok(
        await s.call(update ? 'update_event_type' : 'create_event_type', {
          ...(update ? { id: created.id } : input()),
          successRedirect: { url: 'https://localhost/thanks' },
        }),
      )
      expect(saved.successRedirect?.url).toBe('https://localhost/thanks')
    }
  }
  it.each([false, true])(
    'uses the current MCP instance host and local-target switch for update=%s',
    async (update) => {
      await verifyPolicy(productTools, update)
      await verifyPolicy(sourceCopy(), update)
      await expect(
        verifyPolicy(
          sourceCopy([
            '    successRedirectPolicy,\n    followUpHostNotesEnabled,',
            '    followUpHostNotesEnabled,',
          ]),
          update,
        ),
      ).rejects.toMatchObject({ name: 'AssertionError' })
      await verifyPolicy(productSourceCopy(), update)
      await expect(
        verifyPolicy(
          productSourceCopy([
            '      followUpHostNotesEnabled,\n      successRedirectPolicy,',
            '      followUpHostNotesEnabled,',
          ]),
          update,
        ),
      ).rejects.toMatchObject({ name: 'AssertionError' })
    },
  )
})

it('documents additive REST input/output and field-error shapes and shares them with MCP', async () => {
  const doc = (await openApiDocument()) as {
    components: { schemas: Record<string, { properties?: Record<string, unknown> }> }
  }
  for (const name of ['EventType', 'EventTypeInput', 'EventTypeUpdate'])
    expect(doc.components.schemas[name]?.properties).toHaveProperty('successRedirect')
  expect(doc.components.schemas.Error?.properties).toHaveProperty('field')
  expect(schemas.EventTypeInput.shape.successRedirect.unwrap()).toBe(
    schemas.EventTypeUpdate.shape.successRedirect.unwrap(),
  )
})

it('detects losing service-validated parameter documentation from MCP', () => {
  const anchor = 'if (Array.isArray(meta.enum)) ctx.jsonSchema.enum = [...meta.enum]'
  const source = readFileSync('apps/server/src/mcp/tools.ts', 'utf8')
  const body = source.slice(
    source.indexOf('function adaptJsonSchema('),
    source.indexOf('/**\n * A zod schema'),
  )
  expect(body).toContain(anchor)
  function verify(text: string) {
    const adapt = new Function(
      'getOpenApiMetadata',
      `${stripTypeScriptTypes(text)}; return adaptJsonSchema`,
    )(getOpenApiMetadata) as (ctx: {
      zodSchema: unknown
      jsonSchema: Record<string, unknown>
    }) => void
    const jsonSchema: Record<string, unknown> = {}
    adapt({
      zodSchema: z.string().openapi({
        enum: [...scheduling.SUCCESS_REDIRECT_PARAMETERS],
      }),
      jsonSchema,
    })
    expect(jsonSchema).toMatchObject({
      enum: [...scheduling.SUCCESS_REDIRECT_PARAMETERS],
    })
  }
  verify(body)
  expect(() => verify(body.replace(anchor, ''))).toThrowError(
    expect.objectContaining({ name: 'AssertionError' }),
  )
})
