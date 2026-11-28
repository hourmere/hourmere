import '@hono/zod-openapi'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  type Auth,
  createAuth,
  createAuthPool,
  createCallerResolver,
  type Principal,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { openTimeSnippetTools } from './mcp/open-time-snippets.ts'
import { OpenTimeSnippet, openTimeSnippetRoutes } from './routes/open-time-snippets.ts'

const bootstrap = process.env.DATABASE_URL
const publicUrl = 'https://example.test'
type App = ReturnType<typeof createApp>

async function requestSnippetMcp(app: App, key: string, input: object) {
  const response = await app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-03-26',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'generate_open_time_snippet', arguments: input },
    }),
  })
  expect(response.status).toBe(200)
  const wire = await response.text()
  const body = JSON.parse(
    wire.startsWith('event:')
      ? (wire.split('\n').find((line) => line.startsWith('data: ')) ?? '').slice(6)
      : wire,
  ) as { result: { isError?: boolean; structuredContent?: unknown } }
  return body.result
}

async function runSnippetCli(app: App, key: string, input: object) {
  let stdout = ''
  let stderr = ''
  const code = await runCli({
    argv: ['open-time-snippet', '--json', '--input', '-'],
    env: { HOURMERE_URL: publicUrl, HOURMERE_API_KEY: key },
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
  return { code, stdout, stderr }
}

describe.skipIf(!bootstrap)('real REST, MCP and CLI snippet parity across time zones', () => {
  const organizerZone = 'America/Los_Angeles'
  const key = 'hm_test'
  let database: TestDatabase
  let app: App
  let eventTypeId: string

  beforeAll(async () => {
    database = await createTestDatabase(bootstrap as string)
    const db = createDb(database.pool)
    const user = await createTestUser(db)
    const principal: Extract<Principal, { kind: 'api_key' }> = {
      ...user.principal,
      kind: 'api_key',
      apiKeyId: 'transport-test',
      apiKeyScope: 'read',
    }
    await db
      .insertInto('profiles')
      .values({
        user_id: user.id,
        handle: 'snippet-transport',
        time_zone: organizerZone,
        locale: 'en',
      })
      .execute()
    const fixtures = createFixtures(db)
    const evening = [{ start: '17:30', end: '18:30' }]
    await fixtures.schedule(user.id, {
      timeZone: organizerZone,
      weeklyHours: {},
      // Same local hours before and after the organizer's spring transition.
      overrides: [
        { date: '2030-03-09', intervals: evening },
        { date: '2030-03-30', intervals: evening },
      ],
    })
    eventTypeId = await fixtures.eventType(user.principal.organization.id, user.id, {
      slug: 'chat',
      durationMinutes: 60,
      slotStepMinutes: 30,
    })
    const options = { db, publicUrl, slotSnippetsEnabled: true }
    app = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: async () => new Response(null),
      resolveCaller: async () => ({ ok: true, principal, setCookie: [] }),
      routes: [openTimeSnippetRoutes(options)],
      mcp: mcpEndpoint({ tools: openTimeSnippetTools(options) }),
    })
  })

  afterAll(async () => {
    await database?.drop()
  })

  it.each([
    {
      timeZone: organizerZone,
      displayTimeZone: undefined,
      locale: 'en',
      labels: [
        'Sat, March 9, 2030, 5:30 PM – 6:30 PM [America/Los_Angeles, UTC-08:00]',
        'Sat, March 30, 2030, 5:30 PM – 6:30 PM [America/Los_Angeles, UTC-07:00]',
      ],
    },
    {
      timeZone: 'Asia/Shanghai',
      displayTimeZone: 'Asia/Shanghai',
      locale: 'zh-CN',
      labels: [
        '2030年3月10日周日，9:30至10:30［Asia/Shanghai，UTC+08:00］',
        '2030年3月31日周日，8:30至9:30［Asia/Shanghai，UTC+08:00］',
      ],
    },
    {
      timeZone: 'Europe/Berlin',
      displayTimeZone: 'Europe/Berlin',
      locale: 'en',
      labels: [
        'Sun, March 10, 2030, 2:30 AM – 3:30 AM [Europe/Berlin, UTC+01:00]',
        'Sun, March 31, 2030, 1:30 AM (UTC+01:00) – 3:30 AM (UTC+02:00) [Europe/Berlin]',
      ],
    },
  ])('keeps the same slots and renders the local DST offsets in $timeZone', async (testCase) => {
    const clock = vi
      .spyOn(Temporal.Now, 'instant')
      .mockReturnValue(Temporal.Instant.from('2030-03-01T00:00:00Z'))
    try {
      const { timeZone, displayTimeZone, locale, labels } = testCase
      const input = {
        eventTypeId,
        from: '2030-03-09T17:30:00-08:00',
        to: '2030-03-30T18:30:00-07:00',
        count: 2,
        displayTimeZone,
        locale,
      }
      const response = await app.request('/api/v1/open-time-snippets', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      expect(response.status).toBe(200)
      const rest = OpenTimeSnippet.parse(await response.json())
      const bookingUrl = `${publicUrl}/snippet-transport/chat`
      expect(rest).toMatchObject({
        bookingUrl,
        durationMinutes: 60,
        displayTimeZone: timeZone,
        locale,
      })
      const starts = ['2030-03-10T01:30:00.000Z', '2030-03-31T00:30:00.000Z']
      const ends = ['2030-03-10T02:30:00.000Z', '2030-03-31T01:30:00.000Z']
      expect(rest.slots).toEqual(
        starts.map((start, index) => ({
          start,
          end: ends[index],
          label: labels[index],
          url: `${bookingUrl}?start=${encodeURIComponent(start)}&durationMinutes=60`,
        })),
      )
      for (const { label, url } of rest.slots) {
        expect(rest.text).toContain(`${label}\n${url}`)
        expect(rest.html).toContain(`href="${url.replace('&', '&amp;')}"`)
        expect(rest.html).toContain(`>${label}</a>`)
      }

      const mcp = await requestSnippetMcp(app, key, input)
      expect(mcp.isError).not.toBe(true)
      expect(mcp.structuredContent).toEqual(rest)
      const cli = await runSnippetCli(app, key, input)
      expect(cli.code).toBe(0)
      expect(cli.stderr).toBe('')
      expect(JSON.parse(cli.stdout)).toEqual(rest)
    } finally {
      clock.mockRestore()
    }
  })
})

describe.skipIf(!bootstrap)('snippet tenant isolation through REST, MCP and CLI', () => {
  let database: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth
  let app: ReturnType<typeof createApp>
  const secret = 'synthetic-snippet-isolation-session-secret-0000000000'
  const callers: { name: string; cookie: string; key: string; foreignId: string }[] = []
  const today = Temporal.Now.plainDateISO('UTC')
  const day = today.add({ days: 7 + ((8 - today.dayOfWeek) % 7) })
  const range = { from: `${day}T00:00:00Z`, to: `${day.add({ days: 1 })}T00:00:00Z` }
  beforeAll(async () => {
    database = await createTestDatabase(bootstrap as string)
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
    const owner = await createTestUser(db)
    const admin = await createTestUser(db)
    const other = await createTestUser(db)
    const teamA = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
    ])
    const teamB = await createTestTeam(db, [{ user: other, role: 'owner' }])
    const f = createFixtures(db)
    for (const user of [owner, admin, other]) {
      await f.schedule(user.id, { timeZone: 'UTC' })
      await db
        .insertInto('profiles')
        .values({
          user_id: user.id,
          handle: `isolation-${user.id.slice(0, 8)}`,
          time_zone: 'UTC',
          locale: 'en',
        })
        .execute()
    }
    await f.eventType(teamA.id, null, { slug: 'shared', hosts: [{ userId: owner.id }] })
    const teamForeignId = await f.eventType(teamB.id, null, {
      slug: 'shared',
      title: 'Secret team B title',
      hosts: [{ userId: other.id }],
    })
    const personalForeignId = await f.eventType(other.principal.organization.id, other.id, {
      slug: 'personal',
      title: 'Secret personal title',
    })
    const ownPersonalId = await f.eventType(owner.principal.organization.id, owner.id, {
      slug: 'mine',
    })
    for (const [name, user, organizationId, foreignId] of [
      ['team owner', owner, teamA.id, teamForeignId],
      ['personal event from team', owner, teamA.id, ownPersonalId],
      ['team admin', admin, teamA.id, teamForeignId],
      ['personal owner', owner, owner.principal.organization.id, personalForeignId],
    ] as const) {
      const token = randomBytes(24).toString('base64url')
      await db
        .insertInto('auth.session')
        .values({
          userId: user.id,
          token,
          activeOrganizationId: organizationId,
          expiresAt: new Date(Date.now() + 3_600_000),
          updatedAt: new Date(),
        })
        .execute()
      const signature = createHmac('sha256', secret).update(token).digest('base64')
      const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
      const key = (
        await auth.api.createApiKey({
          body: { userId: user.id, metadata: { organizationId, scope: 'read' } },
        })
      ).key
      callers.push({ name, cookie, key, foreignId })
    }
    const options = { db, publicUrl, slotSnippetsEnabled: true }
    app = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      routes: [openTimeSnippetRoutes(options)],
      mcp: mcpEndpoint({ tools: openTimeSnippetTools(options) }),
    })
  })
  afterAll(async () => {
    await authPool?.end()
    await database?.drop()
  })
  for (const transport of ['REST session', 'REST key', 'MCP', 'CLI'] as const) {
    it(`${transport} hides foreign team and personal types exactly like missing ids`, async () => {
      for (const caller of callers) {
        const results: unknown[] = []
        for (const eventTypeId of [caller.foreignId, randomUUID()]) {
          const input = { ...range, eventTypeId }
          if (transport === 'REST session' || transport === 'REST key') {
            const response = await app.request('/api/v1/open-time-snippets', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(transport === 'REST session'
                  ? { cookie: caller.cookie, origin: publicUrl }
                  : { authorization: `Bearer ${caller.key}` }),
              },
              body: JSON.stringify(input),
            })
            expect(response.status, caller.name).toBe(404)
            const body = await response.json()
            expect(body).toMatchObject({ error: 'event_type_not_found' })
            results.push(body)
          } else if (transport === 'MCP') {
            const result = await requestSnippetMcp(app, caller.key, input)
            expect(result).toMatchObject({ isError: true })
            expect(JSON.stringify(result)).toContain('event_type_not_found')
            results.push(result)
          } else {
            const { code, stdout, stderr } = await runSnippetCli(app, caller.key, input)
            expect(code, caller.name).toBe(1)
            expect(stdout).toBe('')
            expect(stderr).toContain('event_type_not_found')
            results.push(stderr)
          }
        }
        expect(results[0], caller.name).toEqual(results[1])
      }
    })
  }
})
