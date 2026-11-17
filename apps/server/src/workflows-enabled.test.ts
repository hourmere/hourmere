// The workflow definition paths through REST, MCP and the CLI, as it will behave once workflows are
// enabled. The constant stays false and pinned: this file alone replaces the hard-off module
// with WORKFLOWS_IMPLEMENTED-equivalent guards (a test-only module mock, not an option any
// production code can pass), so the transports reach the definition services. It checks scope and
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

describe.skipIf(!serverUrl)('workflow definitions once workflows are enabled', () => {
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
      routes: [
        workflowRoutes({ db, audit: { record: async () => {} } }),
        instanceRoutes({ publicUrl: URL, socialProviders: {} }),
      ],
      mcp: mcpEndpoint({ tools: workflowTools({ db, audit: { record: async () => {} } }) }),
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
      expect(tools).toEqual(
        scope === 'full'
          ? [
              'create_workflow',
              'update_workflow',
              'delete_workflow',
              'list_workflows',
              'get_workflow',
            ]
          : ['list_workflows', 'get_workflow'],
      )
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

  const createInput = () => ({
    owner: { kind: 'personal' as const, id: owner.id },
    idempotencyKey: randomUUID(),
    name: 'Created workflow',
    ...candidate({ scope: { type: 'all_event_types' }, enabled: false }),
  })
  const post = (token: string, input: object) =>
    app.request('/api/v1/workflows', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })

  it('creates and replays one definition over REST, MCP and CLI', async () => {
    const token = bearer(owner, 'full')
    const input = createInput()
    const created = await post(token, input)
    expect(created.status).toBe(201)
    const body = await created.json()
    expect(Workflow.parse(body)).toEqual(body)
    expect(body).toMatchObject({
      owner: input.owner,
      revision: 1,
      enabled: false,
      name: input.name,
    })
    expect((await post(token, input)).status).toBe(201)
    expect(
      (await mcp(token, 'tools/call', { name: 'create_workflow', arguments: input }))
        .structuredContent,
    ).toEqual(body)
    const command = await cli(token, ['workflows', 'create'], input)
    expect(command.code).toBe(0)
    expect(JSON.parse(command.stdout)).toEqual(body)
    const changed = await post(token, { ...input, name: 'Changed replay' })
    expect(changed.status).toBe(409)
    expect(await changed.json()).toMatchObject({ error: 'idempotency_key_reused' })
  })

  const patch = (token: string, id: string, input: object) =>
    app.request(`/api/v1/workflows/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })

  it('edits, enables and disables through all three surfaces with stale-revision conflicts', async () => {
    const token = bearer(owner, 'full')
    const created = Workflow.parse(await (await post(token, createInput())).json())
    const edited = await patch(token, created.id, { expectedRevision: 1, name: 'Edited workflow' })
    expect(edited.status).toBe(200)
    expect(await edited.json()).toMatchObject({
      revision: 2,
      name: 'Edited workflow',
      enabled: false,
    })
    const enabled = await mcp(token, 'tools/call', {
      name: 'update_workflow',
      arguments: { id: created.id, expectedRevision: 2, enabled: true },
    })
    expect(enabled.structuredContent).toMatchObject({ revision: 2, enabled: true })
    const disabled = await cli(token, ['workflows', 'update'], {
      id: created.id,
      expectedRevision: 2,
      enabled: false,
    })
    expect(disabled.code).toBe(0)
    expect(JSON.parse(disabled.stdout)).toMatchObject({ revision: 2, enabled: false })
    const stale = { expectedRevision: 1, name: 'Stale edit' }
    const response = await patch(token, created.id, stale)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'workflow_revision_conflict' })
    expect(
      toolError(
        await mcp(token, 'tools/call', {
          name: 'update_workflow',
          arguments: { id: created.id, ...stale },
        }),
      ),
    ).toMatchObject({ error: 'workflow_revision_conflict' })
    const command = await cli(token, ['workflows', 'update'], { id: created.id, ...stale })
    expect(command.code).toBe(1)
    expect(JSON.parse(command.stderr)).toMatchObject({ error: 'workflow_revision_conflict' })
  })

  it('keeps update scope and foreign-owner refusals identical on all surfaces', async () => {
    const before = await db.selectFrom('workflow_definitions').selectAll().orderBy('id').execute()
    for (const [token, id, status, error] of [
      [bearer(owner, 'read'), workflow.personal, 403, 'insufficient_scope'],
      [bearer(owner, 'bookings'), workflow.personal, 403, 'insufficient_scope'],
      [bearer(member, 'full', team), workflow.team, 404, 'workflow_not_found'],
      [bearer(owner, 'full'), workflow.foreign, 404, 'workflow_not_found'],
      [bearer(owner, 'full'), workflow.team, 404, 'workflow_not_found'],
      [bearer(owner, 'full', team), workflow.personal, 404, 'workflow_not_found'],
      [bearer(owner, 'full'), 'not-an-id', 404, 'workflow_not_found'],
    ] as const) {
      const input = { expectedRevision: 1, enabled: true }
      if (!id) throw new Error('Missing workflow fixture')
      const response = await patch(token, id, input)
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ error })
      expect(
        toolError(
          await mcp(token, 'tools/call', { name: 'update_workflow', arguments: { id, ...input } }),
        ),
      ).toMatchObject({ error })
      const command = await cli(token, ['workflows', 'update'], { id, ...input })
      expect(command.code).toBe(1)
      expect(JSON.parse(command.stderr)).toMatchObject({ error })
    }
    expect(await db.selectFrom('workflow_definitions').selectAll().orderBy('id').execute()).toEqual(
      before,
    )
  })

  const remove = (token: string, id: string, input: object = { expectedRevision: 1 }) =>
    app.request(`/api/v1/workflows/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })

  it('deletes and safely repeats across REST, MCP and CLI', async () => {
    for (const token of [bearer(owner, 'full'), bearer(admin, 'full', team)]) {
      const input = {
        ...createInput(),
        ...(tokens.get(token)?.organization.id === team.id
          ? { owner: { kind: 'team' as const, id: team.id } }
          : {}),
      }
      const created = Workflow.parse(await (await post(token, input)).json())
      const response = await remove(token, created.id)
      expect(response.status).toBe(204)
      expect(await response.text()).toBe('')
      const called = await mcp(token, 'tools/call', {
        name: 'delete_workflow',
        arguments: { id: created.id, expectedRevision: 1 },
      })
      expect(called.structuredContent).toEqual({ deleted: true })
      const command = await cli(token, ['workflows', 'delete'], {
        id: created.id,
        expectedRevision: 1,
      })
      expect(command.code).toBe(0)
      expect(JSON.parse(command.stdout)).toEqual({ deleted: true })
      expect((await rest(token, `/api/v1/workflows/${created.id}`)).status).toBe(404)
      expect(
        await db
          .selectFrom('workflow_definitions')
          .select(['enabled', 'deleted_at'])
          .where('id', '=', created.id)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ enabled: false, deleted_at: expect.any(Date) })
    }
  })

  it('keeps deletion scope, revision and opaque ownership refusals identical across transports', async () => {
    const before = await db.selectFrom('workflow_definitions').selectAll().orderBy('id').execute()
    for (const [token, id, revision, status, error] of [
      [bearer(owner, 'read'), workflow.personal, 1, 403, 'insufficient_scope'],
      [bearer(owner, 'bookings'), workflow.personal, 1, 403, 'insufficient_scope'],
      [bearer(member, 'full', team), workflow.team, 1, 404, 'workflow_not_found'],
      [bearer(owner, 'full'), workflow.foreign, 1, 404, 'workflow_not_found'],
      [bearer(owner, 'full'), workflow.team, 1, 404, 'workflow_not_found'],
      [bearer(owner, 'full', team), workflow.personal, 1, 404, 'workflow_not_found'],
      [bearer(owner, 'full'), 'not-an-id', 1, 404, 'workflow_not_found'],
      [bearer(owner, 'full'), randomUUID(), 1, 404, 'workflow_not_found'],
      [bearer(owner, 'full'), workflow.personal, 99, 409, 'workflow_revision_conflict'],
    ] as const) {
      if (!id) throw new Error('Missing workflow fixture')
      const input = { expectedRevision: revision }
      const response = await remove(token, id, input)
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ error })
      expect(
        toolError(
          await mcp(token, 'tools/call', { name: 'delete_workflow', arguments: { id, ...input } }),
        ),
      ).toMatchObject({ error })
      const command = await cli(token, ['workflows', 'delete'], { id, ...input })
      expect(command.code).toBe(1)
      expect(JSON.parse(command.stderr)).toMatchObject({ error })
    }
    expect(await db.selectFrom('workflow_definitions').selectAll().orderBy('id').execute()).toEqual(
      before,
    )
  })

  it('requires a strict deletion revision on every transport without modifying storage', async () => {
    const token = bearer(owner, 'full')
    const before = await db.selectFrom('workflow_definitions').selectAll().orderBy('id').execute()
    for (const input of [{}, { expectedRevision: 0 }, { expectedRevision: 1, unexpected: true }]) {
      const id = workflow.personal as string
      const response = await remove(token, id, input)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_request' })
      expect(
        toolError(
          await mcp(token, 'tools/call', { name: 'delete_workflow', arguments: { id, ...input } }),
        ),
      ).toMatchObject({ error: 'invalid_request' })
      const command = await cli(token, ['workflows', 'delete'], { id, ...input })
      expect(command.code).toBe(1)
      expect(JSON.parse(command.stderr)).toMatchObject({ error: 'invalid_request' })
    }
    expect(await db.selectFrom('workflow_definitions').selectAll().orderBy('id').execute()).toEqual(
      before,
    )
  })

  it('rejects unknown update fields and webhook actions across all surfaces', async () => {
    const token = bearer(owner, 'full')
    const created = Workflow.parse(await (await post(token, createInput())).json())
    for (const fields of [
      { owner: { kind: 'personal', id: owner.id } },
      { unexpected: true },
      { actions: [{ type: 'webhook', webhookId: randomUUID() }] },
    ]) {
      const input = { expectedRevision: 1, ...fields }
      const error = 'actions' in fields ? 'invalid_workflow' : 'invalid_request'
      const response = await patch(token, created.id, input)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error })
      expect(
        toolError(
          await mcp(token, 'tools/call', {
            name: 'update_workflow',
            arguments: { id: created.id, ...input },
          }),
        ),
      ).toMatchObject({ error })
      const command = await cli(token, ['workflows', 'update'], { id: created.id, ...input })
      expect(command.code).toBe(1)
      expect(JSON.parse(command.stderr)).toMatchObject({ error })
    }
    expect(await (await rest(token, `/api/v1/workflows/${created.id}`)).json()).toEqual(created)
  })

  it('rejects read keys, team members and foreign owner contexts for creation on every surface', async () => {
    for (const [token, input, status, code] of [
      [bearer(owner, 'read'), createInput(), 403, 'insufficient_scope'],
      [
        bearer(member, 'full', team),
        { ...createInput(), owner: { kind: 'team', id: team.id } },
        404,
        'workflow_not_found',
      ],
      [
        bearer(owner, 'full'),
        { ...createInput(), owner: { kind: 'personal', id: outsider.id } },
        404,
        'workflow_not_found',
      ],
      [
        bearer(owner, 'full'),
        { ...createInput(), owner: { kind: 'team', id: team.id } },
        404,
        'workflow_not_found',
      ],
      [bearer(owner, 'full', team), createInput(), 404, 'workflow_not_found'],
    ] as const) {
      const response = await post(token, input)
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ error: code })
      expect(
        toolError(await mcp(token, 'tools/call', { name: 'create_workflow', arguments: input })),
      ).toMatchObject({ error: code })
      const command = await cli(token, ['workflows', 'create'], input)
      expect(command.code).toBe(1)
      expect(JSON.parse(command.stderr)).toMatchObject({ error: code })
    }
  })

  it('rejects caller IDs, unknown fields and webhook actions on every creation surface', async () => {
    const token = bearer(owner, 'full')
    const before = await db.selectFrom('workflow_definitions').select('id').execute()
    for (const extra of [
      { id: randomUUID() },
      { unexpected: true },
      { actions: [{ type: 'webhook', webhookId: randomUUID() }] },
    ]) {
      const input = { ...createInput(), ...extra }
      const response = await post(token, input)
      expect(response.status).toBe(400)
      const code = 'actions' in extra ? 'invalid_workflow' : 'invalid_request'
      expect(await response.json()).toMatchObject({ error: code })
      expect(
        toolError(await mcp(token, 'tools/call', { name: 'create_workflow', arguments: input })),
      ).toMatchObject({ error: code })
      const command = await cli(token, ['workflows', 'create'], input)
      expect(command.code).toBe(1)
      expect(JSON.parse(command.stderr)).toMatchObject({ error: code })
    }
    expect(await db.selectFrom('workflow_definitions').select('id').execute()).toEqual(before)
  })

  it('binds browser creation to its live session context while keeping owner refusals opaque', async () => {
    async function session(user: TestUser, acting?: TestTeam) {
      const base = acting ? acting.as(user) : user.principal
      const token = randomUUID()
      const row = await db
        .insertInto('auth.session')
        .values({
          userId: user.id,
          token,
          updatedAt: new Date(),
          expiresAt: new Date(Date.now() + 3_600_000),
          activeOrganizationId: base.organization.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      tokens.set(token, { ...base, kind: 'session', sessionId: row.id })
      return { token, id: row.id }
    }
    const browserPost = (token: string, input: object, expected?: string) =>
      app.request('/api/v1/workflows', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          origin: URL,
          'content-type': 'application/json',
          ...(expected === undefined ? {} : { 'x-expected-organization-id': expected }),
        },
        body: JSON.stringify(input),
      })
    const personal = await session(owner)
    expect(
      (await browserPost(personal.token, createInput(), owner.principal.organization.id)).status,
    ).toBe(201)
    for (const user of [owner, admin]) {
      const current = await session(user, team)
      const input = { ...createInput(), owner: { kind: 'team', id: team.id } }
      expect((await browserPost(current.token, input, team.id)).status).toBe(201)
    }
    const ordinary = await session(member, team)
    const before = await db.selectFrom('workflow_definitions').select('id').execute()
    for (const selected of [
      { kind: 'team', id: team.id },
      { kind: 'team', id: randomUUID() },
      { kind: 'personal', id: outsider.id },
    ]) {
      const response = await browserPost(
        ordinary.token,
        { ...createInput(), owner: selected },
        team.id,
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        error: 'workflow_not_found',
        message: 'No such workflow',
      })
    }
    for (const selected of [
      { kind: 'team', id: team.id },
      { kind: 'personal', id: outsider.id },
    ]) {
      const response = await browserPost(
        personal.token,
        { ...createInput(), owner: selected },
        owner.principal.organization.id,
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        error: 'workflow_not_found',
        message: 'No such workflow',
      })
    }
    for (const expected of [undefined, 'not-an-id', team.id]) {
      const response = await browserPost(personal.token, createInput(), expected)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'organization_context_changed' })
    }
    // Resolver metadata can lag a real session switch; the live row fences the write.
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: team.id })
      .where('id', '=', personal.id)
      .execute()
    const stale = await browserPost(personal.token, createInput(), owner.principal.organization.id)
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: 'organization_context_changed' })
    const staleUpdate = await app.request(`/api/v1/workflows/${workflow.personal}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${personal.token}`,
        origin: URL,
        'content-type': 'application/json',
        'x-expected-organization-id': owner.principal.organization.id,
      },
      body: JSON.stringify({ expectedRevision: 1, enabled: false }),
    })
    expect(staleUpdate.status).toBe(409)
    expect(await staleUpdate.json()).toMatchObject({ error: 'organization_context_changed' })

    const staleDelete = await app.request(`/api/v1/workflows/${workflow.personal}`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${personal.token}`,
        origin: URL,
        'content-type': 'application/json',
        'x-expected-organization-id': owner.principal.organization.id,
      },
      body: JSON.stringify({ expectedRevision: 1 }),
    })
    expect(staleDelete.status).toBe(409)
    expect(await staleDelete.json()).toMatchObject({ error: 'organization_context_changed' })

    expect(await db.selectFrom('workflow_definitions').select('id').execute()).toEqual(before)
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
