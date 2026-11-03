import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createEventType, type LocationOption } from '@hourmere/scheduling'
import { createTestUser, testContext } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { catalogTools } from '../mcp/catalog.ts'
import { mcpEndpoint } from '../mcp/endpoint.ts'
import { eventTypeTools } from '../mcp/event-types.ts'
import type { McpCaller } from '../mcp/tools.ts'
import * as routes from './event-types.ts'
import { openApiDocument } from './test-app.ts'

type Change = readonly [string, string]
type Schemas = Pick<
  typeof routes,
  'eventTypeRoutes' | 'EventType' | 'EventTypeInput' | 'EventTypeUpdate'
>

/** The complete route module; the boundary assertions assume no response-helper name. */
async function sourceCopy(change?: Change): Promise<Schemas> {
  const url = new URL('event-types.ts', import.meta.url)
  let source = readFileSync(url, 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match source').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source)
  const bindings: Record<string, unknown> = {}
  for (const imported of source.matchAll(/^import\s*\{([\s\S]*?)\}\s*from '([^']+)'\n/gm)) {
    const specifier = imported[2] as string
    const module = await import(
      specifier.startsWith('.') ? new URL(specifier, url).href : specifier
    )
    for (const binding of (imported[1] as string)
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)) {
      const [name, local] = binding.split(/\s+as\s+/)
      bindings[local ?? (name as string)] = module[name as string]
    }
    source = source.replace(imported[0], '')
  }
  return new Function(
    ...Object.keys(bindings),
    `${source.replace(/\bexport /g, '')}; return { eventTypeRoutes, EventType, EventTypeInput, EventTypeUpdate }`,
  )(...Object.values(bindings)) as Schemas
}

const options: LocationOption[] = [
  { id: 'office', kind: 'in_person', address: '1 Main Street', label: 'Our office' },
  { id: 'call', kind: 'phone', number: '+14155550123', isDefault: true },
  { id: 'room', kind: 'link', url: 'https://example.com/room' },
]
const base = { slug: 'choice', title: 'Choose where to meet', durationMinutes: 30 }
const auth = { authorization: 'Bearer hm_synthetic' }

function verifyPhoneInput(schemas: Schemas) {
  for (const location of [
    { kind: 'phone', number: '+14155550123' },
    { kind: 'phone', askInvitee: true },
  ]) {
    expect(schemas.EventTypeInput.safeParse({ ...base, location }).success).toBe(true)
    expect(schemas.EventTypeUpdate.safeParse({ location }).success).toBe(true)
  }
  for (const location of [
    { kind: 'phone' },
    { kind: 'phone', askInvitee: false },
    { kind: 'phone', number: '+14155550123', askInvitee: true },
    { kind: 'phone', askInvitee: true, extra: true },
  ]) {
    expect(schemas.EventTypeInput.safeParse({ ...base, location }).success).toBe(false)
    expect(schemas.EventTypeUpdate.safeParse({ location }).success).toBe(false)
  }
}

async function verifyPublishedLocation(schemas: Schemas) {
  const app = createApp({
    publicUrl: 'http://localhost:4189',
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
    routes: [schemas.eventTypeRoutes({ db: {} as Db })],
  })
  const doc = await openApiDocument(app)
  const properties = doc.components.schemas.EventType?.properties as Record<string, unknown>
  expect(properties.location).toHaveProperty('oneOf', expect.any(Array))
  expect(properties.location).not.toHaveProperty('anyOf')
  const variants = (
    properties.location as { oneOf: { properties?: { kind?: { enum?: string[] } } }[] }
  ).oneOf
  expect(variants).toHaveLength(6)
  expect(
    variants.filter((variant) => variant.properties?.kind?.enum?.[0] === 'phone'),
  ).toHaveLength(1)
  expect(doc.paths['/api/v1/event-types/{id}']?.patch?.responses['409']).toHaveProperty(
    'description',
    expect.stringContaining('location_options_conflict'),
  )
}

