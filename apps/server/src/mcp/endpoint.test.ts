// The MCP endpoint over HTTP with the SDK's own client, in process (app.request as fetch):
// transport, authentication, Origin, limits and the tool framework's error mapping.
// Real API keys, rate limits and booking tools are in bookings.test.ts.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from '@hono/zod-openapi'
import type { CallerResult, Principal } from '@hourmere/auth'
import { DomainError, type DomainErrorKind } from '@hourmere/scheduling'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type AppDeps, createApp } from '../app.ts'
import { CHUNK_SIZE, chunkedBody } from '../chunked-body.ts'
import { createRateLimiter } from '../rate-limit.ts'
import { MCP_BODY_LIMIT, mcpEndpoint } from './endpoint.ts'
import { clip, defineTool, type Tool } from './tools.ts'
import { whoamiTool } from './whoami.ts'

const PUBLIC_URL = 'http://localhost:3000'
const principal: Principal = {
  kind: 'api_key',
  apiKeyId: '00000000-0000-7000-8000-000000000001',
  user: { id: '00000000-0000-7000-8000-000000000002', name: 'Ada', email: 'ada@example.com' },
  organization: {
    id: '00000000-0000-7000-8000-000000000003',
    name: 'Ada',
    slug: 'ada',
    personal: true,
  },
}

/** Keys the fake resolver knows; anything else is unknown. */
const resolveCaller = vi.fn(async (headers: Headers): Promise<CallerResult> => {
  const auth = headers.get('authorization')
  if (auth === 'Bearer hm_good') return { ok: true, principal, setCookie: [] }
  if (auth === 'Bearer hm_spent') {
    return { ok: false, error: 'rate_limited', retryAfterSeconds: 42, setCookie: [] }
  }
  // A session cookie would authenticate on the REST API; /mcp must never pass one on.
  if (auth === null && headers.get('cookie')) {
    return { ok: true, principal: { ...principal, kind: 'session', sessionId: 's' }, setCookie: [] }
  }
  return { ok: false, error: 'unauthorized', setCookie: [] }
})

const oncePerMinute = createRateLimiter({ limit: 1, windowSeconds: 60 })

/** A tool whose outcome the test chooses. */
const probeTool = defineTool({
  name: 'probe',
  title: 'Probe',
  description: 'Test tool',
  input: z.strictObject({
    outcome: z.enum(['ok', 'domain', 'caused', 'weird', 'bug', 'bad_output', 'limited']),
    count: z.number().int().optional(),
    text: z.string().optional(),
  }),
  output: z.object({ outcome: z.string(), caller: z.string() }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  async run({ outcome }, call) {
    switch (outcome) {
      case 'domain':
        throw new DomainError('conflict', 'slot_taken', 'Someone else just booked this time')
      case 'caused':
        throw new DomainError('invalid', 'bad_thing', 'Bad thing', {
          cause: new Error('duplicate key value\nKey (email)=(a@b.c) secret-detail'),
        })
      case 'weird':
        throw new DomainError('weird' as DomainErrorKind, 'weird_thing')
      case 'bug':
        throw new Error('db password is hunter2')
      case 'bad_output':
        return { outcome: 1 } as unknown as { outcome: string; caller: string }
      case 'limited':
        call.rateLimit(oncePerMinute)
        return { outcome, caller: call.caller.user.name }
      default:
        return { outcome, caller: call.caller.user.name }
    }
  },
})

function appWith(tools: Tool[] = [whoamiTool, probeTool], extra: Partial<AppDeps> = {}) {
  return createApp({
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller,
    publicUrl: PUBLIC_URL,
    mcp: mcpEndpoint({ tools }),
    ...extra,
  })
}

const app = appWith()
const url = `${PUBLIC_URL}/mcp`

async function connect({
  headers = { authorization: 'Bearer hm_good' },
  era = 'legacy',
}: {
  headers?: Record<string, string>
  era?: 'legacy' | 'modern'
} = {}) {
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  )
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: async (input, init) => app.request(input, init),
    requestInit: { headers },
  })
  await client.connect(transport)
  return client
}

