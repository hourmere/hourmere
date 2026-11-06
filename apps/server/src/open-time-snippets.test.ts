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
import { generateOpenTimeSnippet } from '@hourmere/scheduling'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { openTimeSnippetTools } from './mcp/open-time-snippets.ts'
import { runTool } from './mcp/tools.ts'
import { openTimeSnippetRoutes } from './routes/open-time-snippets.ts'

const bootstrap = process.env.DATABASE_URL
const publicUrl = 'https://example.test'
describe.skipIf(!bootstrap)('real REST and MCP snippet parity', () => {
  let database: TestDatabase
  let db: Db
  let principal: Extract<Principal, { kind: 'api_key' }>
  let eventTypeId: string
  beforeAll(async () => {
    database = await createTestDatabase(bootstrap as string)
    db = createDb(database.pool)
    const user = await createTestUser(db)
    principal = {
      ...user.principal,
      kind: 'api_key',
      apiKeyId: 'transport-test',
      apiKeyScope: 'read',
    }
    await db
      .insertInto('profiles')
      .values({ user_id: user.id, handle: 'snippet-transport', time_zone: 'UTC', locale: 'en' })
      .execute()
    const fixtures = createFixtures(db)
    await fixtures.schedule(user.id, { timeZone: 'UTC' })
    eventTypeId = await fixtures.eventType(user.principal.organization.id, user.id, {
      slug: 'chat',
    })
  })
  afterAll(async () => {
    await database?.drop()
  })
  it('returns identical real selected slots, links, text and HTML through REST and MCP', async () => {
    const today = Temporal.Now.plainDateISO('UTC')
    const day = today.add({ days: 7 + ((8 - today.dayOfWeek) % 7) })
    const input = {
      eventTypeId,
      from: `${day}T00:00:00Z`,
      to: `${day.add({ days: 1 })}T00:00:00Z`,
      locale: 'zh-CN' as const,
      count: 3,
    }
    const options = { publicUrl, slotSnippetsEnabled: true }
    const expected = await generateOpenTimeSnippet(
      { db, principal, now: () => Temporal.Now.instant() },
      input,
      options,
    )
    expect(expected.slots).toHaveLength(3)
    const app = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: async () => new Response(null),
      resolveCaller: async () => ({ ok: true, principal, setCookie: [] }),
      routes: [openTimeSnippetRoutes({ db, ...options })],
    })
    const response = await app.request('/api/v1/open-time-snippets', {
      method: 'POST',
      headers: { authorization: 'Bearer hm_test', 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expected)
    const tool = openTimeSnippetTools({ db, ...options })[0]
    if (!tool) throw Error('Missing snippet tool')
    const mcp = await runTool(tool, input, { caller: principal, rateLimit: () => {} }, () => {})
    expect(mcp.isError).not.toBe(true)
    expect(mcp.structuredContent).toEqual(expected)
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
            const response = await app.request('/mcp', {
              method: 'POST',
              headers: {
                authorization: `Bearer ${caller.key}`,
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
            ) as { result: { isError?: boolean } }
            expect(body.result).toMatchObject({ isError: true })
            expect(JSON.stringify(body.result)).toContain('event_type_not_found')
            results.push(body.result)
          } else {
            let stdout = ''
            let stderr = ''
            const code = await runCli({
              argv: ['open-time-snippet', '--json', '--input', '-'],
              env: { HOURMERE_URL: publicUrl, HOURMERE_API_KEY: caller.key },
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
