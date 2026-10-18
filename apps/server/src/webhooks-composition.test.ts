import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { createDb } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser, testContext } from '@hourmere/scheduling/testing'
import { createWebhook, updateWebhook } from '@hourmere/webhooks'
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
    } finally {
      await running?.close()
      await owned.drop()
      for (const spy of spies) spy.mockRestore()
    }
  }, 20_000)
})
