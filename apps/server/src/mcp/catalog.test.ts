// Real keys, MCP transport and REST parity against an owned throwaway database.
import '@hono/zod-openapi'
import { randomBytes, randomUUID } from 'node:crypto'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { listEventTypeCatalog, listScheduleCatalog, putProfile } from '@hourmere/scheduling'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  domainError,
  type Fixtures,
  type TestTeam,
  type TestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { eventTypeRoutes } from '../routes/event-types.ts'
import { profileRoutes } from '../routes/profile.ts'
import { scheduleRoutes } from '../routes/schedules.ts'
import { catalogTools } from './catalog.ts'
import { mcpEndpoint } from './endpoint.ts'
import { whoamiTool } from './whoami.ts'

const serverUrl = process.env.DATABASE_URL
const PUBLIC_URL = 'http://localhost:4188'
type Result = { isError?: boolean; content?: unknown; structuredContent?: unknown }
type Page = { data: { id: string; [key: string]: unknown }[]; nextAfter: string | null }

describe.skipIf(!serverUrl)('MCP configuration catalog with real keys', () => {
  let testDb: TestDatabase
  let db: Db
  let authPool: pg.Pool
  let auth: Auth
  let f: Fixtures
  let ada: TestUser
  let grace: TestUser
  let team: TestTeam
  let key: string
  let teamKey: string
  let graceTeamKey: string
  let eventId: string
  let teamEventId: string
  let graceEventId: string
  let deletedId: string
  let scheduleId: string
  let foreignScheduleId: string
  let app: ReturnType<typeof createApp>
  async function makeKey(user: TestUser, organizationId?: string) {
    const created = await auth.api.createApiKey({
      body: {
        userId: user.id,
        name: 'catalog-test',
        ...(organizationId ? { metadata: { organizationId } } : {}),
      },
    })
    return created.key
  }
  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
    db = createDb(testDb.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    authPool = createAuthPool(testDb.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: PUBLIC_URL,
      secret: randomBytes(32).toString('base64'),
      mailer: { send: async () => {} },
      signup,
    })
    f = createFixtures(db)
    ada = await createTestUser(db, 'Ada')
    grace = await createTestUser(db, 'Grace')
    team = await createTestTeam(db, [
      { user: ada, role: 'owner' },
      { user: grace, role: 'member' },
    ])
    key = await makeKey(ada)
    teamKey = await makeKey(ada, team.id)
    graceTeamKey = await makeKey(grace, team.id)
    await putProfile(testContext(db, ada.principal), {
      handle: 'catalog-ada',
      timeZone: 'America/Los_Angeles',
      locale: 'en',
    })
    eventId = await f.eventType(ada.principal.organization.id, ada.id, {
      description: 'private detail',
      questions: [{ id: 'topic', type: 'short_text', label: 'Topic', required: true }],
      location: { kind: 'link', url: 'https://example.com/meeting' },
      isActive: false,
    })
    teamEventId = await f.eventType(team.id, null, { hosts: [{ userId: ada.id }] })
    graceEventId = await f.eventType(team.id, grace.id)
    deletedId = await f.eventType(team.id, null, { deletedAt: '2026-10-01T00:00:00Z' })
    scheduleId = await f.schedule(ada.id, {
      timeZone: 'America/Los_Angeles',
      weeklyHours: { sunday: [{ start: '00:00', end: '24:00' }] },
      overrides: [{ date: '2026-11-01', intervals: [] }],
    })
    foreignScheduleId = await f.schedule(grace.id)
    app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl: PUBLIC_URL,
      routes: [profileRoutes({ db }), scheduleRoutes({ db }), eventTypeRoutes({ db })],
      mcp: mcpEndpoint({ tools: [whoamiTool, ...catalogTools({ db })] }),
    })
  })
  afterAll(async () => {
    await authPool?.end()
    await testDb?.drop()
  })
  async function connect(token = key) {
    const client = new Client({ name: 'catalog-test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}/mcp`), {
        fetch: async (input, init) => app.request(input, init),
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    )
    return client
  }
  async function call(name: string, args: Record<string, unknown> = {}, token = key) {
    const client = await connect(token)
    try {
      return (await client.callTool({ name, arguments: args })) as Result
    } finally {
      await client.close()
    }
  }
  function ok<T>(result: Result): T {
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
    const content = result.content as { type: string; text: string }[]
    expect(content).toHaveLength(1)
    expect(JSON.parse(content[0]?.text ?? 'null')).toEqual(result.structuredContent)
    return result.structuredContent as T
  }
  function error(result: Result) {
    expect(result.isError).toBe(true)
    return JSON.parse((result.content as { text: string }[])[0]?.text ?? 'null') as {
      error: string
      message?: string
    }
  }
  async function rest(path: string, token = key) {
    const response = await app.request(`${PUBLIC_URL}/api/v1/${path}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    return response.json()
  }
  it('advertises all five read-only strict tools and bounded page output schemas', async () => {
    const client = await connect()
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual([
        'get_event_type',
        'get_profile',
        'get_schedule',
        'list_event_types',
        'list_schedules',
        'whoami',
      ])
      for (const tool of tools.filter((t) => t.name !== 'whoami')) {
        expect(tool.inputSchema.additionalProperties).toBe(false)
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        })
        if (tool.name.startsWith('list_')) {
          expect(tool.outputSchema).toMatchObject({ properties: { data: { maxItems: 100 } } })
          expect(tool.inputSchema.properties?.limit).toMatchObject({ minimum: 1, maximum: 100 })
        }
      }
    } finally {
      await client.close()
    }
  })
  it('returns the exact REST profile, including when using a team key', async () => {
    expect(ok(await call('get_profile'))).toEqual(await rest('profile'))
    expect(ok(await call('get_profile', {}, teamKey))).toEqual(await rest('profile', teamKey))
  })
  it('reports a missing profile with the service error', async () => {
    expect(error(await call('get_profile', {}, graceTeamKey))).toEqual({
      error: 'profile_not_found',
      message: 'Create a profile with PUT /api/v1/profile',
    })
  })
  it('returns full event and schedule configurations identical to REST', async () => {
    const event = ok<Record<string, unknown>>(await call('get_event_type', { id: eventId }))
    expect(event).toEqual(await rest(`event-types/${eventId}`))
    expect(event).toMatchObject({
      isActive: false,
      description: 'private detail',
      questions: [{ id: 'topic' }],
      location: { kind: 'link' },
    })
    const schedule = ok<Record<string, unknown>>(await call('get_schedule', { id: scheduleId }))
    expect(schedule).toEqual(await rest(`schedules/${scheduleId}`))
    expect(schedule).toMatchObject({
      timeZone: 'America/Los_Angeles',
      weeklyHours: { sunday: [{ start: '00:00', end: '24:00' }] },
    })
    expect(schedule).not.toHaveProperty('overrides')
  })
  it('lists only personal-organization types for a personal key, including inactive ones', async () => {
    expect(ok<Page>(await call('list_event_types'))).toEqual({
      data: [expect.objectContaining({ id: eventId, ownerUserId: ada.id, isActive: false })],
      nextAfter: null,
    })
  })
  it('limits a team owner to team types and their own personal types, excluding deleted rows', async () => {
    const ownTeamPersonal = await f.eventType(team.id, ada.id)
    try {
      const page = ok<Page>(await call('list_event_types', {}, teamKey))
      expect(page.data.map((r) => r.id)).toEqual([teamEventId, ownTeamPersonal].sort())
      expect(error(await call('get_event_type', { id: graceEventId }, teamKey)).error).toBe(
        'event_type_not_found',
      )
    } finally {
      await db.deleteFrom('event_types').where('id', '=', ownTeamPersonal).execute()
    }
    for (const id of [eventId, deletedId, randomUUID()]) {
      expect(error(await call('get_event_type', { id }, teamKey)).error).toBe(
        'event_type_not_found',
      )
    }
  })
  it('allows ordinary team members to discover team configuration and their own types', async () => {
    const page = ok<Page>(await call('list_event_types', {}, graceTeamKey))
    expect(page.data.map((r) => r.id)).toEqual([teamEventId, graceEventId].sort())
    expect(
      ok<Record<string, unknown>>(await call('get_event_type', { id: teamEventId }, graceTeamKey))
        .id,
    ).toBe(teamEventId)
  })
  it('schedules follow the user across organizations, never another member', async () => {
    const personal = ok<Page>(await call('list_schedules'))
    expect(personal.data.map((r) => r.id)).toEqual([scheduleId])
    expect(ok(await call('list_schedules', {}, teamKey))).toEqual(personal)
    expect(ok(await call('get_schedule', { id: scheduleId }, teamKey))).toEqual(
      await rest(`schedules/${scheduleId}`, teamKey),
    )
    for (const id of [foreignScheduleId, randomUUID()])
      expect(error(await call('get_schedule', { id }, teamKey)).error).toBe('schedule_not_found')
  })
  it('summary pages omit large fields and expose only discovery metadata', async () => {
    const event = ok<Page>(await call('list_event_types')).data[0]
    expect(Object.keys(event ?? {}).sort()).toEqual(
      [
        'id',
        'organizationId',
        'ownerUserId',
        'slug',
        'title',
        'durationMinutes',
        'schedulingType',
        'isActive',
        'position',
      ].sort(),
    )
    const schedule = ok<Page>(await call('list_schedules')).data[0]
    expect(Object.keys(schedule ?? {}).sort()).toEqual(
      ['id', 'name', 'timeZone', 'isDefault'].sort(),
    )
    expect(JSON.stringify(event)).not.toContain('private detail')
    expect(JSON.stringify(schedule)).not.toContain('weeklyHours')
  })
  it.each(['list_event_types', 'list_schedules'])(
    'paginates %s with an exclusive id, exact tail, and a 100-row ceiling',
    async (name) => {
      const user = await createTestUser(db, 'Page owner')
      const token = await makeKey(user)
      const ids: string[] = []
      for (let i = 0; i < 105; i++)
        ids.push(
          name === 'list_event_types'
            ? await f.eventType(user.principal.organization.id, user.id, {
                title: 'Same title',
                description: 'x'.repeat(4000),
              })
            : await f.schedule(user.id, { isDefault: i === 0 }),
        )
      ids.sort()
      const first = ok<Page>(await call(name, {}, token))
      expect(first.data.map((r) => r.id)).toEqual(ids.slice(0, 20))
      expect(first.nextAfter).toBe(ids[19])
      const all: string[] = []
      let after: string | null = null
      do {
        const page: Page = ok(await call(name, { limit: 17, ...(after ? { after } : {}) }, token))
        expect(page.data.length).toBeLessThanOrEqual(17)
        expect(JSON.stringify(page).length).toBeLessThan(18000)
        all.push(...page.data.map((r) => r.id))
        after = page.nextAfter
        if (after) expect(after).toBe(page.data.at(-1)?.id)
        expect(all.length).toBeLessThanOrEqual(105)
      } while (after)
      expect(all).toEqual(ids)
      const max = ok<Page>(await call(name, { limit: 100 }, token))
      expect(max.data.map((r) => r.id)).toEqual(ids.slice(0, 100))
      expect(max.nextAfter).toBe(ids[99])
      expect(ok<Page>(await call(name, { limit: 5, after: ids[99] }, token))).toEqual({
        data: expect.any(Array),
        nextAfter: null,
      })
      expect(ok<Page>(await call(name, { after: ids.at(-1) }, token))).toEqual({
        data: [],
        nextAfter: null,
      })
      // A removed cursor row is still a position, not a required record lookup.
      if (name === 'list_event_types')
        await db
          .updateTable('event_types')
          .set({ deleted_at: new Date() })
          .where('id', '=', ids[19] as string)
          .execute()
      else
        await db
          .deleteFrom('schedules')
          .where('id', '=', ids[19] as string)
          .execute()
      expect(
        ok<Page>(await call(name, { limit: 2, after: ids[19] }, token)).data.map((r) => r.id),
      ).toEqual(ids.slice(20, 22))
    },
    20000,
  )
  it.each(['list_event_types', 'list_schedules'])(
    'validates %s bounds, UUIDs and unknown authority fields',
    async (name) => {
      for (const args of [
        { limit: 0 },
        { limit: 101 },
        { limit: 1.5 },
        { limit: null },
        { after: 'bad' },
        { userId: grace.id },
        { organizationId: team.id },
      ])
        expect(error(await call(name, args)).error).toBe('invalid_request')
    },
  )
  it.each(['get_profile', 'get_event_type', 'get_schedule'])(
    'rejects forged authority or malformed selectors in %s',
    async (name) => {
      expect(error(await call(name, { userId: grace.id })).error).toBe('invalid_request')
      if (name !== 'get_profile')
        for (const args of [{}, { id: 'bad' }, { id: randomUUID(), organizationId: team.id }])
          expect(error(await call(name, args)).error).toBe('invalid_request')
    },
  )
  it('fetches at most one lookahead row and no large JSON columns from SQL', async () => {
    const user = await createTestUser(db, 'Bounded queries')
    for (let i = 0; i < 6; i++) {
      await f.eventType(user.principal.organization.id, user.id)
      await f.schedule(user.id, { isDefault: i === 0 })
    }
    const seen: Record<string, unknown>[][] = []
    const observed = db.withPlugin({
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        seen.push(result.rows)
        return result
      },
    })
    const ctx = testContext(observed, user.principal)
    for (const list of [listEventTypeCatalog, listScheduleCatalog]) {
      seen.length = 0
      expect((await list(ctx, { limit: 3 })).data).toHaveLength(3)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toHaveLength(4)
      for (const row of seen[0] ?? []) {
        for (const large of ['description', 'questions', 'location', 'weekly_hours'])
          expect(row).not.toHaveProperty(large)
      }
    }
  })
  it('validates service cursors and limits without echoing input', async () => {
    const ctx = testContext(db, ada.principal)
    for (const list of [listEventTypeCatalog, listScheduleCatalog]) {
      for (const limit of [0, 101, 1.5, Number.NaN])
        expect((await domainError(() => list(ctx, { limit }))).code).toBe('invalid_limit')
      const err = await domainError(() => list(ctx, { after: 'bad'.repeat(10000) }))
      expect(err.code).toBe('invalid_cursor')
      expect(err.detail).not.toContain('bad')
      expect(err.detail?.length).toBeLessThan(100)
    }
  })
})
