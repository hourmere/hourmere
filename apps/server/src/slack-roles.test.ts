import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser, testContext } from '@hourmere/scheduling/testing'
import { createSlackDestination } from '@hourmere/webhooks'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { slackDestinationTools } from './mcp/slack-destinations.ts'
import { type McpCaller, runTool, type Tool } from './mcp/tools.ts'
import { slackDestinationRoutes } from './routes/slack-destinations.ts'
import { productApp, syntheticSessionCookie } from './routes/test-app.ts'

const url = 'https://hooks.slack.com/services/TREST/BREST/rest-role-fixture-secret'
const attacker = 'https://hooks.slack.com/services/TATTACK/BATTACK/attacker-fixture-secret'
const settings = { enabled: true, encryptionKey: Buffer.alloc(32, 5).toString('base64') }

describe.skipIf(!process.env.DATABASE_URL)('Slack owner/admin checks through REST and MCP', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function fixture() {
    const owner = await createTestUser(db)
    const member = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const destination = await createSlackDestination(testContext(db, team.as(owner)), settings, {
      url,
      events: ['booking.created'],
    })
    const enqueue = vi.fn(async () => randomUUID())
    const deps = { db, ...settings, queue: { enqueue } }
    const sessionId = randomUUID()
    await db
      .insertInto('auth.session')
      .values({
        id: sessionId,
        userId: member.id,
        token: randomUUID(),
        activeOrganizationId: team.id,
        expiresAt: new Date(Date.now() + 3600000),
        updatedAt: new Date(),
      })
      .execute()
    const memberKey = team.as(member)
    const principals = new Map<string, Principal>([
      ['hm_owner', team.as(owner)],
      ['hm_member', memberKey],
      ['member_session', { ...memberKey, kind: 'session', sessionId }],
    ])
    const app = productApp(db, principals, [slackDestinationRoutes(deps)])
    const rest = (token: string, path: string, method: string, body?: unknown) =>
      app.request(`/api/v1/slack-destinations${path}`, {
        method,
        headers: {
          ...(token === 'member_session'
            ? {
                cookie: syntheticSessionCookie(token),
                origin: 'http://localhost:3000',
                'X-Expected-Organization-Id': team.id,
              }
            : { authorization: `Bearer ${token}` }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const tools = slackDestinationTools(deps)
    const oauth: McpCaller = {
      kind: 'oauth',
      user: memberKey.user,
      organization: memberKey.organization,
      oauthConsentId: randomUUID(),
      clientId: 'slack-role-client',
      scopes: ['mcp:tools'],
    }
    const mcp = (caller: McpCaller, name: string, args: unknown) =>
      runTool(
        tools.find((tool) => tool.name === name) as Tool,
        args,
        { caller, rateLimit: () => {} },
        () => {},
      )
    return { team, destination, enqueue, rest, mcp, oauth, memberKey: memberKey as McpCaller }
  }

  async function snapshot(id: string) {
    return JSON.stringify({
      destination: await db
        .selectFrom('webhooks')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst(),
      outbox: await db
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('webhook_id', '=', id)
        .orderBy('id')
        .execute(),
    })
  }

  it('refuses ordinary members through REST and MCP without changing the row or outbox', async () => {
    const { destination, enqueue, rest, mcp, oauth, memberKey } = await fixture()
    const before = await snapshot(destination.id)
    const id = destination.id
    for (const [token, code] of [
      ['hm_member', 'insufficient_role'],
      // Session writes run the shared team context check first and keep its uniform 403 code.
      ['member_session', 'team_management_access_denied'],
    ] as const) {
      for (const [path, method, body] of [
        [`/${id}`, 'PATCH', { url: attacker, isActive: false }],
        [`/${id}`, 'DELETE', undefined],
        [`/${id}/test`, 'POST', undefined],
      ] as const) {
        const response = await rest(token, path, method, body)
        const text = await response.text()
        expect(response.status, `${token} ${method} ${path}`).toBe(403)
        expect(JSON.parse(text)).toMatchObject({ error: code })
        expect(text).not.toContain('attacker-fixture-secret')
        expect(await snapshot(id), `${token} ${method} ${path}`).toBe(before)
      }
    }
    for (const caller of [memberKey, oauth])
      for (const [name, args] of [
        ['update_slack_destination', { id, url: attacker, isActive: false }],
        ['delete_slack_destination', { id }],
        ['test_slack_destination', { id }],
      ] as const) {
        const result = await mcp(caller, name, args)
        expect(result.isError, `${caller.kind} ${name}`).toBe(true)
        expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
          error: 'insufficient_role',
        })
        expect(JSON.stringify(result)).not.toContain('attacker-fixture-secret')
        expect(await snapshot(id), `${caller.kind} ${name}`).toBe(before)
      }
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('counts only authorized test attempts, so members cannot spend the admin budget', async () => {
    const { destination, enqueue, rest, mcp, oauth, memberKey } = await fixture()
    for (let i = 0; i < 6; i++) {
      expect((await rest('hm_member', `/${destination.id}/test`, 'POST')).status).toBe(403)
      expect((await rest('member_session', `/${destination.id}/test`, 'POST')).status).toBe(403)
      for (const caller of [memberKey, oauth])
        expect(
          JSON.parse(
            (
              (await mcp(caller, 'test_slack_destination', { id: destination.id })).content[0] as {
                text: string
              }
            ).text,
          ),
        ).toMatchObject({ error: 'insufficient_role' })
      // An admin probing an unknown destination is not counted either.
      expect((await rest('hm_owner', `/${randomUUID()}/test`, 'POST')).status).toBe(404)
    }
    expect((await rest('hm_owner', `/${destination.id}/test`, 'POST')).status).toBe(202)
    for (let i = 0; i < 4; i++)
      expect((await rest('hm_owner', `/${destination.id}/test`, 'POST')).status).toBe(409)
    const refused = await rest('hm_owner', `/${destination.id}/test`, 'POST')
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(await refused.json()).toEqual({ error: 'rate_limited' })
    expect(enqueue).toHaveBeenCalledTimes(1)
  })
})
