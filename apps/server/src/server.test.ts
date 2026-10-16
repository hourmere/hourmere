import { Console } from 'node:console'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { Writable } from 'node:stream'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { BOOKING_NOTIFICATION_JOB, bookingNotificationJob } from '@hourmere/notifications'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from './server.ts'

const serverUrl = process.env.DATABASE_URL
const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'dir', 'dirxml'] as const

/** Runs `fn` with the console silenced (servers print their start-up and request lines). */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const saved = METHODS.map((m) => [m, console[m]] as const)
  for (const m of METHODS) console[m] = (() => {}) as never
  try {
    return await fn()
  } finally {
    for (const [m, fn] of saved) console[m] = fn as never
  }
}

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