/** A raw JSON-RPC POST, as a 2025-era client sends it. */
const rpc = (body: unknown, headers: Record<string, string> = {}, a = app) =>
  a.request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer hm_good',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'curl', version: '1' },
  },
}

/** The JSON-RPC message of a response, whether sent as JSON or as one SSE event. */
async function message(
  res: Response,
): Promise<{ id?: unknown; result?: unknown; error?: unknown }> {
  const text = await res.text()
  if (res.headers.get('content-type')?.startsWith('text/event-stream')) {
    const data = text.split('\n').find((l) => l.startsWith('data: '))
    return JSON.parse(data?.slice(6) ?? 'null')
  }
  return JSON.parse(text)
}

const textOf = (result: { content?: unknown }) =>
  JSON.parse((result.content as { type: string; text: string }[])[0]?.text ?? 'null')

afterEach(() => {
  resolveCaller.mockClear()
})

describe('MCP transport', () => {
  it.each(['legacy', 'modern'] as const)(
    'serves %s clients: tools in order, then a call',
    async (era) => {
      const client = await connect({ era })
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual(['whoami', 'probe'])
      const whoami = await client.callTool({ name: 'whoami', arguments: {} })
      expect(whoami.isError).toBeFalsy()
      expect(whoami.structuredContent).toEqual({
        user: principal.user,
        organization: principal.organization,
        principal: { kind: 'api_key', apiKeyId: principal.apiKeyId },
      })
      expect(textOf(whoami)).toEqual(whoami.structuredContent)
      await client.close()
    },
  )

  it('describes tools for models: annotations, title, and schemas with descriptions', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    const whoami = tools.find((t) => t.name === 'whoami')
    expect(whoami).toMatchObject({
      title: 'Who am I',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: { type: 'object', additionalProperties: false },
    })
    expect(whoami?.description).toMatch(/API key/)
    // Descriptions given with .openapi() on the shared REST schema reach the JSON Schema.
    const out = whoami?.outputSchema as {
      properties: { organization: { description: string; properties: { personal: object } } }
    }
    expect(out.properties.organization.description).toBe('The organization the caller acts in')
    expect(out.properties.organization.properties.personal).toMatchObject({
      description: 'A personal organization (every user has one) rather than a team',
    })
    expect(tools.find((t) => t.name === 'probe')?.annotations?.destructiveHint).toBe(true)
    await client.close()
  })

  it('is stateless: no session id, and GET and DELETE are 405', async () => {
    const res = await rpc(initialize)
    expect(res.status).toBe(200)
    expect(res.headers.get('mcp-session-id')).toBeNull()
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const other = await app.request(url, {
        method,
        headers: { authorization: 'Bearer hm_good', accept: 'text/event-stream' },
      })
      expect(other.status).toBe(405)
      expect(other.headers.get('allow')).toBe('POST')
    }
  })

  it('answers no-store on every response, errors included', async () => {
    expect((await rpc(initialize)).headers.get('cache-control')).toBe('no-store')
    const refused = await rpc(initialize, { authorization: 'Bearer hm_nope' })
    expect(refused.headers.get('cache-control')).toBe('no-store')
  })

  it('answers malformed JSON with a JSON-RPC parse error', async () => {
    const res = await rpc('{"jsonrpc":')
    expect(res.status).toBe(400)
    expect(await message(res)).toMatchObject({ error: { code: -32700 } })
  })

  it('answers a message that is not JSON-RPC with a JSON-RPC error', async () => {
    const res = await rpc({ hello: 'world' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(await message(res)).toMatchObject({
      jsonrpc: '2.0',
      error: { code: expect.any(Number) },
    })
  })

  it('answers an unknown tool with a protocol error, not a tool result', async () => {
    const res = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    })
    expect(await message(res)).toMatchObject({ id: 2, error: { code: -32602 } })
  })

  it('refuses bodies over the limit before reading them', async () => {
    const res = await app.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer hm_good',
        'content-length': String(MCP_BODY_LIMIT + 1),
      },
      body: 'x',
    })
    expect(res.status).toBe(413)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(resolveCaller).not.toHaveBeenCalled()
  })

  it('takes requests up to the limit: a 1.9 MB tool call works', async () => {
    const text = 'x'.repeat(1_900_000)
    const res = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'probe', arguments: { outcome: 'ok', text } },
    })
    expect(res.status).toBe(200)
    expect(await message(res)).toMatchObject({
      id: 3,
      result: { structuredContent: { outcome: 'ok', caller: 'Ada' } },
    })
  })

  it('counts streamed bodies while the SDK reads them, after authentication', async () => {
    const stream = (body: string, headers: Record<string, string> = {}) => {
      const sent = chunkedBody(body)
      const res = app.request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        ...sent.init,
      })
      return { res, pulled: sent.pulled }
    }
    const call = (text: string) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'probe', arguments: { outcome: 'ok', text } },
      })
    // No key: refused without reading the body (at most one chunk of read-ahead).
    const anonymous = stream(call('x'.repeat(1_900_000)))
    expect((await anonymous.res).status).toBe(401)
    expect(anonymous.pulled()).toBeLessThanOrEqual(CHUNK_SIZE)
    // With a key: over the limit is the REST-shaped 413, whatever the SDK made of the read.
    const tooBig = await stream(call('x'.repeat(MCP_BODY_LIMIT)), {
      authorization: 'Bearer hm_good',
    }).res
    expect(tooBig.status).toBe(413)
    expect(await tooBig.json()).toEqual({ error: 'payload_too_large' })
    expect(tooBig.headers.get('cache-control')).toBe('no-store')
    // Within the limit, the call works.
    const fits = await stream(call('x'.repeat(1_900_000)), { authorization: 'Bearer hm_good' }).res
    expect(fits.status).toBe(200)
    expect(await message(fits)).toMatchObject({
      id: 4,
      result: { structuredContent: { outcome: 'ok', caller: 'Ada' } },
    })
  })

  it('keeps results open to new fields and arguments closed', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    await client.close()
    const closed: string[] = []
    const walk = (schema: unknown, at: string) => {
      if (typeof schema !== 'object' || schema === null) return
      const s = schema as Record<string, unknown>
      if (s.additionalProperties === false) closed.push(at)
      for (const [key, value] of Object.entries(s)) walk(value, `${at}.${key}`)
    }
    for (const tool of tools) walk(tool.outputSchema, tool.name)
    expect(closed).toEqual([])
    for (const tool of tools) {
      expect(tool.inputSchema, tool.name).toMatchObject({ additionalProperties: false })
    }
  })

  it('logs what the SDK refuses on one bounded line, whatever the client sent', async () => {
    const lines: string[] = []
    const spies = (['warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args) => {
        lines.push(args.join(' '))
      }),
    )
    const huge = `tool${'n'.repeat(500_000)}`
    try {
      // A 2026-07-28 request whose Mcp-Name header does not match the body.
      const res = await app.request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer hm_good',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'other',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: huge,
            arguments: {},
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      })
      expect(res.status).toBe(400)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/WARN POST \/mcp: /)
    expect(lines[0]).toMatch(/…\(\+\d+ chars\)$/)
    expect(lines[0]?.length).toBeLessThan(2200)
  })

  it('answers OAuth discovery and GET /mcp itself, not the web app', async () => {
    const webDist = await mkdtemp(join(tmpdir(), 'hourmere-web-'))
    try {
      await writeFile(join(webDist, 'index.html'), '<title>Hourmere</title>')
      const withWeb = appWith(undefined, { webDist })
      for (const path of [
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/mcp',
        '/.well-known/oauth-authorization-server',
        '/.well-known/oauth-authorization-server/mcp',
        '/.well-known/openid-configuration',
        '/.well-known/openid-configuration/mcp',
        '/mcp/.well-known/openid-configuration',
        '/mcp/.well-known/oauth-authorization-server',
        '/mcp/anything',
      ]) {
        const res = await withWeb.request(path)
        expect(res.status, path).toBe(404)
        expect(await res.json()).toEqual({ error: 'not_found' })
        expect(res.headers.get('cache-control')).toBe(path.startsWith('/mcp') ? 'no-store' : null)
      }
      for (const path of ['/mcp', '/mcp/']) {
        const get = await withWeb.request(path)
        expect(get.status, path).toBe(405)
        expect(get.headers.get('allow')).toBe('POST')
      }
      const slash = await withWeb.request(`${PUBLIC_URL}/mcp/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer hm_good',
        },
        body: JSON.stringify(initialize),
      })
      expect(slash.status).toBe(200)
      expect((await withWeb.request('/some/page')).status).toBe(200)
    } finally {
      await rm(webDist, { recursive: true, force: true })
    }
  })

  it('refuses invalid or duplicate tool names at startup', () => {
    expect(() => mcpEndpoint({ tools: [whoamiTool, whoamiTool] })).toThrow(/duplicate/)
    expect(() => mcpEndpoint({ tools: [{ ...whoamiTool, name: 'Who Am I' }] })).toThrow(/invalid/)
  })
})

describe('MCP authentication', () => {
  it('needs an API key: none, unknown and malformed keys get 401 with WWW-Authenticate', async () => {
    for (const [authorization, challenge] of [
      ['', 'Bearer'],
      ['Basic abc', 'Bearer'],
      ['Bearer hm_nope', 'Bearer error="invalid_token"'],
      ['bearer  hm_nope', 'Bearer error="invalid_token"'],
    ]) {
      const res = await rpc(initialize, { authorization: authorization as string })
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe(challenge)
      expect(await res.json()).toMatchObject({ error: 'unauthorized' })
    }
    await expect(connect({ headers: { authorization: 'Bearer hm_nope' } })).rejects.toThrow()
  })

  it('refuses session cookies, and never passes them to caller resolution', async () => {
    const cookieOnly = await app.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'better-auth.session_token=s.t' },
      body: JSON.stringify(initialize),
    })
    expect(cookieOnly.status).toBe(401)
    expect(cookieOnly.headers.get('www-authenticate')).toBe('Bearer')
    expect((await cookieOnly.json()) as { message: string }).toMatchObject({
      error: 'unauthorized',
      message: expect.stringMatching(/cookies/),
    })
    expect(resolveCaller).not.toHaveBeenCalled()

    // With a key as well, the key decides and the cookie is dropped.
    const both = await rpc(initialize, { cookie: 'better-auth.session_token=s.t' })
    expect(both.status).toBe(200)
    expect(resolveCaller).toHaveBeenCalledTimes(1)
    const [[seen] = []] = resolveCaller.mock.calls
    expect(seen?.get('cookie')).toBeNull()
    expect(seen?.get('authorization')).toBe('Bearer hm_good')
  })

  it("answers 429 with Retry-After when the key's rate limit is used up", async () => {
    const res = await rpc(initialize, { authorization: 'Bearer hm_spent' })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('42')
    expect(await res.json()).toEqual({ error: 'rate_limited' })
  })
})

describe('MCP Origin check', () => {
  it('lets clients without Origin and the app itself through', async () => {
    expect((await rpc(initialize)).status).toBe(200)
    expect((await rpc(initialize, { origin: PUBLIC_URL })).status).toBe(200)
  })

  it('refuses other origins with 403 before authenticating', async () => {
    for (const origin of ['https://evil.example', 'null', 'http://localhost:3001']) {
      const res = await rpc(initialize, { origin })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: 'forbidden' })
    }
    expect(resolveCaller).not.toHaveBeenCalled()
  })
})

describe('MCP tool results', () => {
  const call = async (args: Record<string, unknown>, name = 'probe') => {
    const client = await connect()
    try {
      return await client.callTool({ name, arguments: args })
    } finally {
      await client.close()
    }
  }

  /** Runs fn and returns what it wrote with console.error. */
  async function errorLines(fn: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      lines.push(args.join(' '))
    })
    try {
      await fn()
    } finally {
      spy.mockRestore()
    }
    return lines
  }

  it('passes the caller to the handler', async () => {
    const result = await call({ outcome: 'ok' })
    expect(result.structuredContent).toEqual({ outcome: 'ok', caller: 'Ada' })
  })

  it('maps a DomainError to an error result with its code and message', async () => {
    const result = await call({ outcome: 'domain' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(textOf(result)).toEqual({
      error: 'slot_taken',
      message: 'Someone else just booked this time',
    })
  })

  it("logs a DomainError's cause on one line without sending it", async () => {
    let result: Awaited<ReturnType<typeof call>> | undefined
    const lines = await errorLines(async () => {
      result = await call({ outcome: 'caused' })
    })
    expect(textOf(result as { content: unknown })).toEqual({
      error: 'bad_thing',
      message: 'Bad thing',
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/ERROR POST \/mcp tools\/call probe: bad_thing caused by /)
    expect(lines[0]).toContain('secret-detail')
    expect(lines[0]).not.toContain('\n')
  })

  it.each([
    ['bug', 'db password is hunter2'],
    ['weird', 'weird_thing'],
    ['bad_output', 'output schema'],
  ])(
    'answers %s with an opaque internal_error and logs it on one line',
    async (outcome, logged) => {
      let result: Awaited<ReturnType<typeof call>> | undefined
      const lines = await errorLines(async () => {
        result = await call({ outcome })
      })
      expect(result?.isError).toBe(true)
      expect(textOf(result as { content: unknown })).toEqual({ error: 'internal_error' })
      expect(JSON.stringify(result)).not.toContain('hunter2')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain(logged)
      expect(lines[0]).not.toContain('\n')
    },
  )

  it('answers invalid arguments with invalid_request naming the fields', async () => {
    const result = await call({ outcome: 'nope', count: 1.5, extra: true })
    expect(result.isError).toBe(true)
    const body = textOf(result) as { error: string; message: string }
    expect(body.error).toBe('invalid_request')
    expect(body.message).toMatch(/outcome: /)
    expect(body.message).toMatch(/count: /)
    expect(body.message).toMatch(/extra/)

    const missing = textOf(await call({})) as { message: string }
    expect(missing.message).toMatch(/outcome: /)
    expect(textOf(await call({ surprise: 1 }, 'whoami'))).toMatchObject({
      error: 'invalid_request',
      message: expect.stringMatching(/surprise/),
    })
  })

  it('bounds the validation message, whatever names the client sent', async () => {
    const result = await call({ outcome: 'ok', [`k${'e'.repeat(100_000)}`]: 1 })
    const body = textOf(result) as { error: string; message: string }
    expect(body.error).toBe('invalid_request')
    expect(body.message).toMatch(/Unrecognized key/)
    expect(body.message.length).toBeLessThan(2100)
  })

  it('refuses NUL and lone surrogates anywhere in the arguments', async () => {
    for (const args of [
      { outcome: 'ok', text: 'a\u0000b' },
      { outcome: 'ok', text: '\ud800' },
      { outcome: 'ok', 'k\u0000': 1 },
    ]) {
      expect(textOf(await call(args))).toEqual({
        error: 'invalid_request',
        message: 'Text in the request must not contain NUL characters or malformed Unicode',
      })
    }
  })

  it('answers rate_limited with the seconds to wait when a tool limit is used up', async () => {
    expect((await call({ outcome: 'limited' })).isError).toBeFalsy()
    const limited = await call({ outcome: 'limited' })
    expect(limited.isError).toBe(true)
    expect(textOf(limited)).toMatchObject({
      error: 'rate_limited',
      retryAfterSeconds: expect.any(Number),
    })
  })
})

describe('clip', () => {
  it('keeps short text and never leaves half a surrogate pair', () => {
    expect(clip('abc', 3)).toBe('abc')
    expect(clip('abcdef', 3)).toBe('abc…(+3 chars)')
    const cut = clip(`${'x'.repeat(280)}😀${'a'.repeat(100)}`, 281)
    expect(cut).toBe(`${'x'.repeat(280)}…(+102 chars)`)
    expect(cut.isWellFormed()).toBe(true)
    expect(() => encodeURIComponent(cut)).not.toThrow()
  })
})
