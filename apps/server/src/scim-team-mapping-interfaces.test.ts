import { randomUUID } from 'node:crypto'
import {
  type ApiKeyScope,
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
  type Principal,
  SCIM_MAPPING_SCOPE_OPERATIONS,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apiKeyScopeParityErrors } from '../../../scripts/api-key-scope-parity.ts'
import { restOperations } from '../../../scripts/interface-parity.ts'
import { cliCommands, HELP, runCli } from '../../../tools/cli/src/cli.ts'
import { callTool } from '../../../tools/cli/src/client.ts'
import { type AppDeps, createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { whoamiTool } from './mcp/whoami.ts'
import { openApiRouteInventory } from './openapi-document.ts'
import { instanceRoutes } from './routes/instance.ts'
import { SCIM_TEAM_MAPPINGS_PATH as path } from './routes/scim-team-mappings.ts'
import { scimDiscovery } from './scim-discovery.ts'
import type { ScimTeamMappingApprovalInput } from './scim-team-hierarchy.ts'
import {
  deliverMailboxProof,
  MAILBOX_PROOF_CONSUME_PATH,
  MAILBOX_PROOF_SEND_PATH,
  MailboxProofEmailPayload,
  mailboxProofRoutes,
} from './sso-mailbox-proof.ts'

const publicUrl = 'https://hourmere.example.test'
const tools = ['create_scim_team_mapping', 'delete_scim_team_mapping'] as const
const key = 'hm_mapping_synthetic'
const denied = { error: 'scim_mapping_access_denied' }
const capabilities = { ssoOidcEnabled: false, ssoSamlEnabled: false }
type App = ReturnType<typeof createApp>

function headers(auth: string) {
  return new Headers({ authorization: `Bearer ${auth}`, 'content-type': 'application/json' })
}

const appFetch =
  (app: App): typeof fetch =>
  async (input, init) =>
    app.request(input, init)

const rpc = async (app: App, method: string, params?: object) => {
  const init = headers(key)
  init.set('accept', 'application/json, text/event-stream')
  const response = await app.request(`${publicUrl}/mcp`, {
    method: 'POST',
    headers: init,
    body: JSON.stringify({ jsonrpc: '2.0', method, id: 1, params }),
  })
  const body = await response.text()
  const data = response.headers.get('content-type')?.startsWith('text/event-stream')
    ? body
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6)
    : body
  return JSON.parse(data ?? 'null')
}

async function cli(
  app: App,
  command: string[],
  input: object = {},
  scimResourcesEnabled?: boolean,
  fetcher = appFetch(app),
  auth = key,
) {
  let stdout = ''
  let stderr = ''
  const exit = await runCli({
    argv: command,
    env: {
      HOURMERE_API_KEY: auth,
      HOURMERE_URL: publicUrl,
      SCIM_PROVISIONING_ENABLED: 'true',
    },
    stdin: (async function* () {
      yield JSON.stringify(input)
    })(),
    stdout: (value) => {
      stdout += value
    },
    stderr: (value) => {
      stderr += value
    },
    fetch: fetcher,
    ...(scimResourcesEnabled === undefined ? {} : { scimResourcesEnabled }),
  })
  return { exit, stdout, stderr }
}

