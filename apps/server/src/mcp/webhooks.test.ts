import { randomBytes, randomUUID } from 'node:crypto'
import { type ApiKeyScope, createAuth, createAuthPool, createCallerResolver } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, type Fixtures } from '@hourmere/scheduling/testing'
import type { WebhookView } from '@hourmere/webhooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../../../tools/cli/src/cli.ts'
import { createApp } from '../app.ts'
import { webhookRoutes } from '../routes/webhooks.ts'
import { productTools } from '../server.ts'
import { mcpEndpoint } from './endpoint.ts'

const publicUrl = 'http://localhost:4185'
const events = [
  'booking.attendee_no_show_changed',
  'booking.cancelled',
  'booking.created',
  'booking.reschedule_request_expired',
  'booking.reschedule_requested',
  'booking.rescheduled',
]
const input = { url: 'https://hooks.example.com/bookings', events, isActive: false }
const methods = { list: 'GET', create: 'POST', update: 'PATCH', delete: 'DELETE' } as const
const tools = {
  list: 'list_webhooks',
  create: 'create_webhook',
  update: 'update_webhook',
  delete: 'delete_webhook',
} as const
type Action = keyof typeof methods
type Input = { id?: string } & Record<string, unknown>
type Created = { webhook: WebhookView; secret: string }

