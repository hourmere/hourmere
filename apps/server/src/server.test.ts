import { Console } from 'node:console'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { Writable } from 'node:stream'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
})
