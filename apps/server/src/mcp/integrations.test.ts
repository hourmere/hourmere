import { randomBytes, randomUUID } from 'node:crypto'
import { type Auth, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import {
  beginGoogleConnection,
  type CalendarDeps,
  finishGoogleConnection,
} from '@hourmere/calendars'
import {
  beginZoomConnection,
  type ConferenceDeps,
  finishZoomConnection,
  listConferenceConnections,
} from '@hourmere/conferences'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam } from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  calendarTestSession,
  fakeGoogle,
  TEST_CALENDAR_KEY,
} from '../../../../packages/calendars/src/testing.ts'
import { fakeZoom, TEST_CONFERENCE_KEY } from '../../../../packages/conferences/src/testing.ts'
import { createApp } from '../app.ts'
import { calendarRoutes } from '../routes/calendars.ts'
import { conferenceRoutes } from '../routes/conferences.ts'
import { productTools } from '../server.ts'
import { mcpEndpoint } from './endpoint.ts'
import { integrationTools } from './integrations.ts'
import { type McpCaller, runTool } from './tools.ts'

const PUBLIC_URL = 'http://localhost:4189'
const names = ['list_calendar_connections', 'list_conference_connections'] as const
type Name = (typeof names)[number]
type Listing = { data: { id: string; [key: string]: unknown }[]; [key: string]: unknown }