it('keeps every management interface unreachable with the production resource switch off', async () => {
  const principal: Principal = {
    kind: 'api_key',
    apiKeyScope: 'full',
    apiKeyId: randomUUID(),
    user: { id: randomUUID(), email: 'owner@example.test', name: 'Owner' },
    organization: { id: randomUUID(), name: 'Team', slug: 'team', personal: false },
  }
  const db = {} as Db
  const app = (scim?: AppDeps['scim']) =>
    createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: true, principal, setCookie: [] }),
      publicUrl,
      scim,
      routes: [instanceRoutes({ publicUrl, socialProviders: {} })],
      mcp: mcpEndpoint({ tools: [whoamiTool] }),
    })
  const baseline = app()
  const production = app({ db, enabled: true })
  for (const [method, url] of [
    ['GET', path],
    ['POST', path],
    ['DELETE', `${path}/${randomUUID()}`],
    ['POST', `${path}/consent`],
  ] as const) {
    const result = await production.request(url, { method, headers: headers(key) })
    expect(result.status).toBe(404)
    expect(await result.json()).toEqual({ error: 'not_found' })
  }
  const openApi = async (server: App) =>
    (await (await server.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, unknown>
      components: { schemas: { Instance: { properties: unknown } } }
    }
  const published = await openApi(production)
  expect(published).toEqual(await openApi(baseline))
  expect(Object.keys(published.paths).filter((route) => route.startsWith(path))).toEqual([])
  expect(published.components.schemas.Instance.properties).not.toHaveProperty(
    'scimResourcesEnabled',
  )
  const listed = await rpc(production, 'tools/list')
  expect(listed).toEqual(await rpc(baseline, 'tools/list'))
  expect(listed.result.tools.map(({ name }: { name: string }) => name)).toEqual(['whoami'])
  for (const name of tools) {
    const params = { name, arguments: { intentId: randomUUID() } }
    const result = await rpc(production, 'tools/call', params)
    expect(result).toMatchObject({ error: { code: -32602 } })
    expect(result).toEqual(await rpc(baseline, 'tools/call', params))
  }
  const fetcher = vi.fn(appFetch(production))
  expect(await cli(production, ['--help'], {}, false, fetcher)).toMatchObject({ stdout: HELP })
  expect(HELP).not.toContain('scim-team-mappings')
  for (const command of ['create', 'delete']) {
    const result = await cli(production, ['scim-team-mappings', command], {}, false, fetcher)
    expect(result).toEqual({
      exit: 1,
      stdout: '',
      stderr: `${JSON.stringify({ error: 'invalid_command' }, null, 2)}\n`,
    })
  }
  expect(fetcher).not.toHaveBeenCalled()
})

it('classifies the actual resource-test REST routes, MCP tools and CLI commands with equivalent scopes', async () => {
  const { document, routes, scimMappingTools } = await openApiRouteInventory({
    scimResourcesEnabled: true,
  })
  expect(
    apiKeyScopeParityErrors(
      {
        rest: restOperations(document).filter((route) => route.path.startsWith(path)),
        registeredRest: routes.filter((route) => route.path.startsWith(path)),
        mcp: scimMappingTools,
        cli: Object.fromEntries(
          Object.entries(cliCommands(true)).filter(([command]) =>
            command.startsWith('scim-team-mappings '),
          ),
        ),
      },
      SCIM_MAPPING_SCOPE_OPERATIONS,
    ),
  ).toEqual([])
})

const databaseUrl = process.env.DATABASE_URL
const secret = 'synthetic-mapping-interface-proof-secret-000000000'
const signup = { mode: 'open', allowedDomains: [] } as const

