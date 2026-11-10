import { randomBytes, randomUUID } from 'node:crypto'
import { createAuth, createAuthPool } from '@hourmere/auth'
import { createDb } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'
import { describe, expect, it, vi } from 'vitest'
import { callTool } from '../../../tools/cli/src/client.ts'
import { type RunningServer, startServer } from './server.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('Slack composition across server roles', () => {
  it('captures lifecycle and sample jobs with webhooks enabled, preserving DST instants and replay', async () => {
    const owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'slack_roles' })
    const db = createDb(owned.pool)
    const spies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    let running: RunningServer | undefined
    const syntheticUrl = 'https://hooks.slack.com/services/TTEST/BTEST/syntheticCompositionOnly'
    const replacementUrl = 'https://hooks.slack.com/services/TTEST/BTEST/syntheticMcpReplacement'
    try {
      const user = await createTestUser(db)
      const fixtures = createFixtures(db)
      const handle = `slack-${user.id.slice(0, 8)}`
      await db
        .insertInto('profiles')
        .values({ user_id: user.id, handle, time_zone: 'America/New_York' })
        .execute()
      await fixtures.schedule(user.id, {
        timeZone: 'America/New_York',
        weeklyHours: { sunday: [{ start: '01:00', end: '05:00' }] },
      })
      await fixtures.eventType(user.principal.organization.id, user.id, {
        slug: 'intro',
        title: 'Private <@channel> title',
      })
      const secret = randomBytes(32).toString('base64')
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
        SIGNUP: 'closed',
        WEBHOOKS_ENABLED: 'true',
        WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        PORT: '0',
        PUBLIC_URL: 'http://localhost',
      }
      running = await startServer({ ...env, HOURMERE_ROLE: 'web' })
      const request = (
        path: string,
        method: string,
        body?: unknown,
        extra: Record<string, string> = {},
      ) =>
        fetch(`http://127.0.0.1:${running?.port}/api/v1${path}`, {
          method,
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            ...extra,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      const created = await request('/slack-destinations', 'POST', {
        url: syntheticUrl,
        events: ['booking.created', 'booking.rescheduled', 'booking.cancelled'],
      })
      expect(created.status).toBe(201)
      const createdText = await created.text()
      expect(createdText).not.toContain(syntheticUrl)
      const destination = JSON.parse(createdText) as { id: string }
      const sample = await request(`/slack-destinations/${destination.id}/test`, 'POST')
      expect(sample.status).toBe(202)
      await sample.body?.cancel()
      // MCP is served from the same production app options: replacing the URL needs the
      // configured webhook encryption key there.
      const replaced = await callTool({
        url: new URL('/mcp', `http://127.0.0.1:${running.port}`),
        key: apiKey,
        tool: 'update_slack_destination',
        input: { id: destination.id, url: replacementUrl },
      })
      expect(replaced).toMatchObject({ id: destination.id, isActive: true })
      expect(JSON.stringify(replaced)).not.toContain(replacementUrl)

      // Second Sunday in March: 01:30 EST + 30 elapsed minutes ends at 03:00 EDT.
      const year = Temporal.Now.plainDateISO('America/New_York').year + 1
      let day = Temporal.PlainDate.from({ year, month: 3, day: 8 })
      while (day.dayOfWeek !== 7) day = day.add({ days: 1 })
      const start = day
        .toZonedDateTime({ timeZone: 'America/New_York', plainTime: '01:30' })
        .toInstant()
      const input = {
        start: start.toString(),
        invitee: {
          name: 'Private <@here> & <https://example.com|link>',
          email: 'private-slack@example.com',
          timeZone: 'America/New_York',
        },
      }
      const replayKey = randomUUID()
      const path = `/public/${handle}/intro/bookings`
      const booked = await request(path, 'POST', input, { 'idempotency-key': replayKey })
      expect(booked.status).toBe(201)
      const booking = (await booked.json()) as {
        booking: { id: string; start: string; end: string }
      }
      expect(Temporal.Instant.compare(booking.booking.end, start.add({ minutes: 30 }))).toBe(0)
      const replay = await request(path, 'POST', input, { 'idempotency-key': replayKey })
      expect(replay.status).toBe(200)
      await replay.body?.cancel()
      const nextStart = start.add({ hours: 1 }).toString()
      const moved = await request(`/bookings/${booking.booking.id}/reschedule`, 'POST', {
        start: nextStart,
      })
      expect(moved.status).toBe(200)
      const successor = (await moved.json()) as { booking: { id: string } }
      const cancelled = await request(`/bookings/${successor.booking.id}/cancel`, 'POST', {
        reason: 'Private cancellation text',
      })
      expect(cancelled.status).toBe(200)
      await cancelled.body?.cancel()
      const deliveries = await db
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('webhook_id', '=', destination.id)
        .execute()
      expect(deliveries).toHaveLength(4)
      expect(
        deliveries
          .filter((row) => row.booking_id !== null)
          .map((row) => row.event_type)
          .sort(),
      ).toEqual(['booking.cancelled', 'booking.created', 'booking.rescheduled'])
      expect(deliveries.every((row) => row.status === 'pending' && row.attempts === 0)).toBe(true)
      const payloads = deliveries.map((row) => row.payload).join('\n')
      for (const value of [
        '@here',
        '@channel',
        'private-slack@example.com',
        syntheticUrl,
        replacementUrl,
      ])
        expect(payloads.includes(value)).toBe(false)
      expect(payloads).toContain(
        start.toZonedDateTimeISO('America/New_York').toString({ smallestUnit: 'minute' }),
      )
      const jobs = await owned.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pgboss.job WHERE name='webhook-delivery'",
      )
      expect(jobs.rows[0]?.n).toBe(4)
      const paused = await request(`/slack-destinations/${destination.id}`, 'PATCH', {
        isActive: false,
      })
      expect(paused.status).toBe(200)
      await paused.body?.cancel()
      await running.close()
      running = undefined
      // Only this throwaway database's unrelated email jobs are removed. All Slack
      // destinations are paused before the worker starts, so no network call can occur.
      await owned.pool.query("DELETE FROM pgboss.job WHERE name <> 'webhook-delivery'")
      running = await startServer({ ...env, HOURMERE_ROLE: 'worker' })
      await vi.waitFor(
        async () => {
          const rows = await db
            .selectFrom('webhook_deliveries')
            .select(['status', 'attempts'])
            .where('webhook_id', '=', destination.id)
            .execute()
          expect(rows).toHaveLength(4)
          expect(rows.every((row) => row.status === 'skipped' && row.attempts === 0)).toBe(true)
        },
        { timeout: 8000, interval: 50 },
      )
      for (const spy of spies)
        for (const value of [syntheticUrl, replacementUrl])
          expect(JSON.stringify(spy.mock.calls)).not.toContain(value)
    } finally {
      await running?.close()
      await owned.drop()
      for (const spy of spies) spy.mockRestore()
    }
  }, 25_000)
})
