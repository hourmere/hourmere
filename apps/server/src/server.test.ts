import { Console } from 'node:console'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Server as HttpServer } from 'node:http'
import { connect, createServer, type Socket } from 'node:net'
import { Writable } from 'node:stream'
import { createAuth, createAuthPool } from '@hourmere/auth'
import { createDb, createPool } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import { BOOKING_NOTIFICATION_JOB, bookingNotificationJob } from '@hourmere/notifications'
import { createFixtures } from '@hourmere/scheduling/testing'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type RunningServer, startServer } from './server.ts'
import { trickle } from './slow-client-testing.ts'

const serverUrl = process.env.DATABASE_URL
const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'dir', 'dirxml'] as const

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
      const server = await startServer({
        DATABASE_URL: testDb.url,
        PORT: '0',
        PUBLIC_URL: 'http://localhost',
        HOSTED_SIGNUP_URL: 'https://hosted.example/sign-up',
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
      })
      try {
        const health = await fetch(`http://127.0.0.1:${server.port}/api/health`)
        expect(await health.json()).toEqual({ status: 'ok', database: 'ok' })
        const instance = await fetch(`http://127.0.0.1:${server.port}/api/v1/instance`)
        expect(await instance.json()).toHaveProperty(
          'hostedSignupUrl',
          'https://hosted.example/sign-up',
        )
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

  it('registers every catalog tool in the production MCP composition', async () => {
    const db = createDb(testDb.pool)
    const f = createFixtures(db)
    const host = await f.host()
    const secret = randomBytes(32).toString('base64')
    const signup = { mode: 'open', allowedDomains: [] } as const
    const authPool = createAuthPool(testDb.url, signup)
    let key: string
    try {
      const auth = createAuth({
        pool: authPool,
        db,
        baseURL: 'http://localhost',
        secret,
        mailer: { send: async () => {} },
        signup,
      })
      key = (await auth.api.createApiKey({ body: { userId: host.userId, name: 'catalog' } })).key
    } finally {
      await authPool.end()
    }
    const printed = await quietly(async () => {
      const server = await startServer({
        DATABASE_URL: testDb.url,
        PORT: '0',
        PUBLIC_URL: 'http://localhost',
        BETTER_AUTH_SECRET: secret,
        HOURMERE_ROLE: 'web',
      })
      const client = new Client({ name: 'catalog-registration-test', version: '1.0.0' })
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
            requestInit: { headers: { authorization: `Bearer ${key}` } },
          }),
        )
        const result = await client.listTools()
        expect(result.tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining([
            'get_profile',
            'list_event_types',
            'get_event_type',
            'list_schedules',
            'get_schedule',
          ]),
        )
        const profile = await client.callTool({ name: 'get_profile', arguments: {} })
        expect(profile.isError).toBeFalsy()
        expect(profile.structuredContent).toMatchObject({ handle: host.handle })
      } finally {
        await client.close()
        await server.close()
      }
    })
    expect(printed.error).toEqual([])
  })

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
      const publicUrl = 'http://localhost'
      const server = await startServer({
        DATABASE_URL: testDb.url,
        PORT: '0',
        PUBLIC_URL: publicUrl,
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
        SMTP_URL: `smtp://127.0.0.1:${(smtp.address() as { port: number }).port}`,
        MAIL_FROM: 'Hourmere <hourmere@example.com>',
        SIGNUP: 'open',
      })
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/auth/sign-in/magic-link`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: publicUrl },
          body: JSON.stringify({ email: 'ada@example.com', callbackURL: '/' }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ status: true })
        await sending
      } finally {
        // The request already completed while SMTP was blocked. Shutdown now waits for
        // this durable worker attempt; release only this test's SMTP sockets to finish it.
        const closing = server.close()
        for (const socket of sockets) socket.destroy()
        await new Promise((resolve) => smtp.close(resolve))
        await closing
      }
      // The failed delivery remains available for a worker retry, without a raw link log.
      const pending = await testDb.pool.query<{ id: string }>('SELECT id FROM sign_in_emails')
      expect(pending.rows).toHaveLength(1)
      for (const row of pending.rows) {
        await testDb.pool.query(
          "DELETE FROM pgboss.job WHERE name = $1 AND data->>'emailId' = $2",
          ['sign-in-email', row.id],
        )
        await testDb.pool.query('DELETE FROM sign_in_emails WHERE id = $1', [row.id])
      }
    })
    expect(
      printed.error.some((line) => line.includes('Sign-in email could not be sent (ECONNECTION)')),
    ).toBe(true)
    expect(printed.error.join(' ')).not.toContain('ada@example.com')
    expect(printed.error.join(' ')).not.toContain('token=')
    expect(printed.warn.filter((l) => l.includes('dropping'))).toHaveLength(0)
  })

  it('queues both addresses in web role, persists through shutdown, and delivers only eligible mail in worker role', async () => {
    const email = `queue-${randomUUID()}@example.com`
    const denied = `denied-${randomUUID()}@example.com`
    const user = (
      await testDb.pool.query<{ id: string }>(
        `INSERT INTO auth."user" (name, email, "emailVerified") VALUES ('Queue owner', $1, true) RETURNING id`,
        [email],
      )
    ).rows[0]
    const printed = await quietly(async () => {
      let web: RunningServer | undefined
      let worker: RunningServer | undefined
      let ids: string[] = []
      const publicUrl = 'http://localhost'
      const config = {
        DATABASE_URL: testDb.url,
        PORT: '0',
        PUBLIC_URL: publicUrl,
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
        SIGNUP: 'closed',
      }
      try {
        web = await startServer({ ...config, HOURMERE_ROLE: 'web' })
        const answers = []
        for (const to of [email, denied]) {
          const response = await fetch(`http://127.0.0.1:${web.port}/api/auth/sign-in/magic-link`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: publicUrl },
            body: JSON.stringify({ email: to, callbackURL: '/app' }),
          })
          answers.push({ status: response.status, body: await response.json() })
        }
        expect(answers).toEqual(Array(2).fill({ status: 200, body: { status: true } }))
        ids = (await testDb.pool.query<{ id: string }>('SELECT id FROM sign_in_emails')).rows.map(
          (row) => row.id,
        )
        expect(ids).toHaveLength(2)
        const webClosing = web
        web = undefined
        await webClosing.close()
        expect((await testDb.pool.query('SELECT id FROM sign_in_emails')).rows).toHaveLength(2)
        // Read the spy after the server restores the console it temporarily wraps.
        expect(
          vi.mocked(console.log).mock.calls.some((args) => args.join(' ').startsWith('[mail]')),
        ).toBe(false)
        worker = await startServer({
          ...config,
          PORT: '0',
          PUBLIC_URL: 'http://localhost',
          HOURMERE_ROLE: 'worker',
        })
        await vi.waitFor(
          async () =>
            expect(
              (await testDb.pool.query('SELECT id FROM sign_in_emails')).rows,
              'waiting for the worker to drain queued sign-in emails',
            ).toHaveLength(0),
          { timeout: 6_000 },
        )
        const workerClosing = worker
        worker = undefined
        await workerClosing.close()
        const messages = vi
          .mocked(console.log)
          .mock.calls.map((args) => args.join(' '))
          .filter((line) => line.startsWith('[mail]'))
        expect(messages).toHaveLength(1)
        expect(messages[0]).toContain(email)
        expect(messages[0]).not.toContain(denied)
      } finally {
        await worker?.close()
        await web?.close()
        if (ids.length) {
          await testDb.pool.query(
            "DELETE FROM pgboss.job WHERE name = $1 AND data->>'emailId' = ANY($2::text[])",
            ['sign-in-email', ids],
          )
          await testDb.pool.query('DELETE FROM sign_in_emails WHERE id = ANY($1::uuid[])', [ids])
        }
        if (user) await testDb.pool.query('DELETE FROM auth."user" WHERE id = $1', [user.id])
      }
    })
    expect(printed.error).toEqual([])
  }, 15_000)

  it('cuts off clients that send too slowly, after the configured timeouts', async () => {
    await quietly(async () => {
      const server = await startServer({
        DATABASE_URL: testDb.url,
        PORT: '0',
        PUBLIC_URL: 'http://localhost',
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
        HTTP_HEADERS_TIMEOUT: '1',
        HTTP_REQUEST_TIMEOUT: '2',
      })
      try {
        const headers = await trickle(server.port, {
          first: 'GET /api/health HTTP/1.1\r\nHost: localhost\r\n',
          drip: 'X-Slow: 1\r\n',
          everyMs: 100,
        })
        expect(headers.response).toMatch(/^HTTP\/1\.1 408 /)
        // Checked every quarter of the shorter timeout; plus room for a busy machine.
        expect(headers.closedAfterMs).toBeGreaterThanOrEqual(1000)
        expect(headers.closedAfterMs).toBeLessThan(1000 + 250 + 500)

        // A booking request whose JSON body never ends; the route waits for it to validate.
        const body = await trickle(server.port, {
          first:
            'POST /api/v1/public/ada/intro/bookings HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 10000\r\n\r\n{',
          drip: ' ',
          everyMs: 100,
        })
        expect(body.response).toMatch(/^HTTP\/1\.1 408 /)
        expect(body.closedAfterMs).toBeGreaterThanOrEqual(2000)
        expect(body.closedAfterMs).toBeLessThan(2000 + 250 + 500)
      } finally {
        await server.close()
      }
    })
  })

  /**
   * Closes `server` while a request is in progress on a kept-alive connection: one whole
   * request to `path` first, then a second whose headers are finished only once close() has
   * begun. Returns the second answer, whether the server then closed the connection, and how
   * long after that answer close() resolved.
   */
  async function closeDuringRequest(server: RunningServer, path: string) {
    const socket = connect(server.port, '127.0.0.1')
    await once(socket, 'connect')
    socket.setEncoding('utf8')
    let received = ''
    socket.on('data', (chunk) => {
      received += chunk
    })
    const hungUp = once(socket, 'close')
    socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`)
    await vi.waitFor(() => expect(received).toMatch(/\r\n\r\n\{.*\}$/s))
    const first = received
    socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const closed = server.close().then(() => Date.now())
    await new Promise((resolve) => setTimeout(resolve, 300))
    socket.write('\r\n')
    await hungUp
    const answeredAt = Date.now()
    const closedAt = await closed
    return {
      first,
      second: received.slice(first.length),
      closedAfterAnswerMs: closedAt - answeredAt,
    }
  }

  it('closes once requests in progress are answered, keep-alive or not, in every role', async () => {
    const env = { DATABASE_URL: testDb.url, BETTER_AUTH_SECRET: randomBytes(32).toString('base64') }
    await quietly(async () => {
      for (const role of ['all', 'worker'] as const) {
        const server = await startServer({
          ...env,
          PORT: '0',
          PUBLIC_URL: 'http://localhost',
          HOURMERE_ROLE: role,
        })
        const { first, second, closedAfterAnswerMs } = await closeDuringRequest(
          server,
          '/api/health',
        )
        // Kept alive (for 125 s) before shutting down; answered and closed while shutting down.
        expect(first, role).toMatch(/^HTTP\/1\.1 200 [\s\S]*\r\nKeep-Alive: timeout=125\r\n/)
        expect(second, role).toMatch(/^HTTP\/1\.1 200 [\s\S]*\r\nConnection: close\r\n/)
        expect(closedAfterAnswerMs, role).toBeLessThan(2000)
      }
    })
  }, 20_000)

  it('sends HSTS with the configured max-age when PUBLIC_URL is https', async () => {
    await quietly(async () => {
      const server = await startServer({
        DATABASE_URL: testDb.url,
        PORT: '0',
        PUBLIC_URL: 'https://hourmere.example',
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
        HSTS_MAX_AGE: '60',
      })
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/health`)
        expect(res.headers.get('strict-transport-security')).toBe('max-age=60')
        await res.text()
      } finally {
        await server.close()
      }
    })
  })

  it('closes through closeServer, which sweeps idle connections and cuts off the rest', async () => {
    // closeServer's sweep and cut-off are tested in shutdown.test.ts; this checks close()
    // uses them (Connection: close alone covers the test above).
    vi.resetModules()
    const closeServer = vi.fn()
    vi.doMock('./shutdown.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./shutdown.ts')>()
      closeServer.mockImplementation(actual.closeServer)
      return { ...actual, closeServer }
    })
    try {
      const { startServer: start } = await import('./server.ts')
      await quietly(async () => {
        const server = await start({
          DATABASE_URL: testDb.url,
          PORT: '0',
          PUBLIC_URL: 'http://localhost',
          BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
        })
        await server.close()
      })
      expect(closeServer).toHaveBeenCalledOnce()
      expect(closeServer.mock.calls[0]?.[0]).toBeInstanceOf(HttpServer)
    } finally {
      vi.doUnmock('./shutdown.ts')
      vi.resetModules()
    }
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
            PORT: '0',
            PUBLIC_URL: 'http://localhost',
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

  it('emails booking changes made over REST and MCP, from jobs it queues and runs', async () => {
    const secret = randomBytes(32).toString('base64')
    const db = createDb(testDb.pool)
    const f = createFixtures(db)
    const host = await f.host({
      name: 'Grace Hopper',
      handle: `mail-${randomBytes(3).toString('hex')}`,
    })
    await f.schedule(host.userId)
    await f.eventType(host.organizationId, host.userId, { slug: 'intro', title: 'Intro call' })
    // An API key for MCP, made the way the server's own Better Auth would.
    const signup = { mode: 'open', allowedDomains: [] } as const
    const authPool = createAuthPool(testDb.url, signup)
    const agent = await f.host({ name: 'Assistant', handle: null })
    const { key } = await createAuth({
      pool: authPool,
      db,
      baseURL: 'http://localhost',
      secret,
      mailer: { send: async () => {} },
      signup,
    }).api.createApiKey({ body: { userId: agent.userId, name: 'agent' } })
    await authPool.end()

    // The log mailer prints one `[mail] {json}` line per email.
    const lines: string[] = []
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '))
      }),
    )
    type MailRecord = { to: string; subject: string; links: string[]; attachments?: unknown[] }
    const mails = () =>
      lines
        .filter((l) => l.startsWith('[mail] '))
        .map((l) => JSON.parse(l.slice('[mail] '.length)) as MailRecord)
    const untilMails = async (count: number) => {
      const deadline = Date.now() + 15_000
      while (mails().length < count && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
      }
      return mails()
    }
    try {
      const server = await startServer({
        DATABASE_URL: testDb.url,
        PORT: '0',
        PUBLIC_URL: 'http://localhost',
        BETTER_AUTH_SECRET: secret,
      })
      try {
        const base = `http://127.0.0.1:${server.port}`
        const page = `${base}/api/v1/public/${host.handle}/intro`
        const now = Temporal.Now.instant()
        const slots = (await (
          await fetch(`${page}/slots?start=${now}&end=${now.add({ hours: 14 * 24 })}`)
        ).json()) as { data: { start: string }[] }
        const [first, second] = slots.data
        const invitee = { name: 'Ada Lovelace', email: 'ada@example.com', timeZone: 'UTC' }

        const booked = await fetch(`${page}/bookings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ start: first?.start, invitee }),
        })
        expect(booked.status).toBe(201)
        const confirmations = await untilMails(2)
        expect(confirmations.map((m) => m.subject)).toEqual([
          expect.stringMatching(/^New booking: Intro call with Ada Lovelace/),
          expect.stringMatching(/^Confirmed: Intro call with Grace Hopper/),
        ])
        expect(confirmations[1]?.attachments).toEqual([
          {
            filename: 'invite.ics',
            contentType: 'text/calendar; method=REQUEST; charset=UTF-8',
            bytes: expect.any(Number),
          },
        ])
        const link = confirmations[1]?.links.find((l) => l.includes('action=cancel')) ?? ''
        const token = /#token=([A-Za-z0-9_-]{43})&/.exec(link)?.[1] as string
        expect(link.startsWith('http://localhost/booking#token=')).toBe(true)

        const client = new Client({ name: 'test-agent', version: '1.0.0' })
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
            requestInit: { headers: { authorization: `Bearer ${key}` } },
          }),
        )
        try {
          const result = await client.callTool({
            name: 'create_booking',
            arguments: { handle: host.handle, slug: 'intro', start: second?.start, invitee },
          })
          expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
        } finally {
          await client.close()
        }
        expect((await untilMails(4)).slice(2).map((m) => m.to)).toEqual([
          expect.stringMatching(/@example\.com$/),
          'ada@example.com',
        ])

        // The emailed link's secret cancels the first booking.
        const cancelled = await fetch(`${base}/api/v1/bookings/manage/cancel`, {
          method: 'POST',
          headers: { 'x-manage-token': token },
        })
        expect(cancelled.status).toBe(200)
        const cancellations = (await untilMails(6)).slice(4)
        expect(cancellations.map((m) => m.subject)).toEqual([
          expect.stringMatching(/^Cancelled: Intro call with Ada Lovelace/),
          expect.stringMatching(/^Cancelled: Intro call with Grace Hopper/),
        ])
        expect(cancellations[1]?.attachments).toEqual([
          expect.objectContaining({ filename: 'cancel.ics' }),
        ])
      } finally {
        await server.close()
      }
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  }, 60_000)

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
        PORT: '0',
        PUBLIC_URL: 'http://localhost',
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
          PORT: '0',
          PUBLIC_URL: 'http://localhost',
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
