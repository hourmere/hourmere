// REST, MCP and CLI over real HTTP, real API keys/sessions and disposable PostgreSQL: one
// shared service, identical output and identical denials.

import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import {
  type Auth,
  createAuth,
  createAuthPool,
  createCallerResolver,
  type Principal,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import * as scheduling from '@hourmere/scheduling'
import { troubleshootEventAvailability } from '@hourmere/scheduling'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { availabilityTroubleshootingTools } from './mcp/availability-troubleshooting.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { defineTool, runTool } from './mcp/tools.ts'
import * as openapi from './openapi.ts'
import * as routeModule from './routes/availability-troubleshooting.ts'
import { availabilityTroubleshootingRoutes } from './routes/availability-troubleshooting.ts'

const bootstrap = process.env.DATABASE_URL
const publicUrl = 'https://example.test'
const secret = 'synthetic-troubleshoot-session-secret-000000000000000'
const day = '2030-11-04' // A Monday far enough ahead to stay in the future.

type Transport = 'REST session' | 'REST key' | 'MCP' | 'CLI'
type Outcome = { ok: true; body: unknown } | { ok: false; status: number; error: unknown }

describe.skipIf(!bootstrap)('availability troubleshooting through REST, MCP and CLI', () => {
  let database: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth
  let app: ReturnType<typeof createApp>
  const sessions = new Map<string, string>()
  const keys = new Map<string, string>()
  const principals = new Map<string, Principal>()
  let teamEvent = ''
  let personalEvent = ''
  let foreignEvent = ''
  let memberId = ''

  async function session(name: string, userId: string, organizationId: string) {
    const token = randomBytes(24).toString('base64url')
    await db
      .insertInto('auth.session')
      .values({
        userId,
        token,
        activeOrganizationId: organizationId,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
      })
      .execute()
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    sessions.set(
      name,
      `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
    )
  }
  async function key(name: string, userId: string, organizationId: string, scope: string) {
    const created = await auth.api.createApiKey({
      body: { userId, metadata: { organizationId, scope } },
    })
    keys.set(name, created.key)
  }

  beforeAll(async () => {
    database = await createTestDatabase(bootstrap as string, undefined, {
      tag: 'trouble_http',
    })
    db = createDb(database.pool)
    const signup = { mode: 'open', allowedDomains: [] } as const
    authPool = createAuthPool(database.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret,
      signup,
      mailer: { send: async () => {} },
    })
    const f = createFixtures(db)
    const owner = await createTestUser(db, 'Avery Owner')
    const admin = await createTestUser(db, 'Casey Admin')
    const member = await createTestUser(db, 'Blake Member')
    const outsider = await createTestUser(db, 'Outside Owner')
    memberId = member.id
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const otherTeam = await createTestTeam(db, [{ user: outsider, role: 'owner' }])
    for (const user of [owner, member, outsider]) {
      await f.schedule(user.id, {
        timeZone: 'UTC',
        weeklyHours: { monday: [{ start: '09:00', end: '12:00' }] },
      })
      await db
        .insertInto('profiles')
        .values({
          user_id: user.id,
          handle: `troubleshoot-${user.id.slice(0, 8)}`,
          time_zone: 'UTC',
          locale: 'en',
        })
        .execute()
    }
    teamEvent = (
      await scheduling.createEventType(
        { db, principal: team.as(owner), now: () => Temporal.Now.instant() },
        {
          title: 'Team meeting',
          slug: 'team-meeting',
          durationMinutes: 30,
          schedulingType: 'collective',
          hosts: [{ userId: owner.id }, { userId: member.id }],
        },
      )
    ).id
    personalEvent = await f.eventType(owner.principal.organization.id, owner.id, { slug: 'mine' })
    foreignEvent = await f.eventType(otherTeam.id, null, {
      slug: 'foreign',
      title: 'Secret foreign title',
      hosts: [{ userId: outsider.id }],
    })
    // Private details that must never leave through any transport.
    const other = await f.eventType(owner.principal.organization.id, owner.id, {
      slug: 'board',
      title: 'Private board review',
    })
    await f.booking(owner.principal.organization.id, [owner.id], `${day}T10:30Z`, `${day}T11:00Z`, {
      eventTypeId: other,
      attendee: { name: 'Secret Invitee', email: 'secret-invitee@example.com' },
    })
    await f.calendarBusy(member.id, [[`${day}T09:30Z`, `${day}T10:00Z`]])

    await session('owner', owner.id, team.id)
    await session('admin', admin.id, team.id)
    await session('member', member.id, team.id)
    await session('outsider', outsider.id, otherTeam.id)
    await session('owner personal', owner.id, owner.principal.organization.id)
    await key('owner', owner.id, team.id, 'full')
    await key('admin', admin.id, team.id, 'full')
    await key('member', member.id, team.id, 'full')
    await key('outsider', outsider.id, otherTeam.id, 'full')
    await key('owner personal', owner.id, owner.principal.organization.id, 'full')
    await key('owner read', owner.id, team.id, 'read')
    await key('owner bookings', owner.id, team.id, 'bookings')
    principals.set('owner', team.as(owner))
    principals.set('owner personal', owner.principal)
    const options = { db }
    app = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      routes: [availabilityTroubleshootingRoutes(options)],
      mcp: mcpEndpoint({ tools: availabilityTroubleshootingTools(options) }),
    })
  }, 30_000)
  afterAll(async () => {
    await authPool?.end()
    await database?.drop()
  })

  async function call(
    transport: Transport,
    caller: string,
    input: { eventTypeId: string; date: string; timeZone?: string; durationMinutes?: number },
  ): Promise<Outcome> {
    if (transport === 'REST session' || transport === 'REST key') {
      const { eventTypeId, ...query } = input
      const search = new URLSearchParams(
        Object.entries(query).map(([name, value]) => [name, String(value)]),
      )
      const response = await app.request(
        `/api/v1/event-types/${eventTypeId}/availability-troubleshooting?${search}`,
        {
          headers:
            transport === 'REST session'
              ? { cookie: sessions.get(caller) as string }
              : { authorization: `Bearer ${keys.get(caller)}` },
        },
      )
      const body = await response.json()
      return response.ok ? { ok: true, body } : { ok: false, status: response.status, error: body }
    }
    if (transport === 'MCP') {
      const response = await app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${keys.get(caller)}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-03-26',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'troubleshoot_availability', arguments: input },
        }),
      })
      expect(response.status).toBe(200)
      const wire = await response.text()
      const message = JSON.parse(
        wire.startsWith('event:')
          ? (wire.split('\n').find((line) => line.startsWith('data: ')) ?? '').slice(6)
          : wire,
      ) as {
        result: { isError?: boolean; structuredContent?: unknown; content: { text: string }[] }
      }
      return message.result.isError
        ? { ok: false, status: 0, error: JSON.parse(message.result.content[0]?.text ?? '') }
        : { ok: true, body: message.result.structuredContent }
    }
    let stdout = ''
    let stderr = ''
    const code = await runCli({
      argv: ['troubleshoot-availability', '--input', '-'],
      env: { HOURMERE_URL: publicUrl, HOURMERE_API_KEY: keys.get(caller) as string },
      stdin: (async function* () {
        yield JSON.stringify(input)
      })(),
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      fetch: async (url, init) => app.request(new Request(url, init)),
    })
    return code === 0
      ? { ok: true, body: JSON.parse(stdout) }
      : { ok: false, status: code, error: JSON.parse(stderr) }
  }

  const transports: Transport[] = ['REST session', 'REST key', 'MCP', 'CLI']

  it('returns the identical shared-service result through every transport', async () => {
    for (const [caller, eventTypeId] of [
      ['owner', teamEvent],
      ['admin', teamEvent],
      ['owner personal', personalEvent],
    ] as const) {
      const input = { eventTypeId, date: day, timeZone: 'UTC' }
      const principal = principals.get(caller === 'admin' ? 'owner' : caller) as Principal
      const results: unknown[] = []
      for (const transport of transports) {
        const outcome = await call(transport, caller, input)
        expect(outcome, `${caller} ${transport}`).toMatchObject({ ok: true })
        results.push((outcome as { body: unknown }).body)
      }
      for (const result of results.slice(1)) expect(result).toEqual(results[0])
      if (caller !== 'admin') {
        const direct = await troubleshootEventAvailability(
          { db, principal, now: () => Temporal.Now.instant() },
          input,
        )
        expect(results[0]).toEqual(JSON.parse(JSON.stringify(direct)))
      }
      const result = results[0] as scheduling.TroubleshootAvailabilityResult
      expect(result.slots.some((slot) => slot.status === 'available')).toBe(true)
      if (eventTypeId === teamEvent) {
        expect(result.hosts.map((host) => host.name)).toEqual(['Avery Owner', 'Blake Member'])
        const busy = result.slots.find((slot) => slot.start === `${day}T09:30:00Z`)
        expect(busy?.reasons).toContainEqual({
          code: 'calendar_busy',
          start: `${day}T09:30:00Z`,
          end: `${day}T10:00:00Z`,
          hostUserId: memberId,
        })
      }
      const wire = JSON.stringify(results)
      for (const leaked of [
        'Private board review',
        'Fixture booking',
        'Secret Invitee',
        'secret-invitee@example.com',
        'Work',
      ])
        expect(wire).not.toContain(leaked)
    }
  })

  it('answers non-managers exactly like a missing event type, on every transport', async () => {
    for (const transport of transports) {
      for (const [caller, eventTypeId] of [
        ['member', teamEvent],
        ['outsider', teamEvent],
        ['owner personal', teamEvent],
        ['owner', foreignEvent],
        ['owner', personalEvent],
      ] as const) {
        if (transport === 'REST session' && !sessions.has(caller)) continue
        const denied = await call(transport, caller, { eventTypeId, date: day, timeZone: 'UTC' })
        const missing = await call(transport, caller, {
          eventTypeId: randomUUID(),
          date: day,
          timeZone: 'UTC',
        })
        expect(denied, `${transport} ${caller}`).toMatchObject({ ok: false })
        expect(JSON.stringify(denied)).toContain('event_type_not_found')
        expect(JSON.stringify(denied)).not.toContain('Secret foreign title')
        expect(denied, `${transport} ${caller}`).toEqual(missing)
        if (transport.startsWith('REST')) expect((denied as { status: number }).status).toBe(404)
      }
    }
  })

  it('refuses read and bookings keys before any lookup, the same for any id', async () => {
    for (const transport of ['REST key', 'MCP', 'CLI'] as const)
      for (const caller of ['owner read', 'owner bookings']) {
        const existing = await call(transport, caller, {
          eventTypeId: teamEvent,
          date: day,
          timeZone: 'UTC',
        })
        const missing = await call(transport, caller, {
          eventTypeId: randomUUID(),
          date: day,
          timeZone: 'UTC',
        })
        expect(existing, `${transport} ${caller}`).toMatchObject({ ok: false })
        expect(JSON.stringify(existing)).toContain('insufficient_scope')
        expect(existing).toEqual(missing)
        if (transport === 'REST key') expect((existing as { status: number }).status).toBe(403)
      }
  })

  it('validates the day and time zone identically', async () => {
    for (const transport of transports) {
      const badDate = await call(transport, 'owner', { eventTypeId: teamEvent, date: '2030-02-30' })
      expect(JSON.stringify(badDate), transport).toContain('invalid_date')
      const badZone = await call(transport, 'owner', {
        eventTypeId: teamEvent,
        date: day,
        timeZone: 'Mars/Base',
      })
      expect(JSON.stringify(badZone), transport).toContain('invalid_time_zone')
    }
  })

  it('serves MCP OAuth callers through the same service boundary', async () => {
    const owner = principals.get('owner') as Principal
    const oauth = (principal: Principal): Extract<Principal, { kind: 'oauth' }> => ({
      user: principal.user,
      organization: principal.organization,
      kind: 'oauth',
      oauthConsentId: randomUUID(),
      clientId: 'client',
      scopes: ['mcp:tools'],
    })
    const tool = availabilityTroubleshootingTools({ db })[0]
    if (!tool) throw Error('Missing troubleshooting tool')
    const input = { eventTypeId: teamEvent, date: day, timeZone: 'UTC' }
    const allowed = await runTool(
      tool,
      input,
      { caller: oauth(owner), rateLimit: () => {} },
      () => {},
    )
    expect(allowed.isError).not.toBe(true)
    expect(allowed.structuredContent).toEqual(
      ((await call('REST session', 'owner', input)) as { body: unknown }).body,
    )
    const member = await db
      .selectFrom('auth.user')
      .select(['id', 'name', 'email'])
      .where('id', '=', memberId)
      .executeTakeFirstOrThrow()
    const denied = await runTool(
      tool,
      input,
      { caller: oauth({ ...owner, user: member }), rateLimit: () => {} },
      () => {},
    )
    const missing = await runTool(
      tool,
      { ...input, eventTypeId: randomUUID() },
      { caller: oauth({ ...owner, user: member }), rateLimit: () => {} },
      () => {},
    )
    expect(denied.isError).toBe(true)
    expect(denied).toEqual(missing)
  })

  it('kills transport mutations that would change the shared output or the target', async () => {
    const input = { eventTypeId: teamEvent, date: day, timeZone: 'UTC' }
    const expected = ((await call('REST session', 'owner', input)) as { body: unknown }).body
    const routeSource = readFileSync(
      'apps/server/src/routes/availability-troubleshooting.ts',
      'utf8',
    )
    const build = (change?: [string, string]) => {
      let source = routeSource
      if (change) {
        expect(source).toContain(change[0])
        source = source.replace(...change)
      }
      source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
        /\bexport /g,
        '',
      )
      const bindings = {
        z,
        createRoute,
        AVAILABILITY_REASON_CODES: [],
        troubleshootEventAvailability,
        ...openapi,
      }
      return new Function(
        ...Object.keys(bindings),
        `${source}; return availabilityTroubleshootingRoutes`,
      )(...Object.values(bindings)) as typeof availabilityTroubleshootingRoutes
    }
    const verify = async (routes: typeof availabilityTroubleshootingRoutes) => {
      const copyApp = createApp({
        publicUrl,
        checkDb: async () => {},
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db }),
        routes: [routes({ db })],
      })
      const response = await copyApp.request(
        `/api/v1/event-types/${teamEvent}/availability-troubleshooting?date=${day}&timeZone=UTC`,
        { headers: { cookie: sessions.get('owner') as string } },
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(expected)
    }
    await verify(build())
    for (const change of [
      ['            eventTypeId: id,\n', `            eventTypeId: '${personalEvent}',\n`],
      ['            ...query,\n', "            ...query, timeZone: 'Asia/Tokyo',\n"],
    ] as [string, string][])
      await expect(verify(build(change))).rejects.toMatchObject({ name: 'AssertionError' })

    // The MCP entry point: same input, same output, no rewriting.
    const toolSource = readFileSync('apps/server/src/mcp/availability-troubleshooting.ts', 'utf8')
    const buildTool = (change?: [string, string]) => {
      let source = toolSource
      if (change) {
        expect(source).toContain(change[0])
        source = source.replace(...change)
      }
      source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
        /\bexport /g,
        '',
      )
      const bindings = { ...routeModule, defineTool, troubleshootEventAvailability }
      return new Function(
        ...Object.keys(bindings),
        `${source}; return availabilityTroubleshootingTools`,
      )(...Object.values(bindings)) as typeof availabilityTroubleshootingTools
    }
    const verifyTool = async (tools: typeof availabilityTroubleshootingTools) => {
      const tool = tools({ db })[0]
      if (!tool) throw Error('Missing tool')
      const owner = principals.get('owner') as Principal
      if (owner.kind !== 'api_key') throw Error('Expected an API key principal')
      const result = await runTool(tool, input, { caller: owner, rateLimit: () => {} }, () => {})
      expect(result.structuredContent).toEqual(expected)
    }
    await verifyTool(buildTool())
    await expect(
      verifyTool(buildTool(['          args,\n', '          { ...args, durationMinutes: 45 },\n'])),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
