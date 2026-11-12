// The workflow read path through REST, MCP and the CLI, as it will behave once workflows are
// enabled. The constant stays false and pinned: this file alone replaces the hard-off module
// with WORKFLOWS_IMPLEMENTED-equivalent guards (a test-only module mock, not an option any
// production code can pass), so the transports reach the read services. It checks scope and
// role decisions, opaque refusals, the response schema and the parity of the three transports.
import { randomUUID } from 'node:crypto'
import '@hono/zod-openapi'
import type { ApiKeyScope, CallerResolver, Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  createTestTeam,
  createTestUser,
  type TestTeam,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  validateWorkflowDefinition,
  WORKFLOWS_IMPLEMENTED,
} from '../../../packages/workflows/src/index.ts'
import { listWorkflowDefinitions } from '../../../packages/workflows/src/reads.ts'
import {
  candidate,
  ids,
  personalContext,
  teamContext,
} from '../../../packages/workflows/src/testing.ts'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { workflowTools } from './mcp/workflows.ts'
import { instanceRoutes } from './routes/instance.ts'
import { Workflow, WorkflowPage, workflowRoutes } from './routes/workflows.ts'

// The enabled build's guards, for this file only: every operation runs its service.
vi.mock('../../../packages/workflows/src/hard-off.ts', () => ({
  WORKFLOWS_IMPLEMENTED: true,
  requireWorkflowsImplemented: () => {},
  workflowOperation: (operation: unknown) => operation,
  workflowCapture: (capture: unknown) => capture,
  workflowExecution: (execute: unknown) => execute,
}))

const serverUrl = process.env.DATABASE_URL
const URL = 'http://localhost:4188'

