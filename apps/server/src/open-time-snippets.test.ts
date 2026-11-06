import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { generateOpenTimeSnippet } from '@hourmere/scheduling'
import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
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