describe.skipIf(!process.env.DATABASE_URL)('MCP integration discovery with real API keys', () => {
  let database: TestDatabase
  let db: Db
  let pool: pg.Pool
  let auth: Auth
  let owner: Awaited<ReturnType<typeof calendarTestSession>>
  let other: typeof owner
  let teamOwner: McpCaller
  let keys: string[]
  let calendar: CalendarDeps
  let conference: ConferenceDeps
  let google: ReturnType<typeof fakeGoogle>
  let zoom: ReturnType<typeof fakeZoom>
  let app: ReturnType<typeof createApp>
  const ownIds = new Map<Name, string>()

  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(database.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    pool = createAuthPool(database.url, signup)
    auth = createAuth({
      pool,
      db,
      baseURL: PUBLIC_URL,
      secret: randomBytes(32).toString('base64'),
      mailer: { send: async () => {} },
      signup,
    })
    owner = await calendarTestSession(db)
    other = await calendarTestSession(db)
    const team = await createTestTeam(db, [
      { user: { ...owner.user, principal: owner }, role: 'owner' },
      { user: { ...other.user, principal: other }, role: 'admin' },
    ])
    teamOwner = {
      kind: 'api_key',
      apiKeyId: randomUUID(),
      user: owner.user,
      organization: team.as({ ...owner.user, principal: owner }).organization,
    }
    keys = []
    for (const [userId, organizationId] of [
      [owner.user.id, owner.organization.id],
      [owner.user.id, team.id],
      [other.user.id, team.id],
    ] as const) {
      keys.push(
        (await auth.api.createApiKey({ body: { userId, metadata: { organizationId } } })).key,
      )
    }
    google = fakeGoogle()
    zoom = fakeZoom(PUBLIC_URL)
    calendar = { db, google: { client: google.client, encryptionKey: TEST_CALENDAR_KEY } }
    conference = { db, zoom: { client: zoom.client, encryptionKey: TEST_CONFERENCE_KEY } }
    for (const [index, principal] of [owner, other].entries()) {
      google.controls.identity.sub = `discovery-google-${index}`
      const { authorizationUrl } = await beginGoogleConnection(calendar, principal)
      expect(
        await finishGoogleConnection(
          calendar,
          principal,
          new URLSearchParams({
            state: new URL(authorizationUrl).searchParams.get('state') as string,
            code: 'synthetic-code',
          }),
        ),
      ).toBe('connected')
      zoom.controls.identity.id = `discovery-zoom-${index}`
      const started = await beginZoomConnection(conference, principal)
      expect(
        await finishZoomConnection(
          conference,
          principal,
          new URLSearchParams({
            state: new URL(started.authorizationUrl).searchParams.get('state') as string,
            code: 'synthetic-code',
          }),
        ),
      ).toBe('connected')
    }
    ownIds.set(
      'list_calendar_connections',
      (
        await db
          .selectFrom('calendar_connections')
          .select('id')
          .where('user_id', '=', owner.user.id)
          .executeTakeFirstOrThrow()
      ).id,
    )
    ownIds.set(
      'list_conference_connections',
      (
        await db
          .selectFrom('conference_connections')
          .select('id')
          .where('user_id', '=', owner.user.id)
          .executeTakeFirstOrThrow()
      ).id,
    )
    // A browser-only pending attempt must not appear in agent discovery.
    await beginZoomConnection(conference, owner)
    app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl: PUBLIC_URL,
      routes: [calendarRoutes(calendar), conferenceRoutes(conference)],
      mcp: mcpEndpoint({
        tools: productTools({
          db,
          googleCalendar: calendar.google,
          zoomConference: conference.zoom,
        }),
      }),
    })
  })
  afterAll(async () => {
    await pool?.end()
    await database?.drop()
  })

  async function connected(index = 0) {
    const client = new Client({ name: 'integration-discovery-test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}/mcp`), {
        fetch: async (input, init) => app.request(input, init),
        requestInit: { headers: { authorization: `Bearer ${keys[index]}` } },
      }),
    )
    return client
  }
  async function call(name: Name, index = 0, args: Record<string, unknown> = {}) {
    const client = await connected(index)
    try {
      return await client.callTool({ name, arguments: args })
    } finally {
      await client.close()
    }
  }
  async function rest(name: Name, index = 0) {
    const path =
      name === 'list_calendar_connections' ? 'calendar-connections' : 'conference-connections'
    const response = await app.request(`${PUBLIC_URL}/api/v1/${path}`, {
      headers: { authorization: `Bearer ${keys[index]}` },
    })
    expect(response.status).toBe(200)
    return response.json() as Promise<Listing>
  }

  it('registers both strict read-only tools in the production registry', async () => {
    const client = await connected()
    try {
      const { tools } = await client.listTools()
      for (const name of names) {
        const tool = tools.find((tool) => tool.name === name)
        expect(tool?.inputSchema.additionalProperties).toBe(false)
        expect(tool?.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        })
        expect(tool?.outputSchema).toMatchObject({ properties: { data: { type: 'array' } } })
      }
      const zoomDescription = tools.find(
        (tool) => tool.name === 'list_conference_connections',
      )?.description
      expect(zoomDescription).toContain('accountEmail')
      expect(zoomDescription).toContain('displayName')
    } finally {
      await client.close()
    }
  })
  it.each(names)(
    '%s matches REST for personal and team keys and excludes another admin',
    async (name) => {
      const personal = await rest(name)
      expect(personal.data.map((row) => row.id)).toEqual([ownIds.get(name)])
      for (const index of [0, 1]) {
        const result = await call(name, index)
        expect(result.isError).toBeFalsy()
        expect(result.structuredContent).toEqual(personal)
        expect(result.structuredContent).toEqual(await rest(name, index))
      }
      const otherView = await rest(name, 2)
      expect(otherView.data).toHaveLength(1)
      expect(otherView.data.some((row) => row.id === ownIds.get(name))).toBe(false)
      expect((await call(name, 2)).structuredContent).toEqual(otherView)
    },
  )
  it.each(names)(
    '%s accepts an MCP OAuth principal through the same service and output schema',
    async (name) => {
      const tool = integrationTools({ calendar, conference }).find((tool) => tool.name === name)
      if (!tool) throw Error('Missing integration tool')
      const result = await runTool(
        tool,
        {},
        {
          caller: {
            kind: 'oauth',
            user: owner.user,
            organization: teamOwner.organization,
            oauthConsentId: randomUUID(),
            clientId: 'synthetic-client',
            scopes: ['mcp:tools'],
          },
          rateLimit: () => {},
        },
        () => {
          throw Error('Unexpected tool error')
        },
      )
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toEqual(await rest(name))
    },
  )
  it.each(names)('%s rejects caller-selected authority', async (name) => {
    for (const args of [
      { userId: other.user.id },
      { organizationId: teamOwner.organization.id },
      { id: randomUUID() },
    ]) {
      const result = await call(name, 0, args)
      expect(result.isError).toBe(true)
      expect(result.content).toMatchObject([
        { type: 'text', text: expect.stringContaining('invalid_request') },
      ])
    }
  })
  it('returns only safe metadata without provider requests or browser OAuth attempts', async () => {
    const before = [google.calls.length, zoom.calls.length]
    const calendarView = await rest('list_calendar_connections')
    const conferenceView = await rest('list_conference_connections')
    expect(Object.keys(calendarView.data[0] ?? {}).sort()).toEqual(
      [
        'id',
        'provider',
        'accountEmail',
        'status',
        'lastError',
        'createdAt',
        'updatedAt',
        'syncAuthorized',
        'calendars',
      ].sort(),
    )
    expect(Object.keys(conferenceView.data[0] ?? {}).sort()).toEqual(
      [
        'id',
        'provider',
        'mode',
        'accountEmail',
        'displayName',
        'status',
        'lastError',
        'createdAt',
        'updatedAt',
      ].sort(),
    )
    expect((await listConferenceConnections(conference, owner)).pendingAttempts).toBe(1)
    expect(conferenceView.pendingAttempts).toBe(0)
    for (const name of names) expect((await call(name)).structuredContent).toEqual(await rest(name))
    expect([google.calls.length, zoom.calls.length]).toEqual(before)
  })
})
