import { randomBytes } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { createAuth, createAuthPool } from '@hourmere/auth'
import { createDb } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser, testContext } from '@hourmere/scheduling/testing'
import { createWebhook, updateWebhook, webhookSignature } from '@hourmere/webhooks'
import { describe, expect, it, vi } from 'vitest'
import { type RunningServer, startServer } from './server.ts'

const serverUrl = process.env.DATABASE_URL
const port = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as { port: number }
      probe.close(() => resolve(address.port))
    })
  })

describe.skipIf(!serverUrl)('webhook composition across real server roles', () => {
  it('captures over HTTP in web, persists through shutdown, and safely skips in worker', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    const db = createDb(owned.pool)
    const spies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    let running: RunningServer | undefined
    try {
      const key = Buffer.alloc(32, 3).toString('base64')
      const user = await createTestUser(db)
      const ctx = testContext(db, user.principal)
      const { webhook } = await createWebhook(
        ctx,
        { enabled: true, encryptionKey: key },
        { url: 'https://hooks.example.com/', events: ['booking.created'] },
      )
      const f = createFixtures(db)
      const handle = `composition-${user.id.slice(0, 8)}`
      await db
        .insertInto('profiles')
        .values({ user_id: user.id, handle, time_zone: 'UTC' })
        .execute()
      await f.schedule(user.id, { timeZone: 'UTC' })
      await f.eventType(user.principal.organization.id, user.id, { slug: 'intro' })
      const env = {
        DATABASE_URL: owned.url,
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
        WEBHOOKS_ENABLED: 'true',
        WEBHOOK_ENCRYPTION_KEY: key,
        SIGNUP: 'closed',
      }
      const webPort = await port()
      running = await startServer({
        ...env,
        HOURMERE_ROLE: 'web',
        PORT: String(webPort),
        PUBLIC_URL: `http://localhost:${webPort}`,
      })
      const day = Temporal.Now.zonedDateTimeISO('UTC').add({ days: 7 }).toPlainDate()
      let target = day
      while (target.dayOfWeek > 5) target = target.add({ days: 1 })
      const start = target
        .toZonedDateTime({ timeZone: 'UTC', plainTime: '10:00' })
        .toInstant()
        .toString()
      const response = await fetch(
        `http://127.0.0.1:${running.port}/api/v1/public/${handle}/intro/bookings`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            start,
            invitee: { name: 'Synthetic', email: 'synthetic-webhook@example.com', timeZone: 'UTC' },
          }),
        },
      )
      expect(response.status).toBe(201)
      await response.body?.cancel()
      const delivery = await db
        .selectFrom('webhook_deliveries')
        .select(['id', 'status', 'attempts'])
        .where('webhook_id', '=', webhook.id)
        .executeTakeFirstOrThrow()
      expect(delivery).toMatchObject({ status: 'pending', attempts: 0 })
      await running.close()
      running = undefined
      // No provider/mail/receiver is contacted. Pause before starting the worker, and
      // discard only this disposable fixture's notification jobs to avoid log-mail tokens.
      await updateWebhook(ctx, webhook.id, { isActive: false })
      await owned.pool.query("DELETE FROM pgboss.job WHERE name='booking-notification'")
      running = await startServer({ ...env, HOURMERE_ROLE: 'worker', PORT: String(await port()) })
      expect((await fetch(`http://127.0.0.1:${running.port}/api/v1/webhooks`)).status).toBe(404)
      await vi.waitFor(
        async () => {
          const current = await db
            .selectFrom('webhook_deliveries')
            .select(['status', 'attempts'])
            .where('id', '=', delivery.id)
            .executeTakeFirstOrThrow()
          expect(current).toEqual({ status: 'skipped', attempts: 0 })
        },
        { timeout: 8000, interval: 50 },
      )
      await running.close()
      running = undefined
      running = await startServer({ ...env, HOURMERE_ROLE: 'all', PORT: String(await port()) })
      expect((await fetch(`http://127.0.0.1:${running.port}/api/health`)).status).toBe(200)
      expect((await fetch(`http://127.0.0.1:${running.port}/api/v1/webhooks`)).status).toBe(401)
      expect(
        spies[2]?.mock.calls.some((args) => args.join(' ').includes('WEBHOOK_PRIVATE_TARGETS')),
      ).toBe(false)
    } finally {
      await running?.close()
      await owned.drop()
      for (const spy of spies) spy.mockRestore()
    }
  }, 20_000)

  it('passes private targets to REST and a separate worker, warning without their values', async () => {
    const owned = await createTestDatabase(serverUrl as string)
    const db = createDb(owned.pool)
    const spies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    let signingSecret = ''
    const requests: { path: string; method: string | undefined; signatureValid: boolean }[] = []
    const receiver = createHttpServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        requests.push({
          path: request.url ?? '',
          method: request.method,
          signatureValid:
            typeof request.headers['webhook-id'] === 'string' &&
            typeof request.headers['webhook-event-id'] === 'string' &&
            request.headers['webhook-signature'] ===
              webhookSignature(signingSecret, String(request.headers['webhook-timestamp']), body),
        })
        response.writeHead(204).end()
      })
    })
    let running: RunningServer | undefined
    try {
      await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
      const receiverPort = (receiver.address() as { port: number }).port
      const privateTarget = `127.0.0.1:${receiverPort}`
      const secret = randomBytes(32).toString('base64')
      const key = Buffer.alloc(32, 5).toString('base64')
      const user = await createTestUser(db)
      const signup = { mode: 'closed', allowedDomains: [] } as const
      const authPool = createAuthPool(owned.url, signup)
      let apiKey: string
      try {
        const auth = createAuth({
          pool: authPool,
          db,
          baseURL: 'http://localhost',
          secret,
          signup,
          mailer: { send: async () => {} },
        })
        apiKey = (await auth.api.createApiKey({ body: { userId: user.id } })).key
      } finally {
        await authPool.end()
      }
      const env = {
        DATABASE_URL: owned.url,
        BETTER_AUTH_SECRET: secret,
        PORT: '0',
        PUBLIC_URL: 'http://localhost',
        WEBHOOKS_ENABLED: 'true',
        WEBHOOK_ENCRYPTION_KEY: key,
        WEBHOOK_PRIVATE_TARGETS: privateTarget,
        SIGNUP: 'closed',
      }
      running = await startServer({ ...env, HOURMERE_ROLE: 'web' })
      const created = await fetch(`http://127.0.0.1:${running.port}/api/v1/webhooks`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          url: `http://${privateTarget}/owned-hook`,
          events: ['booking.created'],
        }),
      })
      expect(created.status).toBe(201)
      const endpoint = (await created.json()) as { secret: string; webhook: { id: string } }
      signingSecret = endpoint.secret
      const f = createFixtures(db)
      const handle = `private-composition-${user.id.slice(0, 8)}`
      await db
        .insertInto('profiles')
        .values({ user_id: user.id, handle, time_zone: 'UTC' })
        .execute()
      await f.schedule(user.id, { timeZone: 'UTC' })
      await f.eventType(user.principal.organization.id, user.id, { slug: 'intro' })
      let day = Temporal.Now.plainDateISO('UTC').add({ days: 7 })
      while (day.dayOfWeek > 5) day = day.add({ days: 1 })
      const start = day
        .toZonedDateTime({ timeZone: 'UTC', plainTime: '10:00' })
        .toInstant()
        .toString()
      const booking = await fetch(
        `http://127.0.0.1:${running.port}/api/v1/public/${handle}/intro/bookings`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            start,
            invitee: { name: 'Synthetic', email: 'private-webhook@example.com', timeZone: 'UTC' },
          }),
        },
      )
      expect(booking.status).toBe(201)
      await booking.body?.cancel()
      await running.close()
      running = undefined
      // Avoid delivering unrelated mail from this disposable fixture in the real worker.
      await owned.pool.query("DELETE FROM pgboss.job WHERE name='booking-notification'")
      expect(requests).toEqual([])
      running = await startServer({ ...env, HOURMERE_ROLE: 'worker' })
      await vi.waitFor(
        async () => {
          expect(
            await db
              .selectFrom('webhook_deliveries')
              .select(['status', 'attempts', 'http_status'])
              .where('webhook_id', '=', endpoint.webhook.id)
              .executeTakeFirstOrThrow(),
          ).toEqual({ status: 'delivered', attempts: 1, http_status: 204 })
        },
        { timeout: 8000, interval: 50 },
      )
      expect(requests).toEqual([{ path: '/owned-hook', method: 'POST', signatureValid: true }])
      const warnings = spies[2]?.mock.calls
        .map((args) => args.join(' '))
        .filter((line) => line.includes('WEBHOOK_PRIVATE_TARGETS'))
      expect(warnings).toHaveLength(2)
      expect(warnings?.every((line) => line.includes('Cloud must never'))).toBe(true)
      expect(warnings?.some((line) => line.includes(privateTarget))).toBe(false)
    } finally {
      await running?.close()
      await new Promise<void>((resolve, reject) =>
        receiver.close((error) => (error ? reject(error) : resolve())),
      )
      await owned.drop()
      for (const spy of spies) spy.mockRestore()
    }
  }, 25_000)
})