describe('internal event location options transport schemas', () => {
  it('keeps option writes out of the shared REST and MCP schemas', () => {
    expect(routes.EventTypeInput.safeParse({ ...base, locations: options }).success).toBe(false)
    expect(routes.EventTypeUpdate.safeParse({ locations: options }).success).toBe(false)
    expect(routes.EventType.shape).not.toHaveProperty('locations')
  })
  it('accepts either phone mode while rejecting missing, mixed and unknown settings', () =>
    verifyPhoneInput(routes))
  it.each([
    ['strict phone mode validation', 'true'],
    ['invitee-phone compatibility writes', 'phone.number !== undefined'],
  ])('detects removal of %s in a source copy', async (_name, replacement) => {
    verifyPhoneInput(await sourceCopy())
    const mutant = await sourceCopy([
      '(phone.number !== undefined) !== (phone.askInvitee === true)',
      replacement,
    ])
    expect(() => verifyPhoneInput(mutant)).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    verifyPhoneInput(await sourceCopy())
  })
  it('preserves the published location oneOf and documents the legacy conflict', () =>
    verifyPublishedLocation(routes))
  it('detects replacing the published discriminated oneOf with anyOf', async () => {
    await verifyPublishedLocation(await sourceCopy())
    await expect(
      verifyPublishedLocation(await sourceCopy([".discriminatedUnion('kind', [", '.union(['])),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await verifyPublishedLocation(await sourceCopy())
  })
})

describe.skipIf(!process.env.DATABASE_URL)('location compatibility over REST and MCP HTTP', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'location_http',
    })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function setup(schemas: Schemas = routes) {
    const user = await createTestUser(db)
    const caller = user.principal as McpCaller
    const ctx = testContext(db, caller)
    const tools = [...eventTypeTools({ db }), ...catalogTools({ db })].map((tool) =>
      [
        'create_event_type',
        'update_event_type',
        'get_event_type',
        'set_event_type_notifications',
      ].includes(tool.name)
        ? { ...tool, output: schemas.EventType }
        : tool,
    )
    const app = createApp({
      publicUrl: 'http://localhost:4189',
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: true, principal: caller, setCookie: [] }),
      routes: [schemas.eventTypeRoutes({ db })],
      mcp: mcpEndpoint({ tools }),
    })
    async function rest(method: string, path: string, body?: unknown) {
      const response = await app.request(path, {
        method,
        headers: { ...auth, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return {
        status: response.status,
        isError: !response.ok,
        body: (await response.json()) as Record<string, unknown>,
      }
    }
    async function mcp(name: string, args: Record<string, unknown>) {
      const response = await app.request('/mcp', {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      })
      expect(response.status).toBe(200)
      const text = await response.text()
      const message = JSON.parse(
        response.headers.get('content-type')?.startsWith('text/event-stream')
          ? (text
              .split('\n')
              .find((line) => line.startsWith('data: '))
              ?.slice(6) ?? 'null')
          : text,
      )
      expect(message.error).toBeUndefined()
      const result = message.result
      const body = result.structuredContent ?? JSON.parse(result.content[0].text)
      return {
        status: response.status,
        isError: result.isError === true,
        body: body as Record<string, unknown>,
      }
    }
    return {
      create: (locations: LocationOption[]) =>
        createEventType(ctx, { ...base, slug: randomUUID(), locations }),
      stored: (id: string) =>
        db
          .selectFrom('event_types')
          .select('locations')
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      rest,
      mcp,
      update: (mode: 'REST' | 'MCP', id: string, changes: Record<string, unknown>) =>
        mode === 'REST'
          ? rest('PATCH', `/api/v1/event-types/${id}`, changes)
          : mcp('update_event_type', { id, ...changes }),
      read: (mode: 'REST' | 'MCP', id: string) =>
        mode === 'REST' ? rest('GET', `/api/v1/event-types/${id}`) : mcp('get_event_type', { id }),
    }
  }

  it.each(['REST', 'MCP'] as const)(
    'preserves ordered, labelled defaults on %s read-then-write',
    async (mode) => {
      const s = await setup()
      for (const locations of [options, [options[0] as LocationOption]]) {
        const created = await s.create(locations)
        const read = await s.read(mode, created.id)
        expect(read.status).toBe(200)
        expect(read.body).not.toHaveProperty('locations')
        expect(
          await s.update(mode, created.id, { title: 'Renamed', location: read.body.location }),
        ).toMatchObject({ status: 200, body: { title: 'Renamed' } })
        expect(await s.stored(created.id)).toEqual({ locations })
      }
    },
  )
  it.each(['REST', 'MCP'] as const)(
    'retains singleton identity for %s edits and rotates it on kind change',
    async (mode) => {
      const s = await setup()
      const created = await s.create([
        { id: 'saved-id', kind: 'phone', number: '+14155550123', isDefault: true },
      ])
      expect(
        await s.update(mode, created.id, { location: { kind: 'phone', number: '+14155550124' } }),
      ).toMatchObject({ status: 200 })
      expect(await s.stored(created.id)).toEqual({
        locations: [{ id: 'saved-id', kind: 'phone', number: '+14155550124', isDefault: true }],
      })
      expect(
        await s.update(mode, created.id, {
          location: { kind: 'in_person', address: 'New office' },
        }),
      ).toMatchObject({ status: 200 })
      const stored = await s.stored(created.id)
      expect(stored.locations).toEqual([
        { id: expect.any(String), kind: 'in_person', address: 'New office', isDefault: true },
      ])
      expect((stored.locations as unknown as LocationOption[])[0]?.id).not.toBe('saved-id')
    },
  )
  it.each(['REST', 'MCP'] as const)(
    'rejects destructive %s legacy edits and clears atomically',
    async (mode) => {
      const s = await setup()
      for (const locations of [options, [options[0] as LocationOption]]) {
        const created = await s.create(locations)
        for (const location of [null, { kind: 'phone', number: '+14155550124' }]) {
          expect(
            await s.update(mode, created.id, { title: 'Rejected title', location }),
          ).toMatchObject({
            status: mode === 'REST' ? 409 : 200,
            isError: true,
            body: {
              error: 'location_options_conflict',
              message: expect.stringContaining('Use locations'),
            },
          })
          expect(await s.stored(created.id)).toEqual({ locations })
          expect((await s.read(mode, created.id)).body.title).toBe(base.title)
        }
      }
    },
  )
  it.each(['REST', 'MCP'] as const)(
    'round-trips default invitee-phone compatibility on %s saves',
    async (mode) => {
      const s = await setup()
      const locations: LocationOption[] = [
        options[0] as LocationOption,
        { id: 'ask', kind: 'phone', askInvitee: true, isDefault: true },
      ]
      const created = await s.create(locations)
      const read = await s.read(mode, created.id)
      expect(read.body.location).toEqual({ kind: 'phone', askInvitee: true })
      expect(
        await s.update(mode, created.id, { title: 'Saved phone', location: read.body.location }),
      ).toMatchObject({ status: 200, body: { location: read.body.location } })
      expect(await s.stored(created.id)).toEqual({ locations })
    },
  )

  async function verifyBoundary(schemas: Schemas = routes) {
    const s = await setup(schemas)
    const created = await s.create(options)
    const notifications = { reminders: [], followUps: [] }
    const restCreated = await s.rest('POST', '/api/v1/event-types', {
      ...base,
      slug: randomUUID(),
      location: created.location,
    })
    expect(restCreated.status).toBe(201)
    expect(restCreated.body).not.toHaveProperty('locations')
    const responses = [
      await s.read('REST', created.id),
      await s.update('REST', created.id, { title: 'REST save' }),
      await s.rest('PUT', `/api/v1/event-types/${created.id}/notifications`, { notifications }),
      await s.read('MCP', created.id),
      await s.update('MCP', created.id, { title: 'MCP save' }),
      await s.mcp('set_event_type_notifications', { id: created.id, notifications }),
      await s.mcp('create_event_type', {
        ...base,
        slug: randomUUID(),
        location: created.location,
      }),
    ]
    const list = await s.rest('GET', '/api/v1/event-types')
    expect(list.status).toBe(200)
    for (const response of responses) {
      expect(response.status).toBe(200)
      expect(response.isError).toBe(false)
      expect(response.body).not.toHaveProperty('locations')
      expect(response.body).toHaveProperty('successRedirect', null)
    }
    for (const item of list.body.data as unknown[]) expect(item).not.toHaveProperty('locations')
    expect(await s.stored(created.id)).toEqual({ locations: options })
  }
  it('keeps options out of actual REST and MCP responses regardless of projection helpers', () =>
    verifyBoundary())
  it('detects a REST response leak introduced after its projection', async () => {
    await verifyBoundary(await sourceCopy())
    const mutant = await sourceCopy([
      'return ({ app, caller }) => {',
      `return ({ app, caller }) => {
      app.use('/api/v1/event-types*', async (c, next) => {
        await next()
        if (c.res.status === 200) c.res = Response.json({ ...await c.res.json(), locations: [] })
      })`,
    ])
    await expect(verifyBoundary(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
    await verifyBoundary(await sourceCopy())
  })
  it('detects the MCP output schema retaining internal service fields', async () => {
    const mutant = await sourceCopy([
      ".openapi('EventType')",
      ".passthrough().openapi('EventType')",
    ])
    await expect(verifyBoundary(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
    await verifyBoundary(await sourceCopy())
  })
})
