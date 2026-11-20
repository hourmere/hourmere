// Operator-off transport behavior. Recovery operations still validate input and preserve
// opaque ID refusals. The other operations stop after caller and scope checks.
import { randomUUID } from 'node:crypto'
import '@hono/zod-openapi'
import type { ApiKeyScope, CallerResolver, Principal } from '@hourmere/auth'
import { createDb, createPool } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling/errors'
import { workflowsEnabled } from '@hourmere/workflows'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { type McpCaller, runTool, type Tool } from './mcp/tools.ts'
import { workflowTools } from './mcp/workflows.ts'
import { workflowRoutes } from './routes/workflows.ts'
import { workflowFeatureTools } from './workflows.ts'

const URL = 'http://localhost:4187'
const user = { id: randomUUID(), name: 'Workflow off', email: 'workflow-off@example.test' }
const organization = {
  id: randomUUID(),
  name: 'Workflow off',
  slug: 'workflow-off',
  personal: true,
}
const key = (apiKeyScope: ApiKeyScope): McpCaller => ({
  kind: 'api_key',
  apiKeyScope,
  apiKeyId: randomUUID(),
  user,
  organization,
})
const callers: Record<string, Principal> = {
  'Bearer hm_full': key('full'),
  'Bearer hm_read': key('read'),
  'Bearer hm_bookings': key('bookings'),
  'Bearer oauth': {
    kind: 'oauth',
    user,
    organization,
    oauthConsentId: randomUUID(),
    clientId: 'workflow-off',
    scopes: ['mcp:tools'],
  },
  session: { kind: 'session', sessionId: randomUUID(), user, organization },
}
const resolveCaller: CallerResolver = async (headers) => {
  const principal =
    callers[headers.get('authorization') ?? (headers.get('cookie') ? 'session' : '')]
  return principal
    ? { ok: true, principal, setCookie: [] }
    : { ok: false, error: 'unauthorized', setCookie: [] }
}
const disabled = { error: 'workflows_disabled' }
const denial = {
  error: 'insufficient_scope',
  message: 'This API key does not allow this operation.',
}
const guardedTools = ['create_workflow', 'update_workflow', 'preview_workflow']
const fullOnlyTools = [...guardedTools, 'delete_workflow']

/** An app whose database refuses every connection: a lookup would answer 500. */
function appWith(tools?: readonly Tool[]) {
  const db = createDb(createPool('postgres://workflows-off@127.0.0.1:9/workflows-off'))
  const settings = { workflowsEnabled: false }
  const app = createApp({
    publicUrl: URL,
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller,
    routes: [workflowRoutes({ db, ...settings })],
    mcp: mcpEndpoint({
      tools: tools ?? workflowTools({ db, ...settings }),
      oauth: {
        resolve: async () => ({
          ok: true,
          principal: callers['Bearer oauth'] as Extract<Principal, { kind: 'oauth' }>,
        }),
        handler: async () => new Response(null, { status: 404 }),
      },
    }),
  })
  return { app, db }
}
const textOf = (result: { content: { type: string; text?: string }[] }) =>
  JSON.parse(result.content[0]?.text ?? '')

async function rpc(app: ReturnType<typeof appWith>['app'], authorization: string, body: object) {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
  })
  const text = await res.text()
  const data = text.split('\n').find((line) => line.startsWith('data: '))
  return JSON.parse(data ? data.slice(6) : text)
}