describe.skipIf(!databaseUrl)('mapping administration transports', () => {
  let owned: TestDatabase
  let db: Db
  let pool: ReturnType<typeof createAuthPool>
  let auth: ReturnType<typeof createAuth>
  let app: App
  const delivery = new Map<string, string>()

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'scim_mapping_api' })
    db = createDb(owned.pool)
    pool = createAuthPool(owned.url, signup)
    auth = createAuth({
      db,
      pool,
      signup,
      secret,
      baseURL: publicUrl,
      scimResourcesEnabled: true,
      mailer: { send: async () => expect.unreachable('Only the test proof mailer sends') },
    })
    app = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: auth.handler,
      resolveCaller: createCallerResolver({ auth, db }),
      routes: [instanceRoutes({ publicUrl, socialProviders: {} })],
      mcp: mcpEndpoint({ tools: [whoamiTool] }),
      scim: {
        db,
        enabled: true,
        resources: scimDiscovery,
        mappingNotices: { enqueue: async () => randomUUID() },
      },
      ssoTeamReads: { db, capabilities },
      ssoMailboxProof: mailboxProofRoutes({
        db,
        capabilities,
        queue: {
          async enqueue(_name, raw) {
            const payload = MailboxProofEmailPayload.parse(raw)
            await deliverMailboxProof(
              {
                db,
                capabilities,
                secret,
                publicUrl,
                scimMappingConsentEnabled: true,
                mailer: {
                  send: async (message) => {
                    const match = /&token=([A-Za-z0-9_-]+)/.exec(message.text)
                    if (!match?.[1]) throw new Error('Expected a mailbox token in fake mail')
                    delivery.set(payload.attemptId, match[1])
                  },
                },
              },
              payload,
            )
            return randomUUID()
          },
        },
      }),
    })
  })

  afterAll(async () => {
    try {
      await pool?.end()
    } finally {
      await owned?.drop()
    }
  })

  async function team() {
    const owner = await createTestUser(db)
    const admin = await createTestUser(db)
    const { id } = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
    ])
    const { id: connectionId } = await db
      .insertInto('scim_connections')
      .values({ organization_id: id })
      .returning('id')
      .executeTakeFirstOrThrow()
    return { id, owner, admin, connectionId }
  }

  async function browser(userId: string, organizationId: string) {
    const { cookie } = await db.transaction().execute((trx) =>
      createBrowserSession(
        trx,
        { publicUrl, secret },
        {
          userId,
          organizationId,
          now: Temporal.Now.instant().toString(),
          headers: new Headers(),
        },
      ),
    )
    const cookies = [cookie.split(';')[0]]
    return async (method: string, url: string, input?: object) => {
      const response = await app.request(url, {
        method,
        headers: {
          cookie: cookies.join('; '),
          origin: publicUrl,
          'content-type': 'application/json',
          'x-expected-organization-id': organizationId,
        },
        ...(input && { body: JSON.stringify(input) }),
      })
      const binding = response.headers
        .getSetCookie()
        .find((value) => value.startsWith('__Host-hourmere.sso_binding='))
      if (binding) cookies[1] = binding.split(';')[0]
      return { status: response.status, body: await response.json() }
    }
  }

  async function approve(
    actor: Awaited<ReturnType<typeof browser>>,
    input: ScimTeamMappingApprovalInput,
  ) {
    const challenge = await actor('POST', `${path}/consent`, input)
    expect(challenge).toMatchObject({
      status: 403,
      body: { error: 'sso_reauthentication_required', proofMethods: ['mailbox'] },
    })
    const { attemptId } = challenge.body as { attemptId: string }
    expect(await actor('POST', MAILBOX_PROOF_SEND_PATH, { attemptId })).toEqual({
      status: 202,
      body: { status: 'queued' },
    })
    const token = delivery.get(attemptId)
    delivery.delete(attemptId)
    if (!token) throw new Error('Expected fake proof delivery')
    const consumed = await actor('POST', MAILBOX_PROOF_CONSUME_PATH, { attemptId, token })
    expect(consumed).toEqual({ status: 200, body: { status: 'proven' } })
    expect(await actor('POST', `${path}/consent`, { ...input, proofAttemptId: attemptId })).toEqual(
      {
        status: 200,
        body: { intentId: input.intentId },
      },
    )
  }

  async function apiKey(teamId: string, userId: string, scope: ApiKeyScope = 'full') {
    const result = await auth.api.createApiKey({
      body: { userId, metadata: { organizationId: teamId, scope } },
    })
    return result.key
  }

  const call = (apiKeyValue: string, tool: string, input: Record<string, unknown>) =>
    callTool({
      url: new URL('/mcp', publicUrl),
      key: apiKeyValue,
      input,
      tool,
      fetch: appFetch(app),
    })

  it('requires both browser approvals, shares them across REST/MCP/CLI and projects safe metadata', async () => {
    const parent = await team()
    const child = await team()
    const outsider = await team()
    const ownParent = await browser(parent.owner.id, parent.id)
    const ownChild = await browser(child.owner.id, child.id)
    const admin = await browser(parent.admin.id, parent.id)
    const foreign = await browser(outsider.owner.id, outsider.id)
    const parentKey = await apiKey(parent.id, parent.owner.id)
    const readKey = await apiKey(parent.id, parent.owner.id, 'read')
    const foreignKey = await apiKey(outsider.id, outsider.owner.id)
    const instance = await app.request('/api/v1/instance')
    expect(await instance.json()).toMatchObject({ scimResourcesEnabled: true })
    const scope = {
      parentOrganizationId: parent.id,
      childOrganizationId: child.id,
      connectionId: parent.connectionId,
    }
    const link = {
      ...scope,
      intentId: randomUUID(),
      action: 'link' as const,
      allowGroupRetirement: true as const,
      externalId: 'External-Group',
      linkGeneration: 0,
    }
    const request = { intentId: link.intentId }
    expect(await admin('POST', `${path}/consent`, link)).toEqual({ status: 403, body: denied })
    const consentWithKey = await app.request(`${path}/consent`, {
      method: 'POST',
      headers: headers(parentKey),
      body: JSON.stringify(link),
    })
    expect(consentWithKey.status).toBe(403)
    expect(await consentWithKey.json()).toEqual(denied)

    await approve(ownParent, link)
    expect(await ownParent('POST', path, request)).toEqual({ status: 403, body: denied })
    await expect(call(parentKey, tools[0], request)).rejects.toMatchObject({ code: denied.error })
    const unapproved = await cli(
      app,
      ['scim-team-mappings', 'create', '--input', '-'],
      request,
      true,
      appFetch(app),
      parentKey,
    )
    expect(unapproved).toMatchObject({ exit: 1, stdout: '' })
    expect(JSON.parse(unapproved.stderr)).toMatchObject(denied)
    await approve(ownChild, link)
    await expect(call(readKey, tools[0], request)).rejects.toMatchObject({
      code: 'insufficient_scope',
    })
    await expect(call(foreignKey, tools[0], request)).rejects.toMatchObject({ code: denied.error })
    const linked = await ownParent('POST', path, request)
    expect(linked).toEqual({ status: 201, body: { mappingId: expect.any(String), generation: 1 } })
    const { mappingId } = linked.body as { mappingId: string }
    expect(await ownParent('POST', path, request)).toEqual({ status: 403, body: denied })
    const mappings = [{ id: mappingId, ...scope, externalId: link.externalId, state: 'pending' }]
    expect(await ownParent('GET', path)).toEqual({
      status: 200,
      body: { mappings, connectionId: parent.connectionId, linkGeneration: 0 },
    })
    expect(await ownChild('GET', path)).toEqual({
      status: 200,
      body: { mappings, connectionId: child.connectionId, linkGeneration: 1 },
    })
    expect(await admin('GET', path)).toEqual({
      status: 200,
      body: { mappings, connectionId: null, linkGeneration: null },
    })
    expect(await foreign('GET', path)).toEqual({
      status: 200,
      body: { mappings: [], connectionId: outsider.connectionId, linkGeneration: 0 },
    })
    const unlink = { ...scope, intentId: randomUUID(), action: 'unlink' as const, mappingId }
    await approve(ownParent, unlink)
    await approve(ownChild, unlink)
    const unlinkRequest = { intentId: unlink.intentId }
    const deletePath = `${path}/${mappingId}`
    expect(await foreign('DELETE', deletePath, unlinkRequest)).toEqual(
      await foreign('DELETE', `${path}/${randomUUID()}`, unlinkRequest),
    )
    expect(await ownChild('DELETE', `${path}/${randomUUID()}`, unlinkRequest)).toEqual({
      status: 403,
      body: denied,
    })
    await expect(call(parentKey, tools[0], unlinkRequest)).rejects.toMatchObject({
      code: denied.error,
    })
    expect(
      await cli(
        app,
        ['scim-team-mappings', 'delete', '--input', '-'],
        { id: mappingId, ...unlinkRequest },
        true,
        appFetch(app),
        parentKey,
      ),
    ).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ mappingId, generation: 2 }, null, 2)}\n`,
      stderr: '',
    })
    expect(await ownChild('DELETE', deletePath, unlinkRequest)).toEqual({
      status: 403,
      body: denied,
    })
    expect(await ownChild('GET', path)).toEqual({
      status: 200,
      body: { mappings: [], connectionId: child.connectionId, linkGeneration: 2 },
    })
  })

  it('finalizes a CLI link and REST unlink using the same browser consent', async () => {
    const parent = await team()
    const child = await team()
    const parentOwner = await browser(parent.owner.id, parent.id)
    const childOwner = await browser(child.owner.id, child.id)
    const childKey = await apiKey(child.id, child.owner.id)
    const scope = {
      parentOrganizationId: parent.id,
      childOrganizationId: child.id,
      connectionId: parent.connectionId,
    }
    const link = {
      ...scope,
      intentId: randomUUID(),
      action: 'link' as const,
      allowGroupRetirement: true as const,
      externalId: 'Another-Group',
      linkGeneration: 0,
    }
    await approve(parentOwner, link)
    await approve(childOwner, link)
    const linked = await cli(
      app,
      ['scim-team-mappings', 'create', '--input', '-'],
      { intentId: link.intentId },
      true,
      appFetch(app),
      childKey,
    )
    expect(linked).toMatchObject({ exit: 0, stderr: '' })
    const { mappingId, generation } = JSON.parse(linked.stdout)
    expect(generation).toBe(1)
    const unlink = { ...scope, intentId: randomUUID(), action: 'unlink' as const, mappingId }
    await approve(parentOwner, unlink)
    await approve(childOwner, unlink)
    expect(
      await parentOwner('DELETE', `${path}/${mappingId}`, { intentId: unlink.intentId }),
    ).toEqual({
      status: 200,
      body: { mappingId, generation: 2 },
    })
  })
})
