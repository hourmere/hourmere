import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_HTTP_TIMEOUTS, httpServerOptions } from './http-timeouts.ts'
import { afterOneRequest, trickle } from './slow-client-testing.ts'

describe('httpServerOptions', () => {
  it('sets the three timeouts and checks for late clients four times as often', () => {
    expect(httpServerOptions(DEFAULT_HTTP_TIMEOUTS)).toEqual({
      headersTimeout: 20_000,
      requestTimeout: 60_000,
      keepAliveTimeout: 125_000,
      connectionsCheckingInterval: 5_000,
    })
  })
})

describe('a server with short timeouts', () => {
  // As with the defaults, keep-alive outlasts the other two: headers in 300 ms, the whole
  // request in 600 ms, 900 ms idle.
  const timeouts = { headers: 300, request: 600, keepAlive: 900 }
  // How late a cut-off may come: one check interval, plus room for a busy test machine.
  const lateBy = timeouts.headers / 4 + 500
  // Node closes an idle connection a second after the keep-alive timeout it announces.
  const keepAliveBuffer = 1000
  const OK = 'GET /ok HTTP/1.1\r\nHost: localhost\r\n\r\n'
  let server: ReturnType<typeof serve>
  let port: number

  beforeAll(async () => {
    const app = new Hono()
    app.get('/ok', (c) => c.text('ok'))
    app.post('/echo', async (c) => c.text(`got ${(await c.req.text()).length} bytes`))
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

  it('cuts off a client that trickles its headers', async () => {
    const { response, closedAfterMs } = await trickle(port, {
      first: 'GET /ok HTTP/1.1\r\nHost: localhost\r\n',
      drip: 'X-Slow: 1\r\n',
    })
    expect(response).toMatch(/^HTTP\/1\.1 408 /)
    expect(closedAfterMs).toBeGreaterThanOrEqual(timeouts.headers)
    expect(closedAfterMs).toBeLessThan(timeouts.headers + lateBy)
  })

  it('cuts off a client that trickles its body', async () => {
    const { response, closedAfterMs } = await trickle(port, {
      first:
        'POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: 1000\r\n\r\n',
      drip: 'x',
    })
    expect(response).toMatch(/^HTTP\/1\.1 408 /)
    expect(closedAfterMs).toBeGreaterThanOrEqual(timeouts.request)
    expect(closedAfterMs).toBeLessThan(timeouts.request + lateBy)
  })

  it('answers a slow client that finishes in time', async () => {
    // Three bytes, one every 100 ms: done after about 300 of the 600 ms allowed.
    const { response } = await trickle(port, {
      first:
        'POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Length: 3\r\nConnection: close\r\n\r\n',
      drip: 'x',
      everyMs: 100,
    })
    expect(response).toMatch(/^HTTP\/1\.1 200 /)
    expect(response).toMatch(/got 3 bytes$/)
  })

  it('keeps an idle connection open for the keep-alive timeout, not the shorter ones', async () => {
    const { response, closedAfterAnswerMs } = await afterOneRequest(port, { first: OK })
    expect(response).toMatch(/^HTTP\/1\.1 200 /)
    expect(response).not.toMatch(/408/)
    expect(closedAfterAnswerMs).toBeGreaterThanOrEqual(timeouts.keepAlive)
    expect(closedAfterAnswerMs).toBeLessThan(timeouts.keepAlive + keepAliveBuffer + 500)
  })

  it('times the next request on a kept-alive connection from its own first byte', async () => {
    // Idle for longer than the headers and request timeouts together, then a whole request.
    const { response } = await afterOneRequest(port, {
      first: OK,
      idleMs: timeouts.request + 200,
      second: 'GET /ok HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
    })
    expect(response.match(/HTTP\/1\.1 200 /g)).toHaveLength(2)
  })

  it('cuts off a client that trickles headers on a kept-alive connection', async () => {
    const idleMs = 200
    const { response, closedAfterAnswerMs } = await afterOneRequest(port, {
      first: OK,
      idleMs,
      second: 'GET /ok HTTP/1.1\r\nHost: localhost\r\n',
      drip: 'X-Slow: 1\r\n',
    })
    expect(response).toMatch(/^HTTP\/1\.1 200 [\s\S]*HTTP\/1\.1 408 /)
    expect(closedAfterAnswerMs).toBeGreaterThanOrEqual(idleMs + timeouts.headers)
    expect(closedAfterAnswerMs).toBeLessThan(idleMs + timeouts.headers + lateBy)
  })
})