describe('workflow REST operations while off', () => {
  it('publishes the operator switch and recovery operations in OpenAPI and MCP', async () => {
    const { app, db } = appWith()
    try {
      const response = await app.request('/api/v1/openapi.json')
      expect(response.status).toBe(200)
      const { paths } = (await response.json()) as {
        paths: Record<string, Record<string, { description: string }>>
      }
      const tools = workflowTools({ db, workflowsEnabled: true })
      for (const [path, method, name] of [
        ['/api/v1/workflows', 'post', 'create_workflow'],
        ['/api/v1/workflows/{id}', 'patch', 'update_workflow'],
        ['/api/v1/workflows/{id}', 'delete', 'delete_workflow'],
        ['/api/v1/workflows/preview', 'post', 'preview_workflow'],
        ['/api/v1/workflows', 'get', 'list_workflows'],
        ['/api/v1/workflows/{id}', 'get', 'get_workflow'],
        ['/api/v1/workflows/{id}/runs', 'get', 'list_workflow_runs'],
      ] as const) {
        for (const description of [
          paths[path]?.[method]?.description,
          tools.find((tool) => tool.name === name)?.description,
        ]) {
          expect(description, name).toContain('WORKFLOWS_ENABLED=true')
          expect(description, name).toContain(
            'creation, preview, enabling and other edits return 404 workflows_disabled',
          )
          expect(description, name).toContain('reads, disable-only updates and deletion')
        }
      }
    } finally {
      await db.destroy()
    }
  })

  it('preserves recovery validation and opaque IDs after caller and scope checks', async () => {
    const { app, db } = appWith()
    try {
      for (const [url, status, error] of [
        ['/api/v1/workflows', 400, 'invalid_request'],
        [
          `/api/v1/workflows?ownerKind=personal&ownerId=${user.id}&cursor=abc`,
          400,
          'invalid_cursor',
        ],
        ['/api/v1/workflows/not-a-uuid', 404, 'workflow_not_found'],
        [`/api/v1/workflows/${'9'.repeat(300)}`, 404, 'workflow_not_found'],
        ['/api/v1/workflows/not-a-uuid/runs', 404, 'workflow_not_found'],
        ['/api/v1/workflows/not-a-uuid/runs?limit=0', 400, 'invalid_request'],
      ] as const) {
        for (const headers of [
          { authorization: 'Bearer hm_full' },
          { authorization: 'Bearer hm_read' },
          { cookie: 'session=valid' },
        ]) {
          const res = await app.request(url, { headers })
          expect(res.status, `${JSON.stringify(headers)} ${url}`).toBe(status)
          expect(await res.json()).toMatchObject({ error })
          expect(res.headers.get('cache-control')).toBe('no-store')
        }
        const bookings = await app.request(url, {
          headers: { authorization: 'Bearer hm_bookings' },
        })
        expect(bookings.status, url).toBe(403)
        expect(await bookings.json()).toEqual(denial)
        for (const headers of [{}, { authorization: 'Bearer hm_unknown' }]) {
          const res = await app.request(url, { headers })
          expect(res.status, url).toBe(401)
          expect(await res.json()).toMatchObject({ error: 'unauthorized' })
        }
      }
    } finally {
      await db.destroy()
    }
  })
})

describe('workflow POST, PATCH and DELETE routes while off', () => {
  it('checks caller and write scope before allowing recovery writes or blocking other changes', async () => {
    const { app, db } = appWith()
    try {
      const methodCases = [
        ['POST', '/api/v1/workflows', '{}', 'workflows_disabled'],
        ['POST', '/api/v1/workflows/preview', '{}', 'workflows_disabled'],
        ['PATCH', '/api/v1/workflows/not-a-uuid', '{}', 'workflows_disabled'],
        [
          'PATCH',
          '/api/v1/workflows/not-a-uuid',
          '{"expectedRevision":1,"enabled":true}',
          'workflows_disabled',
        ],
        [
          'PATCH',
          '/api/v1/workflows/not-a-uuid',
          '{"expectedRevision":1,"enabled":false}',
          'workflow_not_found',
        ],
        ['DELETE', '/api/v1/workflows/not-a-uuid', '{"expectedRevision":1}', 'workflow_not_found'],
      ] as const
      for (const [method, path, input, error] of methodCases) {
        for (const [token, status, body] of [
          ['hm_full', 404, { error }],
          ['hm_read', 403, denial],
          ['hm_bookings', 403, denial],
          ['hm_unknown', 401, { error: 'unauthorized' }],
        ] as const) {
          const response = await app.request(path, {
            method,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: input,
          })
          expect(response.status, `${token} ${method} ${path}`).toBe(status)
          expect(await response.json()).toMatchObject(body)
        }
      }
    } finally {
      await db.destroy()
    }
  })
})

