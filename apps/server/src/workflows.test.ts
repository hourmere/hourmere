// The transports of booking workflows while they are off (docs/workflows.md, "Rollout and
// limitations"): REST answers 404 workflows_disabled after the caller and its API-key scope
// and before input validation or any lookup; MCP leaves the tools out of tools/list and
// answers a direct call after the scope check and before the arguments are read; the CLI
// reports the same code. No database is reachable here, so any lookup would fail loudly.
import { randomUUID } from 'node:crypto'
import type { ApiKeyScope, CallerResolver, Principal } from '@hourmere/auth'
import { createDb, createPool } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling/errors'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { type McpCaller, runTool, type Tool } from './mcp/tools.ts'
import { workflowTools } from './mcp/workflows.ts'
import { workflowRoutes } from './routes/workflows.ts'
import { workflowFeatureTools, workflowsAvailable } from './workflows.ts'

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

/** An app whose database refuses every connection: a lookup would answer 500. */
function appWith(tools?: readonly Tool[]) {
  const db = createDb(createPool('postgres://workflows-off@127.0.0.1:9/workflows-off'))
  const app = createApp({
    publicUrl: URL,
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller,
    routes: [workflowRoutes({ db })],
    mcp: mcpEndpoint({
      tools: tools ?? workflowTools({ db }),
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
  it('answer 404 workflows_disabled after the caller and scope, before validation', async () => {
    const { app, db } = appWith()
    try {
      const urls = [
        '/api/v1/workflows',
        `/api/v1/workflows?ownerKind=personal&ownerId=${user.id}`,
        `/api/v1/workflows?ownerKind=team&ownerId=${organization.id}&limit=100&cursor=abc`,
        '/api/v1/workflows?ownerKind=robot&ownerId=1&limit=-1&extra=%00',
        `/api/v1/workflows/${randomUUID()}`,
        '/api/v1/workflows/not-a-uuid',
        `/api/v1/workflows/${'9'.repeat(300)}`,
      ]
      for (const url of urls) {
        for (const headers of [
          { authorization: 'Bearer hm_full' },
          { authorization: 'Bearer hm_read' },
          { cookie: 'session=valid' },
        ]) {
          const res = await app.request(url, { headers })
          expect(res.status, `${JSON.stringify(headers)} ${url}`).toBe(404)
          expect(await res.json()).toEqual(disabled)
          expect(res.headers.get('cache-control')).toBe('no-store')
        }
        const bookings = await app.request(url, {
          headers: { authorization: 'Bearer hm_bookings' },
        })
        expect(bookings.status, url).toBe(403)
        expect(await bookings.json()).toEqual(denial)
        // Missing or unknown credentials are refused before the switch.
        for (const headers of [{}, { authorization: 'Bearer hm_unknown' }]) {
          const res = await app.request(url, { headers })
          expect(res.status, url).toBe(401)
          expect(await res.json()).toEqual({ error: 'unauthorized' })
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
    expect(tools.map(({ name }) => name)).toEqual(['list_workflows', 'get_workflow'])
    for (const tool of tools) {
      expect(tool.requireEnabled).toBeUndefined()
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      })
      expect(() => tool.requireAvailable?.()).toThrow(
        expect.objectContaining({ code: 'workflows_disabled', kind: 'not_found' }),
      )
      expect(tool.description).toContain('workflows_disabled')
    }
    expect(workflowsAvailable()).toBe(false)
  })

  it('are left out of tools/list and refused on a direct call for every caller', async () => {
    const { app, db } = appWith()
    try {
      for (const authorization of ['Bearer hm_full', 'Bearer hm_read', 'Bearer oauth']) {
        const listed = await rpc(app, authorization, { method: 'tools/list', params: {} })
        expect(listed.result.tools).toEqual([])
        for (const [name, args] of [
          ['list_workflows', {}],
          ['list_workflows', { owner: { kind: 'personal', id: user.id } }],
          ['list_workflows', 'not an object'],
          ['get_workflow', { id: randomUUID() }],
          ['get_workflow', { id: 'x', extra: '\u0000' }],
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
          expect(textOf(called.result)).toEqual(disabled)
        }
      }
      // The API-key scope check keeps its precedence.
      for (const name of ['list_workflows', 'get_workflow']) {
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
    for (const original of workflowTools({ db: {} as never })) {
      const run = vi.fn(async () => ({}))
      const tool = { ...original, run } as Tool
      for (const args of [{}, { id: randomUUID() }, { owner: '\u0000' }, null]) {
        const read = await runTool(tool, args, { caller: key('read'), rateLimit: () => {} }, () => {
          throw new Error('nothing is logged')
        })
        expect(textOf(read as never)).toEqual(disabled)
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
        ...(workflowTools({ db: {} as never })[0] as Tool),
        name,
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
    const plain = { ...base, name: 'plain_tool', requireAvailable: undefined }
    const [wrapped] = workflowFeatureTools([plain])
    expect(wrapped).not.toBe(plain)
    expect({ ...wrapped, requireAvailable: undefined }).toEqual(plain)
    expect(plain.requireAvailable).toBeUndefined()
  })
})

describe('workflow CLI commands while off', () => {
  it.each([
    ['list', 'list_workflows', { owner: { kind: 'team', id: organization.id }, limit: 5 }],
    ['get', 'get_workflow', { id: randomUUID() }],
  ] as const)(
    'workflows %s calls %s and reports workflows_disabled',
    async (command, tool, input) => {
      const { app, db } = appWith()
      try {
        let stdout = ''
        let stderr = ''
        const fetcher = vi.fn<typeof fetch>(async (request, init) => app.request(request, init))
        const code = await runCli({
          argv: ['workflows', command, '--input', '-'],
          env: { HOURMERE_URL: URL, HOURMERE_API_KEY: 'hm_read' },
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
        expect(JSON.parse(stderr)).toEqual({ ...disabled, outcomeMayBeUnknown: true })
      } finally {
        await db.destroy()
      }
    },
  )

  it.each([['workflows'], ['workflows', 'create'], ['workflows', 'runs'], ['workflow', 'list']])(
    'refuses %j as an unknown command without calling the server',
    async (...argv) => {
      const fetcher = vi.fn<typeof fetch>()
      let stderr = ''
      const code = await runCli({
        argv,
        env: { HOURMERE_URL: URL, HOURMERE_API_KEY: 'hm_read' },
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
