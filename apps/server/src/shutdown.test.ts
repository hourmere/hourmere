import { once } from 'node:events'
import type { Server } from 'node:http'
import { type AddressInfo, connect } from 'node:net'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { httpServerOptions } from './http-timeouts.ts'
import { closeConnectionsWhen, closeServer, DEFAULT_SHUTDOWN_TIMING } from './shutdown.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const app = new Hono()
app.get('/slow', async (c) => {
  await sleep(300)
  return c.text('slow')
})
// Headers and a first chunk at once, the rest 400 ms later.
app.get('/stream', (c) => {
  const encoder = new TextEncoder()
  return c.body(
    new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode('first '))
        await sleep(400)
        controller.enqueue(encoder.encode('last'))
        controller.close()
      },
    }),
  )
})

/** A server as startServer runs it, with a keep-alive far longer than any test here. */
async function start() {
  let closing = false
  const server = await new Promise<Server>((resolve) => {
    const s = serve(
      {
        fetch: closeConnectionsWhen(() => closing, app.fetch),
        port: 0,
        serverOptions: httpServerOptions({ headers: 20_000, request: 60_000, keepAlive: 60_000 }),
      },
      () => resolve(s as Server),
    )
  })
  const timing = { sweepMs: 100, cutoffMs: 600 }
  return {
    port: (server.address() as AddressInfo).port,
    /** Starts closing, as RunningServer.close does; resolves with when the server closed. */
    close: (cutoffMs = timing.cutoffMs) => {
      closing = true
      return closeServer(server, { ...timing, cutoffMs }).then(() => Date.now())
    },
    timing,
  }
}

/** A raw connection that records what the server sends and when it hangs up. */
async function open(port: number) {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  socket.setEncoding('utf8')
  let received = ''
  socket.on('data', (chunk) => {
    received += chunk
  })
  socket.on('error', () => {})
  const hungUp = once(socket, 'close').then(() => Date.now())
  return {
    socket,
    hungUp,
    received: () => received,
    /** Waits until what the server sent matches `pattern`; returns when. */
    until: (pattern: RegExp) =>
      vi.waitFor(
        () => {
          if (!pattern.test(received)) throw new Error(`not yet: ${received}`)
          return Date.now()
        },
        { timeout: 3000, interval: 5 },
      ),
  }
}

describe('closing the server', () => {
  it('waits by default 250 ms between sweeps and 10 s before cutting connections', () => {
    expect(DEFAULT_SHUTDOWN_TIMING).toEqual({ sweepMs: 250, cutoffMs: 10_000 })
  })

  it('answers a request in progress with Connection: close, then closes at once', async () => {
    const server = await start()
    const client = await open(server.port)
    client.socket.write('GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n')
    await sleep(100)
    const closed = server.close()
    const answeredAt = await client.until(/\r\n\r\nslow$/)
    expect(client.received()).toMatch(/^HTTP\/1\.1 200 [\s\S]*\r\nConnection: close\r\n/)
    // Node hangs up right after the answer: there is no keeping it for another request.
    expect((await client.hungUp) - answeredAt).toBeLessThan(50)
    expect((await closed) - answeredAt).toBeLessThan(50)
  })

  it('closes a kept-alive connection that becomes idle after closing began', async () => {
    const server = await start()
    const client = await open(server.port)
    client.socket.write('GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n')
    // The headers went out before closing began, so they say keep-alive.
    await client.until(/first /)
    expect(client.received()).toMatch(/\r\nConnection: keep-alive\r\n/)
    const closed = server.close()
    const answeredAt = await client.until(/last\r\n0\r\n\r\n$/)
    // Closed by the next sweep, long before the cut-off.
    expect((await closed) - answeredAt).toBeLessThan(server.timing.sweepMs + 100)
  })

  it('cuts off connections still busy at the cut-off', async () => {
    const server = await start()
    const client = await open(server.port)
    // A request that never finishes, as from a client sending slowly.
    client.socket.write('GET /slow HTTP/1.1\r\nHost: localhost\r\n')
    await sleep(50)
    const startedAt = Date.now()
    const closedAt = await server.close()
    expect(closedAt - startedAt).toBeGreaterThanOrEqual(server.timing.cutoffMs - 10)
    expect(closedAt - startedAt).toBeLessThan(server.timing.cutoffMs + 300)
    await client.hungUp
  })
})