describe('workflow MCP tools while off', () => {
  it('stay in the catalog, marked unavailable by the workflow guard', () => {
    const tools = workflowTools({ db: {} as never })
    expect(tools.map(({ name }) => name)).toEqual([
      'create_workflow',
      'update_workflow',
      'delete_workflow',
      'preview_workflow',
      'list_workflows',
      'get_workflow',
      'list_workflow_runs',
    ])
    for (const tool of tools) {
      expect(tool.requireEnabled).toBeUndefined()
      expect(tool.annotations).toEqual({
        readOnlyHint: !['create_workflow', 'update_workflow', 'delete_workflow'].includes(
          tool.name,
        ),
        destructiveHint: tool.name === 'delete_workflow',
        idempotentHint: tool.name !== 'update_workflow',
        openWorldHint: false,
      })
      const check = () => tool.requireAvailable?.()
      if (guardedTools.includes(tool.name))
        expect(check).toThrow(
          expect.objectContaining({ code: 'workflows_disabled', kind: 'not_found' }),
        )
      else expect(check).not.toThrow()
    }
    expect(workflowsEnabled({ workflowsEnabled: false })).toBe(false)
  })

  it('are hidden from discovery and apply operator-off rules to direct calls', async () => {
    const { app, db } = appWith()
    try {
      for (const authorization of ['Bearer hm_full', 'Bearer hm_read', 'Bearer oauth']) {
        const listed = await rpc(app, authorization, { method: 'tools/list', params: {} })
        expect(listed.result.tools).toEqual([])
        for (const [name, args, error] of [
          ['create_workflow', {}, 'workflows_disabled'],
          ['update_workflow', {}, 'workflows_disabled'],
          [
            'update_workflow',
            { id: 'invalid', expectedRevision: 1, enabled: false },
            'workflow_not_found',
          ],
          ['delete_workflow', { id: 'invalid', expectedRevision: 1 }, 'workflow_not_found'],
          ['preview_workflow', { example: { bookingId: randomUUID() } }, 'workflows_disabled'],
          ['list_workflows', {}, 'invalid_request'],
          [
            'list_workflows',
            { owner: { kind: 'personal', id: user.id }, cursor: 'abc' },
            'invalid_cursor',
          ],
          ['list_workflows', 'not an object', 'invalid_request'],
          ['get_workflow', { id: 'invalid' }, 'workflow_not_found'],
          ['get_workflow', { id: 'x', extra: '\u0000' }, 'invalid_request'],
          ['list_workflow_runs', { id: 'invalid' }, 'workflow_not_found'],
          ['list_workflow_runs', { id: 'x', cursor: '\u0000', limit: 0 }, 'invalid_request'],
        ] as const) {
          const called = await rpc(app, authorization, {
            method: 'tools/call',
            params: { name, arguments: args },
          })
          if (typeof args === 'string') {
            // The SDK refuses a malformed envelope before any tool is looked up.
            expect(called.error).toMatchObject({ code: -32602 })
            continue
          }
          expect(called.result.isError, `${authorization} ${name}`).toBe(true)
          expect(textOf(called.result)).toMatchObject(
            fullOnlyTools.includes(name) && authorization === 'Bearer hm_read' ? denial : { error },
          )
        }
      }
      // The API-key scope check keeps its precedence.
      for (const name of [
        ...fullOnlyTools,
        'list_workflows',
        'get_workflow',
        'list_workflow_runs',
      ]) {
        const called = await rpc(app, 'Bearer hm_bookings', {
          method: 'tools/call',
          params: { name, arguments: { id: 'x' } },
        })
        expect(textOf(called.result)).toEqual(denial)
      }
    } finally {
      await db.destroy()
    }
  })

  it('checks availability after the scope and before the arguments, in runTool itself', async () => {
    for (const original of workflowTools({ db: {} as never }).filter(({ name }) =>
      guardedTools.includes(name),
    )) {
      const run = vi.fn(async () => ({}))
      const tool = { ...original, run } as Tool
      for (const args of [{}, { id: randomUUID() }, { owner: '\u0000' }, null]) {
        const read = await runTool(tool, args, { caller: key('read'), rateLimit: () => {} }, () => {
          throw new Error('nothing is logged')
        })
        expect(textOf(read as never)).toEqual(fullOnlyTools.includes(tool.name) ? denial : disabled)
        const bookings = await runTool(
          tool,
          args,
          { caller: key('bookings'), rateLimit: () => {} },
          () => {},
        )
        expect(textOf(bookings as never)).toEqual(denial)
      }
      expect(run).not.toHaveBeenCalled()
    }
  })

  it('treat an asynchronous or failing availability check as unavailable', async () => {
    const probe = (name: string, requireAvailable: () => unknown): Tool =>
      ({
        ...(workflowTools({ db: {} as never }).find(
          (tool) => tool.name === 'list_workflows',
        ) as Tool),
        name,
        discoverable: undefined,
        requireAvailable,
        run: vi.fn(async () => ({ data: [], nextCursor: null })),
      }) as Tool
    const log = vi.fn()
    const asynchronous = probe('probe_async', async () => {})
    const result = await runTool(
      asynchronous,
      {},
      { caller: key('full'), rateLimit: () => {} },
      log,
    )
    expect(textOf(result as never)).toEqual({ error: 'internal_error' })
    expect(log).toHaveBeenCalledTimes(1)
    const domain = probe('probe_domain', () => {
      throw new DomainError('not_found', 'probe_disabled')
    })
    expect(
      textOf(
        (await runTool(domain, {}, { caller: key('full'), rateLimit: () => {} }, log)) as never,
      ),
    ).toEqual({ error: 'probe_disabled' })
    const available = probe('probe_available', () => undefined)
    const ran = await runTool(
      available,
      { owner: { kind: 'personal', id: user.id } },
      { caller: key('full'), rateLimit: () => {} },
      log,
    )
    expect(ran.isError).toBeFalsy()
    expect(ran.structuredContent).toEqual({ data: [], nextCursor: null })
    const { app, db } = appWith([asynchronous, domain, available])
    try {
      const listed = await rpc(app, 'Bearer hm_full', { method: 'tools/list', params: {} })
      // Listed only while the check answers synchronously without throwing.
      expect(listed.result.tools.map(({ name }: { name: string }) => name)).toEqual([
        'probe_available',
      ])
    } finally {
      await db.destroy()
    }
  })

  it('wraps only the given tools, leaving their behavior otherwise unchanged', () => {
    const base = workflowTools({ db: {} as never })[0] as Tool
    const plain = {
      ...base,
      name: 'plain_tool',
      requireAvailable: undefined,
      discoverable: undefined,
    }
    const [wrapped] = workflowFeatureTools([plain], { workflowsEnabled: true })
    expect(wrapped).not.toBe(plain)
    expect({ ...wrapped, requireAvailable: undefined, discoverable: undefined }).toEqual(plain)
    expect(plain.requireAvailable).toBeUndefined()
  })
})

