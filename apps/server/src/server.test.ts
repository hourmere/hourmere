import { Console } from 'node:console'
import { randomBytes } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { Writable } from 'node:stream'
import { createPool } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { BOOKING_NOTIFICATION_JOB, bookingNotificationJob } from '@hourmere/notifications'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startServer } from './server.ts'

const serverUrl = process.env.DATABASE_URL
const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'dir', 'dirxml'] as const

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })

describe.skipIf(!serverUrl)('startServer', () => {
  let testDb: TestDatabase

  beforeAll(async () => {
    testDb = await createTestDatabase(serverUrl as string)
  })

  afterAll(async () => {
    await testDb?.drop()
  })

  it('serves the app and makes the console print one line per call until closed', async () => {
    // The process console, writing to a stream.
    let text = ''
    const stream = new Writable({
      write(chunk, _encoding, done) {
        text += chunk.toString()
        done()
      },
    })
    const out = new Console({ stdout: stream, stderr: stream })
    const saved = METHODS.map((m) => [m, console[m]] as const)
    const streamed = METHODS.map((m) => [m, out[m].bind(out)] as const)
    for (const [m, fn] of streamed) console[m] = fn as never
    try {
      const port = await freePort()
      const server = await startServer({
        DATABASE_URL: testDb.url,
        PORT: String(port),
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
      })
      try {
        const health = await fetch(`http://127.0.0.1:${server.port}/api/health`)
        expect(await health.json()).toEqual({ status: 'ok', database: 'ok' })
        // The composition root registers the product routes.
        const doc = (await (
          await fetch(`http://127.0.0.1:${server.port}/api/v1/openapi.json`)
        ).json()) as { paths: Record<string, unknown> }
        expect(Object.keys(doc.paths)).toEqual(
          expect.arrayContaining([
            '/api/v1/public/{handle}/{slug}/slots',
            '/api/v1/public/{handle}/{slug}/bookings',
            '/api/v1/bookings/manage',
            '/api/v1/bookings/{id}',
          ]),
        )
        // And mounts the MCP endpoint, which wants an API key.
        const mcp = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: 'POST' })
        expect(mcp.status).toBe(401)
        expect(mcp.headers.get('www-authenticate')).toBe('Bearer')
        console.error(new Error('boom\n[mail] {"forged":true}'))
      } finally {
        await server.close()
      }
      // Closing restored the console it found.
      for (const [m, fn] of streamed) expect(console[m]).toBe(fn)

      const lines = text.split('\n').slice(0, -1)
      expect(lines.some((l) => l.startsWith('Hourmere listening on :'))).toBe(true)
      expect(lines.filter((l) => l.startsWith('Error: boom'))).toHaveLength(1)
      expect(lines.filter((l) => l.startsWith('[mail]') || l.startsWith('    at '))).toEqual([])
    } finally {
      for (const [m, fn] of saved) console[m] = fn as never
    }
  })

  /** Silences the console while `fn` runs; returns what went to warn and error, as lines. */
  async function quietly(fn: () => Promise<void>) {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    )
    const lines = (i: number) => (spies[i]?.mock.calls ?? []).map((args) => args.join(' '))
    try {
      await fn()
      return { warn: lines(2), error: lines(3) }
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  }

  it('answers sign-in requests without waiting for email, and closes while one is sending', async () => {
    // An SMTP server that accepts connections and never says a word.
    const sockets = new Set<Socket>()
    let connected = () => {}
    const sending = new Promise<void>((resolve) => {
      connected = resolve
    })
    const smtp = createServer((socket) => {
      sockets.add(socket)
      connected()
    })
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve))
    const printed = await quietly(async () => {
      const port = await freePort()
      const publicUrl = `http://localhost:${port}`
      const server = await startServer({
        DATABASE_URL: testDb.url,
        PORT: String(port),
        PUBLIC_URL: publicUrl,
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
        SMTP_URL: `smtp://127.0.0.1:${(smtp.address() as { port: number }).port}`,
        MAIL_FROM: 'Hourmere <hourmere@example.com>',
        SIGNUP: 'open',
      })
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/auth/sign-in/magic-link`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: publicUrl },
          body: JSON.stringify({ email: 'ada@example.com', callbackURL: '/' }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ status: true })
        await sending
      } finally {
        // Does not wait for the email, and says so.
        await server.close()
        expect(vi.mocked(console.warn)).toHaveBeenLastCalledWith(
          'shutting down: dropping 1 email(s) still being sent',
        )
      }
      // The SMTP server goes away; the failure is logged, without the address.
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => smtp.close(resolve))
      await vi.waitFor(() => expect(vi.mocked(console.error)).toHaveBeenCalled())
    })
    expect(printed.error).toEqual([
      '[auth] sign-in email not sent (code=ECONNECTION, command=CONN)',
    ])
    expect(printed.warn.filter((l) => l.includes('dropping'))).toHaveLength(1)
  })

  it('refuses to start when database connections lose the sign-up settings', async () => {
    // As behind a connection pooler that drops startup parameters.
    vi.resetModules()
    vi.doMock('@hourmere/auth', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@hourmere/auth')>()),
      createAuthPool: (url: string) => createPool(url),
    }))
    try {
      const { startServer: start } = await import('./server.ts')
      await quietly(async () => {
        await expect(
          start({
            DATABASE_URL: testDb.url,
            PORT: String(await freePort()),
            BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
          }),
        ).rejects.toThrow(
          /does not carry the sign-up policy \(hourmere\.signup is nothing, expected first-user/,
        )
      })
    } finally {
      vi.doUnmock('@hourmere/auth')
      vi.resetModules()
    }
  })

  it('splits into a web role that only queues jobs and a worker role that runs them', async () => {
    const env = { DATABASE_URL: testDb.url, BETTER_AUTH_SECRET: randomBytes(32).toString('base64') }
    const state = async (id: string) =>
      (
        await testDb.pool.query<{ state: string }>('SELECT state FROM pgboss.job WHERE id = $1', [
          id,
        ])
      ).rows[0]?.state
    await quietly(async () => {
      const web = await startServer({
        ...env,
        PORT: String(await freePort()),
        HOURMERE_ROLE: 'web',
      })
      const producer = createJobs({
        connectionString: testDb.url,
        definitions: [bookingNotificationJob({} as never)],
        work: false,
        migrate: false,
        log: () => {},
      })
      await producer.start()
      try {
        const doc = await fetch(`http://127.0.0.1:${web.port}/api/v1/openapi.json`)
        expect(doc.status).toBe(200)
        // A booking that does not exist: the job has nothing to send and completes.
        const id = (await producer.enqueue(BOOKING_NOTIFICATION_JOB, {
          bookingId: '0199f0c4-7a2b-7000-8000-00000000abcd',
          kind: 'confirmed',
        })) as string
        await new Promise((r) => setTimeout(r, 2500))
        expect(await state(id)).toBe('created')

        const worker = await startServer({
          ...env,
          PORT: String(await freePort()),
          HOURMERE_ROLE: 'worker',
        })
        const base = `http://127.0.0.1:${worker.port}`
        try {
          const health = await fetch(`${base}/api/health`)
          expect(health.status).toBe(200)
          expect(health.headers.get('cache-control')).toBe('no-store')
          expect(await health.json()).toEqual({ status: 'ok', database: 'ok', jobs: 'running' })
          for (const path of ['/', '/api/v1/openapi.json', '/api/auth/ok', '/api/health/x']) {
            expect((await fetch(`${base}${path}`)).status, path).toBe(404)
          }
          // Nor the MCP endpoint, which the web role serves.
          const mcp = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          expect(mcp.status).toBe(404)
          const deadline = Date.now() + 15_000
          while ((await state(id)) !== 'completed' && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100))
          }
          expect(await state(id)).toBe('completed')
        } finally {
          await worker.close()
        }
        await expect(fetch(`${base}/api/health`)).rejects.toThrow()
      } finally {
        await producer.stop()
        await web.close()
      }
    })
  }, 40_000)
})