describe.skipIf(!process.env.DATABASE_URL)('Webhook REST, MCP and CLI parity', () => {
  let database: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let fixtures: Fixtures
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(database.pool)
    fixtures = createFixtures(db)
    const signup = { mode: 'closed', allowedDomains: [] } as const
    authPool = createAuthPool(database.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: publicUrl,
      secret: randomBytes(32).toString('base64'),
      mailer: {
        send: async () => {
          throw new Error('Mail delivery is forbidden in webhook tests')
        },
      },
      signup,
    })
    const webhooks = { enabled: true, encryptionKey: randomBytes(32).toString('base64') }
    app = createApp({
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      publicUrl,
      routes: [webhookRoutes({ db, ...webhooks })],
      mcp: mcpEndpoint({ tools: productTools({ db, webhooks }) }),
    })
  })

  afterAll(async () => {
    await authPool?.end()
    await database?.drop()
  })

  async function credential(userId: string, organizationId: string, scope: ApiKeyScope = 'full') {
    const { key } = await auth.api.createApiKey({
      body: { userId, metadata: { organizationId, scope } },
    })
    return key
  }

  function rest(key: string, args?: Input, action: Action = args ? 'create' : 'list') {
    const { id, ...changes } = args ?? {}
    const path =
      action === 'update' || action === 'delete' ? `/api/v1/webhooks/${id}` : '/api/v1/webhooks'
    const body = action === 'update' ? changes : action === 'create' ? args : undefined
    return app.request(path, {
      method: methods[action],
      headers: {
        authorization: `Bearer ${key}`,
        ...(body && { 'content-type': 'application/json' }),
      },
      ...(body && { body: JSON.stringify(body) }),
    })
  }

  async function mcp(key: string, body?: Input, action: Action = body ? 'create' : 'list') {
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: tools[action], arguments: body ?? {} },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const text = await response.text()
    const event = text.split('\n').find((line) => line.startsWith('data: '))
    return JSON.parse(event ? event.slice(6) : text).result
  }

  async function cli(key: string, body?: Input, action: Action = body ? 'create' : 'list') {
    let stdout = ''
    let stderr = ''
    const code = await runCli({
      argv: [
        'webhooks',
        action,
        '--json',
        '--input',
        '-',
        ...(action === 'delete' ? ['--yes'] : []),
      ],
      env: { HOURMERE_URL: publicUrl, HOURMERE_API_KEY: key },
      stdin: (async function* () {
        yield JSON.stringify(body ?? {})
      })(),
      stdout: (value) => {
        stdout += value
      },
      stderr: (value) => {
        stderr += value
      },
      fetch: async (request, init) => app.request(request, init),
    })
    expect((stdout + stderr).includes(key)).toBe(false)
    return { code, stdout, stderr }
  }

  async function expectFailure(
    key: string,
    status: number,
    error: string,
    body?: Input,
    action?: Action,
  ) {
    const result = await mcp(key, body, action)
    expect(result.isError).toBe(true)
    const mcpError = JSON.parse(result.content[0].text)
    expect(mcpError).toMatchObject({ error })
    const command = await cli(key, body, action)
    expect(command.code).toBe(1)
    expect(command.stdout).toBe('')
    expect(JSON.parse(command.stderr)).toMatchObject({ error })
    const response = await rest(key, body, action)
    expect(response.status).toBe(status)
    const restError = await response.json()
    expect(restError).toMatchObject({ error })
    if (status === 403 || status === 404) expect(mcpError).toEqual(restError)
    if (status === 404) expect(restError).toEqual({ error })
  }

  it('creates and lists only within the credential organization, revealing each secret once', async () => {
    const owner = await fixtures.host()
    const admin = await fixtures.host()
    const teamId = await fixtures.organization()
    await fixtures.member(owner.userId, teamId, 'owner')
    await fixtures.member(admin.userId, teamId, 'admin')
    const personalFull = await credential(owner.userId, owner.organizationId)
    const personalRead = await credential(owner.userId, owner.organizationId, 'read')
    const teamFull = await credential(owner.userId, teamId)
    const teamRead = await credential(owner.userId, teamId, 'read')
    const adminFull = await credential(admin.userId, teamId)

    const restCreated = await rest(personalFull, input)
    expect(restCreated.status).toBe(201)
    const personal = (await restCreated.json()) as Created
    const mcpCreated = await mcp(teamFull, input)
    expect(mcpCreated.isError).toBeFalsy()
    const team = mcpCreated.structuredContent as Created
    const cliCreated = await cli(adminFull, input)
    expect(cliCreated.code).toBe(0)
    const forAdmin = JSON.parse(cliCreated.stdout) as Created
    expect(cliCreated.stderr.includes(forAdmin.secret)).toBe(false)
    expect(cliCreated.stderr).toBe('')

    const secrets = [personal.secret, team.secret, forAdmin.secret]
    expect(secrets.every((secret) => typeof secret === 'string' && secret.length > 0)).toBe(true)
    expect(new Set(secrets).size).toBe(3)
    expect(personal.webhook.organizationId).toBe(owner.organizationId)
    expect(team.webhook.organizationId).toBe(teamId)
    expect(forAdmin.webhook.organizationId).toBe(teamId)
    for (const result of [personal, team, forAdmin]) expect(result.webhook).toMatchObject(input)

    await expectFailure(personalFull, 400, 'invalid_request', { ...input, organizationId: teamId })
    for (const [key, webhooks] of [
      [personalFull, [personal.webhook]],
      [personalRead, [personal.webhook]],
      [teamFull, [team.webhook, forAdmin.webhook]],
      [teamRead, [team.webhook, forAdmin.webhook]],
    ] as const) {
      const response = await rest(key)
      expect(response.status).toBe(200)
      const listed = await response.text()
      const mcpList = await mcp(key)
      const cliList = await cli(key)
      expect(cliList.code).toBe(0)
      expect(mcpList.isError).toBeFalsy()
      const outputs = listed + JSON.stringify(mcpList) + cliList.stdout + cliList.stderr
      expect(secrets.some((secret) => outputs.includes(secret))).toBe(false)
      expect(JSON.parse(listed)).toEqual(
        [...webhooks].sort((left, right) => left.id.localeCompare(right.id)),
      )
      expect(mcpList.structuredContent).toEqual({ data: JSON.parse(listed) })
      expect(JSON.parse(cliList.stdout)).toEqual({ data: JSON.parse(listed) })
    }
  })

  it('denies scoped writes and rechecks a demoted team admin on both operations', async () => {
    const host = await fixtures.host()
    const teamId = await fixtures.organization()
    await fixtures.member(host.userId, teamId, 'admin')
    const full = await credential(host.userId, teamId)
    const read = await credential(host.userId, teamId, 'read')
    const bookings = await credential(host.userId, teamId, 'bookings')
    await expectFailure(read, 403, 'insufficient_scope', input)
    await expectFailure(bookings, 403, 'insufficient_scope', input)
    await expectFailure(bookings, 403, 'insufficient_scope')
    expect((await mcp(full)).structuredContent).toEqual({ data: [] })
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', teamId)
      .where('userId', '=', host.userId)
      .execute()
    await expectFailure(full, 403, 'insufficient_role', input)
    await expectFailure(full, 403, 'insufficient_role')
    await expectFailure(read, 403, 'insufficient_role')
    const rows = await db
      .selectFrom('webhooks')
      .select('id')
      .where('organization_id', '=', teamId)
      .execute()
    expect(rows).toEqual([])
  })

  it('preserves webhook validation codes and rejects workflow subscriptions', async () => {
    const host = await fixtures.host()
    const key = await credential(host.userId, host.organizationId)
    await expectFailure(key, 400, 'invalid_webhook', { ...input, events: [] })
    await expectFailure(key, 400, 'invalid_request', { ...input, oneTimeToken: 'unused' })
    await expectFailure(key, 400, 'invalid_request', { ...input, events: ['workflow.executed'] })
  })

  it('updates subscriptions and pauses or resumes without changing the destination, then deletes', async () => {
    const owner = await fixtures.host()
    const admin = await fixtures.host()
    const teamId = await fixtures.organization()
    await fixtures.member(owner.userId, teamId, 'owner')
    await fixtures.member(admin.userId, teamId, 'admin')
    const ownerKey = await credential(owner.userId, teamId)
    const adminKey = await credential(admin.userId, teamId)
    const personalKey = await credential(owner.userId, owner.organizationId)
    const created = (await (await rest(ownerKey, input)).json()) as Created
    const personal = (await (await rest(personalKey, input)).json()) as Created
    const { id } = created.webhook

    await expectFailure(
      ownerKey,
      400,
      'invalid_request',
      { id, url: 'https://replacement.example.test' },
      'update',
    )
    await expectFailure(
      ownerKey,
      400,
      'invalid_request',
      { id, events: ['workflow.executed'] },
      'update',
    )
    await expectFailure(ownerKey, 400, 'invalid_webhook', { id }, 'update')

    const newEvents = ['booking.created']
    const edited = await mcp(adminKey, { id, events: newEvents }, 'update')
    expect(edited.isError).toBeFalsy()
    expect(edited.structuredContent).toMatchObject({
      id,
      url: input.url,
      events: newEvents,
      isActive: false,
    })
    expect(JSON.stringify(edited).includes(created.secret)).toBe(false)
    expect(await (await rest(ownerKey)).json()).toEqual([edited.structuredContent])

    const resumed = await cli(ownerKey, { id, isActive: true }, 'update')
    expect(resumed.code).toBe(0)
    expect(resumed.stderr).toBe('')
    expect(resumed.stdout.includes(created.secret)).toBe(false)
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      id,
      url: input.url,
      events: newEvents,
      isActive: true,
    })
    const paused = await rest(adminKey, { id, isActive: false }, 'update')
    expect(paused.status).toBe(200)
    expect(await paused.json()).toMatchObject({
      id,
      url: input.url,
      events: newEvents,
      isActive: false,
    })

    expect((await mcp(adminKey, { id }, 'delete')).structuredContent).toEqual({ deleted: true })
    expect(await (await rest(ownerKey)).json()).toEqual([])
    await expectFailure(ownerKey, 404, 'webhook_not_found', { id }, 'delete')
    const deleted = await cli(personalKey, { id: personal.webhook.id }, 'delete')
    expect(deleted.code).toBe(0)
    expect(deleted.stderr).toBe('')
    expect(JSON.parse(deleted.stdout)).toEqual({ deleted: true })
    expect(await (await rest(personalKey)).json()).toEqual([])
  })

  it('requires full scope and current admin authority for writes, with uniform organization isolation', async () => {
    const host = await fixtures.host()
    const teamId = await fixtures.organization()
    await fixtures.member(host.userId, teamId, 'admin')
    const full = await credential(host.userId, teamId)
    const read = await credential(host.userId, teamId, 'read')
    const bookings = await credential(host.userId, teamId, 'bookings')
    const personal = await credential(host.userId, host.organizationId)
    const created = (await (await rest(full, input)).json()) as Created
    const { id } = created.webhook

    for (const action of ['update', 'delete'] as const) {
      const args = (target: string) => ({
        id: target,
        ...(action === 'update' && { isActive: true }),
      })
      for (const key of [read, bookings])
        await expectFailure(key, 403, 'insufficient_scope', args(id), action)
      for (const target of [id, randomUUID(), 'malformed'])
        await expectFailure(personal, 404, 'webhook_not_found', args(target), action)
    }

    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', teamId)
      .where('userId', '=', host.userId)
      .execute()
    await expectFailure(full, 403, 'insufficient_role', { id, isActive: true }, 'update')
    await expectFailure(full, 403, 'insufficient_role', { id }, 'delete')
    const row = await db
      .selectFrom('webhooks')
      .select('is_active')
      .where('id', '=', id)
      .executeTakeFirst()
    expect(row).toEqual({ is_active: false })
  })
})
