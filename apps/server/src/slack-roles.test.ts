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
    const ownerSessionId = randomUUID()
    const memberSessionId = randomUUID()
    await db
      .insertInto('auth.session')
      .values(
        [
          { id: ownerSessionId, userId: owner.id },
          { id: memberSessionId, userId: member.id },
        ].map((session) => ({
          ...session,
          token: randomUUID(),
          activeOrganizationId: team.id,
          expiresAt: new Date(Date.now() + 3600000),
          updatedAt: new Date(),
        })),
      )
      .execute()
    const memberKey = team.as(member)
    const ownerKey = team.as(owner)
    const principals = new Map<string, Principal>([
      ['hm_owner', ownerKey],
      ['hm_member', memberKey],
      ['owner_session', { ...ownerKey, kind: 'session', sessionId: ownerSessionId }],
      ['member_session', { ...memberKey, kind: 'session', sessionId: memberSessionId }],
    ])
    const app = productApp(db, principals, [slackDestinationRoutes(deps)])
    const rest = (token: string, path: string, method: string, body?: unknown) =>
      app.request(`/api/v1/slack-destinations${path}`, {
        method,
        headers: {
          ...(principals.get(token)?.kind === 'session'
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
    return {
      destination,
      enqueue,
      rest,
      mcp,
      oauth,
      ownerKey: ownerKey as McpCaller,
      memberKey: memberKey as McpCaller,
    }
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
        ['', 'POST', { url: attacker, events: ['booking.created'] }],
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
        ['create_slack_destination', { url: attacker, events: ['booking.created'] }],
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

  it('rejects an exhausted test budget after authorization without waiting for delivery', async () => {
    const { destination, enqueue, rest, mcp, ownerKey, oauth } = await fixture()
    const id = destination.id
    const path = `/${id}/test`
    for (let i = 0; i < 5; i++)
      expect((await rest('hm_owner', path, 'POST')).status).toBe(i === 0 ? 202 : 409)

    const client = await owned.pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await client.query('BEGIN')
      // This is the destination row lock held by a delivery during its transport call.
      await client.query('SELECT id FROM webhooks WHERE id = $1 FOR SHARE', [id])
      const { pid } = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0] as { pid: number }
      async function withoutWaiting<T>(name: string, run: () => T | Promise<T>): Promise<T> {
        let settled = false
        const request = Promise.resolve(run()).finally(() => {
          settled = true
        })
        pending = request
        while (!settled) {
          const blocked = await owned.pool.query(
            'SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))',
            [pid],
          )
          expect(blocked.rows, `${name} queued behind delivery`).toHaveLength(0)
        }
        return request
      }

      for (const token of ['hm_owner', 'owner_session']) {
        const refused = await withoutWaiting(`REST ${token}`, () => rest(token, path, 'POST'))
        expect(refused.status).toBe(429)
        expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0)
        expect(await refused.json()).toEqual({ error: 'rate_limited' })
      }
      const mcpRefused = await withoutWaiting('MCP owner', () =>
        mcp(ownerKey, 'test_slack_destination', { id }),
      )
      expect(mcpRefused.content).toMatchObject([
        { text: expect.stringContaining('"error":"rate_limited"') },
      ])

      for (const token of ['hm_member', 'member_session'])
        expect((await withoutWaiting(token, () => rest(token, path, 'POST'))).status).toBe(403)
      const mcpMember = await withoutWaiting('MCP OAuth member', () =>
        mcp(oauth, 'test_slack_destination', { id }),
      )
      expect(mcpMember.content).toMatchObject([
        { text: expect.stringContaining('"error":"insufficient_role"') },
      ])
    } finally {
      await client.query('ROLLBACK')
      client.release()
      await pending
    }
    expect(enqueue).toHaveBeenCalledTimes(1)
  })
})
