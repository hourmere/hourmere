// The body limit over a real socket, as @hono/node-server serves it: what app.request()
// cannot show, e.g. what happens to a connection whose request body was never read.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { createRoute, z } from '@hono/zod-openapi'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { authenticated, callerWithBodyLimit, json, type RouteModule } from './openapi.ts'

const uploads: RouteModule = ({ app, caller }) => {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/uploads',
      security: authenticated,
      middleware: callerWithBodyLimit(caller, 2 * 1024 * 1024),
      request: { body: { content: json(z.object({ data: z.string() })), required: true } },
      responses: { 200: { description: 'ok', content: json(z.object({ length: z.number() })) } },
    }),
    (c) => c.json({ length: c.req.valid('json').data.length }, 200),
  )
}

interface Answer {
  status: number
  body: string
  reusedSocket: boolean
}

describe('request bodies over a real socket', () => {
  let server: ReturnType<typeof serve>
  let port: number
  // One connection, kept open between requests.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

  beforeAll(async () => {
    const app = createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      publicUrl: 'http://localhost:3000',
      routes: [uploads],
      mcp: mcpEndpoint({ tools: [] }),
    })
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
        port = info.port
        resolve()
      })
    })
  })

  afterAll(async () => {
    agent.destroy()
    await new Promise((resolve) => server.close(resolve))
  })

  const send = (method: string, path: string, body?: string) =>
    new Promise<Answer>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          agent,
          headers: body === undefined ? {} : { 'content-type': 'application/json' },
          timeout: 3000,
        },
        (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            text += chunk
          })
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: text, reusedSocket: req.reusedSocket }),
          )
        },
      )
      req.on('timeout', () => req.destroy(new Error('no answer within 3 s')))
      req.on('error', reject)
      req.end(body)
    })

  it.each(['/api/v1/uploads', '/mcp'])(
    'keeps the connection usable after %s refuses a caller without reading its body',
    async (path) => {
      const refused = await send('POST', path, JSON.stringify({ data: 'x'.repeat(1_000_000) }))
      expect(refused.status).toBe(401)
      await new Promise((resolve) => setTimeout(resolve, 100))
      // The same connection must still be served: the unread body is skipped, not left to
      // stall the connection until the server gives up on it.
      const next = await send('GET', '/api/health')
      expect(next).toEqual({
        status: 200,
        body: '{"status":"ok","database":"ok"}',
        reusedSocket: true,
      })
    },
  )
})
