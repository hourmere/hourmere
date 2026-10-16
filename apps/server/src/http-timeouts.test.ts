import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_HTTP_TIMEOUTS, httpServerOptions } from './http-timeouts.ts'
import { trickle } from './slow-client-testing.ts'

describe('httpServerOptions', () => {
  it('sets the three timeouts and checks for late clients four times as often', () => {
    expect(httpServerOptions(DEFAULT_HTTP_TIMEOUTS)).toEqual({
      headersTimeout: 20_000,
      requestTimeout: 60_000,
      keepAliveTimeout: 5_000,
      connectionsCheckingInterval: 5_000,
    })
  })
})

describe('a server with short timeouts', () => {
  // Short enough to test: headers in 400 ms, the whole request in 800 ms, 300 ms idle.
  const timeouts = { headers: 400, request: 800, keepAlive: 300 }
  // How late a cut-off may come: one check interval, plus room for a busy test machine.
  const lateBy = timeouts.headers / 4 + 500
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
    // Five bytes, one every 100 ms: done after about 500 of the 800 ms allowed.
    const { response } = await trickle(port, {
      first:
        'POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\nConnection: close\r\n\r\n',
      drip: 'x',
      everyMs: 100,
    })
    expect(response).toMatch(/^HTTP\/1\.1 200 /)
    expect(response).toMatch(/got 5 bytes$/)
  })

  it('closes an idle connection after the keep-alive timeout', async () => {
    const { response, closedAfterMs } = await trickle(port, {
      first: 'GET /ok HTTP/1.1\r\nHost: localhost\r\n\r\n',
    })
    expect(response).toMatch(/^HTTP\/1\.1 200 /)
    expect(closedAfterMs).toBeGreaterThanOrEqual(timeouts.keepAlive)
    // Node waits a further second (keepAliveTimeoutBuffer) beyond the advertised timeout.
    expect(closedAfterMs).toBeLessThan(timeouts.keepAlive + 1000 + 500)
  })
})
