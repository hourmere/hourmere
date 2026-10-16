// Clients that go away before their request is read: they close the connection, or the
// request timeout cuts them off. Over real HTTP, since only @hono/node-server aborts the
// request's signal when the connection closes.
import { type AddressInfo, connect } from 'node:net'
import { serve } from '@hono/node-server'
import { createRoute, z } from '@hono/zod-openapi'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { httpServerOptions } from './http-timeouts.ts'
import { json, type RouteModule } from './openapi.ts'
import { trickle } from './slow-client-testing.ts'

/**
 * /api/v1 routes: one that reads a JSON body, one that wraps a failed read in its own error,
 * and ones that fail on their own, at once or after the client may have left.
 */
const echo: RouteModule = ({ app }) => {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/echo',
      request: { body: { content: json(z.object({ text: z.string() })), required: true } },
      responses: { 200: { description: 'ok', content: json(z.object({ text: z.string() })) } },
    }),
    (c) => c.json(c.req.valid('json'), 200),
  )
  app.post('/api/v1/wrapped', async (c) => {
    try {
      await c.req.text()
    } catch (err) {
      throw new Error('could not read the request', { cause: err })
    }
    return c.text('read')
  })
  app.get('/api/v1/bug', () => {
    throw new Error('unexpected')
  })
  app.get('/api/v1/slow-bug', async (c) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (c.req.query('kind') === 'refused') {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
        code: 'ECONNREFUSED',
      })
    }
    // A bug: reading a property of undefined.
    return c.text((undefined as unknown as { x: string }).x)
  })
}

const timeouts = { headers: 300, request: 600, keepAlive: 900 }

/** Sends a GET and closes the connection before the answer. */
function getAndLeave(port: number, path: string) {
  return new Promise<void>((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`)
      setTimeout(() => socket.destroy(), 50)
    })
    socket.on('close', () => resolve())
  })
}

/** Sends the headers and part of the body, then closes the connection. */
function sendHalfAndLeave(port: number, path: string) {
  return new Promise<void>((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"text":"`,
      )
      setTimeout(() => socket.destroy(), 50)
    })
    socket.on('close', () => resolve())
  })
}

describe('a client that goes away mid-request', () => {
  let server: ReturnType<typeof serve>
  let port: number
  let logged: { log: string[]; warn: string[]; error: string[] }

  beforeAll(async () => {
    const app = createApp({
      checkDb: async () => {},
      // Reads the body as Better Auth does; reading fails once the client has gone.
      authHandler: async (request) => Response.json({ length: (await request.text()).length }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      publicUrl: 'http://localhost:3000',
      routes: [echo],
    })
    server = await new Promise((resolve) => {
      const s = serve(
        { fetch: app.fetch, port: 0, serverOptions: httpServerOptions(timeouts) },
        () => resolve(s),
      )
    })
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  beforeEach(() => {
    logged = { log: [], warn: [], error: [] }
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => {
        logged[level].push(args.join(' '))
      })
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Waits until the request log has the answer to `path`; returns that line. */
  const answered = (path: string, method = 'POST') =>
    vi.waitFor(
      () => {
        const line = logged.log.find((l) => l.startsWith(`--> ${method} ${path} `))
        if (!line) throw new Error(`${path} not answered yet`)
        return line
      },
      { timeout: 3000 },
    )

  const WARNING =
    /^\d{4}-\d\d-\d\dT[\d:.]+Z WARN POST \/api\/[\w/-]+: client closed the connection before the answer \(.+\)$/

  it('is one WARN line for Better Auth, not an error with a stack', async () => {
    await sendHalfAndLeave(port, '/api/auth/sign-in/magic-link')
    expect(await answered('/api/auth/sign-in/magic-link')).toMatch(/ 499 /)
    expect(logged.error).toEqual([])
    expect(logged.warn).toHaveLength(1)
    expect(logged.warn[0]).toMatch(WARNING)
    expect(logged.warn[0]).toContain('(Error: aborted (ECONNRESET))')
  })

  it('is one WARN line for /api/v1 too, instead of a 400 nobody receives', async () => {
    await sendHalfAndLeave(port, '/api/v1/echo')
    expect(await answered('/api/v1/echo')).toMatch(/ 499 /)
    expect(logged.error).toEqual([])
    expect(logged.warn).toHaveLength(1)
    expect(logged.warn[0]).toMatch(WARNING)
  })

  it('is the same when the request timeout cuts the client off', async () => {
    for (const path of ['/api/auth/sign-in/magic-link', '/api/v1/echo']) {
      const { response } = await trickle(port, {
        first: `POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"text":"`,
        drip: 'x',
      })
      // What the client got: Node's 408.
      expect(response, path).toMatch(/^HTTP\/1\.1 408 /)
      expect(await answered(path), path).toMatch(/ 499 /)
    }
    expect(logged.error).toEqual([])
    expect(logged.warn).toHaveLength(2)
    for (const line of logged.warn) expect(line).toMatch(WARNING)
  })

  it('is one WARN line when a route wraps the failed read in an error of its own', async () => {
    await sendHalfAndLeave(port, '/api/v1/wrapped')
    expect(await answered('/api/v1/wrapped')).toMatch(/ 499 /)
    expect(logged.error).toEqual([])
    expect(logged.warn).toEqual([
      expect.stringMatching(/WARN POST \/api\/v1\/wrapped: .*could not read the request/),
    ])
  })

  it('keeps errors that are not the disconnect as errors with a stack, client gone or not', async () => {
    // The client leaves after 50 ms; the route fails after 300 ms, for its own reasons.
    for (const path of ['/api/v1/slow-bug', '/api/v1/slow-bug?kind=refused']) {
      await getAndLeave(port, path)
      expect(await answered(path.split('?')[0] as string, 'GET'), path).toMatch(/ 500 /)
      logged.log = []
    }
    expect(logged.warn).toEqual([])
    expect(logged.error).toEqual([
      expect.stringMatching(/ ERROR GET \/api\/v1\/slow-bug: TypeError: .*\\n {4}at /),
      expect.stringMatching(
        / ERROR GET \/api\/v1\/slow-bug: Error: connect ECONNREFUSED .*\\n {4}at /,
      ),
    ])
  })

  it('still logs real failures of clients that stay as errors', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/bug`)
    expect(res.status).toBe(500)
    expect(logged.warn).toEqual([])
    expect(logged.error).toEqual([
      expect.stringMatching(/ ERROR GET \/api\/v1\/bug: Error: unexpected/),
    ])
  })
})