describe('workflow CLI commands while off', () => {
  it.each([
    [
      'list',
      'list_workflows',
      { owner: { kind: 'team', id: organization.id }, cursor: 'abc' },
      'invalid_cursor',
    ],
    ['get', 'get_workflow', { id: 'invalid' }, 'workflow_not_found'],
    ['runs', 'list_workflow_runs', { id: 'invalid' }, 'workflow_not_found'],
    ['create', 'create_workflow', {}, 'workflows_disabled'],
    [
      'update',
      'update_workflow',
      { id: 'invalid', expectedRevision: 1, enabled: true },
      'workflows_disabled',
    ],
    ['delete', 'delete_workflow', { id: 'invalid', expectedRevision: 1 }, 'workflow_not_found'],
    ['preview', 'preview_workflow', {}, 'workflows_disabled'],
  ] as const)(
    'workflows %s calls %s and reports the operator-off outcome',
    async (command, tool, input, error) => {
      const { app, db } = appWith()
      try {
        let stdout = ''
        let stderr = ''
        const fetcher = vi.fn<typeof fetch>(async (request, init) => app.request(request, init))
        const code = await runCli({
          argv: ['workflows', command, '--input', '-'],
          env: { HOURMERE_URL: URL, HOURMERE_API_KEY: 'hm_full' },
          stdin: (async function* () {
            yield JSON.stringify(input)
          })(),
          stdout: (text) => {
            stdout += text
          },
          stderr: (text) => {
            stderr += text
          },
          fetch: fetcher,
        })
        expect(fetcher).toHaveBeenCalledTimes(1)
        const sent = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
        expect(sent.params).toMatchObject({ name: tool, arguments: input })
        expect(code).toBe(1)
        expect(stdout).toBe('')
        expect(JSON.parse(stderr)).toMatchObject({ error, outcomeMayBeUnknown: true })
      } finally {
        await db.destroy()
      }
    },
  )

  it.each([['workflows'], ['workflow', 'list']])(
    'refuses %j as an unknown command without calling the server',
    async (...argv) => {
      const fetcher = vi.fn<typeof fetch>()
      let stderr = ''
      const code = await runCli({
        argv,
        env: { HOURMERE_URL: URL, HOURMERE_API_KEY: 'hm_full' },
        stdin: (async function* () {})(),
        stdout: () => {},
        stderr: (text) => {
          stderr += text
        },
        fetch: fetcher,
      })
      expect(code).toBe(1)
      expect(JSON.parse(stderr)).toEqual({ error: 'invalid_command' })
      expect(fetcher).not.toHaveBeenCalled()
    },
  )
})
