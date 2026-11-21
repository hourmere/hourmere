// Scope, role, privacy and response checks for the workflow transports and operator switch.
import { randomUUID } from 'node:crypto'
import '@hono/zod-openapi'
import type { ApiKeyScope, CallerResolver, Principal } from '@hourmere/auth'
import { createDb, type Database, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestTeam,
  type TestUser,
} from '@hourmere/scheduling/testing'
import { WEBHOOK_EVENTS } from '@hourmere/webhooks'
import { Kysely, PostgresDialect } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  captureWorkflowBooking,
  createWorkflow,
  updateWorkflow,
  validateWorkflowDefinition,
  workflowJobs,
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
import { loadConfig } from './config.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { workflowTools } from './mcp/workflows.ts'
import { instanceRoutes } from './routes/instance.ts'
import { webhookRoutes } from './routes/webhooks.ts'
import { Workflow, WorkflowPage, WorkflowPreview, workflowRoutes } from './routes/workflows.ts'
import { productRoutes, productTools } from './server.ts'

const serverUrl = process.env.DATABASE_URL
const URL = 'http://localhost:4188'
const workflowRunCursorSecret = 'synthetic-test-workflow-cursor-sealing-key'

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
  const runPath = (id: string, query = '') => `/api/v1/workflows/${id}/runs${query}`

  async function mcp(token: string, method: string, params: object = {}, target = app) {
    const res = await target.request('/mcp', {
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

  async function cli(token: string, argv: string[], input: object, target = app) {
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
      fetch: async (request, init) => target.request(request, init),
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
    app = build(db)
  })

  /** The workflow transports over `routesDb`, with the team SSO read gate when `ssoDb` is set. */
  function build(routesDb: Db, ssoDb?: Db, workflowsEnabled = true) {
    return createApp({
      publicUrl: URL,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller,
      routes: [
        workflowRoutes({ db: routesDb, workflowRunCursorSecret, workflowsEnabled }),
        instanceRoutes({ publicUrl: URL, socialProviders: {}, workflowsEnabled }),
        webhookRoutes({
          db: routesDb,
          enabled: true,
          workflowsEnabled,
          encryptionKey: Buffer.alloc(32, 4).toString('base64'),
        }),
      ],
      mcp: mcpEndpoint({
        tools: workflowTools({ db: routesDb, workflowRunCursorSecret, workflowsEnabled }),
      }),
      ...(ssoDb && {
        ssoTeamReads: {
          db: ssoDb,
          capabilities: { ssoOidcEnabled: false, ssoSamlEnabled: false },
        },
      }),
    })
  }
  afterAll(async () => {
    await owned?.drop()
  })

  it('adds the workflow event to an endpoint subscribed to all booking kinds', async () => {
    const headers = {
      authorization: `Bearer ${bearer(owner, 'full')}`,
      'content-type': 'application/json',
    }
    const created = await app.request('/api/v1/webhooks', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: 'https://hooks.example.com/',
        events: WEBHOOK_EVENTS.filter((event) => event !== 'workflow.executed'),
      }),
    })
    expect(created.status).toBe(201)
    const { webhook } = (await created.json()) as { webhook: { id: string } }
    const events = [...WEBHOOK_EVENTS].sort()
    const updated = await app.request(`/api/v1/webhooks/${webhook.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ events }),
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ events })
    expect(
      await db
        .selectFrom('audit_events')
        .select('details')
        .where('action', '=', 'webhook.updated')
        .where('target_id', '=', webhook.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ details: { events } })
  })

  it('forwards the host-text switch through REST and MCP create, update and preview', async () => {
    const user = await createTestUser(db)
    const token = bearer(user, 'full')
    for (const followUpHostNotesEnabled of [true, false]) {
      const testApp = createApp({
        publicUrl: URL,
        checkDb: async () => {},
        authHandler: async () => new Response(null, { status: 404 }),
        resolveCaller,
        routes: [workflowRoutes({ db, followUpHostNotesEnabled, workflowsEnabled: true })],
        mcp: mcpEndpoint({
          tools: workflowTools({ db, followUpHostNotesEnabled, workflowsEnabled: true }),
        }),
      })
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      const builtin = {
        owner: { kind: 'personal', id: user.id },
        idempotencyKey: randomUUID(),
        name: 'Policy',
        scope: { type: 'all_event_types' },
        trigger: { type: 'booking.created' },
        actions: [{ type: 'email', recipients: ['hosts'] }],
      }
      const actions = [
        { ...builtin.actions[0], content: { en: { subject: 'Hello', body: 'Body' } } },
      ]
      const created = await testApp.request('/api/v1/workflows', {
        method: 'POST',
        headers,
        body: JSON.stringify(builtin),
      })
      expect(created.status).toBe(201)
      const { id } = (await created.json()) as { id: string }
      const restCreated = await testApp.request('/api/v1/workflows', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...builtin, idempotencyKey: randomUUID(), actions }),
      })
      expect(restCreated.status).toBe(followUpHostNotesEnabled ? 201 : 400)
      const updated = await testApp.request(`/api/v1/workflows/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ expectedRevision: 1, actions }),
      })
      expect(updated.status).toBe(followUpHostNotesEnabled ? 200 : 400)
      const { idempotencyKey: _key, ...draft } = builtin
      const previewed = await testApp.request('/api/v1/workflows/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...draft, actions }),
      })
      expect(previewed.status).toBe(followUpHostNotesEnabled ? 200 : 400)
      if (!followUpHostNotesEnabled)
        expect(await previewed.json()).toMatchObject({ error: 'invalid_workflow' })
      for (const [name, args] of [
        ['create_workflow', { ...builtin, idempotencyKey: randomUUID(), actions }],
        ['update_workflow', { id, expectedRevision: followUpHostNotesEnabled ? 2 : 1, actions }],
        ['preview_workflow', { ...draft, actions }],
      ] as const) {
        const response = await testApp.request('/mcp', {
          method: 'POST',
          headers: { ...headers, accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        })
        const text = await response.text()
        const data = text.split('\n').find((line) => line.startsWith('data: '))
        const result = JSON.parse(data ? data.slice(6) : text).result
        if (followUpHostNotesEnabled) expect(result.isError).not.toBe(true)
        else expect(toolError(result)).toMatchObject({ error: 'invalid_workflow' })
      }
    }
  })

  it('returns only safe history metadata for personal and team runs and preserves webhook booking IDs', async () => {
    const now = new Date()
    const due = new Date(now.getTime() - 1000)
    const attendee = { name: 'Private Invitee', email: 'private-invitee@example.test' }
    const answer = 'Private answer'
    const url = 'https://private.example.test/meeting'
    for (const [id, organizationId, actor, acting] of [
      [workflow.personal, owner.principal.organization.id, owner, undefined],
      [workflow.team, team.id, admin, team],
    ] as const) {
      if (!id) throw new Error('Expected a workflow history fixture')
      const bookingId = await createFixtures(db).booking(
        organizationId,
        [acting ? member.id : owner.id],
        new Date(now.getTime() + 3600_000).toISOString(),
        new Date(now.getTime() + 5400_000).toISOString(),
        { attendee },
      )
      await db
        .updateTable('bookings')
        .set({
          responses: JSON.stringify({ notes: answer }),
          location: JSON.stringify({ kind: 'custom', value: url }),
        })
        .where('id', '=', bookingId)
        .execute()
      const run = await db.transaction().execute(async (trx) => {
        const { id: enrollmentId } = await trx
          .insertInto('workflow_enrollments')
          .values({
            organization_id: organizationId,
            booking_id: bookingId,
            workflow_id: id,
            revision: 1,
            trigger: 'before_start',
            occurrence: 'created',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        const run = await trx
          .insertInto('workflow_runs')
          .values({
            organization_id: organizationId,
            booking_id: bookingId,
            enrollment_id: enrollmentId,
            due_at: due,
            expires_at: new Date(now.getTime() + 60000),
            finished_at: now,
            state: 'skipped',
            skip_reason: 'workflow_disabled',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        await trx
          .insertInto('workflow_run_history')
          .values({
            run_id: run.id,
            organization_id: organizationId,
            workflow_id: id,
            revision: 1,
            trigger: 'before_start',
            due_at: due,
            finished_at: now,
            outcome: 'skipped',
            reason: 'workflow_disabled',
            skipped: 1,
          })
          .execute()
        return run
      })
      const token = bearer(actor, 'read', acting)
      const iso = (date: Date) => date.toISOString().replace('Z', '000Z')
      const expected = {
        data: [
          {
            workflowId: id,
            revision: 1,
            trigger: 'before_start',
            dueAt: iso(due),
            finishedAt: iso(now),
            outcome: 'skipped',
            reason: 'workflow_disabled',
            sent: 0,
            rejected: 0,
            deliveryUnknown: 0,
            skipped: 1,
          },
        ],
        nextCursor: null,
      }
      const response = await rest(token, runPath(id))
      expect(response.status).toBe(200)
      const responseText = await response.text()
      for (const privateValue of [bookingId, run.id, attendee.name, attendee.email, answer, url])
        expect(responseText).not.toContain(privateValue)
      expect(JSON.parse(responseText)).toEqual(expected)
      const called = await mcp(token, 'tools/call', {
        name: 'list_workflow_runs',
        arguments: { id },
      })
      expect(called.structuredContent).toEqual(expected)
      const command = await cli(token, ['workflows', 'runs'], { id })
      expect(command.code).toBe(0)
      expect(JSON.parse(command.stdout)).toEqual(expected)

      const endpoint = await app.request('/api/v1/webhooks', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer(actor, 'full', acting)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ url: 'https://hooks.example.com/', events: ['booking.created'] }),
      })
      expect(endpoint.status).toBe(201)
      const { webhook } = (await endpoint.json()) as { webhook: { id: string } }
      await db
        .insertInto('webhook_deliveries')
        .values({
          webhook_id: webhook.id,
          organization_id: organizationId,
          booking_id: bookingId,
          event_id: randomUUID(),
          event_type: 'booking.created',
          payload: JSON.stringify({ name: attendee.name, email: attendee.email, answer, url }),
        })
        .execute()
      const deliveries = await rest(token, `/api/v1/webhooks/${webhook.id}/deliveries`)
      expect(deliveries.status).toBe(200)
      expect(await deliveries.json()).toMatchObject({ data: [{ bookingId }] })

      const before = await db
        .selectFrom('workflow_runs')
        .selectAll()
        .where('id', '=', run.id)
        .executeTakeFirstOrThrow()
      await db.deleteFrom('workflow_run_history').where('run_id', '=', run.id).execute()
      const retained = await rest(token, runPath(id))
      expect(await retained.json()).toEqual({ data: [], nextCursor: null })
      expect(
        await db
          .selectFrom('workflow_runs')
          .selectAll()
          .where('id', '=', run.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(before)
      expect(
        await db
          .selectFrom('workflow_enrollments')
          .select('id')
          .where('id', '=', before.enrollment_id)
          .executeTakeFirst(),
      ).toEqual({ id: before.enrollment_id })
    }
  })

  it('refuses team run history without a current SSO proof on REST and MCP, with one policy lookup', async () => {
    const statements: string[] = []
    const logged = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level === 'query') statements.push(event.query.sql)
      },
    })
    const policyStatements = () =>
      statements.filter((statement) =>
        /\b(?:from|join)\s+(?:"?public"?\.)?"?sso_policies\b/i.test(statement),
      )
    const legacy = build(logged)
    const gated = build(logged, logged)
    const enforced = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    await define('enforcedTeam', enforced.id, null)
    await db
      .insertInto('sso_policies')
      .values({ organization_id: enforced.id, require_sso: true })
      .execute()
    const call = (target: typeof app, token: string, id: string) =>
      target.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_workflow_runs', arguments: { id } },
        }),
      })
    const result = async (response: Response) => {
      const text = await response.text()
      const data = text.split('\n').find((line) => line.startsWith('data: '))
      return JSON.parse(data ? data.slice(6) : text).result
    }

    // An enforced team without a fresh proof gets the stable refusal on both transports.
    const enforcedToken = bearer(owner, 'read', enforced)
    statements.length = 0
    const refused = await gated.request(runPath(workflow.enforcedTeam as string), {
      headers: { authorization: `Bearer ${enforcedToken}` },
    })
    expect(refused.status).toBe(403)
    expect(refused.headers.get('location')).toBeNull()
    expect(await refused.json()).toEqual({ error: 'sso_required' })
    expect(policyStatements()).toHaveLength(1)
    expect(statements.some((statement) => statement.includes('workflow_'))).toBe(false)
    statements.length = 0
    expect(
      toolError(await result(await call(gated, enforcedToken, workflow.enforcedTeam as string))),
    ).toEqual({ error: 'sso_required' })
    expect(policyStatements()).toHaveLength(1)
    expect(statements.some((statement) => statement.includes('workflow_'))).toBe(false)

    // A team without a policy answers as before, adding only the one policy lookup.
    const plainToken = bearer(owner, 'read', team)
    for (const send of [
      (target: typeof app) =>
        target.request(runPath(workflow.team as string), {
          headers: { authorization: `Bearer ${plainToken}` },
        }),
      (target: typeof app) => call(target, plainToken, workflow.team as string),
    ]) {
      statements.length = 0
      const before = await (await send(legacy)).text()
      const legacyStatements = [...statements]
      statements.length = 0
      const after = await (await send(gated)).text()
      expect(policyStatements()).toHaveLength(1)
      expect(statements.filter((statement) => !policyStatements().includes(statement))).toEqual(
        legacyStatements,
      )
      // Sealed cursors carry a fresh nonce; everything else is byte-identical.
      const sealed = (text: string) => text.replace(/"nextCursor":"[^"]*"/g, '"nextCursor":"…"')
      expect(sealed(after)).toBe(sealed(before))
      expect(after).toContain('"data":')
    }

    // Personal history needs no policy lookup.
    statements.length = 0
    const personal = await gated.request(runPath(workflow.personal as string), {
      headers: { authorization: `Bearer ${bearer(owner, 'read')}` },
    })
    expect(personal.status).toBe(200)
    expect(policyStatements()).toHaveLength(0)
  })

  it('pages history with exact timestamp and run ordering, rejects tampering and conceals foreign workflows', async () => {
    const reader = await createTestUser(db)
    const organizationId = reader.principal.organization.id
    await define('paged', organizationId, reader.id)
    await define('emptyRuns', organizationId, reader.id)
    const id = workflow.paged as string
    const token = bearer(reader, 'read')
    const now = Temporal.Now.instant()
      .subtract({ minutes: 1 })
      .round({ smallestUnit: 'second', roundingMode: 'floor' })
    const exact = (microseconds: number) =>
      now.add({ microseconds }).toString({ smallestUnit: 'microsecond' })
    const runId = (n: number) => `10000000-0000-4000-8000-00000000000${n}`
    const row = (n: number, finishedAt: string) => ({
      run_id: runId(n),
      organization_id: organizationId,
      workflow_id: id,
      revision: 1,
      trigger: 'before_start',
      due_at: exact(0),
      finished_at: finishedAt,
      outcome: 'completed',
      sent: n,
    })
    await db
      .insertInto('workflow_run_history')
      .values([
        row(1, exact(2)),
        row(3, exact(1)),
        row(2, exact(1)),
        row(4, now.subtract({ hours: 24 * 31 }).toString()),
      ])
      .execute()
    const read = async (extra = '') => {
      const response = await rest(token, runPath(id, extra))
      expect(response.status).toBe(200)
      return (await response.json()) as { data: { sent: number }[]; nextCursor: string | null }
    }
    expect((await read()).data.map(({ sent }) => sent)).toEqual([1, 3, 2])
    const first = await read('?limit=1')
    expect(first.data.map(({ sent }) => sent)).toEqual([1])
    const cursor = first.nextCursor as string
    expect(cursor).toBeTruthy()

    const ciphertext = Buffer.from(cursor, 'base64url')
    const lastByte = ciphertext.length - 1
    ciphertext[lastByte] = (ciphertext[lastByte] as number) ^ 1
    const tampered = ciphertext.toString('base64url')
    const bad = await rest(token, runPath(id, `?cursor=${tampered}`))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: 'invalid_cursor' })
    const crossWorkflow = await rest(
      token,
      runPath(workflow.emptyRuns as string, `?cursor=${cursor}`),
    )
    expect(crossWorkflow.status).toBe(400)
    expect(await crossWorkflow.json()).toMatchObject({ error: 'invalid_cursor' })
    for (const query of ['?limit=0', '?limit=101', '?limit=1.5', '?extra=1']) {
      expect((await rest(token, runPath(id, query))).status).toBe(400)
    }

    // A newer completion and the disappearance of the page's anchor do not move its boundary.
    await db
      .insertInto('workflow_run_history')
      .values(row(5, exact(3)))
      .execute()
    await db.deleteFrom('workflow_run_history').where('run_id', '=', runId(1)).execute()
    const second = await mcp(token, 'tools/call', {
      name: 'list_workflow_runs',
      arguments: { id, limit: 1, cursor },
    })
    expect(second.structuredContent.data.map(({ sent }: { sent: number }) => sent)).toEqual([3])
    expect(await read(`?cursor=${second.structuredContent.nextCursor}&limit=1`)).toMatchObject({
      data: [{ sent: 2 }],
      nextCursor: null,
    })
    expect(
      await db
        .selectFrom('workflow_run_history')
        .select('run_id')
        .where('run_id', '=', runId(4))
        .executeTakeFirst(),
    ).toEqual({ run_id: runId(4) })

    const missing = { error: 'workflow_not_found', message: 'No such workflow' }
    for (const [credential, inaccessible] of [
      [token, 'malformed'],
      [token, randomUUID()],
      [token, workflow.foreign as string],
      [bearer(owner, 'full', team), id],
      [bearer(member, 'full', team), workflow.team as string],
      [bearer(owner, 'full', team), workflow.otherTeam as string],
    ] as const) {
      const response = await rest(credential, runPath(inaccessible, '?cursor=bad'))
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual(missing)
      const called = await mcp(credential, 'tools/call', {
        name: 'list_workflow_runs',
        arguments: { id: inaccessible },
      })
      expect(toolError(called)).toEqual(missing)
    }
    const denied = await rest(bearer(reader, 'bookings'), runPath(id))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: 'insufficient_scope' })
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
              'preview_workflow',
              'list_workflows',
              'get_workflow',
              'list_workflow_runs',
            ]
          : ['list_workflows', 'get_workflow', 'list_workflow_runs'],
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

  const previewInput = (selected = { kind: 'personal', id: owner.id }) => ({
    owner: selected,
    name: 'Example workflow',
    scope: { type: 'all_event_types' },
    trigger: { type: 'booking.created' },
    actions: [
      {
        type: 'email',
        recipients: ['booker'],
        content: { en: { subject: 'Hello', body: '<Hi>' } },
      },
    ],
  })
  const preview = (token: string, input: object) =>
    app.request('/api/v1/workflows/preview', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  const previewTool = (token: string, input: object) =>
    mcp(token, 'tools/call', { name: 'preview_workflow', arguments: input })

  it('binds the shared journal in the production REST and MCP registries', async () => {
    const user = await createTestUser(db)
    const organizationId = user.principal.organization.id
    const testApp = createApp({
      publicUrl: URL,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller,
      routes: productRoutes({
        db,
        socialProviders: {},
        invitationMailLimits: { secret: workflowRunCursorSecret },
        workflowsEnabled: true,
      }),
      mcp: mcpEndpoint({ tools: productTools({ db, workflowsEnabled: true }) }),
    })
    const headers = {
      authorization: `Bearer ${bearer(user, 'full')}`,
      'content-type': 'application/json',
    }
    const input = previewInput({ kind: 'personal', id: user.id })
    const created = await testApp.request('/api/v1/workflows', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...input, idempotencyKey: randomUUID() }),
    })
    expect(created.status).toBe(201)
    const { id } = Workflow.parse(await created.json())
    const previewed = await testApp.request('/mcp', {
      method: 'POST',
      headers: { ...headers, accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'preview_workflow', arguments: input },
      }),
    })
    const response = await previewed.text()
    expect(previewed.status).toBe(200)
    expect(response).toContain('"synthetic":true')
    expect(
      await db
        .selectFrom('audit_events')
        .select(['action', 'target_type', 'target_id', 'details'])
        .where('organization_id', '=', organizationId)
        .where('action', 'in', ['workflow.created', 'workflow.previewed'])
        .orderBy('id')
        .execute(),
    ).toEqual([
      {
        action: 'workflow.created',
        target_type: 'workflow',
        target_id: id,
        details: { revision: 1, trigger: 'booking.created' },
      },
      {
        action: 'workflow.previewed',
        target_type: 'workflow_preview',
        target_id: organizationId,
        details: { trigger: 'booking.created' },
      },
    ])
  })

  it('returns the same synthetic preview over REST, MCP and CLI for personal and team owners', async () => {
    for (const [token, input] of [
      [bearer(owner, 'full'), previewInput()],
      [bearer(admin, 'full', team), previewInput({ kind: 'team', id: team.id })],
    ] as const) {
      const response = await preview(token, input)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const body = await response.json()
      expect(WorkflowPreview.parse(body)).toEqual(body)
      expect(body).toMatchObject({
        synthetic: true,
        match: 'matched',
        emails: [{ text: '<Hi>', html: '<p>&lt;Hi&gt;</p>' }],
      })
      const result = await previewTool(token, input)
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual(body)
      const command = await cli(token, ['workflows', 'preview'], input)
      expect(command.code).toBe(0)
      expect(JSON.parse(command.stdout)).toEqual(body)
    }
  })

  it('keeps scope, owner and booking-ID refusals consistent across preview transports', async () => {
    const full = bearer(owner, 'full')
    for (const [token, input, status, error] of [
      [bearer(owner, 'read'), previewInput(), 403, 'insufficient_scope'],
      [bearer(owner, 'bookings'), previewInput(), 403, 'insufficient_scope'],
      [
        bearer(member, 'full', team),
        previewInput({ kind: 'team', id: team.id }),
        404,
        'workflow_not_found',
      ],
      [full, previewInput({ kind: 'team', id: team.id }), 404, 'workflow_not_found'],
      [full, previewInput({ kind: 'personal', id: outsider.id }), 404, 'workflow_not_found'],
      [full, { ...previewInput(), bookingId: randomUUID() }, 400, 'invalid_request'],
      [full, { ...previewInput(), example: { bookingId: randomUUID() } }, 400, 'invalid_request'],
    ] as const) {
      const response = await preview(token, input)
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ error })
      expect(toolError(await previewTool(token, input))).toMatchObject({ error })
      const command = await cli(token, ['workflows', 'preview'], input)
      expect(command.code).toBe(1)
      expect(JSON.parse(command.stderr)).toMatchObject({ error })
    }
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

  it('rejects unknown update fields and missing webhook targets across all surfaces', async () => {
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

  it('rejects caller IDs, unknown fields and missing webhook targets on every creation surface', async () => {
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

  it('binds browser workflow requests to the live session context with opaque owner refusals', async () => {
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
    const browserPost = (
      token: string,
      input: object,
      expected?: string,
      path = '/api/v1/workflows',
    ) =>
      app.request(path, {
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
    const browserPreview = (expected?: string) =>
      browserPost(personal.token, previewInput(), expected, '/api/v1/workflows/preview')
    expect(
      (await browserPost(personal.token, createInput(), owner.principal.organization.id)).status,
    ).toBe(201)
    expect((await browserPreview(owner.principal.organization.id)).status).toBe(200)
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
    const stalePreview = await browserPreview(owner.principal.organization.id)
    expect(stalePreview.status).toBe(409)
    expect(await stalePreview.json()).toMatchObject({ error: 'organization_context_changed' })
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

  it('reports the operator setting on /instance and hides all workflow tools while off', async () => {
    const res = await app.request('/api/v1/instance')
    expect(await res.json()).toHaveProperty('workflowsEnabled', true)
    const off = build(db, undefined, false)
    const stopped = await off.request('/api/v1/instance')
    expect(await stopped.json()).toHaveProperty('workflowsEnabled', false)
    expect((await mcp(bearer(owner, 'full'), 'tools/list', {}, off)).tools).toEqual([])
  })

  it('admits only recovery operations over REST, MCP and CLI while operator-off', async () => {
    const off = build(db, undefined, false)
    const user = await createTestUser(db)
    const selected = { kind: 'personal' as const, id: user.id }
    const full = bearer(user, 'full')
    const read = bearer(user, 'read')
    const draft = () => ({ ...createInput(), owner: selected, enabled: true })
    const createEnabled = async () => {
      const response = await post(full, draft())
      expect(response.status).toBe(201)
      return Workflow.parse(await response.json())
    }
    const created = await createEnabled()
    const path = `/api/v1/workflows/${created.id}`
    const request = (token: string, method: string, url: string, input?: object) =>
      off.request(url, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(input && { body: JSON.stringify(input) }),
      })
    const call = (token: string, name: string, args: object) =>
      mcp(token, 'tools/call', { name, arguments: args }, off)
    const run = (token: string, command: string, input: object) =>
      cli(token, ['workflows', command], input, off)

    for (const [command, tool, url, args, expected] of [
      [
        'list',
        'list_workflows',
        listPath(selected.kind, selected.id),
        { owner: selected },
        { data: [created], nextCursor: null },
      ],
      ['get', 'get_workflow', path, { id: created.id }, created],
      [
        'runs',
        'list_workflow_runs',
        runPath(created.id),
        { id: created.id },
        { data: [], nextCursor: null },
      ],
    ] as const) {
      const response = await request(read, 'GET', url)
      expect(response.status, command).toBe(200)
      expect(await response.json()).toEqual(expected)
      expect((await call(read, tool, args)).structuredContent).toEqual(expected)
      const cliResult = await run(read, command, args)
      expect(cliResult.code, command).toBe(0)
      expect(JSON.parse(cliResult.stdout)).toEqual(expected)
    }

    const disabled = { error: 'workflows_disabled' }
    const disable = { expectedRevision: created.revision, enabled: false }
    for (const [command, tool, method, url, body, args] of [
      ['create', 'create_workflow', 'POST', '/api/v1/workflows', draft(), draft()],
      [
        'preview',
        'preview_workflow',
        'POST',
        '/api/v1/workflows/preview',
        previewInput(selected),
        previewInput(selected),
      ],
      ...[
        { ...disable, enabled: true },
        { expectedRevision: created.revision, name: 'Rename' },
        { ...disable, name: 'Disable and rename' },
        { expectedRevision: created.revision },
      ].map(
        (patch) =>
          [
            'update',
            'update_workflow',
            'PATCH',
            path,
            patch,
            { id: created.id, ...patch },
          ] as const,
      ),
    ] as const) {
      const response = await request(full, method, url, body)
      expect(response.status, command).toBe(404)
      expect(await response.json()).toEqual(disabled)
      expect(toolError(await call(full, tool, args))).toEqual(disabled)
      const cliResult = await run(full, command, args)
      expect(cliResult.code, command).toBe(1)
      expect(JSON.parse(cliResult.stderr)).toMatchObject(disabled)
    }
    expect(await (await request(read, 'GET', path)).json()).toEqual(created)

    const insufficient = await request(read, 'PATCH', path, disable)
    expect(insufficient.status).toBe(403)
    expect(await insufficient.json()).toMatchObject({ error: 'insufficient_scope' })
    const foreign = bearer(outsider, 'full')
    expect(toolError(await call(foreign, 'get_workflow', { id: created.id }))).toMatchObject({
      error: 'workflow_not_found',
    })
    expect(
      toolError(await call(foreign, 'update_workflow', { id: created.id, ...disable })),
    ).toMatchObject({ error: 'workflow_not_found' })
    expect(
      JSON.parse(
        (
          await run(foreign, 'delete', {
            id: created.id,
            expectedRevision: disable.expectedRevision,
          })
        ).stderr,
      ),
    ).toMatchObject({ error: 'workflow_not_found' })

    for (const surface of ['REST', 'MCP', 'CLI'] as const) {
      const target = surface === 'REST' ? created : await createEnabled()
      const url = `/api/v1/workflows/${target.id}`
      const revision = { expectedRevision: target.revision }
      const update = { ...revision, enabled: false }
      if (surface === 'REST') {
        const response = await request(full, 'PATCH', url, update)
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ enabled: false, revision: target.revision })
      } else if (surface === 'MCP') {
        const response = await call(full, 'update_workflow', { id: target.id, ...update })
        expect(response.structuredContent).toMatchObject({
          enabled: false,
          revision: target.revision,
        })
      } else {
        const response = await run(full, 'update', { id: target.id, ...update })
        expect(response.code).toBe(0)
        expect(JSON.parse(response.stdout)).toMatchObject({
          enabled: false,
          revision: target.revision,
        })
      }
      expect(await (await request(read, 'GET', url)).json()).toHaveProperty('enabled', false)

      if (surface === 'REST') {
        expect((await request(full, 'DELETE', url, revision)).status).toBe(204)
      } else if (surface === 'MCP') {
        const response = await call(full, 'delete_workflow', { id: target.id, ...revision })
        expect(response.structuredContent).toEqual({ deleted: true })
      } else {
        const response = await run(full, 'delete', { id: target.id, ...revision })
        expect(response.code).toBe(0)
        expect(JSON.parse(response.stdout)).toEqual({ deleted: true })
      }
      expect(await (await request(read, 'GET', url)).json()).toMatchObject({
        error: 'workflow_not_found',
      })
    }
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

  it('captures only while on and terminally skips due wakes claimed while off', async () => {
    const user = await createTestUser(db, 'Workflow wake owner')
    const organizationId = user.principal.organization.id
    const fixtures = createFixtures(db)
    const eventTypeId = await fixtures.eventType(organizationId, user.id)
    const setting = (value: string) => ({
      workflowsEnabled: loadConfig({
        DATABASE_URL: owned.url,
        BETTER_AUTH_SECRET: workflowRunCursorSecret,
        WORKFLOWS_ENABLED: value,
      }).WORKFLOWS_ENABLED,
    })
    const on = setting('true')
    const off = setting('')
    const context = { db, principal: user.principal, ...on }
    const definition = await createWorkflow(context, {
      owner: { kind: 'personal', id: user.id },
      idempotencyKey: randomUUID(),
      name: 'Delayed booking workflow',
      scope: { type: 'event_type', eventTypeId },
      trigger: { type: 'booking.created', delayMinutes: 20 },
      actions: [{ type: 'email', recipients: ['booker'] }],
      enabled: true,
    })
    let now = Temporal.Instant.from('2031-03-10T08:00:00Z')
    const initialTime = now
    async function capture(settings: typeof on, capturedAt: Temporal.Instant, offsetHours: number) {
      const start = initialTime.add({ hours: offsetHours })
      const bookingId = await fixtures.booking(
        organizationId,
        [user.id],
        start.toString(),
        start.add({ minutes: 30 }).toString(),
        { eventTypeId },
      )
      await db
        .transaction()
        .execute((trx) =>
          captureWorkflowBooking(
            trx,
            { type: 'created', bookingId, start },
            capturedAt,
            'synthetic-workflow-capture-key',
            settings,
          ),
        )
      return db
        .selectFrom('workflow_runs')
        .selectAll()
        .where('booking_id', '=', bookingId)
        .executeTakeFirst()
    }
    expect(await capture(off, now, 30)).toBeUndefined()
    const due = await capture(on, now.subtract({ minutes: 20 }), 31)
    const future = await capture(on, now, 32)
    if (!due || !future) throw new Error('Expected captures while workflows are on')
    const saved = (id: string) =>
      db.selectFrom('workflow_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    const wakes = new Set<string>()
    const port = {
      ensureWake: async (_trx: Db, id: string) => {
        wakes.add(id)
      },
    }
    const enqueueRetention = vi.fn(async () => {})
    const offJobs = workflowJobs({ db, now: () => now, ...off }, port, enqueueRetention)
    const onJobs = workflowJobs({ db, now: () => now, ...on }, port, enqueueRetention)
    const job = { id: randomUUID(), attempt: 1, signal: new AbortController().signal }
    await offJobs[1].handler({}, job)
    expect(enqueueRetention).toHaveBeenCalledOnce()
    expect(wakes.has(due.id)).toBe(true)
    expect(wakes.has(future.id)).toBe(false)
    await offJobs[0].handler({ runId: future.id }, job)
    expect(await saved(future.id)).toEqual(future)
    await offJobs[0].handler({ runId: due.id }, job)
    const skipped = await saved(due.id)

    now = now.add({ minutes: 20 })
    await onJobs[0].handler({ runId: due.id }, job)
    expect(await saved(due.id)).toEqual(skipped)
    expect(skipped).toMatchObject({ state: 'skipped', skip_reason: 'instance_disabled' })
    await onJobs[0].handler({ runId: future.id }, job)
    expect(await saved(future.id)).toMatchObject({ state: 'claimed', skip_reason: null })

    const disabled = await capture(on, initialTime, 33)
    if (!disabled) throw new Error('Expected capture before disabling the definition')
    await updateWorkflow(context, definition.id, {
      expectedRevision: definition.revision,
      enabled: false,
    })
    await onJobs[0].handler({ runId: disabled.id }, job)
    expect(await saved(disabled.id)).toMatchObject({
      state: 'skipped',
      skip_reason: 'workflow_disabled',
    })
    expect(
      await db
        .selectFrom('workflow_run_history')
        .select(['run_id', 'outcome', 'reason'])
        .where('workflow_id', '=', definition.id)
        .orderBy('reason')
        .execute(),
    ).toEqual([
      { run_id: due.id, outcome: 'skipped', reason: 'instance_disabled' },
      { run_id: disabled.id, outcome: 'skipped', reason: 'workflow_disabled' },
    ])
    const audit = await db
      .selectFrom('audit_events')
      .select('details')
      .where('organization_id', '=', organizationId)
      .where('target_id', '=', definition.id)
      .where('action', '=', 'workflow.run_skipped')
      .execute()
    expect(audit).toHaveLength(2)
    expect(audit).toEqual(
      expect.arrayContaining(
        ['instance_disabled', 'workflow_disabled'].map((reason) => ({
          details: { revision: definition.revision, trigger: 'booking.created', reason },
        })),
      ),
    )
  })
})