describe.skipIf(!serverUrl)('workflow reads once workflows are enabled', () => {
  let owned: TestDatabase
  let db: Db
  let owner: TestUser
  let admin: TestUser
  let member: TestUser
  let outsider: TestUser
  let team: TestTeam
  let other: TestTeam
  const workflow: Record<string, string> = {}
  const tokens = new Map<string, Principal>()
  let app: ReturnType<typeof createApp>

  /** A bearer token for `user` acting in `organization` with an API key of `scope`. */
  function bearer(user: TestUser, scope: ApiKeyScope, acting?: TestTeam) {
    const token = `hm_${randomUUID().replaceAll('-', '')}`
    const base = acting ? acting.as(user) : user.principal
    tokens.set(token, { ...base, kind: 'api_key', apiKeyScope: scope, apiKeyId: randomUUID() })
    return token
  }
  const resolveCaller: CallerResolver = async (headers) => {
    const principal = tokens.get(headers.get('authorization')?.replace(/^Bearer /, '') ?? '')
    return principal
      ? { ok: true, principal, setCookie: [] }
      : { ok: false, error: 'unauthorized', setCookie: [] }
  }

  async function define(name: string, organizationId: string, ownerUserId: string | null) {
    const definition =
      ownerUserId === null
        ? validateWorkflowDefinition(
            candidate({ name, scope: { type: 'all_event_types' } }),
            teamContext,
          )
        : validateWorkflowDefinition(
            candidate({
              name,
              conditions: [{ field: 'booking_source', operator: 'equals', value: 'embed' }],
            }),
            personalContext,
          )
    const { enabled: _enabled, ...content } = definition
    await db.transaction().execute(async (trx) => {
      const { id } = await trx
        .insertInto('workflow_definitions')
        .values({ organization_id: organizationId, owner_user_id: ownerUserId })
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .insertInto('workflow_revisions')
        .values({
          organization_id: organizationId,
          workflow_id: id,
          revision: 1,
          definition: JSON.stringify(content),
        })
        .execute()
      workflow[name] = id
    })
  }

  const rest = (token: string, path: string) =>
    app.request(path, { headers: { authorization: `Bearer ${token}` } })
  const listPath = (kind: string, id: string, extra = '') =>
    `/api/v1/workflows?ownerKind=${kind}&ownerId=${id}${extra}`

  async function mcp(token: string, method: string, params: object = {}) {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const text = await res.text()
    const data = text.split('\n').find((line) => line.startsWith('data: '))
    return JSON.parse(data ? data.slice(6) : text).result
  }
  const toolError = (result: { isError?: boolean; content: { text: string }[] }) => {
    expect(result.isError).toBe(true)
    return JSON.parse(result.content[0]?.text ?? '')
  }

  async function cli(token: string, argv: string[], input: object) {
    let stdout = ''
    let stderr = ''
    const code = await runCli({
      argv: [...argv, '--input', '-'],
      env: { HOURMERE_URL: URL, HOURMERE_API_KEY: token },
      stdin: (async function* () {
        yield JSON.stringify(input)
      })(),
      stdout: (text) => {
        stdout += text
      },
      stderr: (text) => {
        stderr += text
      },
      fetch: async (request, init) => app.request(request, init),
    })
    return { code, stdout, stderr }
  }

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'wf_enabled' })
    db = createDb(owned.pool)
    owner = await createTestUser(db, 'Enabled owner')
    admin = await createTestUser(db, 'Enabled admin')
    member = await createTestUser(db, 'Enabled member')
    outsider = await createTestUser(db, 'Enabled outsider')
    team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    other = await createTestTeam(db, [{ user: outsider, role: 'owner' }])
    await define('personal', owner.principal.organization.id, owner.id)
    await define('foreign', outsider.principal.organization.id, outsider.id)
    await define('team', team.id, null)
    await define('otherTeam', other.id, null)
    app = createApp({
      publicUrl: URL,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller,
      routes: [workflowRoutes({ db }), instanceRoutes({ publicUrl: URL, socialProviders: {} })],
      mcp: mcpEndpoint({ tools: workflowTools({ db }) }),
    })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('uses the enabled guards in this file only', () => {
    expect(WORKFLOWS_IMPLEMENTED).toBe(true)
  })

  it('serves the same definitions over REST, MCP and the CLI to full and read keys', async () => {
    for (const scope of ['full', 'read'] as const) {
      const token = bearer(owner, scope)
      const expected = await listWorkflowDefinitions(
        { db, principal: owner.principal },
        { owner: { kind: 'personal', id: owner.id } },
      )
      expect(expected.data.map(({ id }) => id)).toEqual([workflow.personal])
      const listed = await rest(token, listPath('personal', owner.id))
      expect(listed.status).toBe(200)
      const body = await listed.json()
      expect(body).toEqual(expected)
      // The published schema describes every field: parsing keeps the body whole.
      expect(WorkflowPage.parse(body)).toEqual(body)
      const got = await rest(token, `/api/v1/workflows/${workflow.personal}`)
      expect(got.status).toBe(200)
      expect(await got.json()).toEqual(expected.data[0])

      const tools = (await mcp(token, 'tools/list')).tools.map(({ name }: { name: string }) => name)
      expect(tools).toEqual(['list_workflows', 'get_workflow'])
      const called = await mcp(token, 'tools/call', {
        name: 'list_workflows',
        arguments: { owner: { kind: 'personal', id: owner.id } },
      })
      expect(called.structuredContent).toEqual(expected)
      const one = await mcp(token, 'tools/call', {
        name: 'get_workflow',
        arguments: { id: workflow.personal },
      })
      expect(one.structuredContent).toEqual(expected.data[0])

      const command = await cli(token, ['workflows', 'list'], {
        owner: { kind: 'personal', id: owner.id },
      })
      expect(command.code).toBe(0)
      expect(JSON.parse(command.stdout)).toEqual(expected)
      const single = await cli(token, ['workflows', 'get'], { id: workflow.personal })
      expect(JSON.parse(single.stdout)).toEqual(expected.data[0])
    }
  })

  it('refuses a bookings key before the read, on every transport', async () => {
    const token = bearer(owner, 'bookings')
    for (const path of [listPath('personal', owner.id), `/api/v1/workflows/${workflow.personal}`]) {
      const res = await rest(token, path)
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: 'insufficient_scope' })
    }
    expect((await mcp(token, 'tools/list')).tools).toEqual([])
    const called = await mcp(token, 'tools/call', {
      name: 'get_workflow',
      arguments: { id: workflow.personal },
    })
    expect(toolError(called)).toMatchObject({ error: 'insufficient_scope' })
    const command = await cli(token, ['workflows', 'get'], { id: workflow.personal })
    expect(command.code).toBe(1)
    expect(JSON.parse(command.stderr)).toMatchObject({ error: 'insufficient_scope' })
  })

  it('reads team definitions to team owners and admins in the team, and nothing to members', async () => {
    for (const user of [owner, admin]) {
      const token = bearer(user, 'read', team)
      const res = await rest(token, listPath('team', team.id))
      expect(res.status).toBe(200)
      const page = (await res.json()) as { data: { id: string }[] }
      expect(page.data.map(({ id }) => id)).toEqual([workflow.team])
      expect((await rest(token, `/api/v1/workflows/${workflow.team}`)).status).toBe(200)
    }
    const token = bearer(member, 'full', team)
    const listed = await rest(token, listPath('team', team.id))
    expect(listed.status).toBe(403)
    expect(await listed.json()).toMatchObject({ error: 'insufficient_role' })
    const got = await rest(token, `/api/v1/workflows/${workflow.team}`)
    expect(got.status).toBe(404)
    expect(await got.json()).toEqual({ error: 'workflow_not_found', message: 'No such workflow' })
    expect(
      toolError(
        await mcp(token, 'tools/call', { name: 'get_workflow', arguments: { id: workflow.team } }),
      ),
    ).toEqual({ error: 'workflow_not_found', message: 'No such workflow' })
  })

  it('answers foreign IDs and other contexts exactly like unknown IDs', async () => {
    const answers = new Set<string>()
    const personal = bearer(owner, 'full')
    const inTeam = bearer(owner, 'full', team)
    for (const [token, id] of [
      [personal, randomUUID()],
      [personal, 'not-a-uuid'],
      [personal, workflow.foreign],
      [personal, workflow.team],
      [personal, workflow.otherTeam],
      [inTeam, workflow.personal],
      [inTeam, workflow.otherTeam],
      [inTeam, randomUUID()],
    ] as const) {
      const res = await rest(token, `/api/v1/workflows/${id}`)
      answers.add(`${res.status} ${await res.text()}`)
      // MCP and the CLI give the same answer, malformed IDs included.
      const called = await mcp(token, 'tools/call', { name: 'get_workflow', arguments: { id } })
      answers.add(`mcp ${JSON.stringify(toolError(called))}`)
      const command = await cli(token, ['workflows', 'get'], { id })
      expect(command.code).toBe(1)
      answers.add(
        `cli ${JSON.stringify({ ...JSON.parse(command.stderr), outcomeMayBeUnknown: undefined })}`,
      )
    }
    expect([...answers]).toEqual([
      '404 {"error":"workflow_not_found","message":"No such workflow"}',
      'mcp {"error":"workflow_not_found","message":"No such workflow"}',
      // The CLI prints only the stable code of a server error.
      'cli {"error":"workflow_not_found"}',
    ])
    const lists = new Set<string>()
    for (const [token, kind, id] of [
      [personal, 'team', team.id],
      [personal, 'personal', outsider.id],
      [inTeam, 'personal', owner.id],
      [inTeam, 'team', other.id],
      [inTeam, 'team', randomUUID()],
    ] as const) {
      const res = await rest(token, listPath(kind, id))
      lists.add(`${res.status} ${await res.text()}`)
    }
    expect(lists.size).toBe(1)
    expect([...lists][0]).toMatch(/^403 \{"error":"insufficient_role"/)
  })

  it('validates input only once the switch has let the request through', async () => {
    const token = bearer(owner, 'read')
    for (const path of [
      '/api/v1/workflows',
      listPath('robot', owner.id),
      listPath('personal', 'not-a-uuid'),
      listPath('personal', owner.id, '&limit=0'),
      listPath('personal', owner.id, `&limit=101`),
    ]) {
      const res = await rest(token, path)
      expect(res.status, path).toBe(400)
      expect(await res.json()).toMatchObject({ error: 'invalid_request' })
    }
    const res = await rest(token, listPath('personal', owner.id, '&cursor=nope'))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_cursor' })
    const invalid = await mcp(token, 'tools/call', {
      name: 'list_workflows',
      arguments: { owner: { kind: 'personal', id: owner.id }, extra: true },
    })
    expect(toolError(invalid)).toMatchObject({ error: 'invalid_request' })
  })

  it('reports the guard decision on /instance', async () => {
    const res = await app.request('/api/v1/instance')
    expect(await res.json()).toHaveProperty('workflowsEnabled', true)
  })

  it('publishes response schemas that keep every canonical definition whole', () => {
    const definitions = [
      candidate(),
      candidate({ trigger: { type: 'after_end', offsetMinutes: 5 } }),
      candidate({ trigger: { type: 'booking.cancelled', delayMinutes: 0 } }),
      candidate({ trigger: { type: 'booking.rescheduled', delayMinutes: 43200 } }),
      candidate({
        conditions: [
          { field: 'event_type', operator: 'equals', value: ids.secondEvent },
          { field: 'booking_source', operator: 'equals', value: 'api' },
          { field: 'answer', questionId: 'consent', operator: 'equals', value: true },
          { field: 'location_kind', operator: 'equals', value: 'phone' },
          { field: 'guest_count', operator: 'equals', value: 0 },
        ],
        actions: [
          {
            type: 'email',
            recipients: ['guests', 'booker', 'hosts'],
            content: {
              'zh-CN': { subject: '你好', body: '正文' },
              en: { subject: 'Hi', body: 'Body' },
            },
          },
        ],
      }),
    ]
    for (const value of definitions) {
      const definition = validateWorkflowDefinition(value, personalContext)
      const view = {
        id: randomUUID(),
        owner: { kind: 'personal', id: owner.id },
        revision: 3,
        ...definition,
        createdAt: '2026-11-12T00:00:00.000Z',
        updatedAt: '2026-11-12T00:00:01.000Z',
      }
      expect(Workflow.parse(view)).toEqual(view)
    }
    const webhook = validateWorkflowDefinition(
      candidate({
        scope: { type: 'all_event_types' },
        actions: [{ type: 'webhook', webhookId: ids.webhook }],
      }),
      personalContext,
    )
    expect(() =>
      Workflow.parse({
        id: randomUUID(),
        owner: { kind: 'personal', id: owner.id },
        revision: 1,
        ...webhook,
        createdAt: '2026-11-12T00:00:00.000Z',
        updatedAt: '2026-11-12T00:00:00.000Z',
      }),
    ).not.toThrow()
  })
})
