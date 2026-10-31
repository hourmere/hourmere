// Scope decisions over the actual HTTP/JSON-RPC/CLI adapters. Probe handlers make every
// allowed dispatch observable and prove forbidden calls never enter a resource service.
import { randomUUID } from 'node:crypto'
import { z } from '@hono/zod-openapi'
import type { ApiKeyScope, CallerResolver, Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from '../../../../tools/cli/src/cli.ts'
import { createApp } from '../app.ts'
import { productTools } from '../server.ts'
import { mcpEndpoint } from './endpoint.ts'
import { type McpCaller, runTool, type Tool } from './tools.ts'

const URL = 'http://localhost:4186'
const scopes = ['full', 'read', 'bookings'] as const
const all = [
  'whoami',
  'find_available_slots',
  'create_booking',
  'reschedule_booking',
  'cancel_booking',
  'list_bookings',
  'retry_conference',
  'retry_calendar_copy',
  'get_profile',
  'list_event_types',
  'get_event_type',
  'list_schedules',
  'get_schedule',
  'list_calendar_connections',
  'list_conference_connections',
]
const writes = new Set([
  'create_booking',
  'reschedule_booking',
  'cancel_booking',
  'retry_conference',
  'retry_calendar_copy',
])
const otherReads = new Set([
  'list_schedules',
  'get_schedule',
  'list_calendar_connections',
  'list_conference_connections',
])
const expected = (scope: ApiKeyScope) =>
  all.filter((name) =>
    scope === 'full' ? true : scope === 'read' ? !writes.has(name) : !otherReads.has(name),
  )
const denial = {
  error: 'insufficient_scope',
  message: 'This API key does not allow this operation.',
}
const catalog = productTools({ db: {} as Db })
function principal(scope: ApiKeyScope): McpCaller {
  return {
    kind: 'api_key',
    apiKeyScope: scope,
    apiKeyId: randomUUID(),
    user: { id: randomUUID(), name: 'Scope test', email: 'scope@example.test' },
    organization: { id: randomUUID(), name: 'Personal', slug: 'scope', personal: true },
  }
}
const principals = Object.fromEntries(scopes.map((scope) => [scope, principal(scope)])) as Record<
  ApiKeyScope,
  McpCaller
>
const resolver: CallerResolver = async (headers) => {
  const scope = headers.get('authorization')?.replace('Bearer hm_', '') as ApiKeyScope
  return Object.hasOwn(principals, scope)
    ? { ok: true, principal: principals[scope], setCookie: [] }
    : { ok: false, error: 'unauthorized', setCookie: [] }
}
function appWith(tools: readonly Tool[] = catalog, resolveCaller = resolver) {
  return createApp({
    publicUrl: URL,
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller,
    mcp: mcpEndpoint({ tools }),
  })
}
const app = appWith()
function headers(scope: ApiKeyScope, era: 'legacy' | 'modern', name?: string) {
  return {
    authorization: `Bearer hm_${scope}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(era === 'modern' && {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': name ? 'tools/call' : 'tools/list',
      ...(name && { 'mcp-name': name }),
    }),
  }
}
async function rpc(
  name: string,
  scope: ApiKeyScope,
  era: 'legacy' | 'modern',
  args: unknown = {},
  target = app,
) {
  const res = await target.request('/mcp', {
    method: 'POST',
    headers: headers(scope, era, name),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        ...(era === 'modern' && {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        }),
      },
    }),
  })
  const text = await res.text()
  const data = text.split('\n').find((line) => line.startsWith('data: '))
  return { res, message: JSON.parse(data ? data.slice(6) : text) }
}
const textOf = (result: { content: { text: string }[] }) =>
  JSON.parse(result.content[0]?.text ?? '')
const probe = (tool: Tool) => ({
  ...tool,
  input: z.object({ idempotencyKey: z.string().optional() }),
  output: z.object({ dispatched: z.string() }),
  run: vi.fn(async () => ({ dispatched: tool.name })),
})

describe('MCP scoped discovery and dispatch', () => {
  it.each(['legacy', 'modern'] as const)(
    '%s lists exact production catalogs per key without cross-key reuse',
    async (era) => {
      expect(catalog.map((tool) => tool.name)).toEqual(all)
      for (const scope of ['full', 'read', 'bookings', 'full', 'read'] as const) {
        const client = new Client(
          { name: 'scope-discovery', version: '1' },
          era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
        )
        const responses: Response[] = []
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new globalThis.URL(`${URL}/mcp`), {
              fetch: async (input, init) => {
                const res = await app.request(input, init)
                responses.push(res)
                return res
              },
              requestInit: { headers: { authorization: `Bearer hm_${scope}` } },
            }),
          )
          const { tools } = await client.listTools()
          expect(tools.map((tool) => tool.name)).toEqual(expected(scope))
          for (const tool of tools) {
            expect(tool.inputSchema.additionalProperties).toBe(false)
            expect(tool.outputSchema).toBeDefined()
            expect(tool.annotations).toMatchObject(
              catalog.find((original) => original.name === tool.name)?.annotations ?? {},
            )
          }
          expect(responses.every((res) => res.headers.get('cache-control') === 'no-store')).toBe(
            true,
          )
          const identity = await client.callTool({ name: 'whoami', arguments: {} })
          expect(identity.structuredContent).toMatchObject({ principal: { apiKeyScope: scope } })
          if (era === 'legacy') {
            const instructions = client.getInstructions() ?? ''
            expect(instructions).toContain('refresh tool discovery')
            if (scope === 'read') {
              for (const write of writes) expect(instructions).not.toContain(write)
              expect(instructions).toContain('discovery and inspection only')
            }
          }
        } finally {
          await client.close()
        }
      }
    },
  )

  it.each(scopes)(
    '%s enforces all tools over both protocol eras before handlers',
    async (scope) => {
      const tools = catalog.map(probe)
      const target = appWith(tools)
      for (const era of ['legacy', 'modern'] as const) {
        for (const tool of tools) {
          tool.run.mockClear()
          const { res, message } = await rpc(tool.name, scope, era, {}, target)
          expect(res.status, `${scope}/${era}/${tool.name}`).toBe(200)
          if (expected(scope).includes(tool.name)) {
            expect(message.result.isError, `${scope}/${tool.name}`).toBeFalsy()
            expect(tool.run).toHaveBeenCalledTimes(1)
          } else {
            expect(message.result.isError).toBe(true)
            expect(textOf(message.result)).toEqual(denial)
            expect(tool.run).not.toHaveBeenCalled()
            expect(res.headers.get('cache-control')).toBe('no-store')
          }
        }
      }
    },
  )

  it('checks hidden known names before argument/resource validation but preserves protocol errors', async () => {
    for (const era of ['legacy', 'modern'] as const) {
      for (const args of [{}, { bookingId: randomUUID() }, { manageToken: 'invalid' }]) {
        const { message } = await rpc('cancel_booking', 'read', era, args)
        expect(message).toHaveProperty('result')
        expect(message.result.isError).toBe(true)
        expect(textOf(message.result)).toEqual(denial)
      }
      const unknown = await rpc('unknown_tool', 'read', era)
      expect(unknown.message.error).toMatchObject({ code: -32602 })
      expect(unknown.message.result).toBeUndefined()
      const malformed = await rpc('cancel_booking', 'read', era, 'not-an-object')
      expect(malformed.message.error).toMatchObject({ code: -32602 })
      expect(malformed.message.result).toBeUndefined()
    }
    const mismatch = await app.request('/mcp', {
      method: 'POST',
      headers: { ...headers('read', 'modern', 'cancel_booking'), 'mcp-name': 'whoami' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'cancel_booking',
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    })
    expect(mismatch.status).toBe(400)
  })

  it.each(scopes)(
    '%s protects direct runTool calls for every tool and explicit dispatch mode',
    async (scope) => {
      for (const original of catalog) {
        for (const args of [{}, { teamSlug: 'team' }, { bookingId: randomUUID() }]) {
          const tool = probe(original)
          const result = await runTool(
            tool,
            args,
            { caller: principals[scope], rateLimit: () => {} },
            () => {
              throw Error('Unexpected tool error')
            },
          )
          if (expected(scope).includes(tool.name)) expect(tool.run).toHaveBeenCalledTimes(1)
          else {
            expect(result.isError).toBe(true)
            expect(textOf(result as { content: { text: string }[] })).toEqual(denial)
            expect(tool.run).not.toHaveBeenCalled()
          }
        }
      }
    },
  )

  it('denies unmapped tools and modes for limited scopes, including read-only annotated tools', async () => {
    const unknownTool = { ...probe(catalog[0] as Tool), name: 'new_unmapped_read' }
    const unknownMode = {
      ...probe(catalog[0] as Tool),
      scopeModes: ['new_mode'],
      scopeMode: () => 'new_mode',
    }
    for (const tool of [unknownTool, unknownMode]) {
      for (const scope of scopes) {
        tool.run.mockClear()
        const result = await runTool(
          tool,
          {},
          { caller: principals[scope], rateLimit: () => {} },
          () => {},
        )
        expect(tool.run).toHaveBeenCalledTimes(scope === 'full' ? 1 : 0)
        if (scope !== 'full') {
          expect(textOf(result as { content: { text: string }[] })).toEqual(denial)
          const direct = await rpc(tool.name, scope, 'modern', {}, appWith([tool]))
          expect(textOf(direct.message.result)).toEqual(denial)
        }
      }
    }
  })

  it('keeps OAuth discovery under its existing grant without inventing an API key scope', async () => {
    const { user, organization } = principal('full')
    const oauth: Principal = {
      kind: 'oauth',
      user,
      organization,
      oauthConsentId: randomUUID(),
      clientId: 'scope-oauth-test',
      scopes: ['mcp:tools'],
    }
    const target = createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: resolver,
      publicUrl: URL,
      mcp: mcpEndpoint({
        tools: catalog,
        oauth: {
          resolve: async () => ({ ok: true, principal: oauth }),
          handler: async () => new Response(null, { status: 404 }),
        },
      }),
    })
    const client = new Client({ name: 'scope-oauth', version: '1' })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new globalThis.URL(`${URL}/mcp`), {
          fetch: async (input, init) => target.request(input, init),
          requestInit: { headers: { authorization: 'Bearer oauth-test-token' } },
        }),
      )
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(all)
      const identity = await client.callTool({ name: 'whoami', arguments: {} })
      expect(identity.structuredContent).toHaveProperty('principal')
      expect((identity.structuredContent as { principal: object }).principal).not.toHaveProperty(
        'apiKeyScope',
      )
    } finally {
      await client.close()
    }
  })
})

describe('CLI scope parity', () => {
  const commands = [
    ['whoami', 'whoami'],
    ['profile', 'get_profile'],
    ['catalog', 'list_event_types'],
    ['event', 'get_event_type'],
    ['schedules', 'list_schedules'],
    ['schedule', 'get_schedule'],
    ['slots', 'find_available_slots'],
    ['book', 'create_booking'],
    ['list', 'list_bookings'],
    ['reschedule', 'reschedule_booking'],
    ['cancel', 'cancel_booking'],
    ['retry-meeting', 'retry_conference'],
    ['retry-calendar-copy', 'retry_calendar_copy'],
  ] as const
  it.each(scopes)(
    '%s follows all 13 network aliases and never retries a scope denial',
    async (scope) => {
      const target = appWith(catalog.map(probe))
      for (const [command, name] of commands) {
        let stdout = ''
        let stderr = ''
        const fetcher = vi.fn<typeof fetch>(async (input, init) => target.request(input, init))
        const key = `hm_${scope}`
        const code = await runCli({
          argv: [command, '--input', '-'],
          env: { HOURMERE_URL: URL, HOURMERE_API_KEY: key },
          stdin: (async function* () {
            yield JSON.stringify({ idempotencyKey: 'scope-matrix-test' })
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
        expect((stdout + stderr).includes(key)).toBe(false)
        if (expected(scope).includes(name)) {
          expect(code, `${scope}/${command}`).toBe(0)
          expect(JSON.parse(stdout)).toEqual({ dispatched: name })
        } else {
          expect(code, `${scope}/${command}`).toBe(1)
          expect(stdout).toBe('')
          expect(JSON.parse(stderr)).toMatchObject({ error: 'insufficient_scope' })
          expect(stderr).not.toContain(denial.message)
        }
      }
    },
  )
})
